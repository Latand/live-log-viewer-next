/**
 * Delivery-state surfacing model (issue #264, docs/design/delivery-state.md).
 *
 * Single authority for which receipts render delivery chrome. Three classes:
 * - active   (pending/delivering/queued/uncertain): compact composer disclosure;
 * - resolved (turn-started/steered/delivered/answered/interrupted): nothing
 *   persistent — the user bubble in the feed is the confirmation;
 * - problem  (rejected/failed): one inline actionable row, dismissible, and the
 *   dismissal persists per conversation.
 *
 * Pure — no I/O beyond the explicit sessionStorage helpers, no React — so the
 * grouping, supersede-by-success, echo, and dismissal rules are deterministic.
 */

import { receiptIsTerminal, type ReceiptStatus, type RuntimeReceipt } from "./runtimeModel";

export function deliveryProblem(status: ReceiptStatus): boolean {
  return status === "rejected" || status === "failed";
}

/**
 * The delivery question is settled and there is nothing left to act on: the
 * message is inside the turn/transcript (`turn-started`/`steered`/`delivered`/
 * `answered`) or the operation closed by deliberate user action
 * (`interrupted`). Resolved receipts render no chip, badge, or pill anywhere.
 */
export function deliveryResolved(status: ReceiptStatus): boolean {
  return status === "turn-started" || status === "steered" || (receiptIsTerminal(status) && !deliveryProblem(status));
}

function isMessage(receipt: RuntimeReceipt): boolean {
  return receipt.kind === "send" || receipt.kind === "steer";
}

const newestFirst = (left: RuntimeReceipt, right: RuntimeReceipt) => Date.parse(right.at) - Date.parse(left.at);

export interface DeliveryAttemptGroup {
  /** Newest visible attempt — carries the current state and the action set. */
  current: RuntimeReceipt;
  /** Visible attempts, newest first (`current` is `attempts[0]`). */
  attempts: RuntimeReceipt[];
}

/**
 * Visible attempt groups for the composer disclosure. Attempts of one logical
 * message (identical kind + text) share one group. Grouping runs over ALL
 * message attempts first so a group whose newest attempt resolved disappears
 * entirely — earlier failures superseded by a successful resend of the same
 * text go quiet with it (rule 1). Within a visible group, resolved history and
 * dismissed settled attempts drop; a still-moving attempt always renders
 * (dismissal never hides live delivery truth).
 */
export function deliveryAttemptGroups(
  receipts: readonly RuntimeReceipt[],
  dismissed: ReadonlySet<string> = new Set(),
): DeliveryAttemptGroup[] {
  const messageReceipts = receipts
    .filter((receipt) => isMessage(receipt) && Boolean(receipt.text))
    .sort(newestFirst);
  const order: string[] = [];
  const byKey = new Map<string, RuntimeReceipt[]>();
  for (const receipt of messageReceipts) {
    const key = `${receipt.kind}\u0000${receipt.text}`;
    const group = byKey.get(key);
    if (group) group.push(receipt);
    else {
      byKey.set(key, [receipt]);
      order.push(key);
    }
  }
  const groups: DeliveryAttemptGroup[] = [];
  for (const key of order) {
    const all = byKey.get(key)!;
    if (deliveryResolved(all[0]!.status)) continue;
    const attempts = all.filter((attempt) =>
      !deliveryResolved(attempt.status)
      && !(receiptIsTerminal(attempt.status) && dismissed.has(attempt.operationId)));
    if (!attempts.length) continue;
    groups.push({ current: attempts[0]!, attempts });
  }
  return groups;
}

/**
 * Non-message operations (interrupt/answer/kill/spawn) and message receipts
 * without a text echo, filtered by the same classes: active and problem states
 * render, terminal success never does, and a dismissed settled problem stays
 * dismissed. This is what removes the accumulated green pills.
 */
