import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { procBackend } from "@/lib/proc";

import type {
  DeliveryReceipt,
  EngineHost,
  HostState,
  QueueEntry,
  RuntimeEvent,
} from "./engineHost";
import { RuntimeReplayGapError } from "./engineHost";
import { FileRuntimeEventStore, type RuntimeEventStore } from "./eventStore";

type JsonObject = Record<string, unknown>;
type PendingRpc = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
type Subscriber = {
  afterSeq: number;
  queue: RuntimeEvent[];
  wake: (() => void) | null;
  closed: boolean;
};
type PendingAttention = { rpcId: string | number; method: string };
type UnsequencedEvent = RuntimeEvent extends infer Event
  ? Event extends RuntimeEvent ? Omit<Event, "seq"> : never
  : never;

export interface CodexAppServerHostOptions {
  cwd: string;
  codexHome?: string;
  binary?: string;
  model?: string;
  effort?: string;
  sandbox?: string;
  approvalPolicy?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  shutdownGraceMs?: number;
  initialEventCursor?: number;
  spawnProcess?: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
  eventStore?: RuntimeEventStore;
}

export interface CodexThreadIdentity {
  threadId: string;
  path: string | null;
}

const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;
const MAX_LINE_BYTES = 4 * 1024 * 1024;

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function stringField(value: unknown, key: string): string | null {
  const object = record(value);
  return object && typeof object[key] === "string" ? object[key] as string : null;
}

