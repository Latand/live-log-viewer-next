import type { NativeQueueHost } from "./nativeQueueExecutor";
import type { SelectedContextRef } from "@/lib/selection/selectedContext";

import type { MessageOrigin } from "./messageOrigin";
import type { RuntimeSendSettings, RuntimeHostDiagnostics } from "./contracts";
import type { RuntimeVoiceDelivery, RuntimeVoiceResponse } from "./voiceDelivery";
import {
  structuredContent,
  type StructuredImageRef,
  type StructuredMessageContent,
} from "./structuredContent";

export interface QueueEntry {
  id: string;
  content?: StructuredMessageContent;
  contentDigest?: string;
  /** Compatibility input for text-only host callers during journal migration. */
  text?: string;
  images?: StructuredImageRef[];
  /** Optional caller fence. A mismatch is rejected before any engine write. */
  expectedTurnId?: string | null;
  /** Per-turn runtime settings snapshotted on the durable send effect (issue
      #390 §10). A host applies what its protocol can honor and ignores the
      rest; absent = the host's own configuration, exactly as before. */
  runtime?: RuntimeSendSettings;
  /** #844: the Viewer card the operator had selected when this turn was
      submitted. Hosts that can persist it write it onto the canonical
      structured-user record; the rest ignore it, exactly as with `runtime`. */
  selectedContext?: SelectedContextRef;
  /** #1117: who authored this message, stamped at admission. The Claude
      broker journals it on the delivery ledger's queued record; the Codex
      host stamps it onto the structured-user marker. Absent = unknown, and
      the feed keeps its current rendering. */
  origin?: MessageOrigin;
}

/** Internal journal evidence, never accepted from a send request body. The
 * delivery executor supplies this only after taking the first queued receipt
 * into delivering under a known writer claim. A retry gets no such evidence. */
export interface FirstDispatchEvidence {
  readonly operationId: string;
  readonly writerClaim: string;
  readonly firstDispatch: true;
}

export interface NormalizedQueueEntry {
  id: string;
  content: StructuredMessageContent;
  contentDigest: string;
  expectedTurnId?: string | null;
  runtime?: RuntimeSendSettings;
  selectedContext?: SelectedContextRef;
  origin?: MessageOrigin;
}

export function normalizeQueueEntry(entry: QueueEntry): NormalizedQueueEntry {
  const envelope = structuredContent(entry.content?.text ?? entry.text ?? "", entry.content?.images ?? entry.images ?? []);
  if (entry.contentDigest && entry.contentDigest !== envelope.contentDigest) throw new Error("queue entry content digest mismatch");
  return {
    id: entry.id,
    content: envelope.content,
    contentDigest: envelope.contentDigest,
    ...(entry.expectedTurnId !== undefined ? { expectedTurnId: entry.expectedTurnId } : {}),
    ...(entry.runtime ? { runtime: entry.runtime } : {}),
    ...(entry.selectedContext ? { selectedContext: entry.selectedContext } : {}),
    ...(entry.origin ? { origin: entry.origin } : {}),
  };
}

export type DeliveryReceipt =
  | { outcome: "steered"; turnId: string }
  | { outcome: "turn-started"; turnId: string }
  | { outcome: "queued-next-turn"; turnId: string }
  | { outcome: "rejected"; reason: "stale-turn" | "dead-host" };