export function visibleStandaloneReceipts(
  receipts: readonly RuntimeReceipt[],
  dismissed: ReadonlySet<string> = new Set(),
): RuntimeReceipt[] {
  return receipts.filter((receipt) =>
    (!isMessage(receipt) || !receipt.text)
    && !deliveryResolved(receipt.status)
    && !(receiptIsTerminal(receipt.status) && dismissed.has(receipt.operationId)));
}

/** The mtime fallback self-clears an echo once the transcript grows past the
    delivery moment (small grace: the bubble's write bumps the mtime). */
export const DELIVERY_ECHO_MTIME_GRACE_MS = 2_000;
/** Hard cap so a conversation whose transcript never grows again (finished
    pane, lost poll) cannot keep echoes around forever. */
export const DELIVERY_ECHO_TTL_MS = 10 * 60_000;
const EMPTY_TRANSCRIPT_ECHO_COUNTS: ReadonlyMap<string, number> = new Map();

/**
 * Successful sends whose bubble has not landed in the visible feed yet: the
 * quiet one-line echo above the composer (rule 2). Derived, never stored — one
 * echo per idempotency key. An exact user-text occurrence in the rendered feed
 * retires it immediately. The mtime and TTL checks cover legacy or temporarily
 * incomplete feed snapshots. `interrupted` resolves quietly and never echoes.
 */
export function deliveryEchoes(
  receipts: readonly RuntimeReceipt[],
  fileMtimeMs: number,
  dismissed: ReadonlySet<string>,
  nowMs: number,
  transcriptEchoCounts: ReadonlyMap<string, number> = EMPTY_TRANSCRIPT_ECHO_COUNTS,
): RuntimeReceipt[] {
  const seenKeys = new Set<string>();
  const echoes: RuntimeReceipt[] = [];
  const sorted = receipts
    .filter((receipt) => isMessage(receipt) && Boolean(receipt.text))
    .sort(newestFirst);
  for (const receipt of sorted) {
    if (seenKeys.has(receipt.idempotencyKey)) continue;
    seenKeys.add(receipt.idempotencyKey);
    if (!deliveryResolved(receipt.status) || receipt.status === "interrupted") continue;
    if (dismissed.has(receipt.operationId)) continue;
    const text = receipt.text?.trim();
    if (text && (transcriptEchoCounts.get(text) ?? 0) > 0) continue;
    const at = Date.parse(receipt.at);
    if (!Number.isFinite(at)) continue;
    if (fileMtimeMs >= at + DELIVERY_ECHO_MTIME_GRACE_MS) continue;
    if (nowMs - at >= DELIVERY_ECHO_TTL_MS) continue;
    echoes.push(receipt);
  }
  return echoes;
}

/* ------------------------------------------------------------------ *
 * Dismissal persistence (rule 3)                                      *
 * ------------------------------------------------------------------ */

export const DISMISSED_RECEIPTS_LIMIT = 64;

/** Keyed by conversation identity, adopted across id rotations alongside the
    draft/pending/sent records (see `adoptComposerState`). */
export const dismissedReceiptsKey = (id: string) => "llvReceiptsDismissed:" + id;

export function readDismissedReceipts(id: string): string[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(dismissedReceiptsKey(id)) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is string => typeof entry === "string").slice(-DISMISSED_RECEIPTS_LIMIT);
  } catch {
    return [];
  }
}

export function writeDismissedReceipts(id: string, operationIds: readonly string[]): void {
  try {
    if (operationIds.length) sessionStorage.setItem(dismissedReceiptsKey(id), JSON.stringify(operationIds));
    else sessionStorage.removeItem(dismissedReceiptsKey(id));
  } catch { /* quota/opaque-origin: the in-memory dismissal still holds */ }
}

/** Bounded append, newest last; re-dismissing moves the id to the tail. */
export function withDismissedReceipts(current: readonly string[], operationIds: readonly string[]): string[] {
  const adding = new Set(operationIds);
  return [...current.filter((id) => !adding.has(id)), ...operationIds].slice(-DISMISSED_RECEIPTS_LIMIT);
}
