import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { statePath } from "@/lib/configDir";
import { applyClaudeSpawnPolicy } from "@/lib/agent/spawnPolicy";
import { claudeTranscriptPath } from "@/lib/agent/transcript";
import { procBackend } from "@/lib/proc";
import { signalDetachedProcessGroup, type ProcessSignal } from "@/lib/processGroup";
import { hardenedRedact } from "@/lib/view/compactText";

import type { DeliveryReceipt, EngineHost, HostState, NormalizedQueueEntry, QueueEntry, RuntimeEvent } from "./engineHost";
import { normalizeQueueEntry, RuntimeReplayGapError, StructuredHostAdoptionCleanupError } from "./engineHost";
import {
  FileRuntimeEventStore,
  nextRuntimeEventSequence,
  reconcileRuntimeEventCursor,
  type RuntimeEventCursorRecoveryReporter,
  type RuntimeEventStore,
} from "./eventStore";
import { MAX_STRUCTURED_IMAGE_ENCODED_BYTES, runtimeImageStore } from "./runtimeImageStore";
import {
  STRUCTURED_IMAGE_CAPABILITY,
  normalizeStructuredImageMime,
  structuredContent,
  type StructuredImageRef,
} from "./structuredContent";

type JsonObject = Record<string, unknown>;
type Subscriber = { afterSeq: number; queue: RuntimeEvent[]; wake: (() => void) | null; closed: boolean };
type UnsequencedEvent = RuntimeEvent extends infer Event
  ? Event extends RuntimeEvent ? Omit<Event, "seq"> : never
  : never;