export type RuntimeEvent =
  /** One canonical realtime transcript segment, from the app-server's own
      `thread/realtime/*` notifications rather than the browser's data channel
      (#1629). Carries the whole segment so far, never a delta. */
  | {
    kind: "voice-transcript";
    realtimeSessionId: string;
    segmentId: string;
    role: "user" | "assistant";
    text: string;
    final: boolean;
    seq: number;
  }
  | { kind: "native-queue-changed"; threadId: string; seq: number }
  | { kind: "turn-started"; turnId: string; seq: number }
  | { kind: "delta"; turnId: string; text: string; seq: number }
  | { kind: "item"; turnId: string | null; item: unknown; phase: "started" | "completed"; voiceResponse?: RuntimeVoiceResponse | null; seq: number }
  | { kind: "voice-chunk"; turnId: string; delivery: RuntimeVoiceDelivery; seq: number }
  | { kind: "turn-ended"; turnId: string; status: "completed" | "interrupted" | "error"; seq: number }
  | { kind: "attention"; id: string; method: string; attention: unknown; seq: number }
  | { kind: "attention-resolved"; id: string; resolution: "answered" | "host-restarted" | "server-resolved" | "turn-ended"; seq: number }
  | { kind: "limits"; snapshot: unknown; seq: number }
  | { kind: "realtime-delivery-progress"; deliveryId: string; digest: string; responseIndex: number; offset: number; seq: number }
  | { kind: "realtime-delivery-acknowledged"; deliveryId: string; digest: string; seq: number }
  | { kind: "session-status"; status: "active" | "idle" | "unhosted" | "dead"; activeFlags?: string[]; seq: number };

export interface HostState {
  status: "active" | "attention" | "idle" | "unhosted" | "dead";
  sessionKey: string;
  endpoint: string;
  pid: number | null;
  processStartIdentity: string | null;
  eventCursor: number;
  protocolVersion: string | null;
  activeTurnRef: string | null;
  /** Includes every answerable request; only validated blocking requests affect status. */
  pendingAttention: string[];
  nativeQueueRevision?: number;
  diagnostics?: RuntimeHostDiagnostics;
  activeFlags: string[];
  account: { type: string | null; planType: string | null } | null;
}

export class RuntimeReplayGapError extends Error {
  constructor(readonly requestedAfterSeq: number, readonly firstAvailableSeq: number) {
    super(`runtime replay begins at sequence ${firstAvailableSeq}; requested after ${requestedAfterSeq}`);
    this.name = "RuntimeReplayGapError";
  }
}

/** Shared structured-host boundary from the issue 25 spike. */
export interface EngineHost {
  readonly nativeQueue?: NativeQueueHost;
  readonly supportsSteer?: boolean;
  attach(afterSeq: number): AsyncIterable<RuntimeEvent>;
  send(entry: QueueEntry, firstDispatch?: FirstDispatchEvidence): Promise<DeliveryReceipt>;
  interrupt(turnRef: string): Promise<void>;
  answer(attentionRef: string, value: unknown): Promise<void>;
  health(): Promise<HostState>;
  release(): Promise<void>;
  /** Engine-backed persistence evidence for a fresh session's first message.
      A logical session may exist before its canonical transcript does. */
  sessionMaterializationEvidence?(clientMessageId: string): Promise<SessionMaterializationEvidence>;
}

export type SessionMaterializationEvidence =
  | { state: "materialized" }
  /** The first turn is still live and later persistence reads may advance. */
  | { state: "absent"; reason: string }
  /** The persistence read had no verdict; a readable canonical artifact may still prove success. */
  | { state: "unavailable"; reason: string }
  /** The engine rejected the identity or ended its first turn while still reporting no first message. */
  | { state: "failed"; reason: string };

export class StructuredSessionMaterializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredSessionMaterializationError";
  }
}

export interface RuntimeCompactRequest {
  /** The durable operation this control belongs to. A repeat for the same id
      joins the in-flight control instead of issuing a second compaction. */
  operationId: string;
  /** The generation the caller admitted the operation against. A mismatch is
      refused so a re-seated host can never compact someone else's thread. */
  threadId: string;
}

/** The compaction the engine actually performed, identified by its lifecycle
    item so the durable receipt records which compaction closed the operation. */
export interface RuntimeCompactOutcome {
  compactionId: string | null;
}

/** A host whose engine exposes a client-originated compact control (#862). */
export interface CompactCapableHost extends EngineHost {
  compact(request: RuntimeCompactRequest): Promise<RuntimeCompactOutcome>;
}

export function hostSupportsCompact(host: EngineHost): host is CompactCapableHost {
  return typeof (host as Partial<CompactCapableHost>).compact === "function";
}

