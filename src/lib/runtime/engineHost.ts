import type { SelectedContextRef } from "@/lib/selection/selectedContext";

import type { RuntimeSendSettings } from "./contracts";
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
  operatorActionKey?: string;
}

export interface NormalizedQueueEntry {
  id: string;
  content: StructuredMessageContent;
  contentDigest: string;
  expectedTurnId?: string | null;
  runtime?: RuntimeSendSettings;
  selectedContext?: SelectedContextRef;
  operatorActionKey?: string;
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
    ...(entry.operatorActionKey ? { operatorActionKey: entry.operatorActionKey } : {}),
  };
}

export type DeliveryReceipt =
  | { outcome: "steered"; turnId: string }
  | { outcome: "turn-started"; turnId: string }
  | { outcome: "queued-next-turn"; turnId: string }
  | { outcome: "rejected"; reason: "stale-turn" | "dead-host" };

export type RuntimeEvent =
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
  pendingAttention: string[];
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
  attach(afterSeq: number): AsyncIterable<RuntimeEvent>;
  send(entry: QueueEntry): Promise<DeliveryReceipt>;
  interrupt(turnRef: string): Promise<void>;
  answer(attentionRef: string, value: unknown): Promise<void>;
  health(): Promise<HostState>;
  release(): Promise<void>;
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
