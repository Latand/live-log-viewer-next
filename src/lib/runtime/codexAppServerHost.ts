import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import fs from "node:fs";

import { isKnownEffortTier } from "@/lib/agent/efforts";
import type { ProcessIdentity } from "@/lib/agent/registry";
import { procBackend } from "@/lib/proc";
import { signalDetachedProcessGroup, signalProcessGroup, type ProcessSignal } from "@/lib/processGroup";
import { STRUCTURED_HOST_STAMP_ENV, structuredHostStamp } from "@/lib/scanner/process";
import { headlessCodexThreadConfig } from "@/lib/codexHeadlessConfig";
import { grantedPluginServerNames, grantedPlugins } from "@/lib/agent/pluginAllowlist";
import { hardenedRedact } from "@/lib/view/compactText";
import { decodeCodexStructuredUserText, encodeCodexStructuredUserText } from "./codexStructuredUserText";
import { CodexReplayFrameReducer, ReplayFrameOverflowError, sanitizeCodexImageFrame, shrinkReducedReplayFrame, type ImageSink, type ReplayFrameBudgets } from "./codexImageFrames";
import { MAX_STRUCTURED_IMAGE_ENCODED_BYTES, runtimeImageStore } from "./runtimeImageStore";
import { STRUCTURED_IMAGE_CAPABILITY, type StructuredImageRef } from "./structuredContent";
import { withTelegramConnectorGrant } from "./telegramConnectorEnv";
import {
  normalizeVoiceDeliveries,
  streamingVoiceDelivery,
  terminalVoiceResponse,
  utf8ChunkAt,
  type RuntimeVoiceDelivery,
  type RuntimeVoiceResponse,
} from "./voiceDelivery";
import {
  takeVoiceStreamChunk,
  VOICE_STREAM_BUFFER_LIMIT_BYTES,
  VOICE_STREAM_FLUSH_DELAY_MS,
  VOICE_STREAM_MAX_PENDING,
  type VoiceStreamFlushMode,
} from "./voiceStreamChunks";

