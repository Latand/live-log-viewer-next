"use client";

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
import type { NativeQueueMutation } from "@/hooks/useNativeQueue";

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
 * What one card's slot holds, as this build can and cannot read it.
 *
 * `records` are the operations this build can name. `opaque` are entries the
 * slot already held that it CANNOT name — a record written by a newer build, or
 * one naming an action this build does not know. They are carried through every
 * write verbatim. Dropping them would be this browser forgetting an operation
 * that may be live in the journal, which is the same loss as evicting one of its
 * own, only harder to notice.
 *
 * `contentsUnknown` means this browser cannot say what the slot holds — the read
 * itself failed, or what came back is not JSON at all. AN UNKNOWN SLOT IS NEVER
 * AN EMPTY ONE. Treating it as empty is how a write erases an operation that is
 * live in the journal: the record is gone, and the next press mints a second
 * key for something the journal may already hold. So nothing is written and no
 * new admission is accepted, and whatever is in there stays for whoever can
 * read it.
 */
interface RetainedStore {
  records: RetainedQueueAdmission[];
  opaque: unknown[];
  contentsUnknown: boolean;
}

/**
 * In-process mirror of the durable slot, per conversation.
 *
 * A LIST because sending a second message does not settle the first: an
 * operation whose outcome is unknown stays unresolved until something says what
 * happened to IT, and overwriting one record with the next press is how an
 * unrecoverable operation was quietly forgotten.
 *
 * Mirrored in memory because the composer remounts on every board poll, so a
 * component ref cannot hold this.
 */
const retainedQueueAdmissions = new Map<string, RetainedStore>();

/** A slot that is genuinely absent: nothing was ever written for this card. */
const EMPTY_STORE: RetainedStore = { records: [], opaque: [], contentsUnknown: false };

/** A slot whose contents this browser cannot establish. Distinct from the one
    above on purpose — the difference decides whether anything may be sent. */
const UNKNOWN_STORE: RetainedStore = { records: [], opaque: [], contentsUnknown: true };

/**
 * How many unresolved operations one card may hold — and a REFUSAL BOUND, never
 * an eviction bound.
 *
 * This used to trim the oldest control away when the bound was reached, on the
 * reasoning that a control is recoverable through the entry it names. That is
 * false for the two queue-level commands: `start` and `reorder` name no entry,
 * so `nativeQueueJournal`'s per-entry `mutationOperationId` fence never sees
 * them, and an evicted `start` whose reply was lost came back on the next press
 * as a SECOND start under a new key. Losing the identity of an operation the
 * journal may already hold is the one thing this store exists to prevent, so it
 * is now the new request that is refused — before it reaches the wire, where a
 * refusal costs nothing but a message the operator can act on.
 */
const MAX_RETAINED_ADMISSIONS_PER_CARD = 8;

/**
 * Whether the store took the operation, and therefore whether it may be sent.
 *
 * A refusal is answered BEFORE the wire, so nothing was admitted anywhere and
 * the caller keeps whatever the operator authored.
 *
 * ONE VERDICT, TWO CAUSES, AND THE MESSAGE HAS TO FIT BOTH. Either this card is
 * already holding as many unresolved operations as it can name — where settling
 * one makes room — or the browser cannot keep the record at all, because the
 * slot would not answer, would not take the write, or holds something nothing
 * here can parse. The second happens on the very first press, with nothing
 * retained; telling that operator to settle one of their unresolved operations
 * names a state they are not in and a step they cannot take.
 *
 * So the copy the callers use is scoped to THE ATTEMPT that was refused. It
 * asserts nothing about what came before it: an unreadable slot may hold an
 * operation Codex has already admitted, so saying that nothing reached Codex
 * would be a second false statement in the same breath.
 */
export type RetainOutcome = "retained" | "refused";

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

/**
 * Read the slot, keeping what this build cannot name.
 *
 * The old reading dropped every entry it could not parse and then wrote the
 * survivors back, so one unrecognised record — a newer build's, or one naming an
 * action added later — was silently destroyed by the next ordinary press. An
 * entry nobody here can read still names an operation the journal may be
 * holding, so it is carried verbatim instead.
 */
