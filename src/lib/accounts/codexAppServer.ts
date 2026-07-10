import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
  CodexAppServerProtocolError,
  parseAppServerMessage,
  redactAppServerDetail,
  type AppServerEnvelope,
  type AppServerRequestId,
} from "./codexAppServerProtocol";

export interface CodexAppServerChild {
  stdin: Pick<ChildProcessWithoutNullStreams["stdin"], "write" | "end">;
  stdout: Pick<ChildProcessWithoutNullStreams["stdout"], "on">;
  stderr?: Pick<ChildProcessWithoutNullStreams["stderr"], "on">;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type CodexAppServerSpawn = (home: string) => CodexAppServerChild;

export interface CodexAppServerClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface CodexAppServerOptions {
  home: string;
  spawn?: CodexAppServerSpawn;
  clock?: CodexAppServerClock;
  requestTimeoutMs?: number;
  shutdownGraceMs?: number;
}

export interface DeviceCodeChallenge {
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

export interface AppServerAccount {
  type?: string;
  email?: string | null;
  planType?: string | null;
}

export interface AppServerAccountRead {
  account: AppServerAccount | null;
  requiresOpenaiAuth: boolean;
}

export interface AppServerRateLimitWindow {
  usedPercent: number;
  resetsAt: number | null;
  windowDurationMins: number | null;
}

export interface AppServerRateLimits {
  primary: AppServerRateLimitWindow | null;
  secondary: AppServerRateLimitWindow | null;
  planType: string | null;
}

export interface AppServerRateLimitsRead {
  rateLimits: AppServerRateLimits;
}

export interface AppServerThreadRef {
  id: string;
  path: string | null;
}

export interface AppServerNotification {
  method: string;
  params: unknown;
}

export interface AppServerRequest {
  id: string | number;
  method: string;
  params: unknown;
}

export interface CodexAppServerLifecycleEvent {
  type: "failed" | "closed" | "reaped";
  error?: CodexAppServerError;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;
const MAX_STDOUT_BUFFER_BYTES = 1024 * 1024;
const defaultClock: CodexAppServerClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

function spawnCodexAppServer(home: string): CodexAppServerChild {
  const child = spawn(process.env.LLV_CODEX_BINARY || "codex", ["-c", "cli_auth_credentials_store=file", "app-server"], {
    env: { ...process.env, CODEX_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return child;
}

/** Errors crossing the app-server boundary are deliberately safe for logs and routes. */
export class CodexAppServerError extends Error {
  constructor(message: string) {
    super(redactAppServerDetail(message));
    this.name = "CodexAppServerError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function protocolError(message: string): CodexAppServerError {
  return new CodexAppServerError(`Codex app-server protocol error: ${message}`);
}

function serverError(value: { code: number; message: string }): CodexAppServerError {
  const message = value.message;
  return new CodexAppServerError(`Codex app-server request failed: ${message}`);
}

function requiredString(value: Record<string, unknown>, key: string, method: string): string {
  if (typeof value[key] !== "string" || !value[key]) throw protocolError(`${method} response is missing ${key}`);
  return value[key] as string;
}

function optionalWindow(value: unknown, method: string): AppServerRateLimitWindow | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || typeof value.usedPercent !== "number" || !Number.isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100) throw protocolError(`${method} response has an invalid rate-limit window`);
  const resetsAt = value.resetsAt;
  const windowDurationMins = value.windowDurationMins;
  if (resetsAt !== null && resetsAt !== undefined && (typeof resetsAt !== "number" || !Number.isInteger(resetsAt) || resetsAt < 0)) {
    throw protocolError(`${method} response has an invalid reset timestamp`);
  }
  if (windowDurationMins !== null && windowDurationMins !== undefined && (typeof windowDurationMins !== "number" || !Number.isInteger(windowDurationMins) || windowDurationMins < 0)) {
    throw protocolError(`${method} response has an invalid window duration`);
  }
  return {
    usedPercent: value.usedPercent,
    resetsAt: typeof resetsAt === "number" ? resetsAt : null,
    windowDurationMins: typeof windowDurationMins === "number" ? windowDurationMins : null,
  };
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Small JSON-RPC owner for one `codex app-server` stdio child. The rest of the
 * account layer only sees account methods and never handles framing or pids.
 */
export class CodexAppServerClient {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Set<(notification: AppServerNotification) => void>();
  private readonly requestListeners = new Set<(request: AppServerRequest) => unknown | Promise<unknown>>();
  private readonly lifecycleListeners = new Set<(event: CodexAppServerLifecycleEvent) => void>();
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrTail = "";
  private lastInboundEnvelope: AppServerEnvelope | null = null;
  private closed = false;
  private reaped = false;
  private shutdownTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    private readonly child: CodexAppServerChild,
    private readonly clock: CodexAppServerClock,
    private readonly requestTimeoutMs: number,
    private readonly shutdownGraceMs: number,
  ) {
    child.stdout.on("data", (chunk: Buffer | string) => this.acceptStdout(String(chunk)));
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.stderrTail = redactAppServerDetail((this.stderrTail + String(chunk)).slice(-2_000));
    });
    child.on("error", (error) => this.fail(new CodexAppServerError(`Codex app-server child error: ${error.message}`)));
    child.on("close", (code, signal) => {
      this.reaped = true;
      if (this.shutdownTimer) {
        this.clock.clearTimeout(this.shutdownTimer);
        this.shutdownTimer = null;
      }
      this.emitLifecycle({ type: "reaped" });
      const detail = this.stderrTail ? `: ${this.stderrTail}` : "";
      if (!this.closed) this.fail(new CodexAppServerError(`Codex app-server exited (code ${code ?? "none"}, signal ${signal ?? "none"})${detail}`));
    });
  }

  static async start(options: CodexAppServerOptions): Promise<CodexAppServerClient> {
    const client = new CodexAppServerClient(
      (options.spawn ?? spawnCodexAppServer)(options.home),
      options.clock ?? defaultClock,
      options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
    );
    try {
      const response = await client.request("initialize", {
        clientInfo: { name: "agent-log-viewer", version: "0.11.7" },
        capabilities: { experimentalApi: true },
      });
      if (!isRecord(response)) throw protocolError("initialize response must be an object");
      client.notify("initialized");
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  /** Handles app-server approval and question requests without sacrificing the transport. */
  onRequest(listener: (request: AppServerRequest) => unknown | Promise<unknown>): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  onLifecycle(listener: (event: CodexAppServerLifecycleEvent) => void): () => void {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  inboundEnvelope(): AppServerEnvelope | null {
    return this.lastInboundEnvelope;
  }

  async readAccount(): Promise<AppServerAccountRead> {
    const response = await this.request("account/read", {});
    if (!isRecord(response) || typeof response.requiresOpenaiAuth !== "boolean") throw protocolError("account/read response is malformed");
    if (response.account !== null && response.account !== undefined && !isRecord(response.account)) throw protocolError("account/read response has an invalid account");
    const account = isRecord(response.account) ? {
      ...(typeof response.account.type === "string" ? { type: response.account.type } : {}),
      ...(typeof response.account.email === "string" || response.account.email === null ? { email: response.account.email } : {}),
      ...(typeof response.account.planType === "string" || response.account.planType === null ? { planType: response.account.planType } : {}),
    } : null;
    return { account, requiresOpenaiAuth: response.requiresOpenaiAuth };
  }

  async startDeviceLogin(): Promise<DeviceCodeChallenge> {
    const response = await this.request("account/login/start", { type: "chatgptDeviceCode" });
    if (!isRecord(response) || response.type !== "chatgptDeviceCode") throw protocolError("account/login/start response has an unexpected type");
    return {
      loginId: requiredString(response, "loginId", "account/login/start"),
      verificationUrl: requiredString(response, "verificationUrl", "account/login/start"),
      userCode: requiredString(response, "userCode", "account/login/start"),
    };
  }

  async cancelLogin(loginId: string): Promise<"canceled" | "notFound"> {
    const response = await this.request("account/login/cancel", { loginId });
    if (!isRecord(response) || (response.status !== "canceled" && response.status !== "notFound")) {
      throw protocolError("account/login/cancel response is malformed");
    }
    return response.status;
  }

  async readRateLimits(): Promise<AppServerRateLimitsRead> {
    const response = await this.request("account/rateLimits/read");
    if (!isRecord(response) || !isRecord(response.rateLimits)) throw protocolError("account/rateLimits/read response is malformed");
    const snapshot = response.rateLimits;
    return {
      rateLimits: {
        primary: optionalWindow(snapshot.primary, "account/rateLimits/read"),
        secondary: optionalWindow(snapshot.secondary, "account/rateLimits/read"),
        planType: typeof snapshot.planType === "string" ? snapshot.planType : null,
      },
    };
  }

  async forkThread(threadId: string): Promise<AppServerThreadRef> {
    const response = await this.request("thread/fork", { threadId });
    const thread = isRecord(response) && isRecord(response.thread) ? response.thread : response;
    if (!isRecord(thread)) throw protocolError("thread/fork response is malformed");
    return {
      id: requiredString(thread, "id", "thread/fork"),
      path: typeof thread.path === "string" ? thread.path : null,
    };
  }

  async resumeThread(threadId: string, options: {
    path?: string | null;
    cwd?: string;
    model?: string | null;
    effort?: string | null;
    fast?: boolean | null;
    approvalPolicy?: string | null;
    sandbox?: string | null;
  } = {}): Promise<AppServerThreadRef> {
    const response = await this.request("thread/resume", {
      threadId,
      ...(options.path ? { path: options.path } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.fast != null ? { serviceTier: options.fast ? "priority" : "standard" } : {}),
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
      ...(options.sandbox ? { sandbox: options.sandbox } : {}),
      ...(options.effort ? { config: { model_reasoning_effort: options.effort } } : {}),
    });
    const thread = isRecord(response) && isRecord(response.thread) ? response.thread : response;
    if (!isRecord(thread)) throw protocolError("thread/resume response is malformed");
    return { id: requiredString(thread, "id", "thread/resume"), path: typeof thread.path === "string" ? thread.path : null };
  }

  async readThread(threadId: string): Promise<AppServerThreadRef> {
    const response = await this.request("thread/read", { threadId, includeTurns: true });
    const thread = isRecord(response) && isRecord(response.thread) ? response.thread : response;
    if (!isRecord(thread)) throw protocolError("thread/read response is malformed");
    return { id: requiredString(thread, "id", "thread/read"), path: typeof thread.path === "string" ? thread.path : null };
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.request("thread/name/set", { threadId, name });
  }

  async setThreadGoal(threadId: string, objective: string, status?: "active" | "complete" | "blocked"): Promise<void> {
    await this.request("thread/goal/set", { threadId, objective, ...(status ? { status } : {}) });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      this.clock.clearTimeout(pending.timeout);
      pending.reject(new CodexAppServerError("Codex app-server client closed"));
    }
    this.pending.clear();
    this.beginShutdown();
    this.emitLifecycle({ type: "closed" });
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new CodexAppServerError("Codex app-server client is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = this.clock.setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        const error = new CodexAppServerError(`Codex app-server request timed out: ${method}`);
        reject(error);
        // A timed-out JSON-RPC id cannot be safely correlated with a later reply.
        // Reap the whole stdio transport so a late response cannot affect a new call.
        this.fail(error);
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout });
      try {
        this.write({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
      } catch (error) {
        this.pending.delete(id);
        this.clock.clearTimeout(timeout);
        reject(error instanceof Error ? error : new CodexAppServerError(String(error)));
      }
    });
  }

  private write(message: Record<string, unknown>): void {
    try {
      this.child.stdin.write(JSON.stringify(message) + "\n");
    } catch (error) {
      throw new CodexAppServerError(`could not write to Codex app-server: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private acceptStdout(chunk: string): void {
    if (this.closed) return;
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const rawLine = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(rawLine, "utf8") > MAX_STDOUT_BUFFER_BYTES) {
        this.fail(protocolError("received an oversized JSONL line"));
        return;
      }
      const line = rawLine.trim();
      if (line) this.acceptMessage(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_STDOUT_BUFFER_BYTES) {
      this.fail(protocolError("received an oversized unterminated JSONL line"));
    }
  }

  private acceptMessage(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.fail(protocolError("received malformed JSON"));
      return;
    }
    let parsed;
    try {
      parsed = parseAppServerMessage(message);
    } catch (error) {
      const detail = error instanceof CodexAppServerProtocolError ? error.message : "received malformed JSON-RPC";
      this.fail(new CodexAppServerError(detail));
      return;
    }
    this.lastInboundEnvelope = parsed.envelope;
    if (parsed.kind === "request") {
        const listener = this.requestListeners.values().next().value as ((request: AppServerRequest) => unknown | Promise<unknown>) | undefined;
        if (!listener) {
          console.warn(`[codex app-server] rejected unhandled server request ${parsed.method}`);
          this.write({ jsonrpc: "2.0", id: parsed.id, error: { code: -32601, message: "Viewer has no handler for this request" } });
          return;
        }
        // Requests have one response owner. Additional listeners are observers
        // for notifications and never compete to answer a JSON-RPC request.
        Promise.resolve(listener({ id: parsed.id, method: parsed.method, params: parsed.params }))
          .then((result) => this.write({ jsonrpc: "2.0", id: parsed.id, result: result ?? {} }))
          .catch((error) => this.write({ jsonrpc: "2.0", id: parsed.id, error: { code: -32000, message: redactAppServerDetail(error instanceof Error ? error.message : "request handler failed") } }));
        return;
    }
    if (parsed.kind === "notification") {
      const notification = { method: parsed.method, params: parsed.params };
      for (const listener of this.notificationListeners) {
        try { listener(notification); } catch { /* one consumer cannot break the transport */ }
      }
      return;
    }
    const id: AppServerRequestId = parsed.id;
    if (typeof id !== "number") {
      this.fail(protocolError("response has an invalid id"));
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      this.fail(protocolError(`response id ${id} has no matching request`));
      return;
    }
    this.pending.delete(id);
    this.clock.clearTimeout(pending.timeout);
    if (parsed.error) pending.reject(serverError(parsed.error));
    else pending.resolve(parsed.result);
  }

  private fail(error: CodexAppServerError): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      this.clock.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.beginShutdown();
    this.emitLifecycle({ type: "failed", error });
  }

  private beginShutdown(): void {
    try { this.child.stdin.end(); } catch { /* child already ended */ }
    try { this.child.kill("SIGTERM"); } catch { /* child already exited */ }
    if (!this.reaped && !this.shutdownTimer) {
      this.shutdownTimer = this.clock.setTimeout(() => {
        this.shutdownTimer = null;
        if (this.reaped) return;
        try { this.child.kill("SIGKILL"); } catch { /* child already exited */ }
      }, this.shutdownGraceMs);
    }
  }

  private emitLifecycle(event: CodexAppServerLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) {
      try { listener(event); } catch { /* lifecycle consumers cannot break the transport */ }
    }
  }
}