import type {
  DeliveryReceipt,
  EngineHost,
  HostState,
  QueueEntry,
  RuntimeCompactOutcome,
  RuntimeCompactRequest,
  RuntimeEvent,
} from "./engineHost";
import {
  normalizeQueueEntry,
  RuntimeReplayGapError,
  type SessionMaterializationEvidence,
  StructuredCompactError,
  StructuredHostAdoptionCleanupError,
} from "./engineHost";
import {
  FileRuntimeEventStore,
  nextRuntimeEventSequence,
  reconcileRuntimeEventCursor,
  type RuntimeEventCursorRecoveryReporter,
  type RuntimeEventStore,
} from "./eventStore";
import {
  canonicalVoicePersonaBootstrapExists,
  legacyVoicePersonaBootstrapItemId,
  voicePersonaBootstrap,
  voicePersonaBootstrapIdentity,
  type VoicePersonaBootstrap,
  type VoicePersonaBootstrapIdentity,
  type VoicePersonaBootstrapReceipt,
} from "./voicePersona";

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
/** Why the last realtime call ended, in the backend's own words (#664). */
export type CodexRealtimeFailure = {
  message: string;
  at: string;
  realtimeSessionId: string | null;
};
type PendingRealtimeStart = {
  resolve(result: CodexRealtimeWebRtcResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | undefined;
  started: boolean;
  realtimeSessionId: string | null;
  sdp: string | null;
  personaBootstrap: VoicePersonaBootstrapReceipt;
};
type VoicePersonaBootstrapInsertion = {
  owner: PendingRealtimeStart;
  promise: Promise<void>;
};
type PendingCompaction = {
  promise: Promise<RuntimeCompactOutcome>;
  resolve(outcome: RuntimeCompactOutcome): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

type PendingDelivery = {
  text: string;
  contentDigest: string;
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
type RealtimeDeliveryState = {
  digest: string;
  responseIndex: number;
  offset: number;
  acknowledged: boolean;
};
type VoiceStreamState = {
  turnId: string;
  segmentIndex: number;
  nextChunkIndex: number;
  buffer: string;
  observedChars: number;
  emittedChars: number;
  observedHash: Hash;
  emittedHash: Hash;
  fallbackToTerminal: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};
type RealtimeInitialItem = {
  role: "user" | "assistant";
  text: string;
};
type RealtimeContextCandidate = RealtimeInitialItem & {
  turnId: string | null;
  source: "durable-delta" | "durable-item";
};
type RealtimeContextSelection = {
  items: RealtimeInitialItem[];
  diagnosticItems: Array<{
    role: RealtimeInitialItem["role"];
    source: RealtimeContextCandidate["source"];
    bytes: number;
  }>;
  truncated: boolean;
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
  mcpServers?: string[];
  /** Codex plugins granted to this session (issue #687). Empty or absent
      denies the plugin subsystem, which is the default for every session. */
  plugins?: readonly string[];
  fileAuthCredentials?: boolean;
  sandbox?: string;
  permissionProfile?: string;
  permissionProfileConfig?: string;
  forwardGitHubConfig?: boolean;
  releaseCleanup?: () => void;
  approvalPolicy?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  realtimePersonaTimeoutMs?: number;
  realtimeStartTimeoutMs?: number;
  deliveryConfirmationTimeoutMs?: number;
  compactEvidenceTimeoutMs?: number;
  shutdownGraceMs?: number;
  initialEventCursor?: number;
  onEventCursorRecovery?: RuntimeEventCursorRecoveryReporter;
  spawnProcess?: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
  eventStore?: RuntimeEventStore;
  signalProcess?: ProcessSignal;
  processIdentity?: (pid: number) => string | null;
  pidAlive?: (pid: number) => boolean;
  resolveImagePath?: (ref: StructuredImageRef) => string;
}

type ChildProcessOwnership = "owned" | "gone" | "recycled" | "unknown";
type TerminationSignalResult = "attempted" | "unsafe";

export interface CodexThreadIdentity {
  threadId: string;
  path: string | null;
}

export interface CodexRealtimeWebRtcAnswer {
  sdp: string;
  realtimeSessionId: string | null;
  personaBootstrap: VoicePersonaBootstrapReceipt;
}

export interface CodexRealtimeWebRtcRejection {
  sdp: null;
  realtimeSessionId: null;
  personaBootstrap: VoicePersonaBootstrapReceipt & {
    insertion: "rejected";
    diagnostic: string;
  };
}

export type CodexRealtimeWebRtcResult = CodexRealtimeWebRtcAnswer | CodexRealtimeWebRtcRejection;

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
/**
 * Desktop-session variables forwarded ONLY to a host that holds a plugin grant
 * (issue #687). The bundled `computer-use` backend reads each of these to find
 * the operator's live session; without them it can only guess from defaults,
 * which breaks outside a single-session GNOME/Wayland layout. Kept minimal and
 * enumerated — no blanket environment passthrough:
 *
 *  - `DISPLAY`/`XAUTHORITY`: X11 (and Xwayland) server address plus the auth
 *    cookie that connection needs — used by the AT-SPI and `xprop` paths.
 *  - `WAYLAND_DISPLAY`: compositor socket name, for the Wayland window
 *    backends when it is not the default `wayland-0`.
 *  - `XDG_SESSION_TYPE`, `XDG_CURRENT_DESKTOP`, `DESKTOP_SESSION`: which
 *    backend the plugin selects (GNOME Shell introspection, KWin, COSMIC …).
 *
 * `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` are equally required and
 * already forwarded to every host above. Deliberately excluded: `YDOTOOL_SOCKET`
 * and every other input-backend variable — this grant is for reading the
 * desktop, and input stays behind the desktop permission path.
 */
const DESKTOP_ENV_ALLOWLIST = [
  "DISPLAY",
  "XAUTHORITY",
  "WAYLAND_DISPLAY",
  "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP",
  "DESKTOP_SESSION",
] as const;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_DELIVERY_CONFIRMATION_TIMEOUT_MS = 5 * 60_000;
/** How long a compaction may run before its outcome counts as unverified.
    Compaction is a model call over the whole thread, so the budget is generous;
    past it the operation terminalizes visibly rather than hanging (#862). */
const DEFAULT_COMPACT_EVIDENCE_TIMEOUT_MS = 5 * 60_000;
const ACTIVE_THREAD_READ_TIMEOUT_MULTIPLIER = 3;
const LATE_THREAD_READ_RESPONSE_TTL_MULTIPLIER = 3;
const MIN_LATE_THREAD_READ_RESPONSE_TTL_MS = 1_000;
const MAX_LATE_THREAD_READ_RESPONSES = 32;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;
const REALTIME_START_TIMEOUT_MS = 90_000;
/* First speech waits for the persona's durable insertion outcome. Keep that
   gate bounded when an app-server accepts the method and then stalls. */
const REALTIME_PERSONA_TIMEOUT_MS = 3_000;
/* Releasing the host must not block on a wedged app-server, but the hangup is
   worth a moment: skipping it strands the account's realtime slot. */
const REALTIME_HANGUP_TIMEOUT_MS = 2_000;
/**
 * The live model to ask for by name (#664). Sending none let the backend pick
 * `gpt-live-1-boulder-alpha`, and every such call was cut at 9.0–9.4 seconds
 * with `rate_limit_error / "You have reached your usage limit."` — including on
 * an account sitting at 5% of its window. Codex Desktop names
 * `gpt-live-1-codex` explicitly and holds a call on that same account for as
 * long as the operator talks, so the alpha default is the difference.
 */
const REALTIME_LIVE_MODEL = "gpt-live-1-codex";
const MAX_REALTIME_SDP_BYTES = 512 * 1024;
const MAX_REALTIME_SPEECH_BYTES = 8 * 1024;
const MAX_REALTIME_CONTEXT_ITEMS = 12;
const MAX_REALTIME_CONTEXT_ITEM_BYTES = 8 * 1024;
const MAX_REALTIME_CONTEXT_BYTES = 24 * 1024;
const MAX_REPLAY_ENVELOPE_BYTES = 256 * 1024;
const MAX_LINE_BYTES = MAX_STRUCTURED_IMAGE_ENCODED_BYTES + MAX_REPLAY_ENVELOPE_BYTES;
/**
 * A `thread/resume` (or `thread/read`) response replays the whole thread
 * history as one JSONL frame, and history the operator legally accumulated can
 * dwarf `MAX_LINE_BYTES` (issue #794: a production resume envelope reached
 * ~55 MB, dominated by replayed MCP tool-result text). Only the response the
 * host is itself awaiting for one of these methods may pass the frame guard,
 * and it is admitted through `CodexReplayFrameReducer`, which bounds every
 * string token while it streams. Every other oversized frame stays fail-closed.
 */
const REPLAY_ENVELOPE_METHODS = new Set(["thread/resume", "thread/read"]);
const REPLAY_REDUCTION_THRESHOLD_BYTES = MAX_REPLAY_ENVELOPE_BYTES;
const REPLAY_STRING_UNITS = 16 * 1024;
const MAX_REPLAY_RAW_UNITS = 512 * 1024 * 1024;
/* The streaming pass bounds memory, not the final frame: a history-heavy
   envelope can exceed MAX_LINE_BYTES on structure alone even with every
   string capped, and unit counts undercount UTF-8 bytes for non-ASCII text.
   `shrinkReducedReplayFrame` brings the finished frame under MAX_LINE_BYTES
   with progressively smaller string caps instead of failing the resume. */
const REPLAY_STREAM_OUTPUT_UNITS = 64 * 1024 * 1024;
const MAX_TRACKED_REPLAY_ENVELOPE_REQUESTS = 64;
/* Codex serializes responses as `{"id":N,"result":…}` (the test fake keeps the
   `jsonrpc` member first); anything else fails closed like before. */
const REPLAY_RESPONSE_PREFIX = /^\{(?:"jsonrpc":"2\.0",)?"id":(\d+),"result":/;
const REPLAY_FRAME_BUDGETS: ReplayFrameBudgets = {
  maxStringUnits: REPLAY_STRING_UNITS,
  /* Keep a full admissible image encoding intact (plus data-URL prefix room)
     so replayed inline images still collapse into bounded references. */
  maxImageStringUnits: MAX_STRUCTURED_IMAGE_ENCODED_BYTES + 64,
  maxOutputUnits: REPLAY_STREAM_OUTPUT_UNITS,
  maxRawUnits: MAX_REPLAY_RAW_UNITS,
};
const MAX_STDERR_TAIL_BYTES = 16 * 1024;
const MAX_PRE_RESTORE_FRAMES = 256;
const MAX_PRE_RESTORE_BYTES = 4 * 1024 * 1024;
const MUTATING_RPC_METHODS = new Set([
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "thread/realtime/start",
  "thread/realtime/stop",
  "thread/inject_items",
  "thread/compact/start",
]);

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function stringField(value: unknown, key: string): string | null {
  const object = record(value);
  return object && typeof object[key] === "string" ? object[key] as string : null;
}

function redactCodexHostDiagnosticText(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return hardenedRedact(message)
    .replace(/(["']?(?:cookie|set-cookie)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[redacted]");
}

export function redactCodexHostDiagnostic(value: unknown): string {
  return redactCodexHostDiagnosticText(value).slice(0, 500);
}

const safeError = redactCodexHostDiagnostic;

function stderrExitDiagnostic(value: string): string {
  return redactCodexHostDiagnosticText(value)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-4)
    .reverse()
    .map((line) => line.slice(-240))
    .join(" | ")
    .slice(0, 430);
}

function subscriptionEnv(
  source: NodeJS.ProcessEnv,
  codexHome?: string,
  desktopSession = false,
  forwardGitHubConfig = false,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: source.NODE_ENV };
  const names = desktopSession ? [...CHILD_ENV_ALLOWLIST, ...DESKTOP_ENV_ALLOWLIST] : CHILD_ENV_ALLOWLIST;
  for (const name of names) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  if (forwardGitHubConfig && source.GH_CONFIG_DIR !== undefined) env.GH_CONFIG_DIR = source.GH_CONFIG_DIR;
  if (codexHome) env.CODEX_HOME = codexHome;
  /* Provenance the resources rail can verify later: `codex app-server` is a
     public command line, so only this stamp says the process is a host of
     ours rather than someone else's client (#1199). */
  env[STRUCTURED_HOST_STAMP_ENV] = structuredHostStamp();
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

function modelSupportsImageInput(value: unknown, requestedModel: string | undefined): boolean {
  const models = record(value)?.data;
  if (!Array.isArray(models)) return false;
  const candidates = models.map(record).filter((model): model is JsonObject => model !== null);
  const selected = requestedModel
    ? candidates.find((model) => stringField(model, "id") === requestedModel)
    : candidates.find((model) => model.isDefault === true);
  return Array.isArray(selected?.inputModalities) && selected.inputModalities.includes("image");
}

function resumedTurns(value: unknown): JsonObject[] {
  const outer = record(value);
  const thread = record(outer?.thread) ?? outer;
  if (Array.isArray(thread?.turns)) return thread.turns.map(record).filter((turn): turn is JsonObject => turn !== null);
  const page = record(thread?.initialTurnsPage);
  return Array.isArray(page?.data) ? page.data.map(record).filter((turn): turn is JsonObject => turn !== null) : [];
}

/** Codex 0.151+ deprecates `ThreadReadParams.includeTurns`: a paginated thread
    refuses full-history hydration with "list_turns is not supported yet" and
    expects `thread/turns/list` paging instead (#1332). */
function hydrationUnsupported(reason: string): boolean {
  return reason.startsWith("Codex app-server request failed:") && /not supported/i.test(reason);
}

/* The rollout is bounded before parsing so a very long thread cannot pull its
   whole history into memory; the fallback consumers only need the window near
   one end, and a partial leading line after the cut is skipped by JSON.parse. */
const ROLLOUT_FALLBACK_READ_BYTES = 16 * 1024 * 1024;

const ROLLOUT_TERMINAL_TURN_STATUS: Record<string, string> = {
  turn_completed: "completed",
  turn_complete: "completed",
  turn_aborted: "interrupted",
  turn_failed: "failed",
};

/** Turns reconstructed from the canonical rollout JSONL on disk. Codex 0.151
    refuses full-history hydration on some threads and stubs the pagination
    API it recommends instead ("list_turns is not supported yet"), so the
    session store file is the one version-independent source of persisted
    turns (#1332). Items are normalized to the wire shape the replay and
    confirmation consumers expect (`clientId`, `userMessage`). */
export function rolloutTurnsFromDisk(pathname: string | null | undefined): JsonObject[] {
  if (!pathname) return [];
  let raw: string;
  try {
    const stat = fs.statSync(pathname);
    if (!stat.isFile()) return [];
    if (stat.size > ROLLOUT_FALLBACK_READ_BYTES) {
      const descriptor = fs.openSync(pathname, "r");
      try {
        const buffer = Buffer.alloc(ROLLOUT_FALLBACK_READ_BYTES);
        const read = fs.readSync(descriptor, buffer, 0, buffer.length, stat.size - buffer.length);
        raw = buffer.subarray(0, read).toString("utf8");
      } finally {
        fs.closeSync(descriptor);
      }
    } else {
      raw = fs.readFileSync(pathname, "utf8");
    }
  } catch {
    return [];
  }
  const order: string[] = [];
  const turns = new Map<string, { id: string; status?: string; items: JsonObject[] }>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record(record(parsed)?.payload);
    if (!payload) continue;
    const payloadType = stringField(payload, "type");
    const turnId = stringField(payload, "turn_id") ?? stringField(payload, "turnId");
    if (!payloadType || !turnId) continue;
    let turn = turns.get(turnId);
    if (!turn) {
      turn = { id: turnId, items: [] };
      turns.set(turnId, turn);
      order.push(turnId);
    }
    const terminal = ROLLOUT_TERMINAL_TURN_STATUS[payloadType];
    if (terminal) {
      turn.status = terminal;
      continue;
    }
    if (payloadType !== "item_completed") continue;
    const item = record(payload.item);
    if (!item) continue;
    const itemType = stringField(item, "type");
    const clientId = stringField(item, "client_id") ?? stringField(item, "clientId");
    turn.items.push({
      ...item,
      ...(itemType ? { type: itemType === "UserMessage" ? "userMessage" : itemType } : {}),
      ...(clientId ? { clientId } : {}),
    });
  }
  return order.map((id) => {
    const turn = turns.get(id)!;
    return { id: turn.id, status: turn.status ?? "inProgress", items: turn.items } as JsonObject;
  });
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

function bufferedNotificationReplayKey(event: UnsequencedEvent | RuntimeEvent): string | null {
  if (event.kind === "delta") return JSON.stringify([event.kind, event.turnId, event.text]);
  if (event.kind === "attention") {
    return JSON.stringify([event.kind, event.id, event.method, event.attention]);
  }
  return null;
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

function realtimeMessage(value: unknown): RealtimeInitialItem | null {
  const item = record(value);
  if (!item) return null;
  const type = stringField(item, "type");
  const message = record(item.message);
  const role = stringField(item, "role") ?? stringField(message, "role");
  const user = type === "userMessage"
    || type === "user_message"
    || type === "user"
    || (type === "message" && role === "user");
  const assistant = type === "agentMessage"
    || type === "agent_message"
    || type === "assistant"
    || (type === "message" && role === "assistant");
  if (!user && !assistant) return null;
  const wireText = stringField(item, "text")
    ?? userMessageText(item)
    ?? (message ? stringField(message, "text") ?? userMessageText(message) : null);
  if (!wireText) return null;
  return user
    ? { role: "user", text: decodeCodexStructuredUserText(wireText).text }
    : { role: "assistant", text: wireText };
}

function utf8Tail(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return { text: value, truncated: false };
  let start = encoded.byteLength - maxBytes;
  while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start += 1;
  return { text: encoded.subarray(start).toString("utf8"), truncated: true };
}

function selectRealtimeContext(events: readonly RuntimeEvent[]): RealtimeContextSelection {
  let selected: RealtimeContextCandidate[] = [];
  let truncated = false;
  for (const event of events) {
    if (event.kind === "delta") {
      if (!event.text) continue;
      const latest = selected.at(-1);
      if (latest?.role === "assistant" && latest.turnId === event.turnId) {
        const bounded = utf8Tail(latest.text + event.text, MAX_REALTIME_CONTEXT_ITEM_BYTES);
        latest.text = bounded.text;
        truncated ||= bounded.truncated;
      } else {
        const bounded = utf8Tail(event.text, MAX_REALTIME_CONTEXT_ITEM_BYTES);
        selected = [{
          role: "assistant",
          text: bounded.text,
          turnId: event.turnId,
          source: "durable-delta",
        }];
        truncated = bounded.truncated;
      }
      continue;
    }
    if (event.kind !== "item" || event.phase !== "completed") continue;
    const message = realtimeMessage(event.item);
    if (!message) continue;
    if (message.role === "user") {
      if (selected.length === 0) continue;
      const bounded = utf8Tail(message.text, MAX_REALTIME_CONTEXT_ITEM_BYTES);
      selected.push({
        ...message,
        text: bounded.text,
        turnId: event.turnId,
        source: "durable-item",
      });
      truncated ||= bounded.truncated;
      if (selected.length > MAX_REALTIME_CONTEXT_ITEMS) {
        selected = [selected[0]!, ...selected.slice(-(MAX_REALTIME_CONTEXT_ITEMS - 1))];
        truncated = true;
      }
      continue;
    }
    const draftIndex = selected.findLastIndex((candidate) =>
      candidate.role === "assistant"
      && (event.turnId === null || candidate.turnId === event.turnId));
    if (draftIndex >= 0) {
      selected = [];
      truncated = false;
    }
  }
  selected = selected.filter((candidate) => candidate.text.length > 0);
  let selectedBytes = selected.reduce((total, candidate) =>
    total + Buffer.byteLength(candidate.text, "utf8"), 0);
  while (selectedBytes > MAX_REALTIME_CONTEXT_BYTES && selected.length > 1) {
    const removed = selected.splice(1, 1)[0]!;
    selectedBytes -= Buffer.byteLength(removed.text, "utf8");
    truncated = true;
  }
  return {
    items: selected.map(({ role, text }) => ({ role, text })),
    diagnosticItems: selected.map(({ role, source, text }) => ({
      role,
      source,
      bytes: Buffer.byteLength(text, "utf8"),
    })),
    truncated,
  };
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
  private readonly realtimePersonaTimeoutMs: number;
  private readonly realtimeStartTimeoutMs: number;
  private readonly deliveryConfirmationTimeoutMs: number;
  private readonly compactEvidenceTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private readonly eventStore: RuntimeEventStore;
  private readonly effort: string | undefined;
  private readonly signalProcess: ProcessSignal;
  private readonly processIdentity: (pid: number) => string | null;
  private readonly pidAlive: (pid: number) => boolean;
  private readonly childStartIdentity: string | null;
  private readonly onEventCursorRecovery: RuntimeEventCursorRecoveryReporter | undefined;
  private readonly resolveImagePath: (ref: StructuredImageRef) => string;
  private readonly pending = new Map<number, PendingRpc>();
  private pendingRealtimeStart: PendingRealtimeStart | null = null;
  /* Why a live call's failure has to be retained (#664): the browser holds the
     WebRTC leg, while `thread/realtime/error` arrives on the app-server's own
     sideband channel. Once the start has resolved there is no promise left to
     reject, so the reason used to be dropped and the operator saw only the
     transport dying — "Realtime connection was interrupted" standing in for
     what the backend actually said ("You have reached your usage limit."). */
  private realtimeFailure: CodexRealtimeFailure | null = null;
  private realtimeSessionId: string | null = null;
  private readonly lateThreadReadResponses = new Map<number, number>();
  private readonly replayEnvelopeRequestIds = new Set<number>();
  private replayReduction: CodexReplayFrameReducer | null = null;
  private readonly subscribers = new Set<Subscriber>();
  private readonly events: RuntimeEvent[] = [];
  private readonly confirmedDeliveries = new Map<string, {
    receipt: DeliveryReceipt;
    text: string | null;
    contentDigest: string | null;
  }>();
  private readonly pendingDeliveries = new Map<string, PendingDelivery>();
  private readonly pendingCompactions = new Map<string, PendingCompaction>();
  private readonly realtimeDeliveries = new Map<string, RealtimeDeliveryState>();
  private readonly voiceStreams = new Map<string, VoiceStreamState>();
  /* A host's thread id is immutable, so one memo covers its one stable persona
     item. Successor starts join the same insertion promise. */
  private unresolvedVoicePersonaBootstrap: VoicePersonaBootstrap | null = null;
  private voicePersonaBootstrapInsertion: VoicePersonaBootstrapInsertion | null = null;
  private voicePersonaBootstrapAccepted = false;
  private readonly pendingVoiceChunks = new Map<string, string>();
  private readonly cancelledVoiceTurns = new Set<string>();
  private readonly activeRealtimeDeliveries = new Map<string, {
    digest: string;
    promise: Promise<{ deliveryId: string; acknowledged: true }>;
  }>();
  private readonly attentions = new Map<string, PendingAttention>();
  private readonly stateListeners = new Set<(state: HostState) => void>();
  private readonly preRestoreEvents: UnsequencedEvent[] = [];
  private readonly preRestoreMessages: Array<{ message: JsonObject; bytes: number }> = [];
  private readonly bufferedTerminalTurnIds = new Set<string>();
  private bufferedNotificationOverlap: string[] = [];
  private nextRpcId = 1;
  private stdoutBuffer = "";
  private stderrTail = "";
  private preRestoreBytes = 0;
  private eventLedgerRestored = false;
  private cursor: number;
  private activeTurnId: string | null = null;
  private protocolVersion: string | null = null;
  private account: HostState["account"] = null;
  private engineStatus: "active" | "idle" | "unhosted" | "dead" = "idle";
  private activeFlags: string[] = [];
  /** Image capability learned from `model/list`. An RPC fault leaves the
      value unknown, keeps admission fail-closed, and schedules discovery on
      the next image send. */
  private imageInputSupport: "supported" | "unsupported" | "unknown" = "unknown";
  private requestedModel: string | undefined;
  private realtimeDeliveryEpoch = 0;
  private releasing = false;
  private released = false;
  private dead = false;
  private reaped = false;
  private terminationStarted = false;
  private terminationTimer: ReturnType<typeof setTimeout> | null = null;
  private terminationPromise: Promise<void> | null = null;
  private resolveTermination: (() => void) | null = null;
  private failureCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private releasePromise: Promise<void> | null = null;
  private releaseCleanup: (() => void) | null;
  private writerFence: (() => boolean) | null = null;
  private ledgerFailed = false;
  private failure: Error | null = null;
  private readonly reapedPromise: Promise<void>;
  private resolveReaped!: () => void;

  private constructor(child: ChildProcessWithoutNullStreams, identity: CodexThreadIdentity, options: CodexAppServerHostOptions) {
    this.child = child;
    this.identity = identity;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.realtimePersonaTimeoutMs = options.realtimePersonaTimeoutMs ?? REALTIME_PERSONA_TIMEOUT_MS;
    this.realtimeStartTimeoutMs = options.realtimeStartTimeoutMs ?? REALTIME_START_TIMEOUT_MS;
    this.deliveryConfirmationTimeoutMs = options.deliveryConfirmationTimeoutMs
      ?? DEFAULT_DELIVERY_CONFIRMATION_TIMEOUT_MS;
    this.compactEvidenceTimeoutMs = options.compactEvidenceTimeoutMs ?? DEFAULT_COMPACT_EVIDENCE_TIMEOUT_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.eventStore = options.eventStore ?? new FileRuntimeEventStore();
    this.effort = options.effort;
    this.signalProcess = options.signalProcess ?? process.kill;
    this.processIdentity = options.processIdentity ?? ((pid) => procBackend.processIdentity(pid));
    this.pidAlive = options.pidAlive ?? ((pid) => procBackend.pidAlive(pid));
    this.releaseCleanup = options.releaseCleanup ?? null;
    this.childStartIdentity = child.pid ? this.processIdentity(child.pid) : null;
    this.onEventCursorRecovery = options.onEventCursorRecovery;
    this.resolveImagePath = options.resolveImagePath ?? ((ref) => {
      const store = runtimeImageStore();
      store.read(ref);
      return store.pathFor(ref);
    });
    this.cursor = options.initialEventCursor ?? 0;
    this.reapedPromise = new Promise((resolve) => { this.resolveReaped = resolve; });
    child.stdout.on("data", (chunk: Buffer | string) => this.acceptStdout(String(chunk)));
    child.stderr.on("data", (chunk: Buffer | string) => this.acceptStderr(String(chunk)));
    child.stdin.on("error", (error) => {
      if (!this.releasing && !this.released) this.fail(new Error(`Codex app-server stdin failed: ${safeError(error)}`));
    });
    child.on("error", (error) => this.fail(new Error(`Codex app-server child failed: ${safeError(error)}`)));
    child.on("close", () => {
      this.reaped = true;
      this.completeGroupCleanupAfterReap();
      this.resolveReaped();
      if (this.releasing) {
        this.startFailureCleanup();
      } else if (!this.released) {
        if (this.dead) this.notifyStateListeners();
        else {
          const diagnostic = stderrExitDiagnostic(this.stderrTail);
          this.fail(new Error(`Codex app-server child exited${diagnostic ? `: ${diagnostic}` : ""}`));
        }
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
      ...(options.permissionProfile && options.permissionProfileConfig
        ? [
          "-c", `default_permissions=${JSON.stringify(options.permissionProfile)}`,
          "-c", options.permissionProfileConfig,
        ]
        : []),
      "app-server",
      "--enable",
      "realtime_conversation",
    ];
    const granted = grantedPlugins(options.plugins);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(options.binary ?? process.env.LLV_CODEX_BINARY ?? "codex", args, {
        cwd: options.cwd,
        env: withTelegramConnectorGrant(
          subscriptionEnv(
            options.env ?? process.env,
            options.codexHome,
            granted.length > 0,
            options.forwardGitHubConfig === true,
          ),
          options.mcpServers,
        ),
        detached: true,
      });
    } catch (error) {
      options.releaseCleanup?.();
      throw error;
    }
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
      provisional.requestedModel = options.model;
      try {
        provisional.imageInputSupport = modelSupportsImageInput(
          await provisional.rpc("model/list", {}),
          options.model,
        ) ? "supported" : "unsupported";
      } catch {
        /* A probe fault leaves capability unknown and admission fail-closed.
           An image send triggers another discovery attempt. */
        provisional.imageInputSupport = "unknown";
      }
      const config = headlessCodexThreadConfig(
        await provisional.rpc("config/read", { cwd: options.cwd, includeLayers: false }),
        options.allowSubagents === true,
        options.mcpServers,
        granted,
      );
      const result = threadId
        ? await provisional.resumeThreadTolerantly({
          threadId,
          ...(options.permissionProfile ? { permissions: options.permissionProfile } : {}),
          config,
        })
        : await provisional.rpc("thread/start", {
          cwd: options.cwd,
          ...(options.model ? { model: options.model } : {}),
          ...(options.permissionProfile
            ? { permissions: options.permissionProfile }
            : { sandbox: options.sandbox ?? "read-only" }),
          approvalPolicy: options.approvalPolicy ?? "never",
          config,
        });
      const identity = threadFromResult(result, threadId ? "thread/resume" : "thread/start");
      if (threadId && identity.threadId !== threadId) {
        throw new Error("thread/resume returned a different thread id");
      }
      provisional.identity.threadId = identity.threadId;
      provisional.identity.path = identity.path;
      if (granted.length > 0) await provisional.verifyPluginGrant(granted, config);
      provisional.rememberConfirmedDeliveries(result);
      provisional.restoreEvents();
      provisional.beginBufferedNotificationReconciliation();
      provisional.flushPreRestoreEvents();
      provisional.flushPreRestoreMessages(threadId ? result : null);
      if (threadId) provisional.reconcileThreadHistory(result);
      provisional.reconcileAfterOpen(threadStatus(result), resumedActiveTurnId(result));
      provisional.endBufferedNotificationReconciliation();
      return provisional;
    } catch (error) {
      try {
        await provisional.release();
      } catch (cleanupError) {
        throw new StructuredHostAdoptionCleanupError(safeError(error), provisional, { cause: cleanupError });
      }
      throw new Error(safeError(error));
    }
  }

  /**
   * Fails a granted thread closed when its realized tool surface is wider than
   * the grant (issue #687). Codex resolves plugins from the global config, so
   * `features.plugins` is the only per-thread gate it applies — this check is
   * what turns that coarse gate into the allowlist: every MCP server the thread
   * gained beyond its own configured table must belong to a granted plugin, or
   * the host never opens. A grant that cannot be verified is not granted.
   */
  private async verifyPluginGrant(granted: readonly string[], config: JsonObject): Promise<void> {
    const configured = new Set(Object.keys(record(config.mcp_servers) ?? {}));
    const allowed = new Set(grantedPluginServerNames(granted));
    let listed: unknown;
    try {
      listed = await this.rpc("mcpServerStatus/list", { threadId: this.identity.threadId });
    } catch (error) {
      throw new Error(`Codex plugin grant could not be verified: ${safeError(error)}`);
    }
    const entries = record(listed)?.data ?? listed;
    if (!Array.isArray(entries)) throw new Error("Codex plugin grant could not be verified: mcpServerStatus/list returned no server list");
    const unexpected = entries
      .map((entry) => stringField(record(entry), "name"))
      .filter((name): name is string => name !== null && !configured.has(name) && !allowed.has(name));
    if (unexpected.length > 0) {
      throw new Error(`Codex plugin grant surfaced servers outside the allowlist: ${[...new Set(unexpected)].sort().join(", ")}`);
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

  /** On-demand retry of capability discovery after a probe fault. A verdict
      (either way) sticks; another fault stays unknown and fail-closed. A
      transition to supported re-advertises the capability flag. */
  private async refreshImageInputSupport(): Promise<void> {
    try {
      this.imageInputSupport = modelSupportsImageInput(await this.rpc("model/list", {}), this.requestedModel)
        ? "supported"
        : "unsupported";
    } catch {
      return;
    }
    if (this.imageInputSupport === "supported") this.setSessionStatus(this.engineStatus, this.activeFlags);
  }

  async send(entry: QueueEntry): Promise<DeliveryReceipt> {
    if (this.dead || this.releasing || this.released || !this.writerFenceAllowsActuation()) {
      return { outcome: "rejected", reason: "dead-host" };
    }
    const normalized = normalizeQueueEntry(entry);
    if (normalized.content.images.length) {
      if (this.imageInputSupport === "unknown") await this.refreshImageInputSupport();
      if (this.imageInputSupport === "unsupported") {
        throw new Error("The selected Codex model does not advertise image input through app-server.");
      }
      if (this.imageInputSupport !== "supported") {
        throw new Error("Codex image capability discovery is temporarily unavailable; retry shortly.");
      }
    }
    entry = {
      id: normalized.id,
      text: normalized.content.text,
      content: normalized.content,
      contentDigest: normalized.contentDigest,
      ...(normalized.expectedTurnId !== undefined ? { expectedTurnId: normalized.expectedTurnId } : {}),
      ...(normalized.runtime ? { runtime: normalized.runtime } : {}),
      ...(normalized.selectedContext ? { selectedContext: normalized.selectedContext } : {}),
      ...(normalized.origin ? { origin: normalized.origin } : {}),
    };
    if (!entry.id) throw new Error("queue entry id is required");
    const confirmed = await this.confirmedDelivery(entry);
    if (confirmed) return confirmed;
    const currentTurn = this.activeTurnId;
    if (entry.expectedTurnId !== undefined && entry.expectedTurnId !== currentTurn) {
      return { outcome: "rejected", reason: "stale-turn" };
    }
    const input = [
      ...normalized.content.images.map((image) => ({ type: "localImage", path: this.resolveImagePath(image) })),
      {
        type: "text",
        text: encodeCodexStructuredUserText(
          normalized.content.text,
          normalized.content.images.length > 0 ? normalized.contentDigest : undefined,
          /* #844: the selected-card reference becomes durable HERE, on the
             canonical structured-user record, so it survives a restart and a
             re-parse and the transcript row renders the composer badge. */
          normalized.selectedContext,
          /* #1117: authorship lands on the same record, so the feed can tell
             the operator's bubble from an inter-agent relay without a join. */
          normalized.origin,
        ),
      },
    ];
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
    /* Per-turn effort (issue #390 §5): the snapshot riding the durable entry
       outranks the host-fixed default — the only axis `turn/start` accepts
       (model and service tier are thread-level in this protocol, so the
       negotiated capability advertises `perTurnModel: false`). A token outside
       the CLI tier vocabulary falls back to the host default rather than
       failing the turn over a settings blemish; model fit for an in-vocabulary
       tier is the app server's own verdict (per-model scales exceed the base
       engine list — sol/terra accept `ultra`). */
    const perTurnEffort = entry.runtime?.effort && isKnownEffortTier(entry.runtime.effort)
      ? entry.runtime.effort
      : undefined;
    const effort = perTurnEffort ?? this.effort;
    const result = await this.rpc("turn/start", {
      threadId: this.identity.threadId,
      ...(effort ? { effort } : {}),
      input,
      clientUserMessageId: entry.id,
    });
    const turnId = turnIdFromResult(result, "turn/start");
    this.activeTurnId = turnId;
    this.notifyStateListeners();
    return this.awaitDeliveryConfirmation(entry, { outcome: "turn-started", turnId });
  }

  /** Persisted-thread snapshot for materialization evidence: full-history
      hydration first; a paginated thread that refuses it yields the same
      evidence through a metadata-only read plus one ascending full-items
      turns page (#1332). Every other error propagates unchanged so the
      caller's evidence classification stays intact. */
  /** thread/resume with the #1332 fallback: a paginated thread refuses
      full-history resume, so retry with excludeTurns (metadata plus
      live-resume state) and synthesize the persisted turns from the rollout
      on disk — codex 0.151 stubs the pagination API its own deprecation
      notice recommends, so the session store file is the only
      version-independent source. */
  private async resumeThreadTolerantly(params: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.rpc("thread/resume", params);
    } catch (error) {
      if (!hydrationUnsupported(safeError(error))) throw error;
      const resumed = await this.rpc("thread/resume", { ...params, excludeTurns: true });
      const outer = record(resumed) ?? {};
      const thread = record(outer.thread) ?? {};
      const turns = rolloutTurnsFromDisk(stringField(thread, "path") ?? this.identity.path);
      return { ...outer, thread: { ...thread, turns } };
    }
  }

  /** Hydrated thread read with the #1332 fallback, returning the hydrated
      response shape either way so every consumer of `thread.turns` keeps
      working. On refusal the persisted turns come from the rollout on disk;
      `window` bounds which end survives — "first" for materialization
      evidence, "latest" for delivery confirmation; always oldest-first. */
  private async readThreadWithTurns(window: "first" | "latest", timeoutMs?: number): Promise<unknown> {
    try {
      return await this.rpc("thread/read", {
        threadId: this.identity.threadId,
        includeTurns: true,
      }, timeoutMs);
    } catch (error) {
      if (!hydrationUnsupported(safeError(error))) throw error;
      const result = await this.rpc("thread/read", { threadId: this.identity.threadId }, timeoutMs);
      const thread = record(record(result)?.thread) ?? {};
      const persisted = rolloutTurnsFromDisk(stringField(thread, "path") ?? this.identity.path);
      const turns = window === "first" ? persisted.slice(0, 64) : persisted.slice(-64);
      return { thread: { ...thread, turns } };
    }
  }

  async sessionMaterializationEvidence(clientMessageId: string): Promise<SessionMaterializationEvidence> {
    let result: unknown;
    try {
      result = await this.readThreadWithTurns("first");
    } catch (error) {
      const reason = safeError(error);
      if (/not materialized yet/i.test(reason) && /before first user message/i.test(reason)) {
        const confirmed = this.confirmedDeliveries.get(clientMessageId);
        const turnId = confirmed?.receipt.outcome !== "rejected"
          ? confirmed?.receipt.turnId ?? null
          : null;
        const terminal = turnId
          ? this.events.findLast((event): event is Extract<RuntimeEvent, { kind: "turn-ended" }> =>
            event.kind === "turn-ended" && event.turnId === turnId)
          : null;
        /* Fresh Codex threads are in-memory placeholders until their first
           turn persists a rollout. During a live turn this response is a
           pending state. Once that same turn has ended, the app-server has
           supplied the decisive contradiction: it accepted and completed the
           first message while its session store still has no first message. */
        if (terminal) {
          return {
            state: "failed",
            reason: terminal.status === "completed"
              ? "Codex app-server completed the confirmed first turn without materializing its session"
              : `Codex app-server ended the confirmed first turn as ${terminal.status} without materializing its session`,
          };
        }
        return {
          state: "absent",
          reason: "Codex app-server has not materialized the confirmed first message yet",
        };
      }
      if (/thread\/read timed out/i.test(reason)) {
        return { state: "unavailable", reason };
      }
      if (reason.startsWith("Codex app-server request failed:")) {
        return /(?:thread|conversation).*(?:not found|unknown|does not exist)/i.test(reason)
          ? { state: "failed", reason }
          : { state: "unavailable", reason };
      }
      throw error;
    }
    let persistedIdentity: CodexThreadIdentity;
    try {
      persistedIdentity = threadFromResult(result, "thread/read");
    } catch (error) {
      return { state: "failed", reason: safeError(error) };
    }
    if (persistedIdentity.threadId !== this.identity.threadId) {
      return { state: "failed", reason: "Codex app-server read back a different session identity" };
    }
    if (!persistedIdentity.path || persistedIdentity.path !== this.identity.path) {
      return { state: "failed", reason: "Codex app-server did not confirm the canonical transcript path" };
    }
    const persistedFirstMessage = resumedTurns(result).some((turn) =>
      Array.isArray(turn.items)
      && turn.items.some((item) => stringField(item, "clientId") === clientMessageId));
    return persistedFirstMessage
      ? { state: "materialized" }
      : { state: "absent", reason: "Codex app-server did not read back the confirmed first message" };
  }

  async interrupt(turnRef: string): Promise<void> {
    if (this.dead || this.releasing || this.released || !this.writerFenceAllowsActuation()) {
      throw new Error("Codex app-server host is unavailable");
    }
    if (!turnRef || this.activeTurnId !== turnRef) throw new Error("active turn fence is stale");
    await this.rpc("turn/interrupt", { threadId: this.identity.threadId, turnId: turnRef });
  }

  /**
   * Manual context compaction as an engine control (#862). It travels the
   * app-server control channel — `thread/compact/start` for the thread this
   * host owns — so there is no path by which it becomes a user turn: no
   * `turn/start`, no `turn/steer`, no message content anywhere in the request.
   * The promise settles only on a *completed* `contextCompaction` item, so the
   * durable receipt cannot claim success from an accepted request, nor from a
   * compaction that has merely started. `thread/compact/start` takes exactly
   * `{ threadId }` and returns an empty ack, so nothing about the outcome comes
   * back on the request leg.
   */
  async compact(request: RuntimeCompactRequest): Promise<RuntimeCompactOutcome> {
    if (this.dead || this.releasing || this.released || !this.writerFenceAllowsActuation()) {
      throw new StructuredCompactError("Codex app-server host is unavailable", "refused");
    }
    if (request.threadId && request.threadId !== this.identity.threadId) {
      throw new StructuredCompactError("compact target thread is not the thread this host owns", "refused");
    }
    /* The boundary refuses a live turn even though admission already fenced it:
       the turn may have started between admission and execution, and compacting
       underneath a running turn is exactly the race this control must not run. */
    if (this.activeTurnId) {
      throw new StructuredCompactError("a turn is active; compaction would race it", "refused");
    }
    const existing = this.pendingCompactions.get(request.operationId);
    if (existing) return existing.promise;
    /* One compaction per thread at a time. The delivery queue already holds a
       second request back, so reaching here means something bypassed it — and
       a concurrent `thread/compact/start` would compact the thread twice and
       leave both waiters settling on whichever item arrived first. */
    if (this.pendingCompactions.size > 0) {
      throw new StructuredCompactError("a compaction is already running on this thread", "refused");
    }

    let settle!: PendingCompaction;
    const promise = new Promise<RuntimeCompactOutcome>((resolve, reject) => {
      settle = { promise: undefined as unknown as Promise<RuntimeCompactOutcome>, resolve, reject, timer: undefined };
    });
    settle.promise = promise;
    /* Registered before the request so a compaction the app-server reports
       immediately cannot land in the gap and go unobserved. */
    this.pendingCompactions.set(request.operationId, settle);
    void promise.catch(() => undefined);
    try {
      /* Budgeted like the compaction itself, not like an ordinary call.
         `thread/compact/start` is a mutating method, so the default 30 s
         request budget would fail the whole host — and take the operator's live
         conversation with it — the moment a large thread takes longer than that
         to begin compacting.

         The fence at the far end of this budget is deliberate, not inherited: a
         mutating call whose ack never arrives has left the thread in a state
         this host cannot describe, and every other mutating method here fails
         closed for that reason. Five minutes of silence on an ack that normally
         returns at once is that case. The compaction itself terminalizes
         `unverified` either way. */
      await this.rpc(
        "thread/compact/start",
        { threadId: this.identity.threadId },
        this.compactEvidenceTimeoutMs,
      );
    } catch (error) {
      /* The evidence may have won the race: a compaction the app-server already
         reported is a fact, and a late failure on the request leg must not
         overwrite it. */
      if (this.pendingCompactions.get(request.operationId) !== settle) return promise;
      this.pendingCompactions.delete(request.operationId);
      const message = safeError(error);
      /* A refusal proves nothing was compacted; a request that timed out may
         still have started one, and `thread/compact/start` is registered as
         mutating so the transport says which of the two happened. */
      throw new StructuredCompactError(message, /outcome is uncertain/.test(message) ? "unverified" : "refused");
    }
    if (this.pendingCompactions.get(request.operationId) === settle) {
      settle.timer = setTimeout(() => {
        this.pendingCompactions.delete(request.operationId);
        settle.reject(new StructuredCompactError(
          "Codex compaction evidence did not arrive; the outcome is unverified",
          "unverified",
        ));
      }, this.compactEvidenceTimeoutMs);
    }
    return promise;
  }

  /**
   * Reads one `contextCompaction` item as compaction evidence.
   *
   * The item itself carries no outcome — its whole shape is `{ id, type }` per
   * `ContextCompactionThreadItem` in the app-server schema, and that holds for
   * every such item in the local event ledgers. The lifecycle *phase* is
   * therefore the only signal it offers: `item/started` says a compaction began
   * and `item/completed` says it finished, so only the completed phase settles a
   * waiter. Settling on the first sighting would report `delivered` for a
   * compaction still running and release queued messages into a thread
   * mid-compaction.
   *
   * There is consequently no fast failure signal: a compaction that starts and
   * never completes is caught by `compactEvidenceTimeoutMs` (or sooner by host
   * death), and terminalizes unverified — which is the honest verdict, since
   * nothing on the wire says what became of it.
   *
   * Nor is there anything to correlate on. The item's `id` is minted by the
   * engine and appears for the first time in this notification, so ANY completed
   * compaction on the owned thread settles the waiter — including an
   * auto-compaction that happened to land in the same window, whose id the
   * receipt would then record. Two guards make that window small rather than
   * closed: `compact()` refuses while a turn is active, and the delivery queue
   * holds messages behind an unfinished compaction, so the thread should have no
   * turn running to auto-compact. Recorded as a known limit of `{ id, type }`.
   */
  private acceptCompactionItem(item: unknown, phase: "started" | "completed"): void {
    if (phase !== "completed" || this.pendingCompactions.size === 0) return;
    const compaction = record(item);
    if (!compaction) return;
    this.settlePendingCompactions({ compactionId: stringField(compaction, "id") });
  }

  /**
   * The deprecated `thread/compacted` notification, accepted as a second
   * evidence channel for the thread this host owns.
   *
   * Every `contextCompaction` item observed locally came from auto-compaction
   * *inside a turn*, and a manual `thread/compact/start` runs against an idle
   * thread — nothing available here proves the app-server emits the item
   * lifecycle in that case too. If it only sends this notification, reading the
   * item alone would leave every manual compaction to time out as unverified
   * and the control would never once report success. So the item stays the
   * preferred channel (it is the documented replacement, and it names the
   * compaction), and this one is a corroborating fallback rather than the
   * primary source: whichever arrives first settles the waiters.
   */
  private acceptCompactedNotification(params: JsonObject): void {
    if (this.pendingCompactions.size === 0) return;
    if (stringField(params, "threadId") !== this.identity.threadId) return;
    this.settlePendingCompactions({ compactionId: null });
  }

  /** A host that dies mid-compaction leaves the engine outcome unknown, so the
      waiters reject as `unverified` and terminalize the receipt uncertain. */
  private rejectPendingCompactions(error: Error): void {
    this.settlePendingCompactions(new StructuredCompactError(safeError(error), "unverified"));
  }

  /** One thread compacts once at a time, so every waiter shares the outcome. */
  private settlePendingCompactions(outcome: RuntimeCompactOutcome | StructuredCompactError): void {
    if (this.pendingCompactions.size === 0) return;
    const waiting = [...this.pendingCompactions.values()];
    this.pendingCompactions.clear();
    for (const compaction of waiting) {
      if (compaction.timer) clearTimeout(compaction.timer);
      if (outcome instanceof StructuredCompactError) compaction.reject(outcome);
      else compaction.resolve(outcome);
    }
  }

  /** A terminal compaction turn gives stronger evidence than the compact item:
      `failed` proves the engine rejected the operation, while `interrupted`
      leaves its effect uncertain. The app-server does not put an operation id
      on either notification, and this host admits only one idle-thread
      compaction at a time. */
  private settlePendingCompactionsFromTerminalTurn(
    turn: JsonObject | null,
    status: "completed" | "interrupted" | "error",
  ): void {
    if (status === "completed" || this.pendingCompactions.size === 0) return;
    const providerError = record(turn?.error);
    const message = safeError(stringField(providerError, "message")
      ?? (status === "interrupted"
        ? "Codex compaction was interrupted; the outcome is unverified"
        : "Codex compaction failed"));
    this.settlePendingCompactions(new StructuredCompactError(
      message,
      status === "interrupted" ? "unverified" : "refused",
    ));
  }

  async startRealtimeWebRtc(sdp: string): Promise<CodexRealtimeWebRtcResult> {
    if (this.dead || this.releasing || this.released || !this.writerFenceAllowsActuation()) {
      throw new Error("Codex app-server host is unavailable");
    }
    /* SDP grammar requires every line — including the last — to end in CRLF;
       OpenAI's parser fails a trimmed offer with "unmarshal SDP: EOF". Keep
       the payload intact and only heal a missing terminal newline. */
    const offer = sdp.endsWith("\n") ? sdp : `${sdp}\r\n`;
    if (!offer.trimStart().startsWith("v=0") || Buffer.byteLength(offer, "utf8") > MAX_REALTIME_SDP_BYTES) {
      throw new Error("A valid WebRTC SDP offer is required");
    }
    if (this.pendingRealtimeStart) throw new Error("A realtime session is already starting");
    /* A new call owns the failure slot: the previous call's reason must never
       be reported against this one. */
    this.realtimeFailure = null;
    this.realtimeSessionId = null;
    const personaBootstrapIdentity = voicePersonaBootstrapIdentity(this.identity.threadId);

    let pendingStart!: PendingRealtimeStart;
    const answer = new Promise<CodexRealtimeWebRtcResult>((resolve, reject) => {
      pendingStart = {
        resolve,
        reject,
        timer: undefined,
        started: false,
        realtimeSessionId: null,
        sdp: null,
        personaBootstrap: { ...personaBootstrapIdentity, insertion: "accepted" },
      };
    });
    this.pendingRealtimeStart = pendingStart;
    void answer.catch(() => undefined);

    try {
      const outcome = await this.ensureVoicePersonaBootstrap(personaBootstrapIdentity, pendingStart);
      if (outcome === "superseded") return answer;
    } catch (error) {
      if (this.pendingRealtimeStart !== pendingStart) return answer;
      const pending = pendingStart;
      this.pendingRealtimeStart = null;
      clearTimeout(pending.timer);
      const rejected: CodexRealtimeWebRtcRejection = {
        sdp: null,
        realtimeSessionId: null,
        personaBootstrap: {
          ...personaBootstrapIdentity,
          insertion: "rejected",
          diagnostic: safeError(error),
        },
      };
      pending.resolve(rejected);
      return answer;
    }
    if (this.pendingRealtimeStart !== pendingStart) return answer;
    const realtimeContext = selectRealtimeContext(this.events);
    console.info("[realtime context] selected", {
      providerStartupContext: true,
      durableTail: realtimeContext.diagnosticItems,
      truncated: realtimeContext.truncated,
    });
    pendingStart.timer = setTimeout(() => {
      if (this.pendingRealtimeStart !== pendingStart) return;
      this.fail(new Error("thread/realtime/start timed out; outcome is uncertain"));
    }, this.realtimeStartTimeoutMs);
    try {
      await this.rpc("thread/realtime/start", {
        threadId: this.identity.threadId,
        version: "v3",
        model: REALTIME_LIVE_MODEL,
        outputModality: "audio",
        transport: { type: "webrtc", sdp: offer },
        clientManagedHandoffs: true,
        codexResponsesAsItems: true,
        includeStartupContext: true,
        /* Current V3 clients carry initial items in call creation. Add the
           durable tail only when a streamed assistant response has no
           committed item; provider startup context owns the persisted history. */
        ...(realtimeContext.items.length > 0 ? { initialItems: realtimeContext.items } : {}),
      }, this.realtimeStartTimeoutMs);
    } catch (error) {
      this.rejectRealtimeStart(error instanceof Error ? error : new Error(safeError(error)));
    }
    return answer;
  }

  private async ensureVoicePersonaBootstrap(
    identity: VoicePersonaBootstrapIdentity,
    pendingStart: PendingRealtimeStart,
  ): Promise<"accepted" | "superseded"> {
    await this.ensureCanonicalTranscriptPath();
    while (!this.voicePersonaBootstrapAccepted) {
      const active = this.voicePersonaBootstrapInsertion;
      if (active) {
        try {
          await active.promise;
        } catch (error) {
          if (this.pendingRealtimeStart !== pendingStart) return "superseded";
          if (active.owner === pendingStart) throw error;
          continue;
        }
        continue;
      }

      const canonicalExists = await this.scanVoicePersonaBootstrap(
        identity.itemId,
        "canonical scan unavailable; refusing insertion",
      );
      const legacyExists = canonicalExists ? false : await this.scanVoicePersonaBootstrap(
        legacyVoicePersonaBootstrapItemId(this.identity.threadId),
        "legacy canonical scan unavailable; refusing insertion",
      );
      if (canonicalExists || legacyExists) {
        this.voicePersonaBootstrapAccepted = true;
        this.unresolvedVoicePersonaBootstrap = null;
        break;
      }
      if (this.pendingRealtimeStart !== pendingStart) return "superseded";
      if (this.voicePersonaBootstrapInsertion) continue;

      const bootstrap = this.unresolvedVoicePersonaBootstrap ?? voicePersonaBootstrap(identity);
      this.unresolvedVoicePersonaBootstrap = bootstrap;
      const promise = this.insertVoicePersonaBootstrap(bootstrap, identity.itemId);
      const insertion = { owner: pendingStart, promise };
      this.voicePersonaBootstrapInsertion = insertion;
      const clearInsertion = () => {
        if (this.voicePersonaBootstrapInsertion === insertion) this.voicePersonaBootstrapInsertion = null;
      };
      void promise.then(clearInsertion, clearInsertion);
      try {
        await promise;
      } catch (error) {
        if (this.pendingRealtimeStart !== pendingStart) return "superseded";
        throw error;
      }
    }
    return "accepted";
  }

  private async ensureCanonicalTranscriptPath(): Promise<void> {
    if (this.identity.path) return;
    /* Metadata-only on purpose: this reader consumes nothing but the thread
       identity and path, and hydration is refused on paginated threads (#1332). */
    const result = await this.rpc("thread/read", {
      threadId: this.identity.threadId,
    });
    const recovered = threadFromResult(result, "thread/read");
    if (recovered.threadId !== this.identity.threadId) {
      throw new Error("thread/read returned a different thread id");
    }
    if (!recovered.path) {
      const error = new Error("canonical transcript path is unavailable") as NodeJS.ErrnoException;
      error.code = "NO_TRANSCRIPT_PATH";
      throw error;
    }
    this.identity.path = recovered.path;
  }

  private async insertVoicePersonaBootstrap(bootstrap: VoicePersonaBootstrap, itemId: string): Promise<void> {
    try {
      await this.rpc("thread/inject_items", {
        threadId: this.identity.threadId,
        items: [bootstrap.item],
      }, this.realtimePersonaTimeoutMs);
    } catch (error) {
      if (!await this.scanVoicePersonaBootstrap(itemId, "recovery scan unavailable")) throw error;
    }
    this.voicePersonaBootstrapAccepted = true;
    this.unresolvedVoicePersonaBootstrap = null;
  }

  private async scanVoicePersonaBootstrap(itemId: string, warning: string): Promise<boolean> {
    try {
      return await canonicalVoicePersonaBootstrapExists(this.identity.path, itemId);
    } catch (error) {
      console.warn(`[voice persona bootstrap] ${warning}`, {
        code: (error as NodeJS.ErrnoException).code ?? "unknown",
        diagnostic: safeError(error),
      });
      throw error;
    }
  }

  async appendRealtimeSpeech(text: string): Promise<void> {
    if (!text || Buffer.byteLength(text, "utf8") > MAX_REALTIME_SPEECH_BYTES) {
      throw new Error("Realtime speech text is empty or too large");
    }
    await this.rpc("thread/realtime/appendSpeech", {
      threadId: this.identity.threadId,
      text,
    });
  }

  private voiceStream(turnId: string): VoiceStreamState {
    const existing = this.voiceStreams.get(turnId);
    if (existing) return existing;
    const created: VoiceStreamState = {
      turnId,
      segmentIndex: 0,
      nextChunkIndex: 0,
      buffer: "",
      observedChars: 0,
      emittedChars: 0,
      observedHash: createHash("sha256"),
      emittedHash: createHash("sha256"),
      fallbackToTerminal: false,
      timer: null,
    };
    this.voiceStreams.set(turnId, created);
    return created;
  }

  private observeVoiceDelta(turnId: string, text: string): void {
    if (!text || this.cancelledVoiceTurns.has(turnId)) return;
    const stream = this.voiceStream(turnId);
    stream.buffer += text;
    stream.observedChars += text.length;
    stream.observedHash.update(text);
    if (Buffer.byteLength(stream.buffer, "utf8") > VOICE_STREAM_BUFFER_LIMIT_BYTES) {
      stream.fallbackToTerminal = true;
      stream.buffer = "";
      this.clearVoiceStreamTimer(stream);
      return;
    }
    if (!this.realtimeSessionId || stream.fallbackToTerminal) return;
    this.flushVoiceStream(stream, "eager");
    this.scheduleVoiceStreamFlush(stream);
  }

  private flushVoiceStream(stream: VoiceStreamState, mode: VoiceStreamFlushMode): boolean {
    if (!this.realtimeSessionId
      || stream.fallbackToTerminal
      || this.cancelledVoiceTurns.has(stream.turnId)
      || this.pendingVoiceChunks.size >= VOICE_STREAM_MAX_PENDING) return false;
    const chunk = takeVoiceStreamChunk(stream.buffer, mode);
    if (!chunk) return false;
    const startOffset = stream.emittedChars;
    const endOffset = startOffset + chunk.text.length;
    const delivery = streamingVoiceDelivery({
      sourceTurnId: stream.turnId,
      chunkIndex: stream.nextChunkIndex,
      startOffset,
      endOffset,
      text: chunk.text,
    });
    this.emit({ kind: "voice-chunk", turnId: stream.turnId, delivery });
    if (this.ledgerFailed) return false;
    this.pendingVoiceChunks.set(delivery.deliveryId, stream.turnId);
    stream.nextChunkIndex += 1;
    stream.emittedChars = endOffset;
    stream.emittedHash.update(chunk.text);
    stream.buffer = chunk.remainder;
    return true;
  }

  private scheduleVoiceStreamFlush(stream: VoiceStreamState): void {
    this.clearVoiceStreamTimer(stream);
    if (!stream.buffer
      || !this.realtimeSessionId
      || stream.fallbackToTerminal
      || this.cancelledVoiceTurns.has(stream.turnId)) return;
    stream.timer = setTimeout(() => {
      stream.timer = null;
      const flushed = this.flushVoiceStream(stream, "deadline");
      if (flushed && stream.buffer.length > 0 && this.pendingVoiceChunks.size < VOICE_STREAM_MAX_PENDING) {
        this.scheduleVoiceStreamFlush(stream);
      }
    }, VOICE_STREAM_FLUSH_DELAY_MS);
  }

  private clearVoiceStreamTimer(stream: VoiceStreamState): void {
    if (!stream.timer) return;
    clearTimeout(stream.timer);
    stream.timer = null;
  }

  private clearVoiceStreamTimers(): void {
    for (const stream of this.voiceStreams.values()) this.clearVoiceStreamTimer(stream);
  }

  private resetVoiceStreamSegment(stream: VoiceStreamState): void {
    this.clearVoiceStreamTimer(stream);
    stream.segmentIndex += 1;
    stream.buffer = "";
    stream.observedChars = 0;
    stream.emittedChars = 0;
    stream.observedHash = createHash("sha256");
    stream.emittedHash = createHash("sha256");
    stream.fallbackToTerminal = false;
  }

  private finalizeVoiceStreamItem(turnId: string, item: unknown): RuntimeVoiceResponse | null | undefined {
    const stream = this.voiceStreams.get(turnId);
    const terminal = terminalVoiceResponse(item, `voice-final:${turnId}:${stream?.segmentIndex ?? 0}`);
    if (!terminal) return undefined;
    /* Legacy terminal-only turns keep the historical event shape. The
       projection layer derives their complete voice response. An explicit
       override is needed only after streaming has emitted or buffered text. */
    if (!stream || stream.observedChars === 0) return undefined;
    this.clearVoiceStreamTimer(stream);
    const emittedPrefix = terminal.text.slice(0, stream.emittedChars);
    const emittedMatches = createHash("sha256").update(emittedPrefix).digest("hex")
      === stream.emittedHash.copy().digest("hex");
    const observedPrefix = terminal.text.slice(0, stream.observedChars);
    const observedMatches = stream.observedChars <= terminal.text.length
      && createHash("sha256").update(observedPrefix).digest("hex")
        === stream.observedHash.copy().digest("hex");
    if (emittedMatches && observedMatches && !stream.fallbackToTerminal) {
      this.flushVoiceStream(stream, "final");
    }
    const offset = emittedMatches ? stream.emittedChars : 0;
    const suffix = terminal.text.slice(offset);
    if (!emittedMatches || !observedMatches) {
      console.warn("[realtime voice stream] terminal reconciliation used bounded fallback", {
        turnId,
        emittedChars: stream.emittedChars,
        observedChars: stream.observedChars,
        emittedMatches,
        observedMatches,
      });
    }
    this.resetVoiceStreamSegment(stream);
    if (!suffix) return null;
    return {
      responseId: offset > 0 ? `${terminal.responseId}:suffix:${offset}` : terminal.responseId,
      text: suffix,
    };
  }

  private cancelVoiceStream(turnId: string): void {
    const stream = this.voiceStreams.get(turnId);
    if (stream) this.clearVoiceStreamTimer(stream);
    this.voiceStreams.delete(turnId);
    this.cancelledVoiceTurns.add(turnId);
    for (const [deliveryId, sourceTurnId] of this.pendingVoiceChunks) {
      if (sourceTurnId === turnId) this.pendingVoiceChunks.delete(deliveryId);
    }
  }

  private resumeVoiceStreams(): void {
    if (!this.realtimeSessionId) return;
    for (const stream of this.voiceStreams.values()) {
      if (this.cancelledVoiceTurns.has(stream.turnId)) continue;
      stream.fallbackToTerminal = false;
      this.flushVoiceStream(stream, "eager");
      this.scheduleVoiceStreamFlush(stream);
    }
  }

  async deliverRealtimeWorkerResponse(
    value: RuntimeVoiceDelivery,
  ): Promise<{ deliveryId: string; acknowledged: true }> {
    const delivery = normalizeVoiceDeliveries([value])[0];
    if (!delivery || !delivery.ready || delivery.deliveryId !== value.deliveryId) {
      throw new Error("Realtime worker delivery is invalid");
    }
    if (delivery.sourceTurnId && this.cancelledVoiceTurns.has(delivery.sourceTurnId)) {
      throw new Error("Realtime worker delivery belongs to an interrupted turn");
    }
    const digest = createHash("sha256")
      .update(JSON.stringify(delivery.responses))
      .digest("hex");
    const active = this.activeRealtimeDeliveries.get(delivery.deliveryId);
    if (active) {
      if (active.digest !== digest) throw new Error("Realtime delivery id belongs to different content");
      return active.promise;
    }
    const task = this.performRealtimeWorkerDelivery(delivery, digest);
    this.activeRealtimeDeliveries.set(delivery.deliveryId, { digest, promise: task });
    try {
      return await task;
    } finally {
      if (this.activeRealtimeDeliveries.get(delivery.deliveryId)?.promise === task) {
        this.activeRealtimeDeliveries.delete(delivery.deliveryId);
      }
    }
  }

  private async performRealtimeWorkerDelivery(
    delivery: RuntimeVoiceDelivery,
    digest: string,
  ): Promise<{ deliveryId: string; acknowledged: true }> {
    const restored = this.realtimeDeliveries.get(delivery.deliveryId);
    if (restored?.digest !== undefined && restored.digest !== digest) {
      throw new Error("Realtime delivery id belongs to different content");
    }
    if (restored?.acknowledged) {
      return { deliveryId: delivery.deliveryId, acknowledged: true };
    }
    let responseIndex = restored?.responseIndex ?? 0;
    let offset = restored?.offset ?? 0;
    if (responseIndex > delivery.responses.length
      || (responseIndex < delivery.responses.length
        && offset > delivery.responses[responseIndex]!.text.length)) {
      throw new Error("Realtime delivery cursor is invalid");
    }
    const deliveryEpoch = this.realtimeDeliveryEpoch;
    while (responseIndex < delivery.responses.length) {
      if (deliveryEpoch !== this.realtimeDeliveryEpoch) {
        throw new Error("Realtime worker delivery paused by stop");
      }
      const response = delivery.responses[responseIndex]!;
      const chunk = utf8ChunkAt(response.text, offset, MAX_REALTIME_SPEECH_BYTES);
      if (!chunk) {
        responseIndex += 1;
        offset = 0;
        continue;
      }
      await this.appendRealtimeSpeech(chunk.text);
      offset = chunk.nextOffset;
      if (offset === response.text.length) {
        responseIndex += 1;
        offset = 0;
      }
      this.emit({
        kind: "realtime-delivery-progress",
        deliveryId: delivery.deliveryId,
        digest,
        responseIndex,
        offset,
      });
      if (this.ledgerFailed) throw new Error("Realtime delivery progress was not persisted");
      this.realtimeDeliveries.set(delivery.deliveryId, {
        digest,
        responseIndex,
        offset,
        acknowledged: false,
      });
    }
    this.emit({
      kind: "realtime-delivery-acknowledged",
      deliveryId: delivery.deliveryId,
      digest,
    });
    if (this.ledgerFailed) throw new Error("Realtime delivery acknowledgement was not persisted");
    this.realtimeDeliveries.set(delivery.deliveryId, {
      digest,
      responseIndex,
      offset,
      acknowledged: true,
    });
    const sourceTurnId = this.pendingVoiceChunks.get(delivery.deliveryId);
    if (sourceTurnId) {
      this.pendingVoiceChunks.delete(delivery.deliveryId);
      const stream = this.voiceStreams.get(sourceTurnId);
      if (stream && !this.cancelledVoiceTurns.has(sourceTurnId)) {
        this.flushVoiceStream(stream, "eager");
        this.scheduleVoiceStreamFlush(stream);
      }
    }
    return { deliveryId: delivery.deliveryId, acknowledged: true };
  }

  async stopRealtime(): Promise<void> {
    /* Stop is a pause boundary for canonical worker delivery. A chunk already
       admitted by app-server is durably checkpointed; later chunks remain
       pending and resume from that cursor when Live Mode is started again. */
    this.realtimeDeliveryEpoch += 1;
    await this.rpc("thread/realtime/stop", { threadId: this.identity.threadId });
    this.rejectRealtimeStart(new Error("Realtime session stopped during startup"));
    /* An operator hanging up is not a failure to report back to them. */
    this.realtimeFailure = null;
    this.realtimeSessionId = null;
    for (const stream of this.voiceStreams.values()) {
      this.clearVoiceStreamTimer(stream);
      stream.fallbackToTerminal = true;
    }
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
    const processStartIdentity = pid && this.childProcessOwnership() === "owned"
      ? this.childStartIdentity
      : null;
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

  /** Ends this host only while its child still has the exact kernel identity
      carried by the operator's resource row. */
  async releaseIfOwned(expected: Readonly<ProcessIdentity>): Promise<boolean> {
    const pid = this.child.pid;
    if (this.released || this.releasing || this.releasePromise !== null
      || !pid || expected.startIdentity === null
      || pid !== expected.pid
      || this.childStartIdentity !== expected.startIdentity
      || this.childProcessOwnership() !== "owned") return false;
    await this.release();
    return true;
  }

  private async releaseAndReap(): Promise<void> {
    this.realtimeDeliveryEpoch += 1;
    /* Hang up before the process goes away. A realtime call the backend still
       believes is open holds the account's concurrent slot, and every later
       call is refused with "You have reached your usage limit." — the same
       sentence an exhausted window produces, on an account at 10% of it. That
       is what a deploy replacing the runtime host mid-call cost the operator:
       one orphaned session, then nothing worked until it expired an hour on.
       Best effort and bounded: a wedged app-server must not delay teardown. */
    if (this.realtimeSessionId) {
      const hangup = this.rpc("thread/realtime/stop", { threadId: this.identity.threadId }, REALTIME_HANGUP_TIMEOUT_MS);
      await hangup.catch(() => undefined);
      this.realtimeSessionId = null;
    }
    this.releasing = true;
    this.unresolvedVoicePersonaBootstrap = null;
    this.rejectRealtimeStart(new Error("Codex app-server host released"));
    this.rejectPendingAnswers(new Error("Codex app-server host released"));
    this.rejectPendingDeliveries(new Error("Codex app-server host released"));
    /* A graceful release is the one teardown `fail()` never sees — `close`
       skips it while `releasing` is set — so a compaction waiting on evidence
       would otherwise hang until its own timeout, holding this conversation's
       queue behind it for minutes after the host is gone (#862). */
    this.rejectPendingCompactions(new Error("Codex app-server host released"));
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Codex app-server host released"));
    }
    this.pending.clear();
    let terminationStarted = this.startTermination();
    const initialOwnership = this.childProcessOwnership();
    if (!this.reaped && (initialOwnership === "gone" || initialOwnership === "recycled")) {
      await this.finishReleaseAfterGroupCleanup();
      return;
    }
    if (!this.reaped && initialOwnership === "owned" && !terminationStarted) {
      terminationStarted = this.startTermination();
    }
    if (!this.reaped && !terminationStarted) {
      throw new Error("Codex app-server child ownership is unknown");
    }
    if (!await this.waitForReap(this.shutdownGraceMs)) {
      const ownership = this.childProcessOwnership();
      if (!this.reaped && (ownership === "gone" || ownership === "recycled")) {
        await this.finishReleaseAfterGroupCleanup();
        return;
      }
      if (!this.reaped && ownership === "unknown") {
        throw new Error("Codex app-server child ownership is unknown");
      }
      this.signalTermination("SIGKILL");
      if (!await this.waitForReap(this.shutdownGraceMs)) {
        const escalatedOwnership = this.childProcessOwnership();
        if (!this.reaped && (escalatedOwnership === "gone" || escalatedOwnership === "recycled")) {
          await this.finishReleaseAfterGroupCleanup();
          return;
        }
        if (!this.reaped && escalatedOwnership === "unknown") {
          throw new Error("Codex app-server child ownership is unknown");
        }
        throw new Error("Codex app-server child could not be reaped");
      }
    }
    await this.finishReleaseAfterGroupCleanup();
  }

  private async finishReleaseAfterGroupCleanup(): Promise<void> {
    await this.terminationPromise;
    this.finishRelease();
  }

  private finishRelease(): void {
    if (this.released) return;
    this.clearVoiceStreamTimers();
    if (this.failureCleanupTimer) {
      clearTimeout(this.failureCleanupTimer);
      this.failureCleanupTimer = null;
    }
    this.released = true;
    this.releasing = false;
    this.activeTurnId = null;
    this.attentions.clear();
    this.setSessionStatus("unhosted", []);
    if (this.ledgerFailed || !this.eventLedgerRestored) this.notifyStateListeners();
    this.closeSubscribers();
    const cleanup = this.releaseCleanup;
    this.releaseCleanup = null;
    cleanup?.();
  }

  private completeGroupCleanupAfterReap(): void {
    if (!this.terminationStarted || !this.resolveTermination) return;
    if (this.terminationTimer) {
      clearTimeout(this.terminationTimer);
      this.terminationTimer = null;
    }
    try {
      if (this.childProcessOwnership() === "gone") {
        signalProcessGroup(this.child.pid, "SIGKILL", this.signalProcess);
      }
    } finally {
      this.resolveTermination();
      this.resolveTermination = null;
    }
  }

  private startTermination(): boolean {
    if (this.terminationStarted) return true;
    try { this.child.stdin.end(); } catch { /* already closed */ }
    const ownership = this.childProcessOwnership();
    if (ownership === "gone") {
      signalProcessGroup(this.child.pid, "SIGTERM", this.signalProcess);
      signalProcessGroup(this.child.pid, "SIGKILL", this.signalProcess);
      this.terminationStarted = true;
      this.terminationPromise = Promise.resolve();
      return true;
    }
    if (ownership !== "owned") return false;
    if (this.signalTermination("SIGTERM") === "unsafe") return false;
    this.terminationStarted = true;
    this.terminationPromise = new Promise((resolve) => { this.resolveTermination = resolve; });
    this.terminationTimer = setTimeout(() => {
      this.terminationTimer = null;
      try {
        this.signalTermination("SIGKILL");
      } finally {
        this.resolveTermination?.();
        this.resolveTermination = null;
      }
    }, this.shutdownGraceMs);
    return true;
  }

  private childProcessOwnership(): ChildProcessOwnership {
    const pid = this.child.pid;
    if (!pid || !Number.isInteger(pid) || pid <= 0 || !this.pidAlive(pid)) return "gone";
    const observedIdentity = this.processIdentity(pid);
    if (this.childStartIdentity === null || observedIdentity === null) return "unknown";
    return observedIdentity === this.childStartIdentity ? "owned" : "recycled";
  }

  private signalTermination(signal: NodeJS.Signals): TerminationSignalResult {
    const ownership = this.childProcessOwnership();
    if (ownership === "gone") {
      signalProcessGroup(this.child.pid, signal, this.signalProcess);
      return "attempted";
    }
    if (this.reaped || ownership !== "owned") return "unsafe";
    signalDetachedProcessGroup(this.child, signal, this.signalProcess);
    return "attempted";
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
    if (!this.eventLedgerRestored) {
      if (this.preRestoreEvents.length + this.preRestoreMessages.length >= MAX_PRE_RESTORE_FRAMES) {
        this.ledgerFailed = true;
        this.failWithoutLedger(new Error("Codex app-server pre-restore event buffer exceeded its bounded capacity"));
        return;
      }
      this.preRestoreEvents.push(event);
      return;
    }
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
    this.clearVoiceStreamTimers();
    this.voiceStreams.clear();
    this.pendingVoiceChunks.clear();
    this.cancelledVoiceTurns.clear();
    this.events.splice(0, this.events.length, ...stored);
    this.cursor = reconcileRuntimeEventCursor(
      this.identity.threadId,
      stored.at(-1)?.seq ?? 0,
      this.cursor,
      this.onEventCursorRecovery,
    );
    for (const event of stored) {
      if (event.kind === "turn-started") {
        this.cancelledVoiceTurns.delete(event.turnId);
        this.activeTurnId = event.turnId;
      }
      if (event.kind === "delta") this.observeVoiceDelta(event.turnId, event.text);
      if (event.kind === "voice-chunk") {
        const delivery = normalizeVoiceDeliveries([event.delivery])[0];
        const response = delivery?.responses[0];
        const stream = delivery?.sourceTurnId ? this.voiceStream(delivery.sourceTurnId) : null;
        if (delivery?.streamChunk && response && stream
          && delivery.streamChunk.startOffset === stream.emittedChars
          && stream.buffer.startsWith(response.text)) {
          stream.buffer = stream.buffer.slice(response.text.length);
          stream.emittedChars = delivery.streamChunk.endOffset;
          stream.emittedHash.update(response.text);
          stream.nextChunkIndex = Math.max(stream.nextChunkIndex, delivery.streamChunk.index + 1);
          this.pendingVoiceChunks.set(delivery.deliveryId, delivery.sourceTurnId!);
        } else if (stream) {
          stream.fallbackToTerminal = true;
          stream.buffer = "";
        }
      }
      if (event.kind === "item" && event.phase === "completed" && event.turnId
        && terminalVoiceResponse(event.item, "restored")) {
        const stream = this.voiceStreams.get(event.turnId);
        if (stream) this.resetVoiceStreamSegment(stream);
      }
      if (event.kind === "turn-ended") {
        if (event.turnId === this.activeTurnId) this.activeTurnId = null;
        const stream = this.voiceStreams.get(event.turnId);
        if (stream) this.clearVoiceStreamTimer(stream);
        this.voiceStreams.delete(event.turnId);
        if (event.status !== "completed") this.cancelledVoiceTurns.add(event.turnId);
      }
      if (event.kind === "attention") {
        this.attentions.set(event.id, { rpcId: "restored", method: event.method, origin: "restored" });
      }
      if (event.kind === "attention-resolved") this.attentions.delete(event.id);
      if (event.kind === "realtime-delivery-progress") {
        this.realtimeDeliveries.set(event.deliveryId, {
          digest: event.digest,
          responseIndex: event.responseIndex,
          offset: event.offset,
          acknowledged: false,
        });
      }
      if (event.kind === "realtime-delivery-acknowledged") {
        const previous = this.realtimeDeliveries.get(event.deliveryId);
        this.realtimeDeliveries.set(event.deliveryId, {
          digest: event.digest,
          responseIndex: previous?.responseIndex ?? 0,
          offset: previous?.offset ?? 0,
          acknowledged: true,
        });
        this.pendingVoiceChunks.delete(event.deliveryId);
      }
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
    this.eventLedgerRestored = true;
    return stored.length;
  }

  private reconcileAfterOpen(status: ThreadStatus | null, resumedTurnId: string | null): void {
    const resumedStatus = status ?? { type: "idle" as const, activeFlags: [] };
    if (resumedStatus.type === "active" && !resumedTurnId) {
      throw new Error("thread/resume returned active status without an active turn id");
    }
    const resumedTurnTerminalized = resumedTurnId !== null && this.bufferedTerminalTurnIds.has(resumedTurnId);
    if (resumedStatus.type === "active" && resumedTurnId && !resumedTurnTerminalized
      && this.activeTurnId !== resumedTurnId) {
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
    this.emitThreadStatus(resumedTurnTerminalized && !this.activeTurnId
      ? { type: "idle", activeFlags: [] }
      : resumedStatus);
  }

  private reconcileThreadHistory(result: unknown): void {
    for (const turn of resumedTurns(result)) this.reconcileTurnHistory(turn);
  }

  private reconcileTurnHistory(turn: JsonObject): void {
    const turnId = stringField(turn, "id");
    if (!turnId) return;
    const turnEvents = this.events.filter((event) => "turnId" in event && event.turnId === turnId);
    const status = stringField(turn, "status");
    const hasStarted = turnEvents.some((event) => event.kind === "turn-started");
    if (!this.bufferedTerminalTurnIds.has(turnId)
      && (!hasStarted || (status === "inProgress" && this.activeTurnId !== turnId))) {
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
      for (const replayed of turn.items) {
        /* Replayed history items take the same image bounding as live echoes
           (#773); the ledger only ever holds bounded references, and the
           replay key must be computed on the same shape the ledger stores. */
        const item = this.boundImageBodies(replayed);
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
      const timeoutMs = this.activeTurnId
        ? this.requestTimeoutMs * ACTIVE_THREAD_READ_TIMEOUT_MULTIPLIER
        : this.requestTimeoutMs;
      thread = await this.readThreadWithTurns("latest", timeoutMs);
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
      if (existing.contentDigest !== entry.contentDigest) {
        return Promise.reject(new Error("Codex queue entry id belongs to a different payload"));
      }
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
    }, this.deliveryConfirmationTimeoutMs);
    const pending = {
      text: entry.text ?? "",
      contentDigest: entry.contentDigest!,
      receipt,
      promise,
      resolve: resolveDelivery,
      reject: rejectDelivery,
      timer,
    };
    this.pendingDeliveries.set(entry.id, pending);
    return promise;
  }

  private confirmedReceipt(
    entry: QueueEntry,
    confirmed: { receipt: DeliveryReceipt; text: string | null; contentDigest: string | null },
  ): DeliveryReceipt {
    const payloadMatches = confirmed.contentDigest
      ? confirmed.contentDigest === entry.contentDigest
      : confirmed.text === entry.text;
    if (!payloadMatches) {
      throw new Error("Codex queue entry id belongs to a different payload");
    }
    return confirmed.receipt;
  }

  private rememberConfirmedDelivery(turnId: string, value: unknown): void {
    const item = record(value);
    if (!item || stringField(item, "type") !== "userMessage") return;
    const clientId = stringField(item, "clientId");
    if (!clientId) return;
    const wireText = userMessageText(item);
    const decoded = wireText === null ? null : decodeCodexStructuredUserText(wireText);
    const text = decoded?.text ?? null;
    const contentDigest = decoded?.contentDigest ?? null;
    const previous = this.confirmedDeliveries.get(clientId);
    const pending = this.pendingDeliveries.get(clientId);
    const confirmed = {
      receipt: previous?.receipt ?? pending?.receipt ?? { outcome: "turn-started" as const, turnId },
      text: previous && (previous.text !== text || previous.contentDigest !== contentDigest) ? null : text,
      contentDigest: previous && (previous.text !== text || previous.contentDigest !== contentDigest) ? null : contentDigest,
    };
    this.confirmedDeliveries.set(clientId, confirmed);
    if (!pending) return;
    this.pendingDeliveries.delete(clientId);
    clearTimeout(pending.timer);
    try {
      pending.resolve(this.confirmedReceipt({
        id: clientId,
        text: pending.text,
        contentDigest: pending.contentDigest,
      }, confirmed));
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(safeError(error)));
    }
  }

  private flushPreRestoreEvents(): void {
    for (const event of this.preRestoreEvents.splice(0)) this.emit(event);
  }

  private beginBufferedNotificationReconciliation(): void {
    this.bufferedTerminalTurnIds.clear();
    const durableKeys: string[] = [];
    for (const event of this.events) {
      if (event.kind === "attention" && !this.attentions.has(event.id)) continue;
      const key = bufferedNotificationReplayKey(event);
      if (key) durableKeys.push(key);
    }
    const bufferedKeys: string[] = [];
    let activeTurnId = this.activeTurnId;
    for (const { message } of this.preRestoreMessages) {
      const method = typeof message.method === "string" ? message.method : null;
      if (!method) continue;
      const params = record(message.params) ?? {};
      const id = message.id;
      if (typeof id === "number" || typeof id === "string") {
        const key = bufferedNotificationReplayKey({
          kind: "attention",
          id: `${method}:${String(id)}`,
          method,
          attention: params,
        });
        if (key) bufferedKeys.push(key);
        continue;
      }
      /* The overlap is matched against what replay will actually emit, so a
         sibling thread's buffered frames are skipped here for the same reason
         `acceptNotification` rejects them — counting a key that never arrives
         would break the prefix match and replay the whole buffer (#1284). */
      if (this.foreignThreadNotification(params)) continue;
      const turnId = turnIdFromParams(params);
      if (method === "turn/started" && turnId) activeTurnId = turnId;
      if (method === "item/agentMessage/delta") {
        const key = bufferedNotificationReplayKey({
          kind: "delta",
          turnId: turnId ?? activeTurnId ?? "unknown",
          text: stringField(params, "delta") ?? "",
        });
        if (key) bufferedKeys.push(key);
      }
      if (method === "turn/completed" && turnId === activeTurnId) activeTurnId = null;
    }
    const maximum = Math.min(durableKeys.length, bufferedKeys.length);
    let overlap = 0;
    for (let length = maximum; length > 0; length -= 1) {
      const durableStart = durableKeys.length - length;
      if (bufferedKeys.slice(0, length).every((key, index) => key === durableKeys[durableStart + index])) {
        overlap = length;
        break;
      }
    }
    this.bufferedNotificationOverlap = bufferedKeys.slice(0, overlap);
  }

  private consumeBufferedNotification(event: UnsequencedEvent): boolean {
    const key = bufferedNotificationReplayKey(event);
    if (!key || this.bufferedNotificationOverlap[0] !== key) {
      this.bufferedNotificationOverlap = [];
      return false;
    }
    this.bufferedNotificationOverlap.shift();
    return true;
  }

  private endBufferedNotificationReconciliation(): void {
    this.bufferedNotificationOverlap = [];
    this.bufferedTerminalTurnIds.clear();
  }

  private flushPreRestoreMessages(resumeResult: unknown | null): void {
    const turns = new Map(resumedTurns(resumeResult).flatMap((turn) => {
      const turnId = stringField(turn, "id");
      return turnId ? [[turnId, turn] as const] : [];
    }));
    for (const { message, bytes } of this.preRestoreMessages.splice(0)) {
      this.preRestoreBytes -= bytes;
      if (message.method === "turn/completed") {
        const params = record(message.params) ?? {};
        const turnId = turnIdFromParams(params);
        const turn = turnId ? turns.get(turnId) : null;
        if (turn) this.reconcileTurnHistory(turn);
      }
      this.acceptParsedMessage(message, true);
      if (this.dead || this.releasing || this.released) break;
    }
    this.preRestoreBytes = 0;
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
    const advertisedFlags = activeFlags.filter((flag) => flag !== STRUCTURED_IMAGE_CAPABILITY);
    if (this.imageInputSupport === "supported" && status !== "unhosted" && status !== "dead") {
      advertisedFlags.push(STRUCTURED_IMAGE_CAPABILITY);
    }
    this.engineStatus = status;
    this.activeFlags = advertisedFlags;
    this.emit({
      kind: "session-status",
      status,
      ...(advertisedFlags.length > 0 ? { activeFlags: [...advertisedFlags] } : {}),
    });
  }

  private emitThreadStatus(status: ThreadStatus): void {
    if (status.type === "systemError") {
      /* app-server publishes `systemError` for an ordinary failed turn. Its
         error notification and terminal `turn/completed` follow on the same
         live process, and the next turn clears the status. Preserve that
         recovery lifecycle and project the loaded thread as idle. */
      this.setSessionStatus("idle", status.activeFlags);
      return;
    }
    const mapped = status.type === "notLoaded" ? "unhosted" : status.type;
    this.setSessionStatus(mapped, status.activeFlags);
  }

  private rpc(method: string, params: JsonObject = {}, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    if (this.dead || this.releasing || this.released) return Promise.reject(new Error("Codex app-server host is unavailable"));
    const id = this.nextRpcId++;
    if (REPLAY_ENVELOPE_METHODS.has(method)) this.trackReplayEnvelopeRequest(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (method === "thread/read") this.rememberLateThreadReadResponse(id, timeoutMs);
        const error = new Error(`${method} timed out${MUTATING_RPC_METHODS.has(method) ? "; outcome is uncertain" : ""}`);
        reject(error);
        if (MUTATING_RPC_METHODS.has(method)) this.fail(error);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private rememberLateThreadReadResponse(id: number, timeoutMs: number): void {
    const now = Date.now();
    for (const [lateId, expiresAt] of this.lateThreadReadResponses) {
      if (expiresAt <= now) this.lateThreadReadResponses.delete(lateId);
    }
    const ttlMs = Math.max(timeoutMs * LATE_THREAD_READ_RESPONSE_TTL_MULTIPLIER, MIN_LATE_THREAD_READ_RESPONSE_TTL_MS);
    this.lateThreadReadResponses.set(id, now + ttlMs);
    while (this.lateThreadReadResponses.size > MAX_LATE_THREAD_READ_RESPONSES) {
      const oldestId = this.lateThreadReadResponses.keys().next().value;
      if (oldestId === undefined) break;
      this.lateThreadReadResponses.delete(oldestId);
    }
  }

  private consumeLateThreadReadResponse(id: number): boolean {
    const expiresAt = this.lateThreadReadResponses.get(id);
    if (expiresAt === undefined) return false;
    this.lateThreadReadResponses.delete(id);
    return expiresAt > Date.now();
  }

  private notify(method: string, params: JsonObject): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: JsonObject): void {
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
    catch (error) { this.fail(new Error(`Codex app-server stdin failed: ${safeError(error)}`)); }
  }

  private boundImageBodies(item: unknown): unknown {
    const sink: ImageSink = {
      store: (data, mime) => {
        const store = runtimeImageStore();
        const [ref] = store.putMany([{ base64: data.toString("base64"), mime }]);
        return ref ? store.pathFor(ref) : null;
      },
    };
    try { return sanitizeCodexImageFrame(item, sink).value; }
    catch {
      return item;
    }
  }

  private acceptStdout(chunk: string): void {
    let rest = chunk;
    while (rest) {
      if (this.dead || this.releasing || this.released) {
        this.stdoutBuffer = "";
        this.replayReduction = null;
        return;
      }
      rest = this.replayReduction ? this.feedReplayReduction(rest) : this.acceptPlainStdout(rest);
    }
    if (this.dead || this.releasing || this.released) {
      this.stdoutBuffer = "";
      this.replayReduction = null;
    }
  }

  /** Plain JSONL admission; returns any bytes to reprocess in replay-reduction mode. */
  private acceptPlainStdout(chunk: string): string {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        if (this.awaitedReplayEnvelopeId(line) === null) {
          this.fail(new Error("Codex app-server emitted an oversized JSONL frame"));
          return "";
        }
        const remainder = this.stdoutBuffer;
        this.stdoutBuffer = "";
        this.replayReduction = new CodexReplayFrameReducer(REPLAY_FRAME_BUDGETS);
        if (!this.feedReplayFrame(line)) return "";
        this.finishReplayReduction();
        return this.dead || this.releasing || this.released ? "" : remainder;
      }
      if (line) this.acceptMessage(line);
      if (this.dead || this.releasing || this.released) {
        this.stdoutBuffer = "";
        return "";
      }
      newline = this.stdoutBuffer.indexOf("\n");
    }
    const bufferedBytes = Buffer.byteLength(this.stdoutBuffer);
    if (bufferedBytes > REPLAY_REDUCTION_THRESHOLD_BYTES && this.awaitedReplayEnvelopeId(this.stdoutBuffer) !== null) {
      const buffered = this.stdoutBuffer;
      this.stdoutBuffer = "";
      this.replayReduction = new CodexReplayFrameReducer(REPLAY_FRAME_BUDGETS);
      return buffered;
    }
    if (bufferedBytes > MAX_LINE_BYTES) {
      this.fail(new Error("Codex app-server emitted an oversized JSONL frame"));
      this.stdoutBuffer = "";
    }
    return "";
  }

  /** Streams the awaited replay envelope; returns bytes after the frame's newline. */
  private feedReplayReduction(chunk: string): string {
    const newline = chunk.indexOf("\n");
    if (!this.feedReplayFrame(newline === -1 ? chunk : chunk.slice(0, newline))) return "";
    if (newline === -1) return "";
    this.finishReplayReduction();
    return this.dead || this.releasing || this.released ? "" : chunk.slice(newline + 1);
  }

  private feedReplayFrame(text: string): boolean {
    try {
      this.replayReduction!.feed(text);
      return true;
    } catch (error) {
      this.replayReduction = null;
      this.fail(error instanceof ReplayFrameOverflowError ? error : new Error(safeError(error)));
      return false;
    }
  }

  private finishReplayReduction(): void {
    const reducer = this.replayReduction!;
    this.replayReduction = null;
    let reduced: string;
    try {
      reduced = reducer.finish().trim();
      if (Buffer.byteLength(reduced) > MAX_LINE_BYTES) {
        reduced = shrinkReducedReplayFrame(reduced, MAX_LINE_BYTES, REPLAY_FRAME_BUDGETS).trim();
      }
    } catch (error) {
      this.fail(error instanceof ReplayFrameOverflowError ? error : new Error(safeError(error)));
      return;
    }
    if (Buffer.byteLength(reduced) > MAX_LINE_BYTES) {
      this.fail(new Error("Codex app-server emitted an oversized JSONL frame"));
      return;
    }
    if (reduced) this.acceptMessage(reduced);
  }

  /** The numeric id when this frame opens as the response to an awaited replay read. */
  private awaitedReplayEnvelopeId(text: string): number | null {
    const match = REPLAY_RESPONSE_PREFIX.exec(text.slice(0, 64).trimStart());
    if (!match) return null;
    const id = Number(match[1]);
    return this.replayEnvelopeRequestIds.has(id) ? id : null;
  }

  private trackReplayEnvelopeRequest(id: number): void {
    this.replayEnvelopeRequestIds.add(id);
    while (this.replayEnvelopeRequestIds.size > MAX_TRACKED_REPLAY_ENVELOPE_REQUESTS) {
      const oldest = this.replayEnvelopeRequestIds.values().next().value;
      if (oldest === undefined) break;
      this.replayEnvelopeRequestIds.delete(oldest);
    }
  }

  private acceptStderr(chunk: string): void {
    this.stderrTail += chunk;
    while (Buffer.byteLength(this.stderrTail, "utf8") > MAX_STDERR_TAIL_BYTES) {
      this.stderrTail = this.stderrTail.slice(Math.max(1, Math.floor(this.stderrTail.length / 4)));
    }
  }

  private acceptMessage(line: string): void {
    let message: JsonObject | null;
    try { message = record(JSON.parse(line)); } catch { message = null; }
    if (!message) {
      this.fail(new Error("Codex app-server emitted malformed JSON-RPC"));
      return;
    }
    if (typeof message.method === "string" && !this.eventLedgerRestored) {
      const bytes = Buffer.byteLength(line);
      if (this.preRestoreEvents.length + this.preRestoreMessages.length >= MAX_PRE_RESTORE_FRAMES
        || this.preRestoreBytes + bytes > MAX_PRE_RESTORE_BYTES) {
        this.fail(new Error("Codex app-server pre-restore notification buffer exceeded its bounded capacity"));
        return;
      }
      this.preRestoreMessages.push({ message, bytes });
      this.preRestoreBytes += bytes;
      return;
    }
    this.acceptParsedMessage(message);
  }

  private acceptParsedMessage(message: JsonObject, reconcileBufferedLifecycle = false): void {
    const id = message.id;
    const method = typeof message.method === "string" ? message.method : null;
    if ((typeof id === "number" || typeof id === "string") && !method) {
      if (typeof id !== "number") return this.fail(new Error("Codex app-server response id is invalid"));
      this.replayEnvelopeRequestIds.delete(id);
      const pending = this.pending.get(id);
      if (!pending && this.consumeLateThreadReadResponse(id)) return;
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
      const event = { kind: "attention" as const, id: attentionId, method, attention: params };
      if (!reconcileBufferedLifecycle || !this.consumeBufferedNotification(event)) this.emit(event);
      return;
    }
    this.acceptNotification(method, params, reconcileBufferedLifecycle);
  }

  /**
   * True when a thread-scoped notification names a thread this host does not
   * own (issue #1284).
   *
   * One app-server connection serves a whole tree of threads, not just the one
   * this host started. A native sub-agent — `AgentControl` spawn, and the
   * `review` / `compact` / `memory_consolidation` sources beside it — runs as a
   * real child thread (`Thread.parentThreadId`) on this same stdio pipe, and
   * every `turn/*` and `item/*` notification it produces carries the child's own
   * `threadId`. Accepted here, those frames enter the parent's ledger with the
   * child's turn id, so the live projection alternates between two turn ids and
   * opens a fresh live item on every switch — the column of mid-sentence
   * fragments the operator saw, and a `turn/completed` that idles the parent's
   * session while its own answer is still streaming.
   *
   * Nothing the parent produced is lost by the rejection: the child's stream was
   * never part of the parent's transcript, the parent's own record of the
   * delegation arrives as its own `collabAgentToolCall` / `subAgentActivity`
   * items on this thread, and the child's rollout is a transcript in its own
   * right, so the child's stream still has the child's own view to render in.
   *
   * A frame carrying no `threadId` belongs to the owned thread by default. The
   * field is required on every thread-scoped notification handled here, so its
   * absence means a protocol shape older than the schema this was read from —
   * and silently dropping the parent's own stream is a far worse failure than
   * admitting a stray frame.
   */
  private foreignThreadNotification(params: JsonObject): boolean {
    const threadId = stringField(params, "threadId");
    return threadId !== null && threadId !== this.identity.threadId;
  }

  private acceptNotification(method: string, params: JsonObject, reconcileBufferedLifecycle = false): void {
    if (method === "thread/realtime/started") {
      const pending = this.pendingRealtimeStart;
      if (!pending || stringField(params, "threadId") !== this.identity.threadId) return;
      pending.started = true;
      pending.realtimeSessionId = stringField(params, "realtimeSessionId");
      this.realtimeSessionId = pending.realtimeSessionId;
      this.resumeVoiceStreams();
      this.resolveRealtimeStart();
      return;
    }
    if (method === "thread/realtime/sdp") {
      const pending = this.pendingRealtimeStart;
      if (!pending || stringField(params, "threadId") !== this.identity.threadId) return;
      pending.sdp = stringField(params, "sdp");
      if (!pending.sdp) {
        this.rejectRealtimeStart(new Error("Codex app-server returned an empty WebRTC SDP answer"));
        return;
      }
      this.resolveRealtimeStart();
      return;
    }
    if (method === "thread/realtime/error") {
      if (stringField(params, "threadId") !== this.identity.threadId) return;
      const message = stringField(params, "message") ?? "Codex realtime session failed";
      this.recordRealtimeFailure(message);
      this.rejectRealtimeStart(new Error(message));
      return;
    }
    if (method === "thread/realtime/closed") {
      if (stringField(params, "threadId") !== this.identity.threadId) return;
      const reason = stringField(params, "reason") ?? "Codex realtime session closed";
      /* `closed` always trails `error`; the error carries the backend's actual
         words, so it wins and the close reason only fills an empty slot. */
      this.recordRealtimeFailure(reason, { keepExisting: true });
      this.rejectRealtimeStart(new Error(reason));
      return;
    }
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
    /* Everything below this line projects into the owned thread's conversation,
       so a frame belonging to another thread on this connection stops here.
       The approval surface above is deliberately outside the gate: a child's
       request arrives on this connection and has no other answerer, so refusing
       it — or refusing only its `serverRequest/resolved` and stranding the
       attention it opened — would strand work the parent delegated. */
    if (this.foreignThreadNotification(params)) return;
    if (method === "turn/started" && turnId) {
      if (reconcileBufferedLifecycle) {
        const historicalStart = this.events.some((event) => event.kind === "turn-started" && event.turnId === turnId);
        const historicalTerminal = this.events.some((event) => event.kind === "turn-ended" && event.turnId === turnId);
        if (historicalStart && (historicalTerminal || this.activeTurnId !== null)) return;
      }
      this.cancelledVoiceTurns.delete(turnId);
      this.activeTurnId = turnId;
      this.emit({ kind: "turn-started", turnId });
      return;
    }
    if (method === "item/agentMessage/delta") {
      const event = {
        kind: "delta" as const,
        turnId: turnId ?? this.activeTurnId ?? "unknown",
        text: stringField(params, "delta") ?? "",
      };
      if (!reconcileBufferedLifecycle || !this.consumeBufferedNotification(event)) {
        this.emit(event);
        this.observeVoiceDelta(event.turnId, event.text);
      }
      return;
    }
    if ((method === "item/started" || method === "item/completed") && "item" in params) {
      if (method === "item/completed" && turnId) this.rememberConfirmedDelivery(turnId, params.item);
      const eventTurnId = turnId ?? this.activeTurnId;
      const phase = method === "item/started" ? "started" : "completed";
      if (reconcileBufferedLifecycle && eventTurnId) {
        const terminal = this.events.some((event) => event.kind === "turn-ended" && event.turnId === eventTurnId);
        if (terminal) return;
        const replayKey = itemReplayKey(params.item);
        const duplicate = this.events.some((event) => event.kind === "item"
          && event.turnId === eventTurnId
          && event.phase === phase
          && itemReplayKey(event.item) === replayKey);
        if (duplicate) return;
        const started = this.events.some((event) => event.kind === "turn-started" && event.turnId === eventTurnId);
        if (!started) {
          this.activeTurnId = eventTurnId;
          this.emit({ kind: "turn-started", turnId: eventTurnId });
        }
      }
      const voiceResponse = phase === "completed" && eventTurnId
        ? this.finalizeVoiceStreamItem(eventTurnId, params.item)
        : undefined;
      this.emit({
        kind: "item",
        turnId: eventTurnId,
        item: this.boundImageBodies(params.item),
        phase,
        ...(voiceResponse !== undefined ? { voiceResponse } : {}),
      });
      /* #862: the compaction item is the completion signal for a manual
         compact control. It is read after the emit so the durable event ledger
         carries the evidence before any receipt terminalizes on it. */
      if (record(params.item)?.type === "contextCompaction") this.acceptCompactionItem(params.item, phase);
      return;
    }
    if (method === "turn/completed" && turnId) {
      const turn = record(params.turn);
      const status = terminalStatus(turn?.status);
      if (reconcileBufferedLifecycle) this.bufferedTerminalTurnIds.add(turnId);
      if (reconcileBufferedLifecycle
        && this.events.some((event) => event.kind === "turn-ended" && event.turnId === turnId)) return;
      if (this.activeTurnId === turnId) this.activeTurnId = null;
      if (reconcileBufferedLifecycle
        && !this.events.some((event) => event.kind === "turn-started" && event.turnId === turnId)) {
        this.emit({ kind: "turn-started", turnId });
      }
      if (status !== "completed") {
        this.cancelVoiceStream(turnId);
      } else {
        const stream = this.voiceStreams.get(turnId);
        if (stream) this.clearVoiceStreamTimer(stream);
        this.voiceStreams.delete(turnId);
      }
      this.emit({ kind: "turn-ended", turnId, status });
      this.settlePendingCompactionsFromTerminalTurn(turn, status);
      return;
    }
    if (method === "account/rateLimits/updated") {
      this.emit({ kind: "limits", snapshot: params });
      return;
    }
    if (method === "thread/compacted") {
      this.acceptCompactedNotification(params);
      return;
    }
    if (method === "thread/status/changed") {
      const status = threadStatus(params);
      if (status) this.emitThreadStatus(status);
    }
  }

  private fail(error: Error, activeFlags: string[] = []): void {
    if (this.dead || this.released) return;
    this.clearVoiceStreamTimers();
    this.dead = true;
    this.failure = error;
    this.activeTurnId = null;
    this.rejectRealtimeStart(error);
    this.rejectPendingAnswers(error);
    this.rejectPendingDeliveries(error);
    this.rejectPendingCompactions(error);
    this.attentions.clear();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(safeError(error)));
    }
    this.pending.clear();
    this.setSessionStatus("dead", activeFlags);
    this.closeSubscribers();
    this.startFailureCleanup();
  }

  private failWithoutLedger(error: Error): void {
    if (this.dead || this.released) return;
    this.dead = true;
    this.failure = error;
    this.engineStatus = "dead";
    this.activeFlags = [];
    this.activeTurnId = null;
    this.rejectRealtimeStart(error);
    this.rejectPendingAnswers(error);
    this.rejectPendingDeliveries(error);
    this.rejectPendingCompactions(error);
    this.attentions.clear();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(safeError(error)));
    }
    this.pending.clear();
    this.notifyStateListeners();
    this.closeSubscribers();
    this.startFailureCleanup();
  }

  private startFailureCleanup(): void {
    void this.release().catch(() => {
      if (this.released || this.failureCleanupTimer) return;
      this.failureCleanupTimer = setTimeout(() => {
        this.failureCleanupTimer = null;
        this.startFailureCleanup();
      }, this.shutdownGraceMs);
    });
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

  private resolveRealtimeStart(): void {
    const pending = this.pendingRealtimeStart;
    if (!pending?.started || pending.sdp === null) return;
    this.pendingRealtimeStart = null;
    clearTimeout(pending.timer);
    pending.resolve({
      sdp: pending.sdp,
      realtimeSessionId: pending.realtimeSessionId,
      personaBootstrap: pending.personaBootstrap,
    });
  }

  /** The reason the last realtime call ended, or null when none has failed
      since the current call started. Read by the realtime control endpoint so
      the browser can replace its generic transport message with this one. */
  /** #691 §6: the session id minted during the SDP exchange. Injection is
      authorized against this, so only the peer that ran that exchange can write into
      the call. */
  currentRealtimeSessionId(): string | null {
    return this.realtimeSessionId;
  }

  lastRealtimeFailure(): CodexRealtimeFailure | null {
    return this.realtimeFailure;
  }

  private recordRealtimeFailure(message: string, options: { keepExisting?: boolean } = {}): void {
    if (options.keepExisting && this.realtimeFailure) return;
    this.realtimeFailure = {
      message: message.slice(0, 500),
      at: new Date().toISOString(),
      realtimeSessionId: this.realtimeSessionId,
    };
  }

  private rejectRealtimeStart(error: Error): void {
    const pending = this.pendingRealtimeStart;
    if (!pending) return;
    this.pendingRealtimeStart = null;
    clearTimeout(pending.timer);
    pending.reject(new Error(safeError(error)));
  }
}
