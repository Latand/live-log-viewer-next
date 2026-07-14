import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { procBackend } from "@/lib/proc";
import { signalDetachedProcessGroup, signalProcessGroup, type ProcessSignal } from "@/lib/processGroup";
import { headlessCodexThreadConfig } from "@/lib/codexHeadlessConfig";
import { hardenedRedact } from "@/lib/view/compactText";

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
type PendingAnswer = {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
type PendingDelivery = {
  text: string;
  receipt: DeliveryReceipt;
  promise: Promise<DeliveryReceipt>;
  resolve(receipt: DeliveryReceipt): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
type PendingAttention = {
  rpcId: string | number;
  method: string;
  origin: "current" | "restored";
  answer?: PendingAnswer;
};
type ThreadStatus = {
  type: "active" | "idle" | "notLoaded" | "systemError";
  activeFlags: string[];
};
type UnsequencedEvent = RuntimeEvent extends infer Event
  ? Event extends RuntimeEvent ? Omit<Event, "seq"> : never
  : never;

export interface CodexAppServerHostOptions {
  cwd: string;
  codexHome?: string;
  binary?: string;
  model?: string;
  effort?: string;
  allowSubagents?: boolean;
  fileAuthCredentials?: boolean;
  sandbox?: string;
  approvalPolicy?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  shutdownGraceMs?: number;
  initialEventCursor?: number;
  spawnProcess?: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
  eventStore?: RuntimeEventStore;
  signalProcess?: ProcessSignal;
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
  "LLV_SPAWN_CAPABILITY",
] as const;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MUTATING_RPC_METHODS = new Set(["thread/start", "thread/resume", "turn/start", "turn/steer", "turn/interrupt"]);

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function stringField(value: unknown, key: string): string | null {
  const object = record(value);
  return object && typeof object[key] === "string" ? object[key] as string : null;
}

export function redactCodexHostDiagnostic(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return hardenedRedact(message)
    .replace(/(["']?(?:cookie|set-cookie)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[redacted]")
    .slice(0, 500);
}

const safeError = redactCodexHostDiagnostic;

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

function resumedActiveTurnId(value: unknown): string | null {
  const activeTurn = resumedTurns(value).findLast((turn) => stringField(turn, "status") === "inProgress");
  return activeTurn ? stringField(activeTurn, "id") : null;
}

function itemReplayKey(value: unknown): string {
  const id = stringField(value, "id");
  if (id) return `id:${id}`;
  return `json:${JSON.stringify(value)}`;
}

function userMessageText(value: JsonObject): string | null {
  const direct = stringField(value, "text");
  if (direct !== null) return direct;
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return null;
  const parts: string[] = [];
  for (const part of value.content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    const text = stringField(part, "text") ?? stringField(part, "content");
    if (text !== null) parts.push(text);
  }
  return parts.length > 0 ? parts.join("") : null;
}

function threadStatus(value: unknown): ThreadStatus | null {
  const outer = record(value);
  const thread = record(outer?.thread);
  const status = record(outer?.status) ?? record(thread?.status);
  const type = stringField(status, "type");
  if (type !== "active" && type !== "idle" && type !== "notLoaded" && type !== "systemError") return null;
  const activeFlags = Array.isArray(status?.activeFlags)
    ? status.activeFlags.filter((flag): flag is string => typeof flag === "string")
    : [];
  return { type, activeFlags };
}

/** One stdio app-server owner with replayable, multi-subscriber event fan-out. */
export class CodexAppServerHost implements EngineHost {
  readonly identity: CodexThreadIdentity;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly requestTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private readonly eventStore: RuntimeEventStore;
  private readonly effort: string | undefined;
  private readonly signalProcess: ProcessSignal;
  private readonly pending = new Map<number, PendingRpc>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly events: RuntimeEvent[] = [];
  private readonly confirmedDeliveries = new Map<string, { receipt: DeliveryReceipt; text: string | null }>();
  private readonly pendingDeliveries = new Map<string, PendingDelivery>();
  private readonly attentions = new Map<string, PendingAttention>();
  private readonly stateListeners = new Set<(state: HostState) => void>();
  private readonly preIdentityEvents: UnsequencedEvent[] = [];
  private nextRpcId = 1;
  private stdoutBuffer = "";
  private cursor: number;
  private activeTurnId: string | null = null;
  private protocolVersion: string | null = null;
  private account: HostState["account"] = null;
  private engineStatus: "active" | "idle" | "unhosted" | "dead" = "idle";
  private activeFlags: string[] = [];
  private releasing = false;
  private released = false;
  private dead = false;
  private reaped = false;
  private terminationStarted = false;
  private terminationTimer: ReturnType<typeof setTimeout> | null = null;
  private releasePromise: Promise<void> | null = null;
  private writerFence: (() => boolean) | null = null;
  private ledgerFailed = false;
  private failure: Error | null = null;
  private readonly reapedPromise: Promise<void>;
  private resolveReaped!: () => void;

  private constructor(child: ChildProcessWithoutNullStreams, identity: CodexThreadIdentity, options: CodexAppServerHostOptions) {
    this.child = child;
    this.identity = identity;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.eventStore = options.eventStore ?? new FileRuntimeEventStore();
    this.effort = options.effort;
    this.signalProcess = options.signalProcess ?? process.kill;
    this.cursor = options.initialEventCursor ?? 0;
    this.reapedPromise = new Promise((resolve) => { this.resolveReaped = resolve; });
    child.stdout.on("data", (chunk: Buffer | string) => this.acceptStdout(String(chunk)));
    child.stderr.on("data", () => { /* stderr can contain authentication details; keep it out of output */ });
    child.stdin.on("error", (error) => {
      if (!this.releasing && !this.released) this.fail(new Error(`Codex app-server stdin failed: ${safeError(error)}`));
    });
    child.on("error", (error) => this.fail(new Error(`Codex app-server child failed: ${safeError(error)}`)));
    child.on("close", () => {
      this.reaped = true;
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
    const args = [
      ...(options.fileAuthCredentials ? ["-c", "cli_auth_credentials_store=file"] : []),
      "-c",
      "mcp_servers={}",
      "app-server",
    ];
    const child = spawnProcess(options.binary ?? process.env.LLV_CODEX_BINARY ?? "codex", args, {
      cwd: options.cwd,
      env: subscriptionEnv(options.env ?? process.env, options.codexHome),
      detached: true,
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
      const config = headlessCodexThreadConfig(
        await provisional.rpc("config/read", { cwd: options.cwd, includeLayers: false }),
        options.allowSubagents === true,
      );
      const result = threadId
        ? await provisional.rpc("thread/resume", { threadId, config })
        : await provisional.rpc("thread/start", {
          cwd: options.cwd,
          ...(options.model ? { model: options.model } : {}),
          sandbox: options.sandbox ?? "read-only",
          approvalPolicy: options.approvalPolicy ?? "never",
          config,
        });
      const identity = threadFromResult(result, threadId ? "thread/resume" : "thread/start");
      if (threadId && identity.threadId !== threadId) {
        throw new Error("thread/resume returned a different thread id");
      }
      provisional.identity.threadId = identity.threadId;
      provisional.identity.path = identity.path;
      provisional.rememberConfirmedDeliveries(result);
      provisional.restoreEvents();
      if (threadId) provisional.reconcileThreadHistory(result);
      provisional.flushPreIdentityEvents();
      provisional.reconcileAfterOpen(threadStatus(result), resumedActiveTurnId(result));
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
          while (true) {
            const event = subscriber.queue.shift();
            if (event) {
              if (event.seq > subscriber.afterSeq) {
                subscriber.afterSeq = event.seq;
                yield event;
              }
              continue;
            }
            if (subscriber.closed) break;
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
    if (this.dead || this.releasing || this.released || !this.writerFenceAllowsActuation()) {
      return { outcome: "rejected", reason: "dead-host" };
    }
    if (!entry.id || !entry.text) throw new Error("queue entry id and text are required");
    const confirmed = await this.confirmedDelivery(entry);
    if (confirmed) return confirmed;
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
        return this.awaitDeliveryConfirmation(entry, {
          outcome: "steered",
          turnId: turnIdFromResult(result, "turn/steer"),
        });
      } catch (error) {
        if (/expectedTurnId|active turn|stale/i.test(safeError(error))) {
          return { outcome: "rejected", reason: "stale-turn" };
        }
        throw error;
      }
    }
    const result = await this.rpc("turn/start", {
      threadId: this.identity.threadId,
      ...(this.effort ? { effort: this.effort } : {}),
      input,
      clientUserMessageId: entry.id,
    });
    const turnId = turnIdFromResult(result, "turn/start");
    this.activeTurnId = turnId;
    this.notifyStateListeners();
    return this.awaitDeliveryConfirmation(entry, { outcome: "turn-started", turnId });
  }

  async interrupt(turnRef: string): Promise<void> {
    if (this.dead || this.releasing || this.released || !this.writerFenceAllowsActuation()) {
      throw new Error("Codex app-server host is unavailable");
    }
    if (!turnRef || this.activeTurnId !== turnRef) throw new Error("active turn fence is stale");
    await this.rpc("turn/interrupt", { threadId: this.identity.threadId, turnId: turnRef });
  }

  async answer(attentionRef: string, value: unknown): Promise<void> {
    if (this.dead || this.releasing || this.released || !this.writerFenceAllowsActuation()) {
      throw new Error("Codex app-server host is unavailable");
    }
    const attention = this.attentions.get(attentionRef);
    if (!attention) throw new Error("attention request is missing or already answered");
    if (attention.answer) throw new Error("attention answer is already awaiting confirmation");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        attention.answer = undefined;
        const error = new Error("attention answer timed out; outcome is uncertain");
        reject(error);
        this.fail(error);
      }, this.requestTimeoutMs);
      attention.answer = { resolve, reject, timer };
      this.write({ jsonrpc: "2.0", id: attention.rpcId, result: value ?? {} });
    });
  }

  async health(): Promise<HostState> {
    return this.currentState();
  }

  onStateChange(listener: (state: HostState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.currentState());
    return () => this.stateListeners.delete(listener);
  }

  setWriterFence(fence: () => boolean): void {
    this.writerFence = fence;
  }

  private writerFenceAllowsActuation(): boolean {
    try { return this.writerFence?.() ?? true; }
    catch { return false; }
  }

  private currentState(): HostState {
    const pid = this.reaped || this.released ? null : this.child.pid ?? null;
    const processStartIdentity = pid ? procBackend.processIdentity(pid) : null;
    const status: HostState["status"] = this.dead ? "dead"
      : this.released ? "unhosted"
      : this.attentions.size > 0 ? "attention"
      : this.activeTurnId ? "active"
      : this.engineStatus;
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
      activeFlags: [...this.activeFlags],
      account: this.account,
    };
  }

  async release(): Promise<void> {
    this.releasePromise ??= this.releaseAndReap();
    return this.releasePromise;
  }

  private async releaseAndReap(): Promise<void> {
    this.releasing = true;
    this.rejectPendingAnswers(new Error("Codex app-server host released"));
    this.rejectPendingDeliveries(new Error("Codex app-server host released"));
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Codex app-server host released"));
    }
    this.pending.clear();
    this.startTermination();
    if (!await this.waitForReap(this.shutdownGraceMs)) {
      if (this.reaped) signalProcessGroup(this.child.pid, "SIGKILL", this.signalProcess);
      else signalDetachedProcessGroup(this.child, "SIGKILL", this.signalProcess);
      if (!await this.waitForReap(this.shutdownGraceMs)) {
        throw new Error("Codex app-server child could not be reaped");
      }
    }
    this.released = true;
    this.releasing = false;
    this.activeTurnId = null;
    this.attentions.clear();
    this.setSessionStatus("unhosted", []);
    if (this.ledgerFailed) this.notifyStateListeners();
    this.closeSubscribers();
  }

  private startTermination(): void {
    if (this.terminationStarted) return;
    this.terminationStarted = true;
    try { this.child.stdin.end(); } catch { /* already closed */ }
    if (this.reaped) signalProcessGroup(this.child.pid, "SIGTERM", this.signalProcess);
    else signalDetachedProcessGroup(this.child, "SIGTERM", this.signalProcess);
    this.terminationTimer = setTimeout(() => {
      this.terminationTimer = null;
      if (this.reaped) signalProcessGroup(this.child.pid, "SIGKILL", this.signalProcess);
      else signalDetachedProcessGroup(this.child, "SIGKILL", this.signalProcess);
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
    if (this.ledgerFailed) return;
    if (this.identity.threadId === "pending") {
      this.preIdentityEvents.push(event);
      return;
    }
    const sequenced = { ...event, seq: ++this.cursor } as RuntimeEvent;
    try {
      this.eventStore.append(this.identity.threadId, sequenced);
    } catch (error) {
      this.ledgerFailed = true;
      this.cursor = this.events.at(-1)?.seq ?? Math.max(0, this.cursor - 1);
      this.failWithoutLedger(new Error(`runtime event ledger failed: ${safeError(error)}`));
      return;
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
    const currentAttentions = new Map([...this.attentions].filter(([, attention]) => attention.origin === "current"));
    this.attentions.clear();
    this.events.splice(0, this.events.length, ...stored);
    this.cursor = Math.max(this.cursor, stored.at(-1)?.seq ?? 0);
    for (const event of stored) {
      if (event.kind === "turn-started") this.activeTurnId = event.turnId;
      if (event.kind === "turn-ended" && event.turnId === this.activeTurnId) this.activeTurnId = null;
      if (event.kind === "attention") {
        this.attentions.set(event.id, { rpcId: "restored", method: event.method, origin: "restored" });
      }
      if (event.kind === "attention-resolved") this.attentions.delete(event.id);
      if (event.kind === "session-status") {
        this.engineStatus = event.status;
        this.activeFlags = [...(event.activeFlags ?? [])];
        if (event.status === "unhosted" || event.status === "dead") {
          this.activeTurnId = null;
          this.attentions.clear();
        }
      }
    }
    for (const [id, attention] of currentAttentions) this.attentions.set(id, attention);
    return stored.length;
  }

  private reconcileAfterOpen(status: ThreadStatus | null, resumedTurnId: string | null): void {
    const resumedStatus = status ?? { type: "idle" as const, activeFlags: [] };
    if (resumedStatus.type === "active" && !resumedTurnId) {
      throw new Error("thread/resume returned active status without an active turn id");
    }
    if (resumedStatus.type === "active" && resumedTurnId && this.activeTurnId !== resumedTurnId) {
      if (this.activeTurnId) this.emit({ kind: "turn-ended", turnId: this.activeTurnId, status: "error" });
      this.activeTurnId = resumedTurnId;
      this.emit({ kind: "turn-started", turnId: resumedTurnId });
    }
    if (this.activeTurnId && resumedStatus.type !== "active") {
      const turnId = this.activeTurnId;
      this.activeTurnId = null;
      this.emit({ kind: "turn-ended", turnId, status: "error" });
    }
    for (const [attentionId, attention] of [...this.attentions]) {
      if (attention.origin !== "restored") continue;
      this.attentions.delete(attentionId);
      this.emit({ kind: "attention-resolved", id: attentionId, resolution: "host-restarted" });
    }
    this.emitThreadStatus(resumedStatus);
  }

  private reconcileThreadHistory(result: unknown): void {
    for (const turn of resumedTurns(result)) {
      const turnId = stringField(turn, "id");
      if (!turnId) continue;
      const turnEvents = this.events.filter((event) => "turnId" in event && event.turnId === turnId);
      const status = stringField(turn, "status");
      const hasStarted = turnEvents.some((event) => event.kind === "turn-started");
      if (!hasStarted || (status === "inProgress" && this.activeTurnId !== turnId)) {
        this.activeTurnId = turnId;
        this.emit({ kind: "turn-started", turnId });
      }
      const completedItems = new Map<string, number>();
      for (const event of turnEvents) {
        if (event.kind !== "item" || event.phase !== "completed") continue;
        const key = itemReplayKey(event.item);
        completedItems.set(key, (completedItems.get(key) ?? 0) + 1);
      }
      if (Array.isArray(turn.items)) {
        for (const item of turn.items) {
          const key = itemReplayKey(item);
          const recorded = completedItems.get(key) ?? 0;
          if (recorded > 0) {
            completedItems.set(key, recorded - 1);
            continue;
          }
          this.emit({ kind: "item", turnId, item, phase: "completed" });
        }
      }
      if (status === "completed" || status === "interrupted" || status === "failed" || status === "error") {
        const authoritativeStatus = terminalStatus(status);
        const recordedTerminal = turnEvents.findLast((event) => event.kind === "turn-ended");
        if (recordedTerminal?.kind !== "turn-ended" || recordedTerminal.status !== authoritativeStatus) {
          this.emit({ kind: "turn-ended", turnId, status: authoritativeStatus });
        }
        if (this.activeTurnId === turnId) this.activeTurnId = null;
      }
    }
  }

  private rememberConfirmedDeliveries(result: unknown): void {
    for (const turn of resumedTurns(result)) {
      const turnId = stringField(turn, "id");
      if (!turnId || !Array.isArray(turn.items)) continue;
      for (const item of turn.items) this.rememberConfirmedDelivery(turnId, item);
    }
  }

  private async confirmedDelivery(entry: QueueEntry): Promise<DeliveryReceipt | null> {
    const known = this.confirmedDeliveries.get(entry.id);
    if (known) return this.confirmedReceipt(entry, known);
    let thread: unknown;
    try {
      thread = await this.rpc("thread/read", { threadId: this.identity.threadId, includeTurns: true });
    } catch (error) {
      const message = safeError(error);
      if (/not materialized yet/i.test(message) && /before first user message/i.test(message)) return null;
      throw error;
    }
    if (this.dead) throw new Error(safeError(this.failure ?? "Codex app-server host is unavailable"));
    this.rememberConfirmedDeliveries(thread);
    const recovered = this.confirmedDeliveries.get(entry.id);
    return recovered ? this.confirmedReceipt(entry, recovered) : null;
  }

  private awaitDeliveryConfirmation(entry: QueueEntry, receipt: DeliveryReceipt): Promise<DeliveryReceipt> {
    const confirmed = this.confirmedDeliveries.get(entry.id);
    if (confirmed) {
      this.confirmedReceipt(entry, confirmed);
      confirmed.receipt = receipt;
      return Promise.resolve(receipt);
    }
    const existing = this.pendingDeliveries.get(entry.id);
    if (existing) {
      if (existing.text !== entry.text) return Promise.reject(new Error("Codex queue entry id belongs to a different payload"));
      return existing.promise;
    }
    let resolveDelivery!: (confirmed: DeliveryReceipt) => void;
    let rejectDelivery!: (error: Error) => void;
    const promise = new Promise<DeliveryReceipt>((resolve, reject) => {
      resolveDelivery = resolve;
      rejectDelivery = reject;
    });
    const timer = setTimeout(() => {
      if (this.pendingDeliveries.get(entry.id)?.promise !== promise) return;
      this.fail(new Error("Codex delivery confirmation timed out; outcome is uncertain"));
    }, this.requestTimeoutMs);
    const pending = { text: entry.text, receipt, promise, resolve: resolveDelivery, reject: rejectDelivery, timer };
    this.pendingDeliveries.set(entry.id, pending);
    return promise;
  }

  private confirmedReceipt(
    entry: QueueEntry,
    confirmed: { receipt: DeliveryReceipt; text: string | null },
  ): DeliveryReceipt {
    if (confirmed.text !== entry.text) {
      throw new Error("Codex queue entry id belongs to a different payload");
    }
    return confirmed.receipt;
  }

  private rememberConfirmedDelivery(turnId: string, value: unknown): void {
    const item = record(value);
    if (!item || stringField(item, "type") !== "userMessage") return;
    const clientId = stringField(item, "clientId");
    if (!clientId) return;
    const text = userMessageText(item);
    const previous = this.confirmedDeliveries.get(clientId);
    const pending = this.pendingDeliveries.get(clientId);
    const confirmed = {
      receipt: previous?.receipt ?? pending?.receipt ?? { outcome: "turn-started" as const, turnId },
      text: previous && previous.text !== text ? null : text,
    };
    this.confirmedDeliveries.set(clientId, confirmed);
    if (!pending) return;
    this.pendingDeliveries.delete(clientId);
    clearTimeout(pending.timer);
    try {
      pending.resolve(this.confirmedReceipt({ id: clientId, text: pending.text }, confirmed));
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(safeError(error)));
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

  private setSessionStatus(status: "active" | "idle" | "unhosted" | "dead", activeFlags: string[]): void {
    this.engineStatus = status;
    this.activeFlags = [...activeFlags];
    this.emit({ kind: "session-status", status, ...(activeFlags.length > 0 ? { activeFlags: [...activeFlags] } : {}) });
  }

  private emitThreadStatus(status: ThreadStatus): void {
    if (status.type === "systemError") {
      this.fail(new Error("Codex app-server reported a system error"), status.activeFlags);
      return;
    }
    const mapped = status.type === "notLoaded" ? "unhosted" : status.type;
    this.setSessionStatus(mapped, status.activeFlags);
  }

  private rpc(method: string, params: JsonObject = {}): Promise<unknown> {
    if (this.dead || this.releasing || this.released) return Promise.reject(new Error("Codex app-server host is unavailable"));
    const id = this.nextRpcId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`${method} timed out${MUTATING_RPC_METHODS.has(method) ? "; outcome is uncertain" : ""}`);
        reject(error);
        if (MUTATING_RPC_METHODS.has(method)) this.fail(error);
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: JsonObject): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: JsonObject): void {
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
    catch (error) { this.fail(new Error(`Codex app-server stdin failed: ${safeError(error)}`)); }
  }

  private acceptStdout(chunk: string): void {
    if (this.dead || this.releasing || this.released) return;
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
      if (this.dead || this.releasing || this.released) {
        this.stdoutBuffer = "";
        return;
      }
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
      this.attentions.set(attentionId, { rpcId: id, method, origin: "current" });
      this.emit({ kind: "attention", id: attentionId, method, attention: params });
      return;
    }
    this.acceptNotification(method, params);
  }

  private acceptNotification(method: string, params: JsonObject): void {
    const turnId = turnIdFromParams(params);
    if (method === "serverRequest/resolved") {
      const requestId = params.requestId;
      if (typeof requestId !== "number" && typeof requestId !== "string") return;
      const resolved = [...this.attentions.entries()].find(([, attention]) =>
        String(attention.rpcId) === String(requestId));
      if (!resolved) return;
      const answer = resolved[1].answer;
      if (answer) {
        clearTimeout(answer.timer);
        answer.resolve();
      }
      this.attentions.delete(resolved[0]);
      this.emit({ kind: "attention-resolved", id: resolved[0], resolution: answer ? "answered" : "server-resolved" });
      return;
    }
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
      if (method === "item/completed" && turnId) this.rememberConfirmedDelivery(turnId, params.item);
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
      const status = threadStatus(params);
      if (status) this.emitThreadStatus(status);
    }
  }

  private fail(error: Error, activeFlags: string[] = []): void {
    if (this.dead || this.released) return;
    this.dead = true;
    this.failure = error;
    this.activeTurnId = null;
    this.rejectPendingAnswers(error);
    this.rejectPendingDeliveries(error);
    this.attentions.clear();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(safeError(error)));
    }
    this.pending.clear();
    this.setSessionStatus("dead", activeFlags);
    this.closeSubscribers();
    this.startTermination();
  }

  private failWithoutLedger(error: Error): void {
    if (this.dead || this.released) return;
    this.dead = true;
    this.failure = error;
    this.engineStatus = "dead";
    this.activeFlags = [];
    this.activeTurnId = null;
    this.rejectPendingAnswers(error);
    this.rejectPendingDeliveries(error);
    this.attentions.clear();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(safeError(error)));
    }
    this.pending.clear();
    this.notifyStateListeners();
    this.closeSubscribers();
    this.startTermination();
  }

  private rejectPendingAnswers(error: Error): void {
    const rejection = new Error(safeError(error));
    for (const attention of this.attentions.values()) {
      if (!attention.answer) continue;
      clearTimeout(attention.answer.timer);
      attention.answer.reject(rejection);
      attention.answer = undefined;
    }
  }

  private rejectPendingDeliveries(error: Error): void {
    const rejection = new Error(safeError(error));
    for (const delivery of this.pendingDeliveries.values()) {
      clearTimeout(delivery.timer);
      delivery.reject(rejection);
    }
    this.pendingDeliveries.clear();
  }
}
