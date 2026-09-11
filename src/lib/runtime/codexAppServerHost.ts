import { normalizeNativeQueueObservation } from "./nativeQueueContent";
import { CodexRealtimeTranscript } from "./codexRealtimeTranscript";
import type { NativeQueueInput } from "./nativeCodexQueue";
import { StructuredSendRefusedError } from "./engineHost";
import type { FirstDispatchEvidence } from "./engineHost";
import { basename } from "node:path";
import { isNonblockingCodexQuestion } from "./codexAttention";
import { codexTurnProfile } from "./codexTurnProfile";
import { StringDecoder } from "node:string_decoder";
import { NativeCodexQueue, NativeQueueProtocolRefusal } from "./nativeCodexQueue";
import { readCodexDeliveryHistory, findCodexHistoryDelivery, type CodexDeliveryHistoryResult } from "./codexHistoryReader";
import type { NativeQueueHost } from "./nativeQueueExecutor";
import type { NativeQueueRecord } from "./nativeQueueContracts";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import fs from "node:fs";

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
  RuntimeInjectOutcome,
  RuntimeInjectRequest,
} from "./engineHost";
import {
  normalizeQueueEntry,
  RuntimeReplayGapError,
  type SessionMaterializationEvidence,
  StructuredCompactError,
  StructuredHostAdoptionCleanupError,
  StructuredInjectError,
} from "./engineHost";
import {
  FileRuntimeEventStore,
  nextRuntimeEventSequence,
  reconcileRuntimeEventCursor,
  type RuntimeEventCursorRecoveryReporter,
  type RuntimeEventStore,
} from "./eventStore";
import {
  voiceSessionPersona,
  type VoicePersonaVariant,
  type VoiceSessionPersona,
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
  resolve(result: CodexRealtimeWebRtcAnswer): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | undefined;
  started: boolean;
  realtimeSessionId: string | null;
  sdp: string | null;
  persona: VoiceSessionPersonaReceipt;
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
  isBlocking?: boolean;
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
  realtimeStartTimeoutMs?: number;
  deliveryConfirmationTimeoutMs?: number;
  /** How long an injection waits for its item to surface in canonical history
      before reporting the insertion unobserved (#1560). */
  injectObservationTimeoutMs?: number;
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

/**
 * Which persona the live call is running on (#1629).
 *
 * The persona is a parameter of `thread/realtime/start` now, so it either went
 * out with the start or the start did not happen — there is no separate write to
 * succeed or fail, and so no separate receipt to reject. What remains worth
 * reporting is WHICH one, which the voice panel shows and the regression tests
 * assert against.
 */
export interface VoiceSessionPersonaReceipt {
  variant: VoicePersonaVariant;
  personaId: string;
}

export interface CodexRealtimeWebRtcAnswer {
  sdp: string;
  realtimeSessionId: string | null;
  persona: VoiceSessionPersonaReceipt;
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
  /* The re-hosted Viewer MCP launcher resolves the current release and the
     runtime host's stable listener from these non-secret inputs. */
  "LLV_STATE_DIR",
  "LLV_VIEWER_DEPLOY_TARGET",
  "LLV_VIEWER_PORT",
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
/** How often the canonical transcript is re-read while waiting for an injected
    item to surface (#1560). The scan is cached on size and mtime, so a poll
    over an unchanged rollout costs a stat. */
const INJECT_OBSERVATION_POLL_MS = 150;
const INJECT_OBSERVATION_POLL_CEILING_MS = 2_000;
/** The observed capability flag that lets the composer offer the injection
    action (#1560). Absent = the action is not offered at all. */
export const NATIVE_INJECT_CAPABILITY = "native-inject";
/**
 * How long an injection waits to SEE its item in the transcript.
 *
 * The same window an ordinary send's confirmation gets, and for the same
 * reason. The active path's item is written when the turn reaches its next
 * model request, so a turn sitting in one long tool call would blow a short
 * window and settle `uncertain` — terminally, since that status is absorbing —
 * for an insertion that lands and is consumed perfectly well a minute later.
 * The wait almost never runs to this length: the idle flush is immediate, and
 * an active injection stops as soon as its turn ends.
 */
export const DEFAULT_INJECT_OBSERVATION_TIMEOUT_MS = DEFAULT_DELIVERY_CONFIRMATION_TIMEOUT_MS;
/** Exported beside it so a test can hold the two to the same value: the
    equality IS the decision, and it is not observable from behaviour without a
    multi-minute test. */
export const CODEX_DELIVERY_CONFIRMATION_TIMEOUT_MS = DEFAULT_DELIVERY_CONFIRMATION_TIMEOUT_MS;

/**
 * Whether a failed injection request PROVED that nothing was written.
 *
 * Only one thing proves it: a JSON-RPC error the server articulated. The
 * transport decodes those into `NativeQueueProtocolRefusal`, which carries the
 * engine's own numeric code, and every other failure — a timeout, a closed
 * socket, a child that exited, a writer fence, anything whose wording nobody
 * has enumerated — arrives as a plain `Error` and means the request may have
 * been applied with the answer lost.
 *
 * This is deliberately NOT a keyword list over error messages. Such a list
 * decides the default for everything it fails to anticipate, and here the
 * default it would pick is the dangerous one: `refused` tells the operator
 * nothing was written, which is a claim no unrecognised failure supports.
 * Defaulting the other way costs one operation reported as unverified.
 */
function injectionRefusalIsProven(error: unknown): boolean {
  return error instanceof NativeQueueProtocolRefusal;
}
const LATE_THREAD_READ_RESPONSE_TTL_MULTIPLIER = 3;
const MIN_LATE_THREAD_READ_RESPONSE_TTL_MS = 1_000;
const MAX_LATE_THREAD_READ_RESPONSES = 32;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;
const REALTIME_START_TIMEOUT_MS = 90_000;
/* First speech waits for the persona's durable insertion outcome. Keep that
   gate bounded when an app-server accepts the method and then stalls. */
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
// A supported image envelope must fit alongside the bounded surrounding
// history. Per-item pages keep each native response within MAX_LINE_BYTES.
const DELIVERY_HISTORY_BYTES = MAX_STRUCTURED_IMAGE_ENCODED_BYTES + 16 * 1024 * 1024;
// Single-item frames retain the nominal item coverage of 128 pages of 32
// items. The byte budget and existing caller deadline still bound the read.
const DELIVERY_HISTORY_PAGES = 128 * 32;
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
/** How many finished turns a host remembers for the voice ledger's retirement
    check. Beyond this the oldest answers `unknown`, which retires nothing. */
const MAX_TERMINATED_TURN_MEMORY = 512;

/** The app-server notifications that carry the canonical realtime transcript. */
const CANONICAL_REALTIME_TRANSCRIPT_METHODS: ReadonlySet<string> = new Set([
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "thread/realtime/item/transcript/delta",
  "thread/realtime/item/started",
  "thread/realtime/item/completed",
]);
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
/* The fallback runs inside delivery-confirmation and materialization POLL
   loops, so an uncached implementation re-reads and re-parses megabytes per
   tick across every active lane — enough to storm the viewer process
   (observed 2026-08-31: 380% CPU, data routes timing out). One entry per
   rollout, invalidated by size+mtime, bounds that to one parse per change. */
const ROLLOUT_TURNS_CACHE_LIMIT = 32;
const ROLLOUT_DELIVERY_SCAN_CHUNK_BYTES = 1024 * 1024;
const STRUCTURED_USER_MARKER_FRAGMENT = Buffer.from("llv:structured-user");

function codexDeliveryDedup(operationId: string): string {
  return createHash("sha256").update(operationId).digest("hex");
}
type RolloutStructuredUserDelivery =
  | { payloadKind: "text" | "content"; payloadDigest: string }
  | { payloadKind: "conflict"; payloadDigest: null };

interface RolloutTurnsCacheEntry {
  size: number;
  mtimeMs: number;
  fileIdentity: string | null;
  turns: JsonObject[];
  structuredUserDeliveries: Map<string, RolloutStructuredUserDelivery>;
  readState: "readable" | "absent" | "unavailable";
}

interface RolloutDeliveryIndexEntry {
  size: number;
  mtimeMs: number;
  fileIdentity: string | null;
  /** Start of the only incomplete JSONL record, or EOF after a newline. */
  scanOffset: number;
  deliveries: Map<string, RolloutStructuredUserDelivery>;
  readState: "readable" | "absent" | "unavailable";
}

const rolloutTurnsCache = new Map<string, RolloutTurnsCacheEntry>();
const rolloutDeliveryIndexCache = new Map<string, RolloutDeliveryIndexEntry>();
const rolloutDeliveryIndexRuns = new Map<string, Promise<RolloutDeliveryIndexEntry>>();

function rememberRolloutStructuredUser(
  deliveries: Map<string, RolloutStructuredUserDelivery>,
  wireText: string,
): void {
  const decoded = decodeCodexStructuredUserText(wireText);
  if (!decoded.deliveryDedup) return;
  const current = deliveries.get(decoded.deliveryDedup);
  const observed: RolloutStructuredUserDelivery = decoded.contentDigest
    ? { payloadKind: "content", payloadDigest: decoded.contentDigest }
    : { payloadKind: "text", payloadDigest: createHash("sha256").update(decoded.text).digest("hex") };
  if (!current) {
    deliveries.set(decoded.deliveryDedup, observed);
    return;
  }
  if (current.payloadKind !== observed.payloadKind || current.payloadDigest !== observed.payloadDigest) {
    deliveries.set(decoded.deliveryDedup, { payloadKind: "conflict", payloadDigest: null });
  }
}

function rememberRolloutStructuredUsersFromRecord(
  deliveries: Map<string, RolloutStructuredUserDelivery>,
  value: unknown,
): void {
  const payload = record(record(value)?.payload);
  if (!payload) return;
  const payloadType = stringField(payload, "type");
  if (payloadType === "user_message") {
    const message = stringField(payload, "message");
    if (message !== null) rememberRolloutStructuredUser(deliveries, message);
  }
  /* #1560: the RAW Responses form. An ordinary send is persisted through the
     item lifecycle above, but `thread/inject_items` appends raw Responses items
     and codex 0.154 writes those straight out as
     `{"type":"response_item","payload":{"type":"message","role":"user",...}}`
     — verified against real rollouts on disk. Without this branch the canonical
     scan cannot see an injection at all, so every insertion would be reported
     unverified and the pre-insertion dedup check would never find the record it
     is meant to converge on.

     `role` is checked against `user` and nothing else. The same rollout carries
     `developer` and `assistant` messages in the identical shape, and a marker
     appearing on one of those must never be read as the operator's input — the
     role is the only thing separating them. Ordinary sends whose input is also
     persisted this way simply agree with their lifecycle record: both decode
     from the same marker text to the same digest, so the duplicate resolves
     rather than conflicting. */
  if (payloadType === "message" && stringField(payload, "role") === "user") {
    const wireText = userMessageText(payload);
    if (wireText !== null) rememberRolloutStructuredUser(deliveries, wireText);
    return;
  }
  if (payloadType !== "item_completed") return;
  const item = record(payload.item);
  if (!item) return;
  const itemType = stringField(item, "type");
  const wireText = userMessageText(item);
  if ((itemType === "UserMessage" || itemType === "userMessage") && wireText !== null) {
    rememberRolloutStructuredUser(deliveries, wireText);
  }
}

function rememberRolloutStructuredUsersFromLine(
  deliveries: Map<string, RolloutStructuredUserDelivery>,
  line: Buffer,
): void {
  /* Most rollout records carry no structured user marker. Checking the bytes
     first keeps a large tool/result record out of JSON.parse and out of a
     second string allocation while the recipient index walks old history. */
  if (line.indexOf(STRUCTURED_USER_MARKER_FRAGMENT) < 0) return;
  try {
    rememberRolloutStructuredUsersFromRecord(deliveries, JSON.parse(line.toString("utf8")));
  } catch (error) {
    /* The candidate line may be the record that already owns this operation.
       Unreadable evidence cannot authorize another recipient write. */
    throw new Error("Codex recipient transcript contains a malformed structured-user record", { cause: error });
  }
}

async function scanRolloutStructuredUserDeliveries(
  pathname: string,
  size: number,
  fileIdentity: string,
  previous: RolloutDeliveryIndexEntry | undefined,
): Promise<{ deliveries: Map<string, RolloutStructuredUserDelivery>; offset: number }> {
  const extendsPrevious = previous?.readState === "readable"
    && previous.fileIdentity === fileIdentity
    && size > previous.size
    && previous.scanOffset <= previous.size;
  const start = extendsPrevious ? previous.scanOffset : 0;
  const deliveries = extendsPrevious
    ? new Map(previous.deliveries)
    : new Map<string, RolloutStructuredUserDelivery>();
  const descriptor = await fs.promises.open(pathname, "r");
  let position = start;
  let completedOffset = start;
  let lineChunks: Buffer[] = [];
  let lineBytes = 0;
  let markerTail = Buffer.alloc(0);
  let lineContainsMarker = false;
  let skippingOversizedLine = false;
  const observeMarker = (chunk: Buffer) => {
    if (lineContainsMarker || chunk.length === 0) return;
    const probe = markerTail.length > 0 ? Buffer.concat([markerTail, chunk]) : chunk;
    lineContainsMarker = probe.indexOf(STRUCTURED_USER_MARKER_FRAGMENT) >= 0;
    const tailBytes = Math.min(STRUCTURED_USER_MARKER_FRAGMENT.length - 1, probe.length);
    markerTail = Buffer.from(probe.subarray(probe.length - tailBytes));
  };
  const resetLine = () => {
    lineChunks = [];
    lineBytes = 0;
    markerTail = Buffer.alloc(0);
    lineContainsMarker = false;
    skippingOversizedLine = false;
  };
  try {
    while (position < size) {
      const buffer = Buffer.allocUnsafe(Math.min(ROLLOUT_DELIVERY_SCAN_CHUNK_BYTES, size - position));
      const { bytesRead: read } = await descriptor.read(buffer, 0, buffer.length, position);
      if (read === 0) throw new Error("Codex recipient transcript changed during delivery deduplication");
      let cursor = 0;
      while (cursor < read) {
        const newline = buffer.indexOf(0x0a, cursor);
        const end = newline < 0 || newline >= read ? read : newline;
        if (end > cursor) {
          const chunk = buffer.subarray(cursor, end);
          observeMarker(chunk);
          if (skippingOversizedLine && lineContainsMarker) {
            throw new Error("Codex recipient transcript contains an oversized structured-user record");
          }
          if (!skippingOversizedLine) {
            lineChunks.push(chunk);
            lineBytes += chunk.length;
            if (lineBytes > MAX_LINE_BYTES) {
              if (lineContainsMarker) {
                throw new Error("Codex recipient transcript contains an oversized structured-user record");
              }
              /* Old tool/result rows may exceed the app-server frame budget.
                 They cannot carry a dedup marker seen nowhere on the line, so
                 retain only the marker overlap until its newline. */
              lineChunks = [];
              lineBytes = 0;
              skippingOversizedLine = true;
            }
          }
        }
        if (newline < 0 || newline >= read) break;
        if (!skippingOversizedLine) {
          const line = lineChunks.length === 1
            ? lineChunks[0]!
            : Buffer.concat(lineChunks, lineBytes);
          rememberRolloutStructuredUsersFromLine(deliveries, line);
        }
        completedOffset = position + newline + 1;
        resetLine();
        cursor = newline + 1;
      }
      position += read;
    }
    /* A valid last record need not end in a newline. Keep its start as the
       incremental offset so an append that completes a torn record replays it. */
    if (!skippingOversizedLine && lineBytes > 0) {
      const line = lineChunks.length === 1
        ? lineChunks[0]!
        : Buffer.concat(lineChunks, lineBytes);
      rememberRolloutStructuredUsersFromLine(deliveries, line);
    }
    return { deliveries, offset: completedOffset };
  } finally {
    await descriptor.close();
  }
}

const EMPTY_ROLLOUT_CACHE_ENTRY: RolloutTurnsCacheEntry = {
  size: 0,
  mtimeMs: 0,
  fileIdentity: null,
  turns: [],
  structuredUserDeliveries: new Map(),
  readState: "absent",
};

const UNAVAILABLE_ROLLOUT_CACHE_ENTRY: RolloutTurnsCacheEntry = {
  ...EMPTY_ROLLOUT_CACHE_ENTRY,
  structuredUserDeliveries: new Map(),
  readState: "unavailable",
};

const EMPTY_ROLLOUT_DELIVERY_INDEX: RolloutDeliveryIndexEntry = {
  size: 0,
  mtimeMs: 0,
  fileIdentity: null,
  scanOffset: 0,
  deliveries: new Map(),
  readState: "absent",
};

const UNAVAILABLE_ROLLOUT_DELIVERY_INDEX: RolloutDeliveryIndexEntry = {
  ...EMPTY_ROLLOUT_DELIVERY_INDEX,
  deliveries: new Map(),
  readState: "unavailable",
};

function rolloutCacheEntryFromDisk(pathname: string | null | undefined): RolloutTurnsCacheEntry {
  if (!pathname) return EMPTY_ROLLOUT_CACHE_ENTRY;
  let raw: string;
  let statSize = 0;
  let statMtimeMs = 0;
  let fileIdentity: string | null = null;
  const structuredUserDeliveries = new Map<string, RolloutStructuredUserDelivery>();
  try {
    const stat = fs.statSync(pathname);
    statSize = stat.size;
    statMtimeMs = stat.mtimeMs;
    fileIdentity = rolloutFileIdentity(stat);
    if (!stat.isFile()) return UNAVAILABLE_ROLLOUT_CACHE_ENTRY;
    const cached = rolloutTurnsCache.get(pathname);
    if (cached
      && cached.size === stat.size
      && cached.mtimeMs === stat.mtimeMs
      && cached.fileIdentity === fileIdentity) {
      /* Refresh recency so hot rollouts survive the LRU trim. */
      rolloutTurnsCache.delete(pathname);
      rolloutTurnsCache.set(pathname, cached);
      return cached;
    }
    if (stat.size > ROLLOUT_FALLBACK_READ_BYTES) {
      const descriptor = fs.openSync(pathname, "r");
      try {
        // Include the preceding byte to distinguish a complete first record
        // from a fragment created by our bounded read. The full delivery index
        // still scans that record before absence can authorize a new send.
        const buffer = Buffer.alloc(ROLLOUT_FALLBACK_READ_BYTES + 1);
        const read = fs.readSync(descriptor, buffer, 0, buffer.length, stat.size - buffer.length);
        const start = buffer[0] === 0x0a ? 1 : buffer.indexOf(0x0a, 1) + 1;
        raw = start > 0 ? buffer.subarray(start, read).toString("utf8") : "";
      } finally {
        fs.closeSync(descriptor);
      }
    } else {
      raw = fs.readFileSync(pathname, "utf8");
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? EMPTY_ROLLOUT_CACHE_ENTRY
      : UNAVAILABLE_ROLLOUT_CACHE_ENTRY;
  }
  const order: string[] = [];
  const turns = new Map<string, { id: string; status?: string; items: JsonObject[] }>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (line.includes(STRUCTURED_USER_MARKER_FRAGMENT.toString("utf8"))) {
        return UNAVAILABLE_ROLLOUT_CACHE_ENTRY;
      }
      continue;
    }
    const payload = record(record(parsed)?.payload);
    if (!payload) continue;
    rememberRolloutStructuredUsersFromRecord(structuredUserDeliveries, parsed);
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
  const result = order.map((id) => {
    const turn = turns.get(id)!;
    return { id: turn.id, status: turn.status ?? "inProgress", items: turn.items } as JsonObject;
  });
  const cached: RolloutTurnsCacheEntry = {
    size: statSize,
    mtimeMs: statMtimeMs,
    fileIdentity,
    turns: result,
    structuredUserDeliveries,
    readState: "readable",
  };
  rolloutTurnsCache.set(pathname, cached);
  while (rolloutTurnsCache.size > ROLLOUT_TURNS_CACHE_LIMIT) {
    const oldest = rolloutTurnsCache.keys().next().value;
    if (oldest === undefined) break;
    rolloutTurnsCache.delete(oldest);
  }
  return cached;
}

export function rolloutTurnsFromDisk(pathname: string | null | undefined): JsonObject[] {
  return [...rolloutCacheEntryFromDisk(pathname).turns];
}

function rememberRolloutDeliveryIndex(pathname: string, entry: RolloutDeliveryIndexEntry): RolloutDeliveryIndexEntry {
  rolloutDeliveryIndexCache.delete(pathname);
  rolloutDeliveryIndexCache.set(pathname, entry);
  while (rolloutDeliveryIndexCache.size > ROLLOUT_TURNS_CACHE_LIMIT) {
    const oldest = rolloutDeliveryIndexCache.keys().next().value;
    if (oldest === undefined) break;
    rolloutDeliveryIndexCache.delete(oldest);
  }
  return entry;
}

function sameRolloutFile(
  stat: fs.Stats,
  entry: Pick<RolloutDeliveryIndexEntry, "size" | "mtimeMs" | "fileIdentity">,
): boolean {
  return stat.size === entry.size
    && stat.mtimeMs === entry.mtimeMs
    && rolloutFileIdentity(stat) === entry.fileIdentity;
}

function rolloutFileIdentity(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

async function refreshRolloutDeliveryIndex(pathname: string): Promise<RolloutDeliveryIndexEntry> {
  let previous = rolloutDeliveryIndexCache.get(pathname);
  try {
    /* A live rollout may append while its historical prefix is being indexed.
       Converge across bounded snapshots; continuous change stays unavailable
       and therefore cannot authorize a second recipient write. */
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await fs.promises.stat(pathname);
      if (!before.isFile()) return UNAVAILABLE_ROLLOUT_DELIVERY_INDEX;
      if (previous && sameRolloutFile(before, previous)) {
        return rememberRolloutDeliveryIndex(pathname, previous);
      }
      const fileIdentity = rolloutFileIdentity(before);
      const scanned = await scanRolloutStructuredUserDeliveries(
        pathname,
        before.size,
        fileIdentity,
        previous,
      );
      const next: RolloutDeliveryIndexEntry = {
        size: before.size,
        mtimeMs: before.mtimeMs,
        fileIdentity,
        scanOffset: scanned.offset,
        deliveries: scanned.deliveries,
        readState: "readable",
      };
      const after = await fs.promises.stat(pathname);
      if (sameRolloutFile(after, next)) return rememberRolloutDeliveryIndex(pathname, next);
      previous = next;
    }
    return UNAVAILABLE_ROLLOUT_DELIVERY_INDEX;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? EMPTY_ROLLOUT_DELIVERY_INDEX
      : UNAVAILABLE_ROLLOUT_DELIVERY_INDEX;
  }
}

async function rolloutDeliveryIndexFromDisk(
  pathname: string | null | undefined,
): Promise<RolloutDeliveryIndexEntry> {
  if (!pathname) return EMPTY_ROLLOUT_DELIVERY_INDEX;
  const active = rolloutDeliveryIndexRuns.get(pathname);
  if (active) {
    await active;
    return rolloutDeliveryIndexFromDisk(pathname);
  }
  const run = refreshRolloutDeliveryIndex(pathname).finally(() => {
    rolloutDeliveryIndexRuns.delete(pathname);
  });
  rolloutDeliveryIndexRuns.set(pathname, run);
  return run;
}

function rolloutDeliveryReceipt(
  entry: QueueEntry,
  delivery: RolloutStructuredUserDelivery | undefined,
): DeliveryReceipt | null {
  if (!delivery) return null;
  let payloadMatches = false;
  if (delivery.payloadKind === "content") {
    payloadMatches = delivery.payloadDigest === entry.contentDigest;
  } else if (delivery.payloadKind === "text") {
    payloadMatches = delivery.payloadDigest === createHash("sha256")
      .update(entry.text ?? entry.content?.text ?? "")
      .digest("hex");
  }
  if (!payloadMatches) throw new Error("Codex queue entry id belongs to a different payload");
  /* The legacy `event_msg/user_message` record carries no turn id. Its durable
     dedup identity is enough to prove the recipient already owns this message;
     the operation id is a stable historical turn reference for the receipt. */
  return { outcome: "turn-started", turnId: entry.id };
}

function rolloutConfirmedDelivery(
  pathname: string | null | undefined,
  entry: QueueEntry,
): DeliveryReceipt | null | Promise<DeliveryReceipt | null> {
  const rollout = rolloutCacheEntryFromDisk(pathname);
  if (rollout.readState === "unavailable") {
    throw new Error("Codex recipient transcript is unavailable for delivery deduplication");
  }
  const dedup = codexDeliveryDedup(entry.id);
  const delivery = rollout.structuredUserDeliveries.get(dedup);
  if (delivery || rollout.size <= ROLLOUT_FALLBACK_READ_BYTES) {
    return rolloutDeliveryReceipt(entry, delivery);
  }
  return rolloutDeliveryIndexFromDisk(pathname).then((index) => {
    if (index.readState === "unavailable") {
      throw new Error("Codex recipient transcript is unavailable for delivery deduplication");
    }
    return rolloutDeliveryReceipt(entry, index.deliveries.get(dedup));
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
  private readonly realtimeStartTimeoutMs: number;
  private readonly deliveryConfirmationTimeoutMs: number;
  private readonly injectObservationTimeoutMs: number;
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
  private readonly realtimeTranscript = new CodexRealtimeTranscript();
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
  /* KEYED BY VARIANT, because a thread has one identity PER VARIANT and not one
     overall (#1615). While the coordinator persona was the only one, a single
     boolean and a single payload were the whole memo; with two, sharing them
     fails in both directions — a payload resolved for one variant gets injected
     under the other's id, and one accepted variant reports the other as accepted
     without ever injecting it, which is a false receipt that
     `rejectStartedRealtimeContract` would otherwise have caught.
     Successor starts of the SAME variant still join the same insertion promise. */
  private readonly pendingVoiceChunks = new Map<string, string>();
  private readonly cancelledVoiceTurns = new Set<string>();
  private readonly activeRealtimeDeliveries = new Map<string, {
    digest: string;
    promise: Promise<{ deliveryId: string; acknowledged: true }>;
  }>();
  readonly supportsSteer = true;
  nativeQueue?: NativeQueueHost;
  private nativeQueueRevision = 0;
  private readonly selectedExecutable: string;
  private queueCapability: "unknown" | "supported" | "unsupported" = "unknown";
  /** #1560. Fail-closed until the negotiated protocol is known to carry
      `thread/inject_items`, and driven back to `unsupported` by a method-not-
      found at the call site — the one answer that proves this engine lacks it. */
  private injectCapability: "unknown" | "supported" | "unsupported" = "unknown";
  private readonly stdoutDecoder = new StringDecoder("utf8");
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
  /** Turns this host saw end, newest last and bounded. The voice ledger's only
      authoritative retirement evidence (#1629); absence is `unknown`, never
      "finished". */
  private readonly terminatedTurnIds = new Set<string>();
  private protocolVersion: string | null = null;
  private modelCatalog: unknown = null;
  private authRecovery: "unknown" | "started" | "completed-unverified" = "unknown";
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
    this.realtimeStartTimeoutMs = options.realtimeStartTimeoutMs ?? REALTIME_START_TIMEOUT_MS;
    this.selectedExecutable = basename(options.binary ?? "codex");
    this.deliveryConfirmationTimeoutMs = options.deliveryConfirmationTimeoutMs
      ?? DEFAULT_DELIVERY_CONFIRMATION_TIMEOUT_MS;
    this.injectObservationTimeoutMs = options.injectObservationTimeoutMs ?? DEFAULT_INJECT_OBSERVATION_TIMEOUT_MS;
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
    child.stdout.on("data", (chunk: Buffer | string) => this.acceptStdout(typeof chunk === "string" ? chunk : this.stdoutDecoder.write(chunk)));
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
        provisional.modelCatalog = await provisional.rpc("model/list", {});
        provisional.imageInputSupport = modelSupportsImageInput(
          provisional.modelCatalog,
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
      await provisional.initializeNativeQueue();
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

  private supportsNativeHistory(): boolean {
    const version = this.protocolVersion?.match(/^(\d+)\.(\d+)\./);
    return !!version && (Number(version[1]) > 0 || Number(version[2]) >= 153);
  }

  /**
   * Injection capability, decided from the negotiated protocol rather than by
   * probing (#1560).
   *
   * There is no read-only way to ask whether `thread/inject_items` exists: the
   * method's only form is the mutating one, and calling it to find out would
   * write into the operator's thread. So the same protocol floor the native
   * queue uses decides it — `thread/inject_items` is part of that generation of
   * the app-server API — and the authoritative correction comes from the call
   * site, where a method-not-found flips this to `unsupported` for good and
   * re-advertises the capability so the composer stops offering the action.
   *
   * Unknown stays unknown until the protocol version is known, and unknown is
   * fail-closed: no action is offered and an admitted injection is refused.
   */
  private resolveInjectCapability(): void {
    if (!this.protocolVersion) return;
    if (this.injectCapability === "unsupported") return;
    this.injectCapability = this.supportsNativeHistory() ? "supported" : "unsupported";
  }

  private async initializeNativeQueue(): Promise<void> {
    this.resolveInjectCapability();
    if (!this.supportsNativeHistory()) { if (this.protocolVersion) this.queueCapability = "unsupported"; return; }
    const queue = new NativeCodexQueue({ rpc: (method, params, timeout) => {
      if (!this.writerFenceAllowsActuation() || this.dead || this.releasing || this.released) {
        throw new StructuredSendRefusedError("native queue writer is unavailable");
      }
      return this.rpc(method, params, timeout, true);
    } }, this.identity.threadId, { timeoutMs: this.requestTimeoutMs, pageSize: 1, maxPages: 2000 });
    try { await queue.refresh(); }
    catch (error) { queue.dispose(); this.queueCapability = error instanceof NativeQueueProtocolRefusal && error.code === -32601 ? "unsupported" : "unknown"; return; }
    this.queueCapability = "supported";
    this.nativeQueue = {
      queue,
      prepare: async (entry, version) => {
        if (version.images.length && this.imageInputSupport !== "supported") throw new StructuredSendRefusedError("image input capability is unavailable");
        return [
          ...version.images.map(image => ({ type: "localImage" as const, path: this.resolveImagePath(image) })),
          { type: "text", text: encodeCodexStructuredUserText(version.text,
            version.images.length ? version.contentDigest : undefined, version.selectedContext, version.origin ?? { kind: "operator" },
            codexDeliveryDedup(`${entry.entryId}-v${version.revision}`)) },
        ];
      },
      evidence: (entry) => this.nativeQueueEvidence(entry),
      evidenceBatch: async (entries) => {
        if (!this.identity.path) return entries.map(() => null);
        const history = await this.readDeliveryHistory(entries.map(entry => entry.clientUserMessageId), this.requestTimeoutMs,
          candidate => entries.some(entry => this.nativeQueueProof(entry, candidate) !== null));
        return Promise.all(entries.map(entry => this.nativeQueueEvidence(entry, history)));
      },
      sendWithdrawn: async (entry, expectedTurnId) => {
        if (!this.writerFenceAllowsActuation() || this.dead || this.releasing || this.released) throw new StructuredSendRefusedError("native queue writer is unavailable");
        if (this.activeTurnId !== expectedTurnId || this.hasBlockingAttention()) throw new StructuredSendRefusedError("stale-turn or blocking attention");
        const version = entry.versions.find(v => v.revision === entry.revision);
        if (!version?.input) throw new StructuredSendRefusedError("native queue input is unavailable");
        const result = await this.rpc(expectedTurnId === null ? "turn/start" : "turn/steer", {
          threadId: this.identity.threadId, input: version.input, clientUserMessageId: entry.clientUserMessageId,
          ...(expectedTurnId === null ? {} : { expectedTurnId }),
        }, this.requestTimeoutMs, true);
        const turnId = turnIdFromResult(result, expectedTurnId === null ? "turn/start" : "turn/steer");
        if (expectedTurnId !== null && turnId !== expectedTurnId) throw new Error("native steer returned a different turn identity");
        return { turnId };
      },
    };
    this.notifyStateListeners();
  }

  private async readDeliveryHistory(clientIds: string[], timeoutMs = this.requestTimeoutMs,
    accept?: (history: Extract<CodexDeliveryHistoryResult, {state: "observed"}>) => boolean): Promise<CodexDeliveryHistoryResult> {
    if (!this.identity.path) return {state: "unknown", reason: "identity"};
    return readCodexDeliveryHistory((method, params, timeout) => this.rpc(method, params, timeout, true),
      {threadId: this.identity.threadId, path: this.identity.path},
      {deadlineAt: Date.now() + timeoutMs, sortDirection: "desc", itemsPerPage: 1,
        maxPages: DELIVERY_HISTORY_PAGES, maxBytes: DELIVERY_HISTORY_BYTES}, clientIds, accept);
  }

  private async nativeQueueEvidence(entry: NativeQueueRecord, snapshot?: CodexDeliveryHistoryResult) {
    if (entry.binding.threadId !== this.identity.threadId || !this.identity.path) return null;
    const history = snapshot ?? await this.readDeliveryHistory([entry.clientUserMessageId]);
    return this.nativeQueueProof(entry, history);
  }

  private nativeQueueProof(entry: NativeQueueRecord, history: CodexDeliveryHistoryResult) {
    if (entry.binding.threadId !== this.identity.threadId || !this.identity.path) return null;
    const targetHistory = history.state !== "complete" && history.state !== "observed" ? history : { ...history,
      turns: history.turns.map(turn => ({ ...turn, items: turn.items.filter(item => item.type === "userMessage" && item.clientId === entry.clientUserMessageId) }))
        .filter(turn => turn.items.length > 0),
    };
    for (const version of entry.versions) {
      if (!version.input || (entry.dispatchedRevision !== null && entry.dispatchedRevision !== version.revision)) continue;
      const normalizedHistory = targetHistory.state !== "complete" && targetHistory.state !== "observed" ? targetHistory : {
        ...targetHistory,
        turns: targetHistory.turns.map(turn => ({ ...turn, items: turn.items.map(item =>
          item.type === "userMessage" && item.clientId === entry.clientUserMessageId
            ? { ...item, content: normalizeNativeQueueObservation(version, item.content as NativeQueueInput[]) ?? item.content } : item) })),
      };
      const found = findCodexHistoryDelivery(normalizedHistory, { clientId: entry.clientUserMessageId, content: version.input, turnId: entry.dispatchedTurnId ?? null });
      if (found.state === "found") return { threadId: found.identity.threadId, clientUserMessageId: entry.clientUserMessageId,
        revision: version.revision, turnId: found.turnId, itemId: found.item.id, input: version.input };
    }
    return null;
  }

  private hasBlockingAttention(): boolean {
    return [...this.attentions.values()].some(attention => attention.isBlocking !== false);
  }

  async send(entry: QueueEntry, firstDispatch?: FirstDispatchEvidence): Promise<DeliveryReceipt> {
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
    const confirmed = await this.confirmedDelivery(entry, firstDispatch?.firstDispatch === true
      && firstDispatch.operationId === entry.id && Boolean(firstDispatch.writerClaim));
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
          codexDeliveryDedup(normalized.id),
        ),
      },
    ];
    if (currentTurn) {
      if (this.hasBlockingAttention()) throw new StructuredSendRefusedError("blocking attention must be answered before steering");
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
    const profile = codexTurnProfile(entry.runtime, { model: this.requestedModel, effort: this.effort }, this.modelCatalog);
    const result = await this.rpc("turn/start", {
      threadId: this.identity.threadId,
      ...profile,
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

  /** Delivery-scoped native evidence, with the established legacy hydration
      fallback. Every caller names the input it is verifying; native history
      never returns an unbounded full-turn response. Legacy windows stay
      first/latest as before, and the returned turns are oldest-first. */
  private async readThreadForDelivery(clientId: string, window: "first" | "latest", timeoutMs?: number): Promise<unknown> {
    if (this.supportsNativeHistory() && this.identity.path) {
      const history = await this.readDeliveryHistory([clientId], timeoutMs);
      if (history.state === "complete" || history.state === "observed") return { thread: { id: history.identity.threadId, path: history.identity.path,
        turns: [...history.turns].reverse() } };
      if (history.state === "unknown") {
        if (history.reason === "not-materialized") {
          throw new Error("Codex thread is not materialized yet before first user message");
        }
        throw new Error(`Codex canonical history is unavailable: ${history.reason}`);
      }
    }
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
      result = await this.readThreadForDelivery(clientMessageId, "first");
    } catch (error) {
      const reason = safeError(error);
      if (/not materialized yet/i.test(reason) && /before first user message/i.test(reason)) {
        /* Codex 0.151 keeps giving this answer for threads whose rollout is
           already on disk with the confirmed first message in it. The rollout
           IS the session store, so it outranks the engine's claim (#1332). */
        const persistedOnDisk = rolloutTurnsFromDisk(this.identity.path).some((turn) =>
          Array.isArray(turn.items)
          && turn.items.some((item) => stringField(item, "clientId") === clientMessageId));
        if (persistedOnDisk) return { state: "materialized" };
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
    /* Codex 0.151 can answer the hydrated read successfully while omitting
       `thread.turns` entirely, so an empty reply is not absence evidence —
       the rollout on disk decides before absent is ever reported (#1332). */
    const turnHoldsFirstMessage = (turn: JsonObject): boolean =>
      Array.isArray(turn.items)
      && turn.items.some((item) => stringField(item, "clientId") === clientMessageId);
    const persistedFirstMessage = resumedTurns(result).some(turnHoldsFirstMessage)
      || rolloutTurnsFromDisk(this.identity.path).some(turnHoldsFirstMessage);
    return persistedFirstMessage
      ? { state: "materialized" }
      : { state: "absent", reason: "Codex app-server did not read back the confirmed first message" };
  }

  /**
   * Native history injection (#1560): `thread/inject_items`, the one
   * app-server write that appends model-visible input to a thread WITHOUT
   * interrupting the running turn and without starting a new one.
   *
   * The engine's two placements are genuinely different facts and are reported
   * as such. With a turn running, the items land in that turn's pending input
   * and are picked up at its next sampling request, inside the same turn. Idle,
   * they are written to history and simply wait. Neither placement is a claim
   * that the model read them.
   *
   * Three properties make this safe to run as a durable operation:
   *
   * - **The engine does not deduplicate.** A repeated request writes a second
   *   record, which the prior probe observed directly. So the canonical
   *   transcript is scanned for this operation's dedup marker BEFORE the
   *   mutating request, and a hit returns that insertion instead of making
   *   another one.
   * - **The acknowledgement is empty.** `{}` proves the request was accepted
   *   and nothing more — on the active path it can be answered while the items
   *   are still only pending and the rollout flush has not happened. So the ack
   *   never settles this operation on its own; the insertion has to be read
   *   back out of canonical history before it is called observed.
   * - **Injection is not a send.** Nothing here falls back to `turn/steer`,
   *   `turn/start` or `turn/interrupt`. A host that cannot inject says so and
   *   the operation fails with that reason; it is never quietly delivered as
   *   something the operator did not ask for.
   */
  async inject(request: RuntimeInjectRequest): Promise<RuntimeInjectOutcome> {
    if (this.dead || this.releasing || this.released || !this.writerFenceAllowsActuation()) {
      throw new StructuredInjectError("Codex app-server host is unavailable", "refused");
    }
    if (request.threadId && request.threadId !== this.identity.threadId) {
      throw new StructuredInjectError("injection target thread is not the thread this host owns", "refused");
    }
    if (this.injectCapability === "unsupported") {
      throw new StructuredInjectError("this Codex app-server does not support history injection", "refused");
    }
    /* An unanswered approval owns the thread's input. Injecting underneath it
       is the same hazard steering has, and is refused the same way. */
    if (this.hasBlockingAttention()) {
      throw new StructuredInjectError("blocking attention must be answered before injecting context", "refused");
    }
    /* The caller's fence, re-evaluated at actuation because the turn axis can
       move between admission and here. `undefined` accepts either placement. */
    if (request.expectedTurnId !== undefined && request.expectedTurnId !== this.activeTurnId) {
      throw new StructuredInjectError("stale-turn", "refused");
    }
    const dedup = codexDeliveryDedup(request.operationId);
    const entry: QueueEntry = { id: request.operationId, text: request.text, contentDigest: request.contentDigest };
    /* Canonical lookup precedes insertion. A payload mismatch under the same
       operation id throws out of here, which is what keeps one durable key
       bound to one payload for ever.

       Classified as REFUSED, and the wrapper is the whole point: this runs
       BEFORE the request, so whatever it throws — an unreadable transcript, a
       payload that does not match the one this key already carries — is a
       failure in which `thread/inject_items` provably was never called. Left
       unwrapped it reached the caller as a plain error and was reported
       "issued, outcome unverified", which is untrue, and `uncertain` is
       absorbing: retry is refused for this kind and the row is not editable, so
       the operation stranded with nothing the operator could do. On the
       `failed` path the wording is true and Edit comes back. */
    let already;
    try {
      already = await rolloutConfirmedDelivery(this.identity.path, entry);
    } catch (error) {
      throw new StructuredInjectError(safeError(error), "refused");
    }
    if (already) {
      /* Already in the transcript, so the evidence phase has nothing left to
         wait for and answers immediately. */
      return { placement: "history", turnId: null, observe: async () => true };
    }
    /* Read once, before the write, so the placement reported afterwards is the
       one the request was actually issued against rather than whatever the turn
       axis drifted to while the insertion was being observed. */
    const turnAtActuation = this.activeTurnId;
    const items = [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        /* The SAME structured-user envelope an ordinary send writes, so the
           injected record is recognisably ours, keeps its authorship and its
           selected-card reference, and — through `dedup` — is findable in the
           rollout by the scan above. That marker is the whole idempotency
           story here, because the engine supplies none. */
        text: encodeCodexStructuredUserText(
          request.text,
          undefined,
          request.selectedContext,
          request.origin ?? { kind: "operator" },
          dedup,
        ),
      }],
    }];
    try {
      await this.rpc("thread/inject_items", { threadId: this.identity.threadId, items });
    } catch (error) {
      const message = safeError(error);
      if (error instanceof NativeQueueProtocolRefusal && error.code === -32601) {
        this.injectCapability = "unsupported";
        this.setSessionStatus(this.engineStatus, this.activeFlags);
        throw new StructuredInjectError("this Codex app-server does not support history injection", "refused");
      }
      /* A transport failure after the request left is NOT a refusal: the
         insertion may have landed. It is reported unverified so the caller
         terminalizes it as unknown rather than offering a second write. */
      throw new StructuredInjectError(message, injectionRefusalIsProven(error) ? "refused" : "unverified");
    }
    const placement = turnAtActuation ? "pending-input" as const : "history" as const;
    /* The acknowledgement returns NOW. Reading the insertion back is a separate
       phase the caller runs on its own schedule, because the active path's
       evidence does not exist until the turn reaches its next model request. */
    return {
      placement,
      turnId: turnAtActuation,
      observe: () => this.observeInjectedItem(entry, turnAtActuation),
    };
  }

  /**
   * Waits, bounded, for an injected item to appear in the canonical transcript.
   *
   * This is the whole difference between "the engine accepted the request" and
   * "the input is in the thread". The rollout scan is cached on size and mtime,
   * so a poll over an unchanged file costs a stat; the deadline is what keeps
   * an active injection whose flush never comes from waiting for ever. Coming
   * back false is not a failure — it is the honest "not established yet", and
   * the caller records it as exactly that.
   */
  private async observeInjectedItem(entry: QueueEntry, turnAtActuation: string | null): Promise<boolean> {
    const deadline = Date.now() + this.injectObservationTimeoutMs;
    let wait = INJECT_OBSERVATION_POLL_MS;
    for (;;) {
      if (this.dead || this.releasing || this.released) return false;
      /* Read the turn BEFORE the scan, so the final scan below happens after
         the turn ended rather than racing the flush that ends with it. */
      const turnEnded = turnAtActuation !== null && this.activeTurnId !== turnAtActuation;
      try {
        if (await rolloutConfirmedDelivery(this.identity.path, entry)) return true;
      } catch {
        /* An unreadable transcript establishes nothing either way, and must not
           turn an insertion that may have landed into a reported failure. */
        return false;
      }
      /* THE TURN THIS JOINED IS OVER. Its pending input was either consumed or
         discarded, and the rollout has been flushed either way — so one more
         scan cannot change, and waiting out the rest of the deadline would only
         delay the verdict. The scan above already ran after the end. */
      if (turnEnded) return false;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, wait));
      /* Backs off toward the ceiling: an active turn can sit in one tool call
         for minutes, and a 150 ms poll held for that long is thousands of stats
         to learn nothing. Found-fast stays fast — the idle flush is immediate,
         so it is seen on the first or second pass. */
      wait = Math.min(wait * 2, INJECT_OBSERVATION_POLL_CEILING_MS);
    }
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

  /**
   * @param personaVariant which persona this call bootstraps into the thread.
   *   Defaults to `modality`, the variant that assigns no role: a caller that did
   *   not resolve the question has not established that this thread is the voice
   *   front, and the coordinator mandate overwrites whatever role it finds.
   */
  async startRealtimeWebRtc(
    sdp: string,
    personaVariant: VoicePersonaVariant = "modality",
  ): Promise<CodexRealtimeWebRtcAnswer> {
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
    this.realtimeTranscript.end();
    const persona = voiceSessionPersona(personaVariant);

    let pendingStart!: PendingRealtimeStart;
    const answer = new Promise<CodexRealtimeWebRtcAnswer>((resolve, reject) => {
      pendingStart = {
        resolve,
        reject,
        timer: undefined,
        started: false,
        realtimeSessionId: null,
        sdp: null,
        persona: { variant: persona.variant, personaId: persona.personaId },
      };
    });
    this.pendingRealtimeStart = pendingStart;
    void answer.catch(() => undefined);

    const realtimeContext = selectRealtimeContext(this.events);
    console.info("[realtime context] selected", {
      providerStartupContext: true,
      personaVariant: persona.variant,
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
        /* THE SPOKEN MODEL'S ONLY INSTRUCTIONS (#1629). Unset, the backend
           gives it Codex's stock realtime persona — a general-purpose assistant
           that knows nothing about this thread's role or tools — and no item
           written into the thread ever reaches it. */
        "prompt": persona.prompt,
        /* THE BACKING MODEL'S FRAMING, scoped to this call. Paired with the end
           instructions so hanging up withdraws it, which is what keeps a text
           agent from inheriting spoken-delivery rules for the rest of its life. */
        realtimeStartInstructions: persona.startInstructions,
        realtimeEndInstructions: persona.endInstructions,
        /* The last thing said before a hangup is said INTO the tail. Without
           this it is dropped instead of routed through Codex, so an instruction
           given on the way out never reaches the canonical thread. */
        flushTranscriptTailOnSessionEnd: true,
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
    this.realtimeTranscript.end();
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
    if (attention?.origin === "restored") throw new Error("attention belongs to a previous host generation; answer ownership is unavailable");
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
      : this.hasBlockingAttention() ? "attention"
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
      nativeQueueRevision: this.nativeQueueRevision,
      activeFlags: [...this.activeFlags, ...(this.nativeQueue ? ["native-queue"] : []), ...(this.injectCapability === "supported" ? [NATIVE_INJECT_CAPABILITY] : []), ...(this.supportsNativeHistory() && Array.isArray(record(this.modelCatalog)?.data) ? ["native-turn-profile"] : [])],
      account: this.account,
      diagnostics: { executable: this.selectedExecutable, version: this.protocolVersion, nativeQueue: !!this.nativeQueue, queueCapability: this.queueCapability, injectCapability: this.injectCapability, authRecovery: this.authRecovery },
    };
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.nativeQueue?.queue.dispose();
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
    this.realtimeTranscript.end();
    }
    this.releasing = true;
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
    /* Recorded here rather than at each call site, so every path that ends a
       turn — a terminal notification, a resume that finds it already over, an
       error that terminalizes it — leaves the same evidence for the voice
       ledger. Bounded, because a long-lived host ends a great many turns. */
    if (event.kind === "turn-ended") this.recordTerminatedTurn(event.turnId);
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

  /** Bounded terminal-turn memory. The oldest is forgotten first, and forgetting
      answers `unknown` rather than `completed` — the ledger then keeps its own
      record instead of retiring work on missing evidence. */
  private recordTerminatedTurn(turnId: string): void {
    if (!turnId) return;
    this.terminatedTurnIds.delete(turnId);
    this.terminatedTurnIds.add(turnId);
    while (this.terminatedTurnIds.size > MAX_TERMINATED_TURN_MEMORY) {
      const oldest = this.terminatedTurnIds.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.terminatedTurnIds.delete(oldest);
    }
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
        this.attentions.set(event.id, { rpcId: "restored", method: event.method, origin: "restored", isBlocking: !isNonblockingCodexQuestion(event.method, event.attention) });
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
      const previous = this.events.findLast(event => event.kind === "attention" && event.id === attentionId);
      if (previous?.kind === "attention") this.emit({ kind: "attention", id: attentionId, method: attention.method,
        attention: { ...(record(previous.attention) ?? {}), unowned: true } });
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

  private async confirmedDelivery(entry: QueueEntry, firstDispatch = false): Promise<DeliveryReceipt | null> {
    const known = this.confirmedDeliveries.get(entry.id);
    if (known) return this.confirmedReceipt(entry, known);
    const persistedRead = rolloutConfirmedDelivery(this.identity.path, entry);
    const persisted = persistedRead instanceof Promise ? await persistedRead : persistedRead;
    if (persisted) return persisted;
    // The journal already established this operation's first actuation. Keep
    // local duplicate/collision checks, but do not scan unrelated native
    // history to authorize a newly admitted message. Recovery remains below.
    if (firstDispatch) return null;
    let thread: unknown;
    try {
      const timeoutMs = this.activeTurnId
        ? this.requestTimeoutMs * ACTIVE_THREAD_READ_TIMEOUT_MULTIPLIER
        : this.requestTimeoutMs;
      thread = await this.readThreadForDelivery(entry.id, "latest", timeoutMs);
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

  private rpc(method: string, params: JsonObject = {}, timeoutMs = this.requestTimeoutMs, preserveHost = false): Promise<unknown> {
    if (this.dead || this.releasing || this.released) return Promise.reject(new Error("Codex app-server host is unavailable"));
    const id = this.nextRpcId++;
    if (REPLAY_ENVELOPE_METHODS.has(method)) this.trackReplayEnvelopeRequest(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (method === "thread/read" || preserveHost) this.rememberLateThreadReadResponse(id, timeoutMs);
        const error = new Error(`${method} timed out${MUTATING_RPC_METHODS.has(method) ? "; outcome is uncertain" : ""}`);
        reject(error);
        if (MUTATING_RPC_METHODS.has(method) && !preserveHost) this.fail(error);
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
      if (error) {
        const message = `Codex app-server request failed: ${safeError(error.message ?? "unknown error")}`;
        pending.reject(typeof error.code === "number" && Number.isInteger(error.code)
          ? new NativeQueueProtocolRefusal(error.code, message) : new Error(message));
      }
      else pending.resolve(message.result);
      return;
    }
    if (!method) return this.fail(new Error("Codex app-server message has no method"));
    const params = record(message.params) ?? {};
    if (typeof id === "number" || typeof id === "string") {
      const baseAttentionId = `${method}:${String(id)}`;
      const currentRequest = [...this.attentions].find(([, attention]) => attention.origin === "current" && attention.rpcId === id && attention.method === method);
      const attentionId = currentRequest?.[0] ?? (this.attentions.get(baseAttentionId)?.origin === "restored"
        ? `${baseAttentionId}:generation-${this.cursor + 1}` : baseAttentionId);
      this.attentions.set(attentionId, { ...currentRequest?.[1], rpcId: id, method, origin: "current", isBlocking: !isNonblockingCodexQuestion(method, params) });
      const event = { kind: "attention" as const, id: attentionId, method, attention: params };
      if (!reconcileBufferedLifecycle || !this.consumeBufferedNotification(event)) this.emit(event);
      return;
    }
    if (method === "modelProvider/authRecoveryStarted" || method === "modelProvider/authRecoveryCompleted") {
      const valid = params.threadId === this.identity.threadId && typeof params.turnId === "string" && params.turnId.length > 0
        && typeof params.provider === "string" && typeof params.message === "string";
      this.authRecovery = !valid ? "unknown" : method.endsWith("Started") ? "started" : "completed-unverified";
      this.notifyStateListeners();
    }
    if (this.nativeQueue?.queue.handleNotification(method, params)) {
      this.nativeQueueRevision++;
      this.emit({ kind: "native-queue-changed", threadId: this.identity.threadId });
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
    /* #1629: the canonical transcript. These are the app-server's own
       notifications, so they survive a data-channel drop and are what the
       thread's committed timeline is built from. Answered before the pending
       start check because they arrive throughout the call, not around it. */
    if (CANONICAL_REALTIME_TRANSCRIPT_METHODS.has(method)) {
      if (stringField(params, "threadId") !== this.identity.threadId) return;
      const segment = this.realtimeTranscript.observe(method, params);
      if (segment) {
        this.emit({
          kind: "voice-transcript",
          realtimeSessionId: segment.realtimeSessionId,
          segmentId: segment.id,
          role: segment.role,
          text: segment.text,
          final: segment.final,
        });
      }
      return;
    }
    if (method === "thread/realtime/started") {
      const pending = this.pendingRealtimeStart;
      if (!pending || stringField(params, "threadId") !== this.identity.threadId) return;
      pending.started = true;
      pending.realtimeSessionId = stringField(params, "realtimeSessionId");
      this.realtimeSessionId = pending.realtimeSessionId;
      this.realtimeTranscript.begin(pending.realtimeSessionId ?? "");
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
        attention.origin === "current" && String(attention.rpcId) === String(requestId));
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
      persona: pending.persona,
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

  /**
   * The native thread this host runs (#1629).
   *
   * A tool call's `_meta` names the thread it came from. Comparing the two is
   * what turns the caller's claim into evidence, so the voice ledger can refuse
   * a request that names work on some other thread.
   */
  providerThreadId(): string | null {
    return this.identity.threadId;
  }

  /** Whether a backing turn is running right now. */
  hasActiveTurn(): boolean {
    return this.activeTurnId !== null;
  }

  /**
   * What this host can say about one backing turn (#1629).
   *
   * `completed` is the only authoritative retirement evidence the voice ledger
   * accepts: it means this host saw that turn end. A turn it has no terminal
   * record for is `unknown` — a host that restarted, or one whose ledger was
   * replayed past the event, has MISSING evidence, and the ledger keeps what it
   * holds rather than treating silence as an ending.
   */
  voiceWorkTurnState(turnId: string): "active" | "completed" | "unknown" {
    if (!turnId) return "unknown";
    if (this.activeTurnId === turnId) return "active";
    return this.terminatedTurnIds.has(turnId) ? "completed" : "unknown";
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
