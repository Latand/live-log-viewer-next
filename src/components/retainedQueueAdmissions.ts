"use client";

import type { NativeQueueMutation } from "@/hooks/useNativeQueue";

/**
 * Where a queue command whose outcome nobody knows keeps its whole envelope
 * (#1629).
 *
 * ONE RECORD, TWO CALLERS. The composer's hand-off and every control on the
 * queue panel are the same kind of thing — one admission, identified by one
 * immutable key — and they share this store because the composer remounts on
 * every board poll. A component ref cannot hold a key across that, and a key
 * that does not survive the remount is a second operation waiting to be minted
 * for one the journal may already hold.
 */
/** The one sessionStorage slot these records live in, per card. */
export const queueAdmissionKey = (id: string) => "llvQueueAdmission:" + id;

/**
 * The Codex-queue operation this browser cannot say the outcome of (#1629).
 *
 * Every queue command — the composer's hand-off, and a delete, edit, move,
 * send-now or queue start pressed on the panel — is one durable operation
 * identified by its idempotency key, and the runtime journal answers a replay of
 * that key with the operation it already holds. But ONLY for a byte-identical
 * request: it hashes the command and refuses a key whose payload has changed.
 * So recovery is the whole envelope or it is nothing, and this keeps the
 * envelope itself and never a description of one.
 *
 * WHAT IS RETAINED, and why each part:
 *
 * - `key`, the operation's identity. Minting a fresh one for the second press
 *   made the two indistinguishable operations, which is how Codex could receive
 *   one message twice with nothing able to reconcile them.
 * - `mutation`, the exact command body — for a hand-off the text, attachment
 *   refs or bytes, requested runtime and selected card; for a panel control the
 *   entry it names and the revision it was made against. Rebuilding it from the
 *   UI at replay time would submit whatever is on screen now, which is a
 *   different request under an old key and is refused on arrival.
 * - `binding`, the thread and account it was admitted against. An account
 *   switched between the press and the replay must not silently move the
 *   message: replaying the original binding is either accepted by the journal or
 *   refused by it, and both are outcomes; rebinding is neither.
 *
 * WHEN IT IS WRITTEN: BEFORE the request leaves. A reply that never arrives is
 * the case this exists for, and a record written only in the error path does not
 * survive a reload or a navigation while the request is still in flight.
 *
 * It is a record of identity and payload, and nothing else. Nothing here
 * resends, retries or schedules: native owns dispatch and this adds no second
 * owner. It is cleared only by terminal evidence about THAT operation — a
 * journal receipt for it, or a refusal saying it admitted nothing — so sending a
 * different message afterwards leaves it exactly where it was.
 */
export interface RetainedQueueAdmission {
  key: string;
  mutation: NativeQueueMutation;
  binding: { threadId: string | null; accountId: string | null };
}

/**
 * In-process mirror of the durable records, as a LIST per conversation.
 *
 * A list because sending a second message does not settle the first: an
 * operation whose outcome is unknown stays unresolved until something says what
 * happened to IT, and overwriting one record with the next press is how an
 * unrecoverable operation was quietly forgotten.
 *
 * Mirrored in memory because the composer remounts on every board poll, so a
 * component ref cannot hold this; and because `sessionStorage` can refuse a
 * write (quota, opaque origin) exactly when the payload is large enough to
 * matter. Holding both means a storage failure costs the reload case rather than
 * the operation.
 */
const retainedQueueAdmissions = new Map<string, RetainedQueueAdmission[]>();

/** Enough for any realistic run of lost replies; a browser holding more than
    this has a problem no local record is going to solve. */
const MAX_RETAINED_ADMISSIONS_PER_CARD = 8;

/**
 * Whether two presses are the operator asking for the SAME operation.
 *
 * Everything the operator authored, and everything the command addresses: the
 * words, the attachments and the runtime for a hand-off; the entry, the revision
 * it was made against, the submission order and the turn fence for a control.
 * A press that differs in any of them is a DIFFERENT request the operator is
 * entitled to have admitted separately, and it gets its own key.
 *
 * Deliberately excluded: the selected-card reference, which is captured fresh at
 * every submission instant and would therefore never match itself. The reference
 * belongs to the operation that was admitted, so a replay carries the ORIGINAL
 * one out of the retained envelope rather than whatever is on screen at the
 * second press.
 */