type PendingControl = {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  interruptTurnId: string | null;
};
type PendingDelivery = {
  promise: Promise<DeliveryReceipt>;
  resolve(receipt: DeliveryReceipt): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
type PendingAnswer = {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

export interface ClaudeDeliveryState {
  entry: NormalizedQueueEntry;
  disposition: "turn-started" | "queued-next-turn";
  delivered: boolean;
  queuedAt?: string;
  engineMessageId?: string | null;
}

export interface ClaudeDeliveryLedger {
  load(sessionId: string): ClaudeDeliveryState[];
  recordQueued(sessionId: string, entry: QueueEntry, disposition: ClaudeDeliveryState["disposition"]): void;
  confirmDelivered(sessionId: string, entryId: string, engineMessageId: string | null): void;
}

type ClaudeDeliveryRecord =
  | { kind: "queued"; entry: NormalizedQueueEntry; disposition: ClaudeDeliveryState["disposition"]; queuedAt: string }
  | { kind: "delivered"; entryId: string; engineMessageId: string | null; deliveredAt: string };

export class FileClaudeDeliveryLedger implements ClaudeDeliveryLedger {
  constructor(private readonly directory = statePath("claude-delivery-ledger")) {}

  load(sessionId: string): ClaudeDeliveryState[] {
    const records = this.readRecords(sessionId);
    const states: ClaudeDeliveryState[] = [];
    for (const record of records) {
      if (record.kind === "queued") {
        if (states.some((state) => state.entry.id === record.entry.id)) continue;
        states.push({
          entry: record.entry,
          disposition: record.disposition,
          queuedAt: record.queuedAt,
          delivered: false,
        });
      } else {
        const state = states.find((candidate) => candidate.entry.id === record.entryId);
        if (state) {
          state.delivered = true;
          state.engineMessageId = record.engineMessageId;
        }
      }
    }
    return states;
  }

  recordQueued(sessionId: string, entry: QueueEntry, disposition: ClaudeDeliveryState["disposition"]): void {
    const normalized = normalizeQueueEntry(entry);
    const existing = this.load(sessionId).find((state) => state.entry.id === normalized.id);
    if (existing) {
      if (!sameQueueEntry(existing.entry, normalized)) {
        throw new Error("Claude delivery ledger entry id belongs to a different payload");
      }
      return;
    }
    this.append(sessionId, { kind: "queued", entry: normalized, disposition, queuedAt: new Date().toISOString() });
  }

  confirmDelivered(sessionId: string, entryId: string, engineMessageId: string | null): void {
    const state = this.load(sessionId).find((candidate) => candidate.entry.id === entryId);
    if (!state || state.delivered) return;
    this.append(sessionId, { kind: "delivered", entryId, engineMessageId, deliveredAt: new Date().toISOString() });
  }

  private readRecords(sessionId: string): ClaudeDeliveryRecord[] {
    let contents: string;
    try { contents = fs.readFileSync(this.filename(sessionId), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: ClaudeDeliveryRecord[] = [];
    const lines = contents.split("\n");
    const terminated = contents.endsWith("\n");
    for (const [index, line] of lines.entries()) {
      if (!line && index === lines.length - 1 && terminated) continue;
      if (!line) throw new Error("Claude delivery ledger contains an empty record");
      let value: unknown;
      try { value = JSON.parse(line); }
      catch {
        if (index === lines.length - 1 && !terminated) break;
        throw new Error("Claude delivery ledger contains malformed JSON");
      }
      const record = deliveryRecord(value);
      if (!record) {
        if (index === lines.length - 1 && !terminated) break;
        throw new Error("Claude delivery ledger contains an invalid record");
      }
      records.push(record);
    }
    return records;
  }

  private append(sessionId: string, record: ClaudeDeliveryRecord): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const filename = this.filename(sessionId);
    const fd = fs.openSync(filename, "a+", 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      repairJsonlTail(fd, filename, deliveryRecord);
      writeAllSync(fd, Buffer.from(`${JSON.stringify(record)}\n`));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private filename(sessionId: string): string {
    return path.join(this.directory, `${encodeURIComponent(sessionId)}.jsonl`);
  }
}

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
  version?: string | null;
}

export interface ClaudeSessionIdentity { sessionId: string }

export interface ClaudeStreamBrokerHostOptions {
  cwd: string;
  sessionId?: string;
  claudeConfigDir?: string;
  claudeProjectsDir?: string;
  spawnPolicyBaseSettingsPath?: string | null;
  allowSubagents?: boolean;
  readOnly?: boolean;
  binary?: string;
  model?: string;
  effort?: string;
  systemPrompt?: string;
  permissionMode?: string;
  tools?: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  shutdownGraceMs?: number;
  initialEventCursor?: number;
  onEventCursorRecovery?: RuntimeEventCursorRecoveryReporter;
  spawnProcess?: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
  signalProcess?: ProcessSignal;
  readAuthStatus?: () => ClaudeAuthStatus | Promise<ClaudeAuthStatus>;
  readTranscript?: (cwd: string, sessionId: string) => ClaudeTranscriptUser[];
  eventStore?: RuntimeEventStore;
  deliveryLedger?: ClaudeDeliveryLedger;
  readImage?: (ref: StructuredImageRef) => Buffer;
}

export interface ClaudeTranscriptUser {
  text: string;
  contentDigest?: string;
  imageCount?: number;
  uuid: string | null;
  timestamp: string | null;
}

const CHILD_ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG",
  "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "LLV_SPAWN_CAPABILITY",
] as const;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;
const MAX_REPLAY_ENVELOPE_BYTES = 256 * 1024;
const MAX_LINE_BYTES = MAX_STRUCTURED_IMAGE_ENCODED_BYTES + MAX_REPLAY_ENVELOPE_BYTES;

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function stringField(value: unknown, key: string): string | null {
  const object = record(value);
  return object && typeof object[key] === "string" ? object[key] as string : null;
}

function sameQueueEntry(left: QueueEntry, right: QueueEntry): boolean {
  const normalizedLeft = normalizeQueueEntry(left);
  const normalizedRight = normalizeQueueEntry(right);
  return normalizedLeft.id === normalizedRight.id
    && normalizedLeft.contentDigest === normalizedRight.contentDigest
    && normalizedLeft.expectedTurnId === normalizedRight.expectedTurnId;
}

function deliveryRecord(value: unknown): ClaudeDeliveryRecord | null {
  const candidate = record(value);
  if (candidate?.kind === "queued") {
    const entry = record(candidate.entry);
    if (typeof entry?.id !== "string" || !entry.id) return null;
    if (candidate.disposition !== "turn-started" && candidate.disposition !== "queued-next-turn") return null;
    if (typeof candidate.queuedAt !== "string") return null;
    try {
      return { ...candidate, entry: normalizeQueueEntry(entry as unknown as QueueEntry) } as ClaudeDeliveryRecord;
    } catch {
      return null;
    }
  }
  if (candidate?.kind === "delivered"
    && typeof candidate.entryId === "string"
    && (typeof candidate.engineMessageId === "string" || candidate.engineMessageId === null)
    && typeof candidate.deliveredAt === "string") return candidate as unknown as ClaudeDeliveryRecord;
  return null;
}

function repairJsonlTail<T>(fd: number, filename: string, validate: (value: unknown) => T | null): void {
  const size = fs.fstatSync(fd).size;
  if (size === 0) return;
  const contents = fs.readFileSync(filename, "utf8");
  if (contents.endsWith("\n")) return;
  const boundary = contents.lastIndexOf("\n") + 1;
  const tail = contents.slice(boundary);
  let parsed: unknown;
  try { parsed = JSON.parse(tail); } catch { parsed = null; }
  if (validate(parsed)) fs.writeSync(fd, "\n");
  else fs.ftruncateSync(fd, Buffer.byteLength(contents.slice(0, boundary)));
}

function writeAllSync(fd: number, buffer: Uint8Array): void {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const written = fs.writeSync(fd, buffer, offset, buffer.byteLength - offset);
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error("Claude delivery ledger write made no progress");
    }
    offset += written;
  }
}

export function redactClaudeHostDiagnostic(value: unknown): string {
  return hardenedRedact(value instanceof Error ? value.message : String(value))
    .replace(/(["']?(?:cookie|set-cookie)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[redacted]")
    .slice(0, 500);
}

const safeError = redactClaudeHostDiagnostic;

function subscriptionEnv(source: NodeJS.ProcessEnv, claudeConfigDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: source.NODE_ENV };
  for (const name of CHILD_ENV_ALLOWLIST) if (source[name] !== undefined) env[name] = source[name];
  if (claudeConfigDir) env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  return env;
}

function defaultAuthStatus(binary: string, env: NodeJS.ProcessEnv, cwd: string): ClaudeAuthStatus {
  const result = spawnSync(binary, ["auth", "status"], { cwd, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error("Claude subscription authentication check failed");
  let value: JsonObject | null = null;
  try { value = record(JSON.parse(result.stdout)); } catch { /* handled below */ }
  if (!value) throw new Error("Claude subscription authentication status was invalid");
  const versionResult = spawnSync(binary, ["--version"], { cwd, env, encoding: "utf8" });
  const version = versionResult.status === 0 ? versionResult.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null : null;
  return {
    loggedIn: value.loggedIn === true,
    authMethod: typeof value.authMethod === "string" ? value.authMethod : null,
    subscriptionType: typeof value.subscriptionType === "string" ? value.subscriptionType : null,
    version,
  };
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => stringField(part, "text") ?? "").join("");
}

function userText(message: JsonObject): string {
  return textContent(record(message.message)?.content);
}

function messageContent(message: JsonObject): ReturnType<typeof structuredContent> | null {
  const blocks = record(message.message)?.content;
  if (typeof blocks === "string") return blocks.trim() ? structuredContent(blocks, []) : null;
  if (!Array.isArray(blocks)) return null;
  const images: StructuredImageRef[] = [];
  let text = "";
  for (const block of blocks) {
    const item = record(block);
    if (item?.type === "text" && typeof item.text === "string") {
      text += item.text;
      continue;
    }
    if (item?.type !== "image") continue;
    const source = record(item.source);
    const mime = typeof source?.media_type === "string" ? normalizeStructuredImageMime(source.media_type) : null;
    if (source?.type !== "base64" || !mime || typeof source.data !== "string") return null;
    const data = Buffer.from(source.data, "base64");
    if (!data.length || data.toString("base64") !== source.data) return null;
    images.push({
      sha256: crypto.createHash("sha256").update(data).digest("hex"),
      mime,
      bytes: data.byteLength,
    });
  }
  try { return structuredContent(text, images); } catch { return null; }
}

function matchesClaudeUserContent(
  entry: NormalizedQueueEntry,
  observed: { contentDigest: string; text: string; imageCount: number },
): boolean {
  if (entry.contentDigest === observed.contentDigest) return true;
  return entry.content.images.length > 0
    && observed.imageCount === entry.content.images.length
    && observed.text === entry.content.text;
}

function sanitizedUserReplay(
  message: JsonObject,
  content: ReturnType<typeof structuredContent> | null,
): JsonObject {
  const providerMessage = record(message.message) ?? {};
  const sanitizedBlocks: JsonObject[] = content
    ? content.content.images.map((image) => ({
        type: "image",
        source: {
          type: "runtime_ref",
          sha256: image.sha256,
          media_type: image.mime,
          bytes: image.bytes,
        },
      }))
    : [];
  const text = content?.content.text ?? userText(message);
  if (text) sanitizedBlocks.push({ type: "text", text });
  return {
    ...message,
    ...(content ? { contentDigest: content.contentDigest } : {}),
    message: { ...providerMessage, content: sanitizedBlocks },
  };
}

function defaultTranscriptUsers(cwd: string, sessionId: string, projectsRoot?: string): ClaudeTranscriptUser[] {
  const filename = claudeTranscriptPath(cwd, sessionId, projectsRoot);
  let contents: string;
  try { contents = fs.readFileSync(filename, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const users: ClaudeTranscriptUser[] = [];
  for (const line of contents.split("\n")) {
    if (!line) continue;
    let value: JsonObject | null = null;
    try { value = record(JSON.parse(line)); } catch { continue; }
    if (value?.type !== "user" || record(value.message)?.role !== "user") continue;
    const content = messageContent(value);
    users.push({
      text: userText(value),
      ...(content ? { contentDigest: content.contentDigest } : {}),
      ...(content ? { imageCount: content.content.images.length } : {}),
      uuid: stringField(value, "uuid"),
      timestamp: stringField(value, "timestamp"),
    });
  }
  return users;
}

/** One durable writer around a long-lived Claude stream-json process. */
export class ClaudeStreamBrokerHost implements EngineHost {
  readonly identity: ClaudeSessionIdentity;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly eventStore: RuntimeEventStore;
  private readonly deliveryLedger: ClaudeDeliveryLedger;
  private readonly readImage: (ref: StructuredImageRef) => Buffer;
  private readonly requestTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private readonly onEventCursorRecovery: RuntimeEventCursorRecoveryReporter | undefined;
  private readonly signalProcess: ProcessSignal;
  private readonly subscribers = new Set<Subscriber>();
  private readonly events: RuntimeEvent[] = [];
  private readonly deliveries: ClaudeDeliveryState[] = [];
  private readonly turnQueue: string[] = [];
  private readonly attentions = new Map<string, JsonObject>();
  private readonly pendingControls = new Map<string, PendingControl>();
  private readonly pendingAnswers = new Map<string, PendingAnswer>();
  private readonly interruptedTurns = new Set<string>();
  private readonly partialTurns = new Set<string>();
  private readonly pendingDeliveries = new Map<string, PendingDelivery>();
  private readonly stateListeners = new Set<(state: HostState) => void>();
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private stdoutBuffer = "";
  private cursor: number;
  private activeTurnId: string | null = null;
  private protocolVersion: string | null;
  private account: HostState["account"];
  private releasing = false;
  private released = false;
  private dead = false;
  private reaped = false;
  private ledgerFailed = false;
  private writerFence: (() => boolean) | null = null;
  private releasePromise: Promise<void> | null = null;
  private terminationTimer: ReturnType<typeof setTimeout> | null = null;
  private terminationStarted = false;
  private readonly reapedPromise: Promise<void>;
  private resolveReaped!: () => void;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    identity: ClaudeSessionIdentity,
    auth: ClaudeAuthStatus,
    options: ClaudeStreamBrokerHostOptions,
  ) {
    this.child = child;
    this.identity = identity;
    this.eventStore = options.eventStore ?? new FileRuntimeEventStore();
    this.deliveryLedger = options.deliveryLedger ?? new FileClaudeDeliveryLedger();
    this.readImage = options.readImage ?? ((ref) => runtimeImageStore().read(ref));
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.onEventCursorRecovery = options.onEventCursorRecovery;
    this.signalProcess = options.signalProcess ?? process.kill;
    this.cursor = options.initialEventCursor ?? 0;
    this.protocolVersion = auth.version ?? null;
    this.account = { type: auth.authMethod, planType: auth.subscriptionType };
    this.reapedPromise = new Promise((resolve) => { this.resolveReaped = resolve; });
    child.stdout.on("data", (chunk: Buffer | string) => {
      this.acceptStdout(typeof chunk === "string" ? chunk : this.stdoutDecoder.write(chunk));
    });
    child.stdout.on("end", () => {
      const tail = this.stdoutDecoder.end();
      if (tail) this.acceptStdout(tail);
    });
    child.stderr.on("data", () => { /* Provider diagnostics may contain credentials. */ });
    child.stdin.on("error", (error) => {
      if (!this.releasing && !this.released) this.fail(new Error(`Claude stream stdin failed: ${safeError(error)}`));
    });
    child.on("error", (error) => this.fail(new Error(`Claude child failed: ${safeError(error)}`)));
    child.on("close", () => {
      this.reaped = true;
      if (this.terminationTimer) {
        clearTimeout(this.terminationTimer);
        this.terminationTimer = null;
      }
      this.resolveReaped();
      if (this.releasing) this.finishRelease();
      else if (this.dead) this.notifyStateListeners();
      else if (!this.releasing && !this.released) this.fail(new Error("Claude child exited"));
    });
  }

  static async start(options: ClaudeStreamBrokerHostOptions): Promise<ClaudeStreamBrokerHost> {
    return this.open(options.sessionId ?? crypto.randomUUID(), false, options);
  }

  static async adopt(sessionId: string, options: ClaudeStreamBrokerHostOptions): Promise<ClaudeStreamBrokerHost> {
    if (!sessionId) throw new Error("Claude session id is required for adoption");
    return this.open(sessionId, true, options);
  }

  private static async open(
    sessionId: string,
    resume: boolean,
    options: ClaudeStreamBrokerHostOptions,
  ): Promise<ClaudeStreamBrokerHost> {
    const binary = options.binary ?? process.env.LLV_CLAUDE_BINARY ?? "claude";
    const env = subscriptionEnv(options.env ?? process.env, options.claudeConfigDir);
    const auth = await (options.readAuthStatus?.() ?? defaultAuthStatus(binary, env, options.cwd));
    if (!auth.loggedIn || auth.authMethod !== "claude.ai" || !auth.subscriptionType) {
      throw new Error("Claude stream hosting requires a claude.ai subscription login");
    }
    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--safe-mode", "--include-partial-messages", "--replay-user-messages",
      "--permission-prompt-tool", "stdio",
      "--permission-mode", options.permissionMode ?? "default",
    ];
    const disallowedTools = [
      ...(!options.allowSubagents ? ["Task", "Agent"] : []),
      ...(options.readOnly ? ["Edit", "Write", "NotebookEdit"] : []),
    ];
    if (disallowedTools.length > 0) args.push("--disallowedTools", disallowedTools.join(","));
    if (options.claudeConfigDir) {
      const profileId = `structured-${crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 24)}`;
      const settings = applyClaudeSpawnPolicy(options.claudeConfigDir, {
        allowSubagents: options.allowSubagents,
        baseSettingsPath: options.spawnPolicyBaseSettingsPath,
        profileId,
      });
      args.push("--settings", settings.settingsPath);
    }
    if (resume) args.push("--resume", sessionId);
    else args.push("--session-id", sessionId);
    if (options.model) args.push("--model", options.model);
    if (options.effort) args.push("--effort", options.effort);
    if (options.systemPrompt) args.push("--system-prompt", options.systemPrompt);
    if (options.tools) args.push("--tools", options.tools.join(","));
    const spawnProcess = options.spawnProcess ?? ((command, childArgs, spawnOptions) =>
      spawn(command, childArgs, { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] }));
    const child = spawnProcess(binary, args, { cwd: options.cwd, env, detached: true });
    const host = new ClaudeStreamBrokerHost(child, { sessionId }, auth, options);
    try {
      host.restore();
      host.reconcileTranscript(options.readTranscript
        ? options.readTranscript(options.cwd, sessionId)
        : defaultTranscriptUsers(options.cwd, sessionId, options.claudeProjectsDir));
      host.emit({ kind: "session-status", status: "idle" });
      return host;
    } catch (error) {
      try {
        await host.release();
      } catch (cleanupError) {
        throw new StructuredHostAdoptionCleanupError(safeError(error), host, { cause: cleanupError });
      }
      throw new Error(safeError(error));
    }
  }

  attach(afterSeq: number): AsyncIterable<RuntimeEvent> {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error("afterSeq must be a non-negative integer");
    const firstAvailable = this.events[0]?.seq;
    if (firstAvailable !== undefined && afterSeq + 1 < firstAvailable) {
      throw new RuntimeReplayGapError(afterSeq, firstAvailable);
    }
    const subscriber: Subscriber = { afterSeq, queue: this.events.filter((event) => event.seq > afterSeq), wake: null, closed: false };
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
    if (this.unavailable()) return { outcome: "rejected", reason: "dead-host" };
    if (!entry.id) throw new Error("queue entry id is required");
    const normalized = normalizeQueueEntry(entry);
    const duplicate = this.deliveries.find((state) => state.entry.id === entry.id);
    if (duplicate && !sameQueueEntry(duplicate.entry, normalized)) {
      throw new Error("Claude queue entry id belongs to a different payload");
    }
    if (!duplicate && normalized.expectedTurnId !== undefined && normalized.expectedTurnId !== this.activeTurnId) {
      return { outcome: "rejected", reason: "stale-turn" };
    }
    if (duplicate?.delivered) {
      return { outcome: duplicate.disposition, turnId: duplicate.entry.id };
    }
    const existingPending = this.pendingDeliveries.get(entry.id);
    if (existingPending) return existingPending.promise;
    const blocks: JsonObject[] = normalized.content.images.map((image) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mime,
        data: this.readImage(image).toString("base64"),
      },
    }));
    if (normalized.content.text) blocks.push({ type: "text", text: normalized.content.text });
    const disposition: ClaudeDeliveryState["disposition"] = duplicate?.disposition
      ?? (this.activeTurnId ? "queued-next-turn" : "turn-started");
    try {
      this.deliveryLedger.recordQueued(this.identity.sessionId, normalized, disposition);
    } catch (error) {
      this.failWithoutLedger(new Error(`Claude delivery ledger failed: ${safeError(error)}`));
      throw new Error(`Claude delivery ledger failed: ${safeError(error)}`);
    }
    const delivery: ClaudeDeliveryState = duplicate
      ?? { entry: structuredClone(normalized), disposition, delivered: false };
    if (!duplicate) this.deliveries.push(delivery);
    let resolveDelivery!: PendingDelivery["resolve"];
    let rejectDelivery!: PendingDelivery["reject"];
    const promise = new Promise<DeliveryReceipt>((resolve, reject) => {
      resolveDelivery = resolve;
      rejectDelivery = reject;
    });
    const timer = setTimeout(() => {
      if (this.pendingDeliveries.get(entry.id)?.promise !== promise) return;
      this.fail(new Error("Claude delivery confirmation timed out; outcome is uncertain"));
    }, this.requestTimeoutMs);
    const pending: PendingDelivery = {
      promise,
      resolve: (receipt) => resolveDelivery(receipt),
      reject: (error) => rejectDelivery(error),
      timer,
    };
    this.pendingDeliveries.set(entry.id, pending);
    this.write({
      type: "user",
      session_id: this.identity.sessionId,
      message: { role: "user", content: blocks },
    });
    this.turnQueue.push(entry.id);
    if (!this.activeTurnId) {
      this.activeTurnId = entry.id;
      this.emit({ kind: "turn-started", turnId: entry.id });
    } else {
      this.notifyStateListeners();
    }
    return pending.promise;
  }

  async interrupt(turnRef: string): Promise<void> {
    if (this.unavailable()) throw new Error("Claude stream host is unavailable");
    if (!turnRef || turnRef !== this.activeTurnId) throw new Error("active turn fence is stale");
    const requestId = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControls.delete(requestId);
        const error = new Error("Claude interrupt timed out; outcome is uncertain");
        reject(error);
        this.fail(error);
      }, this.requestTimeoutMs);
      this.pendingControls.set(requestId, { resolve, reject, timer, interruptTurnId: turnRef });
      this.write({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } });
    });
  }

  async answer(attentionRef: string, value: unknown): Promise<void> {
    if (this.unavailable()) throw new Error("Claude stream host is unavailable");
    if (!this.attentions.has(attentionRef)) throw new Error("attention request is missing or already answered");
    const attention = this.attentions.get(attentionRef)!;
    const response = record(value);
    const answer = response?.behavior === "allow"
      ? { ...response, updatedInput: { ...(record(attention.input) ?? {}), ...(record(response.updatedInput) ?? {}) } }
      : value ?? {};
    if (this.pendingAnswers.has(attentionRef)) throw new Error("attention answer is already awaiting confirmation");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAnswers.delete(attentionRef);
        const error = new Error("Claude attention answer timed out; outcome is uncertain");
        reject(error);
        this.fail(error);
      }, this.requestTimeoutMs);
      this.pendingAnswers.set(attentionRef, { resolve, reject, timer });
      this.write({
        type: "control_response",
        response: { subtype: "success", request_id: attentionRef, response: answer },
      });
    });
  }

  async health(): Promise<HostState> { return this.currentState(); }

  onStateChange(listener: (state: HostState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.currentState());
    return () => this.stateListeners.delete(listener);
  }

  setWriterFence(fence: () => boolean): void { this.writerFence = fence; }

  async release(): Promise<void> {
    if (this.released) return;
    if (!this.releasePromise) {
      const attempt = this.releaseAndReap();
      this.releasePromise = attempt;
      void attempt.catch(() => {
        if (this.releasePromise === attempt) this.releasePromise = null;
      });
    }
    return this.releasePromise;
  }

  private unavailable(): boolean {
    if (this.dead || this.releasing || this.released) return true;
    try { return this.writerFence?.() === false; } catch { return true; }
  }

  private currentState(): HostState {
    const pid = this.reaped || this.released ? null : this.child.pid ?? null;
    const status: HostState["status"] = this.dead ? "dead"
      : this.released ? "unhosted"
      : this.attentions.size ? "attention"
      : this.activeTurnId ? "active"
      : "idle";
    return {
      status,
      sessionKey: this.identity.sessionId,
      endpoint: pid ? `stdio:${pid}` : "stdio:released",
      pid,
      processStartIdentity: pid ? procBackend.processIdentity(pid) : null,
      eventCursor: this.cursor,
      protocolVersion: this.protocolVersion,
      activeTurnRef: this.activeTurnId,
      pendingAttention: [...this.attentions.keys()],
      activeFlags: [STRUCTURED_IMAGE_CAPABILITY],
      account: this.account,
    };
  }

  private restore(): void {
    const stored = this.eventStore.load(this.identity.sessionId);
    this.events.push(...stored);
    this.cursor = reconcileRuntimeEventCursor(
      this.identity.sessionId,
      stored.at(-1)?.seq ?? 0,
      this.cursor,
      this.onEventCursorRecovery,
    );
    this.deliveries.push(...this.deliveryLedger.load(this.identity.sessionId).map((delivery) => ({
      ...delivery,
      entry: normalizeQueueEntry(delivery.entry),
    })));
    let restoredTurn: string | null = null;
    for (const event of stored) {
      if (event.kind === "turn-started") restoredTurn = event.turnId;
      if (event.kind === "turn-ended" && event.turnId === restoredTurn) restoredTurn = null;
      if (event.kind === "attention") this.attentions.set(event.id, record(event.attention) ?? {});
      if (event.kind === "attention-resolved") this.attentions.delete(event.id);
      if (event.kind === "session-status" && (event.status === "dead" || event.status === "unhosted")) {
        restoredTurn = null;
        this.attentions.clear();
      }
    }
    if (restoredTurn) this.emit({ kind: "turn-ended", turnId: restoredTurn, status: "error" });
    for (const attentionId of this.attentions.keys()) {
      this.emit({ kind: "attention-resolved", id: attentionId, resolution: "host-restarted" });
    }
    this.attentions.clear();
  }

  private reconcileTranscript(users: ClaudeTranscriptUser[]): void {
    const unmatched = [...users];
    for (const delivery of this.deliveries) {
      if (delivery.delivered) continue;
      const queuedAt = delivery.queuedAt ? Date.parse(delivery.queuedAt) : Number.NEGATIVE_INFINITY;
      const index = unmatched.findIndex((user) => {
        const timestamp = user.timestamp ? Date.parse(user.timestamp) : Number.POSITIVE_INFINITY;
        const digest = user.contentDigest ?? structuredContent(user.text, []).contentDigest;
        return matchesClaudeUserContent(delivery.entry, {
          contentDigest: digest,
          text: user.text,
          imageCount: user.imageCount ?? 0,
        }) && timestamp >= queuedAt;
      });
      if (index < 0) continue;
      const [user] = unmatched.splice(index, 1);
      this.deliveryLedger.confirmDelivered(this.identity.sessionId, delivery.entry.id, user?.uuid ?? null);
      delivery.delivered = true;
      delivery.engineMessageId = user?.uuid ?? null;
    }
  }

  private emit(event: UnsequencedEvent): void {
    if (this.ledgerFailed) return;
    let nextCursor: number;
    try {
      nextCursor = nextRuntimeEventSequence(this.cursor);
    } catch (error) {
      this.ledgerFailed = true;
      this.failWithoutLedger(new Error(safeError(error)));
      return;
    }
    this.cursor = nextCursor;
    const sequenced = { ...event, seq: nextCursor } as RuntimeEvent;
    try { this.eventStore.append(this.identity.sessionId, sequenced); }
    catch (error) {
      this.cursor = this.events.at(-1)?.seq ?? Math.max(0, this.cursor - 1);
      this.ledgerFailed = true;
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

  private acceptStdout(chunk: string): void {
    if (this.dead || this.released) return;
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) return this.fail(new Error("Claude emitted an oversized JSONL frame"));
      if (line) this.acceptMessage(line);
      if (this.dead) return;
      newline = this.stdoutBuffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.stdoutBuffer) > MAX_LINE_BYTES) this.fail(new Error("Claude emitted an oversized JSONL frame"));
  }

  private acceptMessage(line: string): void {
    let message: JsonObject | null = null;
    try { message = record(JSON.parse(line)); } catch { /* handled below */ }
    if (!message) return this.fail(new Error("Claude emitted malformed stream JSON"));
    const type = stringField(message, "type");
    const sessionId = stringField(message, "session_id");
    if (sessionId && sessionId !== this.identity.sessionId) return this.fail(new Error("Claude emitted a different session id"));
    if (type === "system" && message.subtype === "init") {
      if (message.apiKeySource !== "none") return this.fail(new Error("Claude stream process did not use subscription OAuth"));
      return;
    }
    if (type === "user") {
      const content = messageContent(message);
      const directUserEcho = stringField(message.message, "role") === "user" && content !== null;
      const delivery = directUserEcho
        ? this.deliveries.find((candidate) => !candidate.delivered && matchesClaudeUserContent(candidate.entry, {
            contentDigest: content.contentDigest,
            text: content.content.text,
            imageCount: content.content.images.length,
          }))
        : undefined;
      if (delivery) {
        try {
          this.deliveryLedger.confirmDelivered(this.identity.sessionId, delivery.entry.id, stringField(message, "uuid"));
          delivery.delivered = true;
          delivery.engineMessageId = stringField(message, "uuid");
          const pending = this.pendingDeliveries.get(delivery.entry.id);
          if (pending) {
            this.pendingDeliveries.delete(delivery.entry.id);
            clearTimeout(pending.timer);
            pending.resolve({ outcome: delivery.disposition, turnId: delivery.entry.id });
          }
        } catch (error) {
          return this.failWithoutLedger(new Error(`Claude delivery ledger failed: ${safeError(error)}`));
        }
      }
      this.emit({ kind: "item", turnId: this.activeTurnId, item: sanitizedUserReplay(message, content), phase: "completed" });
      return;
    }
    if (type === "stream_event") {
      const event = record(message.event);
      const delta = record(event?.delta);
      const text = stringField(delta, "text");
      if (event?.type === "content_block_delta" && text !== null) {
        if (this.activeTurnId) this.partialTurns.add(this.activeTurnId);
        this.emit({ kind: "delta", turnId: this.activeTurnId ?? "unknown", text });
      }
      return;
    }
    if (type === "assistant") {
      const text = textContent(record(message.message)?.content);
      if (text && (!this.activeTurnId || !this.partialTurns.has(this.activeTurnId))) {
        this.emit({ kind: "delta", turnId: this.activeTurnId ?? "unknown", text });
      }
      this.emit({ kind: "item", turnId: this.activeTurnId, item: message, phase: "completed" });
      return;
    }
    if (type === "control_request") {
      const requestId = stringField(message, "request_id");
      if (!requestId) return this.fail(new Error("Claude control request had no request id"));
      const request = record(message.request) ?? {};
      this.attentions.set(requestId, request);
      this.emit({ kind: "attention", id: requestId, method: stringField(request, "subtype") ?? "control_request", attention: request });
      return;
    }
    if (type === "control_cancel_request") {
      const requestId = stringField(message, "request_id");
      if (!requestId) return this.fail(new Error("Claude control cancellation had no request id"));
      if (!this.attentions.has(requestId)) return;
      const pending = this.pendingAnswers.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingAnswers.delete(requestId);
        pending.reject(new Error("Claude attention was cancelled before answer confirmation"));
      }
      this.attentions.delete(requestId);
      this.emit({ kind: "attention-resolved", id: requestId, resolution: "server-resolved" });
      return;
    }
    if (type === "control_response") {
      const response = record(message.response) ?? message;
      const requestId = stringField(response, "request_id");
      if (!requestId) return;
      const answer = this.pendingAnswers.get(requestId);
      if (answer) {
        clearTimeout(answer.timer);
        this.pendingAnswers.delete(requestId);
        this.attentions.delete(requestId);
        if (response.subtype === "error") {
          answer.reject(new Error("Claude attention answer failed"));
          this.emit({ kind: "attention-resolved", id: requestId, resolution: "server-resolved" });
        } else {
          answer.resolve();
          this.emit({ kind: "attention-resolved", id: requestId, resolution: "answered" });
        }
        return;
      }
      const pending = this.pendingControls.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingControls.delete(requestId);
      if (response.subtype === "error") pending.reject(new Error("Claude control request failed"));
      else {
        if (pending.interruptTurnId) this.interruptedTurns.add(pending.interruptTurnId);
        pending.resolve();
      }
      return;
    }
    if (type === "result") this.acceptResult(message);
  }

  private acceptResult(message: JsonObject): void {
    const turnId = this.turnQueue.shift() ?? this.activeTurnId;
    if (!turnId) return;
    this.partialTurns.delete(turnId);
    const interrupted = this.interruptedTurns.delete(turnId);
    const status = interrupted || message.subtype === "interrupted"
      ? "interrupted"
      : message.subtype === "success" ? "completed" : "error";
    this.emit({ kind: "turn-ended", turnId, status });
    this.activeTurnId = this.turnQueue[0] ?? null;
    if (this.activeTurnId) this.emit({ kind: "turn-started", turnId: this.activeTurnId });
    else this.emit({ kind: "session-status", status: "idle" });
  }

  private write(message: JsonObject): void {
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
    catch (error) {
      const failure = new Error(`Claude stream stdin failed: ${safeError(error)}`);
      this.fail(failure);
      throw failure;
    }
  }

  private async releaseAndReap(): Promise<void> {
    this.releasing = true;
    this.rejectPending(new Error("Claude stream host released"));
    this.startTermination();
    if (!await this.waitForReap(this.shutdownGraceMs * 2)) {
      signalDetachedProcessGroup(this.child, "SIGKILL", this.signalProcess);
      if (!await this.waitForReap(this.shutdownGraceMs)) {
        /* "close" waits on the stdio pipes, which an escaped descendant can
           hold open long after the leader died — a kill that keeps failing
           with an unreapable child wedges the session's terminal receipt
           forever. The recorded exit evidence is authoritative: when the
           leader is gone, destroy our pipe ends and settle the reap. */
        const leaderExited = this.child.pid === undefined
          || (this.child.exitCode ?? null) !== null
          || (this.child.signalCode ?? null) !== null;
        if (!leaderExited) throw new Error("Claude child could not be reaped");
        for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
          try { stream?.destroy(); } catch { /* pipe already closed */ }
        }
        this.reaped = true;
        if (this.terminationTimer) {
          clearTimeout(this.terminationTimer);
          this.terminationTimer = null;
        }
        this.resolveReaped();
      }
    }
    this.finishRelease();
  }

  private finishRelease(): void {
    if (this.released) return;
    this.released = true;
    this.releasing = false;
    this.activeTurnId = null;
    this.attentions.clear();
    this.emit({ kind: "session-status", status: "unhosted" });
    if (this.ledgerFailed) this.notifyStateListeners();
    this.closeSubscribers();
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

  private fail(error: Error): void {
    if (this.dead || this.released) return;
    this.dead = true;
    this.activeTurnId = null;
    this.attentions.clear();
    this.rejectPending(error);
    this.emit({ kind: "session-status", status: "dead" });
    this.closeSubscribers();
    this.startTermination();
  }

  private failWithoutLedger(error: Error): void {
    if (this.released) {
      this.notifyStateListeners();
      this.closeSubscribers();
      return;
    }
    if (this.dead) {
      this.notifyStateListeners();
      return;
    }
    this.ledgerFailed = true;
    this.dead = true;
    this.activeTurnId = null;
    this.attentions.clear();
    this.rejectPending(error);
    this.notifyStateListeners();
    this.closeSubscribers();
    this.startTermination();
  }

  private startTermination(): void {
    if (this.terminationStarted || this.reaped) return;
    this.terminationStarted = true;
    try { this.child.stdin.end(); } catch { /* already closed */ }
    signalDetachedProcessGroup(this.child, "SIGTERM", this.signalProcess);
    this.terminationTimer = setTimeout(() => {
      this.terminationTimer = null;
      if (this.reaped) return;
      signalDetachedProcessGroup(this.child, "SIGKILL", this.signalProcess);
    }, this.shutdownGraceMs);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingDeliveries.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(safeError(error)));
    }
    this.pendingDeliveries.clear();
    for (const pending of this.pendingControls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(safeError(error)));
    }
    this.pendingControls.clear();
    for (const pending of this.pendingAnswers.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(safeError(error)));
    }
    this.pendingAnswers.clear();
  }

  private closeSubscribers(): void {
    for (const subscriber of this.subscribers) {
      subscriber.closed = true;
      subscriber.wake?.();
    }
  }

  private notifyStateListeners(): void {
    const state = this.currentState();
    for (const listener of this.stateListeners) listener(state);
  }
}
