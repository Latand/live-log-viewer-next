import type { SelectedContextRef } from "@/lib/selection/selectedContext";
import type { MessageOrigin } from "./messageOrigin";
import type { RuntimeSendSettings } from "./contracts";
import type { NativeQueueInput, NativeQueuedSubmission } from "./nativeCodexQueue";
import type { StructuredImageRef } from "./structuredContent";

export type NativeQueueAction = "add" | "update" | "delete" | "reorder" | "start" | "send-now";
export interface NativeQueueBinding {
  threadId: string;
  accountId: string | null;
}

/** Every mutation has its own immutable Viewer key. The add owns the entry. */
export interface NativeQueueCommand {
  kind: "native-queue";
  conversationId: string;
  operationId?: string;
  idempotencyKey: string;
  action: NativeQueueAction;
  binding: NativeQueueBinding;
  /** Required for all single-entry controls except add. */
  entryId?: string;
  expectedRevision?: number;
  /** Reorder names native submission IDs, never Viewer or client IDs. */
  queuedSubmissionIds?: string[];
  text?: string;
  images?: StructuredImageRef[];
  contentDigest?: string;
  /** Audit only: native queue entries inherit the thread profile at dispatch. */
  runtime?: RuntimeSendSettings;
  selectedContext?: SelectedContextRef;
  origin?: MessageOrigin;
  /** Explicit null means idle. A string permits only that active turn. */
  turnId?: string | null;
}
export interface NativeQueueVersion {
  revision: number;
  operationId: string;
  text: string;
  images: StructuredImageRef[];
  contentDigest: string;
  requestedRuntime?: RuntimeSendSettings;
  selectedContext?: SelectedContextRef;
  origin?: MessageOrigin;
  /** Prepared before the first native write, retained across uncertain outcomes. */
  input?: NativeQueueInput[];
}
export interface NativeQueueProof {
  threadId: string;
  clientUserMessageId: string;
  revision: number;
  turnId: string;
  itemId: string;
  input: NativeQueueInput[];
}
export interface NativeQueueRecord {
  entryId: string;
  conversationId: string;
  binding: NativeQueueBinding;
  clientUserMessageId: string;
  nativeSubmissionId: string | null;
  revision: number;
  versions: NativeQueueVersion[];
  profilePolicy: "thread-at-dispatch";
  state: "admitted" | "queued" | "dispatching" | "withdrawn" | "removed" | "uncertain" | "delivered" | "refused";
  mutationOperationId: string | null;
  /** A dispatched version never changes, even when a concurrent edit was admitted. */
  dispatchedRevision: number | null;
  dispatchedTurnId: string | null;
  proof: NativeQueueProof | null;
  reason: string | null;
}
export type NativeQueueTransition =
  | { phase: "prepared"; input: NativeQueueInput[] }
  | { phase: "acknowledged"; nativeSubmissionId?: string; deleted?: boolean; turnId?: string }
  | { phase: "observed-queued"; submission: NativeQueuedSubmission }
  | { phase: "withdrawn" }
  | { phase: "removed" }
  | { phase: "refused"; reason: string }
  | { phase: "uncertain"; reason: string }
  | { phase: "proven"; proof: NativeQueueProof };

/**
 * Canonical proof for an entry whose add operation journal compaction already
 * removed (#1664). The binding is the one the prover read the thread under.
 */
export interface NativeQueueCompactedProof {
  conversationId: string;
  entryId: string;
  binding: NativeQueueBinding;
  proof: NativeQueueProof;
}
/**
 * What settling such an entry answers. It is NOT an operation receipt: the
 * operation is gone, so the settled entry is the only record of the delivery,
 * and nothing was admitted, queued or retried to produce it.
 */
export interface NativeQueueCompactedSettlement {
  operation: "compacted";
  entry: NativeQueueRecord;
  /** True when this exact proof had already settled the entry. */
  replayed: boolean;
}

/**
 * The proof with exactly the fields the history reader builds, or null when any
 * of them is missing or of the wrong type. Every settlement stores what this
 * returns, so a malformed identity is refused before anything is written and
 * nothing a caller adds beyond these fields is persisted.
 */
export function canonicalNativeQueueProof(value: unknown): NativeQueueProof | null {
  if (!value || typeof value !== "object") return null;
  const proof = value as Record<string, unknown>;
  const identity = (field: unknown): field is string => typeof field === "string" && field.length > 0;
  if (!identity(proof.threadId) || !identity(proof.clientUserMessageId) || !identity(proof.turnId) || !identity(proof.itemId)) return null;
  if (typeof proof.revision !== "number" || !Number.isSafeInteger(proof.revision) || proof.revision < 1) return null;
  if (!Array.isArray(proof.input) || proof.input.length === 0
    || !proof.input.every(item => item !== null && typeof item === "object" && !Array.isArray(item))) return null;
  return { threadId: proof.threadId, clientUserMessageId: proof.clientUserMessageId, revision: proof.revision,
    turnId: proof.turnId, itemId: proof.itemId, input: proof.input as NativeQueueInput[] };
}

export function sameNativeQueueBinding(a: NativeQueueBinding, b: NativeQueueBinding): boolean {
  return a.threadId === b.threadId && a.accountId === b.accountId;
}