export function sameQueueOperation(left: NativeQueueMutation, right: NativeQueueMutation): boolean {
  const authored = (mutation: NativeQueueMutation) => JSON.stringify({
    action: mutation.action,
    text: mutation.text ?? "",
    images: mutation.images ?? [],
    runtime: mutation.runtime ?? null,
    entryId: mutation.entryId ?? null,
    expectedRevision: mutation.expectedRevision ?? null,
    queuedSubmissionIds: mutation.queuedSubmissionIds ?? null,
    turnId: mutation.turnId ?? null,
  });
  return authored(left) === authored(right);
}

/** Every action the journal admits under a key of its own. A stored record
    naming anything else came from a build that is not this one. */
const RETAINABLE_ACTIONS: ReadonlySet<string> = new Set([
  "add", "update", "delete", "reorder", "start", "send-now",
]);

function parseRetainedQueueAdmission(value: unknown): RetainedQueueAdmission | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<RetainedQueueAdmission>;
  if (typeof record.key !== "string" || !record.key) return null;
  if (!record.mutation || typeof record.mutation !== "object") return null;
  if (!RETAINABLE_ACTIONS.has(record.mutation.action as string)) return null;
  if (!record.binding || typeof record.binding !== "object") return null;
  return { key: record.key, mutation: record.mutation, binding: record.binding } as RetainedQueueAdmission;
}

export function readRetainedQueueAdmissions(id: string): RetainedQueueAdmission[] {
  const live = retainedQueueAdmissions.get(id);
  if (live) return live;
  let raw: string | null = null;
  try { raw = sessionStorage.getItem(queueAdmissionKey(id)); }
  catch { return []; }
  if (raw === null) return [];
  let parsed: RetainedQueueAdmission[] = [];
  try {
    const value: unknown = JSON.parse(raw);
    /* UNREADABLE IS NOT ABSENT. Something was written here, so an operation may
       exist that this browser can no longer name; what is dropped is only the
       entries that cannot be read, and the readable ones still replay. */
    parsed = (Array.isArray(value) ? value : [value])
      .map(parseRetainedQueueAdmission)
      .filter((record): record is RetainedQueueAdmission => record !== null);
  } catch { parsed = []; }
  retainedQueueAdmissions.set(id, parsed);
  return parsed;
}

/**
 * Trim to the bound, dropping the oldest CONTROL first.
 *
 * A hand-off is the only record with a payload nobody else holds and the only
 * one with a recovery control behind it; a control names an entry the journal
 * still has and is fenced by that entry's `mutationOperationId`. So when a run
 * of unanswered control presses meets the bound, the operator's unsent words are
 * not what gets evicted to make room for them.
 */
function boundRetained(records: RetainedQueueAdmission[]): RetainedQueueAdmission[] {
  if (records.length <= MAX_RETAINED_ADMISSIONS_PER_CARD) return records;
  const surplus = records.length - MAX_RETAINED_ADMISSIONS_PER_CARD;
  const evicted = new Set<string>();
  for (const record of records) {
    if (evicted.size === surplus) break;
    if (record.mutation.action !== "add") evicted.add(record.key);
  }
  const kept = records.filter((record) => !evicted.has(record.key));
  return kept.slice(-MAX_RETAINED_ADMISSIONS_PER_CARD);
}

/** True when the list is durable; false when only the in-process mirror has it,
    which the caller says out loud rather than swallowing. */
function writeRetainedQueueAdmissions(id: string, records: RetainedQueueAdmission[]): boolean {
  const bounded = boundRetained(records);
  retainedQueueAdmissions.set(id, bounded);
  try {
    if (bounded.length) sessionStorage.setItem(queueAdmissionKey(id), JSON.stringify(bounded));
    else sessionStorage.removeItem(queueAdmissionKey(id));
    return true;
  } catch {
    return false;
  }
}

/** Record one operation as unresolved, replacing an earlier entry for the same
    key so a replay does not accumulate copies of itself. */
export function retainQueueAdmission(id: string, record: RetainedQueueAdmission): boolean {
  const kept = readRetainedQueueAdmissions(id).filter((entry) => entry.key !== record.key);
  return writeRetainedQueueAdmissions(id, [...kept, record]);
}

/** Terminal evidence about ONE operation, and only that one. */
export function releaseQueueAdmission(id: string, key: string): void {
  const kept = readRetainedQueueAdmissions(id).filter((entry) => entry.key !== key);
  writeRetainedQueueAdmissions(id, kept);
}

/** Test seam: the mirror is module-scoped, so a suite must be able to start
    from an empty one without reaching into module internals. */
export function resetRetainedQueueAdmissionsForTests(): void {
  retainedQueueAdmissions.clear();
}