/**
 * One native injection: raw operator input appended to the thread's
 * model-visible history without steering, interrupting or starting a turn
 * (#1560, Codex `thread/inject_items`).
 *
 * Everything the host needs to be idempotent is frozen here at admission. The
 * operation id is what the durable dedup marker is derived from, so a repeated
 * request converges on the insertion that already happened instead of writing
 * a second one — the engine itself does not deduplicate, and a repeated item id
 * was observed producing duplicate rollout records.
 */
export interface RuntimeInjectRequest {
  /** The durable operation this insertion belongs to, and its dedup identity. */
  operationId: string;
  /** The generation the caller admitted against. A mismatch is refused, so a
      re-seated host can never inject into someone else's thread. */
  threadId: string;
  text: string;
  contentDigest: string;
  /** Caller fence. `undefined` accepts whatever the turn axis is at actuation;
      a string requires that exact turn to still be running; `null` requires an
      idle thread. Evaluated before the mutating request. */
  expectedTurnId?: string | null;
  selectedContext?: SelectedContextRef;
  origin?: MessageOrigin;
}

/**
 * What an injection actually did, kept deliberately separate from whether the
 * engine answered.
 *
 * `placement` is the engine's own split: with a turn running the items enter
 * that turn's pending input and are read at its next sampling request; idle,
 * they are written to history and wait for whatever asks next. Neither is a
 * claim that the model has read them — `observed` only says the insertion was
 * found in the canonical transcript, which is as far as evidence goes.
 */
export interface RuntimeInjectOutcome {
  placement: "pending-input" | "history";
  /** The turn the items joined, or null when the thread was idle. */
  turnId: string | null;
  /**
   * The bounded wait for the insertion to appear in canonical history,
   * deliberately SEPARATE from the acknowledgement above.
   *
   * The engine answers `thread/inject_items` with an empty object, which proves
   * the request was accepted and nothing else — so something still has to read
   * the thread back before this operation can be called delivered. But on the
   * active path that evidence only appears when the turn reaches its next model
   * request, which can be minutes into one tool call.
   *
   * Splitting it out is what keeps that wait off the delivery pass. The engine
   * write is already done when this resolves to a function; observing it is a
   * read, so the caller can run it detached without anything else on the thread
   * losing its order. Resolves false when the window closed without evidence,
   * which is "not established", never "did not happen".
   */
  observe(): Promise<boolean>;
}

/** A host whose engine exposes client-originated history injection (#1560). */
export interface InjectCapableHost extends EngineHost {
  inject(request: RuntimeInjectRequest): Promise<RuntimeInjectOutcome>;
}

export function hostSupportsInject(host: EngineHost): host is InjectCapableHost {
  return typeof (host as Partial<InjectCapableHost>).inject === "function";
}

/**
 * An injection that did not succeed, with the same two-phase distinction the
 * compact control draws and for the same reason: `refused` means nothing was
 * written and the operator can be told so plainly, while `unverified` means the
 * request may have landed and no evidence settled it. Only the first may ever
 * be retried, and this slice retries neither — the engine does not deduplicate.
 */
export class StructuredInjectError extends Error {
  constructor(message: string, readonly phase: "refused" | "unverified") {
    super(message);
    this.name = "StructuredInjectError";
  }
}

/**
 * A compact control that did not succeed. `phase` is the whole point:
 * `refused` means the engine did not compact the thread and everyone can see
 * why, while `unverified` means the request may have landed and nothing proved
 * what became of it — the two must terminalize differently.
 */
export class StructuredCompactError extends Error {
  constructor(message: string, readonly phase: "refused" | "unverified") {
    super(message);
    this.name = "StructuredCompactError";
  }
}

export class StructuredHostAdoptionCleanupError<Host extends EngineHost = EngineHost> extends Error {
  constructor(message: string, readonly host: Host, options?: ErrorOptions) {
    super(message, options);
    this.name = "StructuredHostAdoptionCleanupError";
  }
}

/** A local precondition refused a send before a mutating engine request. */
export class StructuredSendRefusedError extends Error {
  constructor(message: string) { super(message); this.name = "StructuredSendRefusedError"; }
}