function safeError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(["']?(?:access|refresh|id)[_-]?token["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[REDACTED]")
    .replace(/(["']?(?:api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[REDACTED]")
    .slice(0, 500);
}

function subscriptionEnv(source: NodeJS.ProcessEnv, codexHome?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: source.NODE_ENV };
  for (const name of CHILD_ENV_ALLOWLIST) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  if (codexHome) env.CODEX_HOME = codexHome;
  return env;
}

function threadFromResult(value: unknown, method: string): CodexThreadIdentity {
  const outer = record(value);
  const thread = record(outer?.thread) ?? outer;
  const threadId = stringField(thread, "id");
  if (!threadId) throw new Error(`${method} returned no thread id`);
  return { threadId, path: stringField(thread, "path") };
}

function turnIdFromResult(value: unknown, method: string): string {
  const outer = record(value);
  const turn = record(outer?.turn);
  const turnId = stringField(turn, "id") ?? stringField(outer, "turnId");
  if (!turnId) throw new Error(`${method} returned no turn id`);
  return turnId;
}

function turnIdFromParams(params: JsonObject): string | null {
  return stringField(params.turn, "id") ?? stringField(params, "turnId");
}

function protocolVersionFromInitialize(value: JsonObject | null): string | null {
  const direct = stringField(value, "appServerVersion")
    ?? stringField(value, "serverVersion")
    ?? stringField(value, "version");
  if (direct) return direct;
  return stringField(value, "userAgent")?.match(/^[^/]+\/([^\s]+)/)?.[1] ?? null;
}

function terminalStatus(value: unknown): "completed" | "interrupted" | "error" {
  return value === "completed" ? "completed" : value === "interrupted" ? "interrupted" : "error";
}

function resumedTurns(value: unknown): JsonObject[] {
  const outer = record(value);
  const thread = record(outer?.thread) ?? outer;
  if (Array.isArray(thread?.turns)) return thread.turns.map(record).filter((turn): turn is JsonObject => turn !== null);
  const page = record(thread?.initialTurnsPage);
  return Array.isArray(page?.data) ? page.data.map(record).filter((turn): turn is JsonObject => turn !== null) : [];
}

/** One stdio app-server owner with replayable, multi-subscriber event fan-out. */
export class CodexAppServerHost implements EngineHost {
  readonly identity: CodexThreadIdentity;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly requestTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private readonly eventStore: RuntimeEventStore;
  private readonly pending = new Map<number, PendingRpc>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly events: RuntimeEvent[] = [];
  private readonly attentions = new Map<string, PendingAttention>();
  private readonly stateListeners = new Set<(state: HostState) => void>();
  private readonly preIdentityEvents: UnsequencedEvent[] = [];
  private nextRpcId = 1;
  private stdoutBuffer = "";
  private cursor: number;
  private activeTurnId: string | null = null;
  private protocolVersion: string | null = null;
  private account: HostState["account"] = null;
  private releasing = false;
  private released = false;
  private dead = false;
  private reaped = false;
  private terminationStarted = false;
  private terminationTimer: ReturnType<typeof setTimeout> | null = null;
  private releasePromise: Promise<void> | null = null;
  private readonly reapedPromise: Promise<void>;
  private resolveReaped!: () => void;

  private constructor(child: ChildProcessWithoutNullStreams, identity: CodexThreadIdentity, options: CodexAppServerHostOptions) {
    this.child = child;
    this.identity = identity;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.eventStore = options.eventStore ?? new FileRuntimeEventStore();
    this.cursor = options.initialEventCursor ?? 0;
    this.reapedPromise = new Promise((resolve) => { this.resolveReaped = resolve; });
    child.stdout.on("data", (chunk: Buffer | string) => this.acceptStdout(String(chunk)));
    child.stderr.on("data", () => { /* stderr can contain authentication details; keep it out of output */ });
    child.on("error", (error) => this.fail(new Error(`Codex app-server child failed: ${safeError(error)}`)));
    child.on("close", () => {
      this.reaped = true;
      if (this.terminationTimer) {
        clearTimeout(this.terminationTimer);
        this.terminationTimer = null;
      }
      this.resolveReaped();
      if (!this.releasing && !this.released) {
        if (this.dead) this.notifyStateListeners();
        else this.fail(new Error("Codex app-server child exited"));
      }
    });
  }

  static async start(options: CodexAppServerHostOptions): Promise<CodexAppServerHost> {
    return this.open(options, null);
  }

  static async adopt(threadId: string, options: CodexAppServerHostOptions): Promise<CodexAppServerHost> {
    if (!threadId) throw new Error("Codex thread id is required for adoption");
    return this.open(options, threadId);
  }

  private static async open(options: CodexAppServerHostOptions, threadId: string | null): Promise<CodexAppServerHost> {
    const spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) =>
      spawn(command, args, { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] }));
    const child = spawnProcess(options.binary ?? process.env.LLV_CODEX_BINARY ?? "codex", ["app-server"], {
      cwd: options.cwd,
      env: subscriptionEnv(options.env ?? process.env, options.codexHome),
    });
    const provisional = new CodexAppServerHost(child, { threadId: threadId ?? "pending", path: null }, options);
    try {
      const initialized = record(await provisional.rpc("initialize", {
        clientInfo: { name: "llv-structured-host", title: "Live Log Viewer", version: "0.11.7" },
        capabilities: { experimentalApi: true },
      }));
      provisional.protocolVersion = protocolVersionFromInitialize(initialized);
      provisional.notify("initialized", {});
      const accountResult = record(await provisional.rpc("account/read", { refreshToken: false }));
      const account = record(accountResult?.account);
      const accountType = stringField(account, "type");
      if (accountType !== "chatgpt") throw new Error("Codex app-server requires a ChatGPT subscription login");
      provisional.account = { type: accountType, planType: stringField(account, "planType") };
      const result = threadId
        ? await provisional.rpc("thread/resume", { threadId })
        : await provisional.rpc("thread/start", {
          cwd: options.cwd,
          ...(options.model ? { model: options.model } : {}),
          sandbox: options.sandbox ?? "read-only",
          approvalPolicy: options.approvalPolicy ?? "never",
        });
      const identity = threadFromResult(result, threadId ? "thread/resume" : "thread/start");
      if (threadId && identity.threadId !== threadId) {
        throw new Error("thread/resume returned a different thread id");
      }
      provisional.identity.threadId = identity.threadId;
      provisional.identity.path = identity.path;
      const restored = provisional.restoreEvents();
      if (threadId && restored === 0) provisional.restoreThreadHistory(result);
      provisional.flushPreIdentityEvents();
      provisional.emit({ kind: "session-status", status: "idle" });
      return provisional;
    } catch (error) {
      await provisional.release();
      throw new Error(safeError(error));
    }
  }

  attach(afterSeq: number): AsyncIterable<RuntimeEvent> {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error("afterSeq must be a non-negative integer");
    const subscriber: Subscriber = { afterSeq, queue: [], wake: null, closed: false };
    const firstAvailable = this.events[0]?.seq;
    if (firstAvailable !== undefined && afterSeq + 1 < firstAvailable) {
      throw new RuntimeReplayGapError(afterSeq, firstAvailable);
    }
    for (const event of this.events) if (event.seq > afterSeq) subscriber.queue.push(event);
    this.subscribers.add(subscriber);
    const subscribers = this.subscribers;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (!subscriber.closed) {
            const event = subscriber.queue.shift();
            if (event) {
              if (event.seq > subscriber.afterSeq) {
                subscriber.afterSeq = event.seq;
                yield event;
              }
              continue;
            }
            await new Promise<void>((resolve) => { subscriber.wake = resolve; });
            subscriber.wake = null;
          }
        } finally {
          subscriber.closed = true;
          subscribers.delete(subscriber);
        }
      },
    };
  }

  async send(entry: QueueEntry): Promise<DeliveryReceipt> {
    if (this.dead || this.releasing || this.released) return { outcome: "rejected", reason: "dead-host" };
    if (!entry.id || !entry.text) throw new Error("queue entry id and text are required");
    const currentTurn = this.activeTurnId;
    if (entry.expectedTurnId !== undefined && entry.expectedTurnId !== currentTurn) {
      return { outcome: "rejected", reason: "stale-turn" };
    }
    const input = [{ type: "text", text: entry.text }];
    if (currentTurn) {
      try {
        const result = await this.rpc("turn/steer", {
          threadId: this.identity.threadId,
          expectedTurnId: currentTurn,
          input,
          clientUserMessageId: entry.id,
        });
        return { outcome: "steered", turnId: turnIdFromResult(result, "turn/steer") };
      } catch (error) {
        if (/expectedTurnId|active turn|stale/i.test(safeError(error))) {
          return { outcome: "rejected", reason: "stale-turn" };
        }
        throw error;
      }
    }
    const result = await this.rpc("turn/start", {
      threadId: this.identity.threadId,
      input,
      clientUserMessageId: entry.id,
    });
    const turnId = turnIdFromResult(result, "turn/start");
    this.activeTurnId = turnId;
    this.notifyStateListeners();
    return { outcome: "turn-started", turnId };
  }

  async interrupt(turnRef: string): Promise<void> {
    if (this.dead || this.releasing || this.released) throw new Error("Codex app-server host is unavailable");
    if (!turnRef || this.activeTurnId !== turnRef) throw new Error("active turn fence is stale");
    await this.rpc("turn/interrupt", { threadId: this.identity.threadId, turnId: turnRef });
  }

  async answer(attentionRef: string, value: unknown): Promise<void> {
    if (this.dead || this.releasing || this.released) throw new Error("Codex app-server host is unavailable");
    const attention = this.attentions.get(attentionRef);
    if (!attention) throw new Error("attention request is missing or already answered");
    this.write({ jsonrpc: "2.0", id: attention.rpcId, result: value ?? {} });
    this.attentions.delete(attentionRef);
    this.notifyStateListeners();
  }

  async health(): Promise<HostState> {
    return this.currentState();
  }

  onStateChange(listener: (state: HostState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.currentState());
    return () => this.stateListeners.delete(listener);
  }

  private currentState(): HostState {
    const pid = this.reaped || this.released ? null : this.child.pid ?? null;
    const processStartIdentity = pid ? procBackend.processIdentity(pid) : null;
    const status: HostState["status"] = this.dead ? "dead"
      : this.released ? "unhosted"
      : this.attentions.size > 0 ? "attention"
      : this.activeTurnId ? "active"
      : "idle";
    return {
      status,
      sessionKey: this.identity.threadId,
      endpoint: pid ? `stdio:${pid}` : "stdio:released",
      pid,
      processStartIdentity,
      eventCursor: this.cursor,
      protocolVersion: this.protocolVersion,
      activeTurnRef: this.activeTurnId,
      pendingAttention: [...this.attentions.keys()],
      account: this.account,
    };
  }

  async release(): Promise<void> {
    this.releasePromise ??= this.releaseAndReap();
    return this.releasePromise;
  }

  private async releaseAndReap(): Promise<void> {
    this.releasing = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Codex app-server host released"));
    }
    this.pending.clear();
    this.closeSubscribers();
    this.startTermination();
    if (!await this.waitForReap(this.shutdownGraceMs)) {
      try { this.child.kill("SIGKILL"); } catch { /* already closed */ }
      if (!await this.waitForReap(this.shutdownGraceMs)) {
        throw new Error("Codex app-server child could not be reaped");
      }
    }
    this.released = true;
    this.releasing = false;
    this.activeTurnId = null;
    this.attentions.clear();
    this.emit({ kind: "session-status", status: "unhosted" });
  }

  private startTermination(): void {
    if (this.terminationStarted || this.reaped) return;
    this.terminationStarted = true;
    try { this.child.stdin.end(); } catch { /* already closed */ }
    try { this.child.kill("SIGTERM"); } catch { /* already closed */ }
    this.terminationTimer = setTimeout(() => {
      this.terminationTimer = null;
      if (this.reaped) return;
      try { this.child.kill("SIGKILL"); } catch { /* already closed */ }
    }, this.shutdownGraceMs);
  }

  private async waitForReap(timeoutMs: number): Promise<boolean> {
    if (this.reaped) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.reapedPromise.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private emit(event: UnsequencedEvent): void {
    if (this.identity.threadId === "pending") {
      this.preIdentityEvents.push(event);
      return;
    }
    const sequenced = { ...event, seq: ++this.cursor } as RuntimeEvent;
    try {
      this.eventStore.append(this.identity.threadId, sequenced);
    } catch (error) {
      this.startTermination();
      throw error;
    }
    this.events.push(sequenced);
    for (const subscriber of this.subscribers) {
      subscriber.queue.push(sequenced);
      subscriber.wake?.();
    }
    this.notifyStateListeners();
  }

  private restoreEvents(): number {
    const stored = this.eventStore.load(this.identity.threadId);
    this.events.splice(0, this.events.length, ...stored);
    this.cursor = Math.max(this.cursor, stored.at(-1)?.seq ?? 0);
    return stored.length;
  }

  private restoreThreadHistory(result: unknown): void {
    for (const turn of resumedTurns(result)) {
      const turnId = stringField(turn, "id");
      if (!turnId) continue;
      this.activeTurnId = turnId;
      this.emit({ kind: "turn-started", turnId });
      if (Array.isArray(turn.items)) {
        for (const item of turn.items) this.emit({ kind: "item", turnId, item, phase: "completed" });
      }
      const status = stringField(turn, "status");
      if (status === "completed" || status === "interrupted" || status === "failed" || status === "error") {
        this.activeTurnId = null;
        this.emit({ kind: "turn-ended", turnId, status: terminalStatus(status) });
      }
    }
  }

  private flushPreIdentityEvents(): void {
    for (const event of this.preIdentityEvents.splice(0)) this.emit(event);
  }

  private notifyStateListeners(): void {
    const state = this.currentState();
    for (const listener of this.stateListeners) listener(state);
  }

  private closeSubscribers(): void {
    for (const subscriber of this.subscribers) {
      subscriber.closed = true;
      subscriber.wake?.();
    }
    this.subscribers.clear();
  }

  private rpc(method: string, params: JsonObject = {}): Promise<unknown> {
    if (this.dead || this.releasing || this.released) return Promise.reject(new Error("Codex app-server host is unavailable"));
    const id = this.nextRpcId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: JsonObject): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: JsonObject): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private acceptStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        this.fail(new Error("Codex app-server emitted an oversized JSONL frame"));
        return;
      }
      if (line) this.acceptMessage(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.stdoutBuffer) > MAX_LINE_BYTES) this.fail(new Error("Codex app-server emitted an oversized JSONL frame"));
  }

  private acceptMessage(line: string): void {
    let message: JsonObject | null;
    try { message = record(JSON.parse(line)); } catch { message = null; }
    if (!message) {
      this.fail(new Error("Codex app-server emitted malformed JSON-RPC"));
      return;
    }
    const id = message.id;
    const method = typeof message.method === "string" ? message.method : null;
    if ((typeof id === "number" || typeof id === "string") && !method) {
      if (typeof id !== "number") return this.fail(new Error("Codex app-server response id is invalid"));
      const pending = this.pending.get(id);
      if (!pending) return this.fail(new Error("Codex app-server response has no matching request"));
      this.pending.delete(id);
      clearTimeout(pending.timer);
      const error = record(message.error);
      if (error) pending.reject(new Error(`Codex app-server request failed: ${safeError(error.message ?? "unknown error")}`));
      else pending.resolve(message.result);
      return;
    }
    if (!method) return this.fail(new Error("Codex app-server message has no method"));
    const params = record(message.params) ?? {};
    if (typeof id === "number" || typeof id === "string") {
      const attentionId = `${method}:${String(id)}`;
      this.attentions.set(attentionId, { rpcId: id, method });
      this.emit({ kind: "attention", id: attentionId, method, attention: params });
      return;
    }
    this.acceptNotification(method, params);
  }

  private acceptNotification(method: string, params: JsonObject): void {
    const turnId = turnIdFromParams(params);
    if (method === "turn/started" && turnId) {
      this.activeTurnId = turnId;
      this.emit({ kind: "turn-started", turnId });
      return;
    }
    if (method === "item/agentMessage/delta") {
      this.emit({ kind: "delta", turnId: turnId ?? this.activeTurnId ?? "unknown", text: stringField(params, "delta") ?? "" });
      return;
    }
    if ((method === "item/started" || method === "item/completed") && "item" in params) {
      this.emit({ kind: "item", turnId: turnId ?? this.activeTurnId, item: params.item, phase: method === "item/started" ? "started" : "completed" });
      return;
    }
    if (method === "turn/completed" && turnId) {
      this.activeTurnId = null;
      const turn = record(params.turn);
      this.emit({ kind: "turn-ended", turnId, status: terminalStatus(turn?.status) });
      return;
    }
    if (method === "account/rateLimits/updated") {
      this.emit({ kind: "limits", snapshot: params });
      return;
    }
    if (method === "thread/status/changed") {
      const status = stringField(params, "status") ?? stringField(record(params.thread), "status");
      this.emit({ kind: "session-status", status: status === "active" ? "active" : "idle" });
    }
  }

  private fail(error: Error): void {
    if (this.dead || this.released) return;
    this.dead = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(safeError(error)));
    }
    this.pending.clear();
    this.emit({ kind: "session-status", status: "dead" });
    this.closeSubscribers();
    this.startTermination();
  }
}