function readRetainedStore(id: string): RetainedStore {
  const live = retainedQueueAdmissions.get(id);
  if (live) return live;
  let raw: string | null = null;
  /* A READ THAT FAILS SAYS NOTHING ABOUT WHAT IS IN THERE. Quota, an opaque
     origin, a storage the browser has disabled mid-session: in every one of
     them the slot may still hold an unresolved operation, and answering "empty"
     let the next admission overwrite it. */
  try { raw = sessionStorage.getItem(queueAdmissionKey(id)); }
  catch { return UNKNOWN_STORE; }
  if (raw === null) return EMPTY_STORE;
  let store: RetainedStore;
  try {
    const value: unknown = JSON.parse(raw);
    const records: RetainedQueueAdmission[] = [];
    const opaque: unknown[] = [];
    for (const entry of Array.isArray(value) ? value : [value]) {
      const record = parseRetainedQueueAdmission(entry);
      if (record) records.push(record); else opaque.push(entry);
    }
    store = { records, opaque, contentsUnknown: false };
  } catch {
    /* NOT JSON AT ALL. There is nothing to carry through a write, so the slot is
       left exactly as it is and no new operation is accepted against it. */
    store = UNKNOWN_STORE;
  }
  retainedQueueAdmissions.set(id, store);
  return store;
}

export function readRetainedQueueAdmissions(id: string): RetainedQueueAdmission[] {
  return readRetainedStore(id).records;
}

/**
 * Commit the slot: this build's records and the entries it cannot read, together.
 *
 * Returns false when the browser refused to store it — quota, or an origin with
 * no session storage. The caller treats that as a refusal for a NEW operation,
 * because a key only this tab remembers is a key a reload loses, and the whole
 * point of the record is the reload.
 */
function writeRetainedStore(id: string, store: RetainedStore): boolean {
  const all: unknown[] = [...store.records, ...store.opaque];
  try {
    if (all.length) sessionStorage.setItem(queueAdmissionKey(id), JSON.stringify(all));
    else sessionStorage.removeItem(queueAdmissionKey(id));
  } catch {
    return false;
  }
  retainedQueueAdmissions.set(id, store);
  return true;
}

/**
 * Record one operation as unresolved, BEFORE it is sent.
 *
 * A replay of a key the slot already holds always succeeds: that operation is
 * already durable, so re-writing it adds no identity and can lose none. A NEW
 * operation is refused when the slot is full, its contents are unknown, or it
 * will not take the write — every case where accepting it would mean sending something this
 * browser could not name afterwards.
 *
 * Entries this build cannot read count against the bound, because each of them
 * may name a live operation too. A slot filled entirely with them refuses
 * everything until the build that wrote them settles those operations, and
 * refusing is the right side to fail on when the alternative is sending under a
 * forgotten key. Discarding the slot would clear the refusal and is exactly the
 * loss it exists to prevent, so nothing here — and nothing the operator is
 * told — offers that as a way out.
 */
export function retainQueueAdmission(id: string, record: RetainedQueueAdmission): RetainOutcome {
  const store = readRetainedStore(id);
  if (store.contentsUnknown) return "refused";
  const replay = store.records.some((entry) => entry.key === record.key);
  const kept = store.records.filter((entry) => entry.key !== record.key);
  if (!replay && kept.length + store.opaque.length >= MAX_RETAINED_ADMISSIONS_PER_CARD) return "refused";
  const next: RetainedStore = { ...store, records: [...kept, record] };
  if (writeRetainedStore(id, next)) return "retained";
  /* The write failed. A replay is already in the slot from its first press, so
     it stays recoverable and may go; a new operation is refused with the mirror
     left exactly as it was, so nothing half-remembers it. */
  return replay ? "retained" : "refused";
}

/** Terminal evidence about ONE operation, and only that one. */
export function releaseQueueAdmission(id: string, key: string): void {
  const store = readRetainedStore(id);
  if (store.contentsUnknown) return;
  writeRetainedStore(id, { ...store, records: store.records.filter((entry) => entry.key !== key) });
}

/** Test seam: the mirror is module-scoped, so a suite must be able to start
    from an empty one without reaching into module internals. */
export function resetRetainedQueueAdmissionsForTests(): void {
  retainedQueueAdmissions.clear();
}
