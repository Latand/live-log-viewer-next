import {
  ComposerPayloadStore,
  ComposerPayloadStorageError,
  type ComposerPayloadIdentity,
  type ComposerPayloadRef,
} from "./composerPayloadStore";

/** The authored submission and the later scaffolded request have distinct,
 * immutable fingerprints. Both belong to the same public conversation/key.
 * Nothing in this adapter queues, dispatches, or authorizes a replay. */
export interface ComposerSubmission {
  text: string;
  images: { id?: string; base64: string; mime: string; preview: string }[];
  files: { id: string; name: string; mime: string; base64: string }[];
  selectedContext?: unknown;
  runtime?: Record<string, unknown>;
  policy?: "interrupt-active" | "steer-if-active";
}

export interface ComposerWireEnvelope {
  route: "runtime" | "legacy";
  body: Record<string, unknown>;
}

/** How a retained message may be attempted again. `operation`: the journal
 * admitted it, so only the runtime operation retry contract starts the next
 * attempt. `resend`: nothing was admitted and the last attempt was refused
 * before admission, so the sealed envelope may go out again under its key. */
export type ComposerPayloadRetryRoute = "operation" | "resend";

export interface ComposerPayloadRefusal {
  status: number;
  reason: string;
}

export interface RestoredComposerSubmission {
  ref: ComposerPayloadRef;
  submission: ComposerSubmission;
  envelope: ComposerWireEnvelope | null;
  /** The operation the journal admitted under the original key. Every retry
   * leaf is presented under it, so it names the message across attempts. */
  operationId: string | null;
  /** Latest receipt of the current attempt, in that presentation identity. */
  receipt: ComposerPayloadReceipt | null;
  retry: ComposerPayloadRetryRoute | null;
  refusal: ComposerPayloadRefusal | null;
}

export interface ComposerPayloadReceipt {
  conversationId: string;
  idempotencyKey: string;
  operationId: string;
  revision: number;
  status: string;
  reason?: string | null;
  resend?: string | null;
  at?: string | null;
  /** Set by the journal on a retry leaf: the terminal attempt it replaces. */
  retryOfOperationId?: string | null;
  /** On a raw leaf receipt: the admitted operation it is presented under and
   * its revision there, which keeps rising across attempts. */
  presentationOperationId?: string;
  presentationRevision?: number;
}

interface PayloadAttempt {
  sequence: number;
  receiptRevision: number;
  refusal: ComposerPayloadRefusal | null;
}

/** The journal's presentation identity: a raw retry leaf receipt is read as
 * its admitted operation at its presentation revision. Snapshots already
 * present leaves this way; live receipt events carry the raw leaf. */
export function presentedPayloadReceipt<T extends ComposerPayloadReceipt>(receipt: T): T {
  return receipt.presentationOperationId && Number.isSafeInteger(receipt.presentationRevision)
    ? { ...receipt, operationId: receipt.presentationOperationId, revision: receipt.presentationRevision! }
    : receipt;
}

/** The operation admitted under the original key and the latest receipt of
 * the current attempt. A retry leaf counts only when it is presented under
 * that operation; anything else is not evidence about this message. */
export function payloadAttemptState(
  key: string,
  history: readonly ComposerPayloadReceipt[],
): { operationId: string | null; current: ComposerPayloadReceipt | null } {
  const operationId = history.find(item => item.idempotencyKey === key && !item.retryOfOperationId)?.operationId ?? null;
  const current = operationId === null ? null : history.filter(item => item.operationId === operationId)
    .sort((a, b) => b.revision - a.revision)[0] ?? null;
  return { operationId, current };
}

function retryRoute(
  key: string,
  history: readonly ComposerPayloadReceipt[],
  attempts: readonly PayloadAttempt[],
): ComposerPayloadRetryRoute | null {
  const { current } = payloadAttemptState(key, history);
  if (current) {
    /* The server remains the authority; an unknown fate is never retried here.
       Once an attempt was unknown, only a proven safe rejection re-opens it,
       as for the queue bubble: a later failure alone proves nothing. */
    const unknownBefore = history.some(item => item.idempotencyKey === current.idempotencyKey
      && (item.status === "uncertain" || item.resend === "verify-first"));
    return (current.status === "failed" || current.status === "rejected")
      && current.reason !== "delivery-discarded" && current.resend !== "verify-first"
      && (!unknownBefore || current.resend === "safe" || current.status === "rejected") ? "operation" : null;
  }
  return latestAttempt(attempts)?.refusal ? "resend" : null;
}

function latestAttempt(attempts: readonly PayloadAttempt[]): PayloadAttempt | null {
  const sequence = Math.max(-1, ...attempts.map(item => item.sequence));
  if (sequence < 0) return null;
  const refusal = attempts.find(item => item.sequence === sequence && item.refusal)?.refusal ?? null;
  return { sequence, receiptRevision: attempts.find(item => item.sequence === sequence)!.receiptRevision, refusal };
}

function snapshot<T>(value: T): T {
  // These are JSON wire values; capture synchronously before acquiring a lock.
  return JSON.parse(JSON.stringify(value)) as T;
}

function checkedSubmission(value: unknown): ComposerSubmission {
  const item = value as ComposerSubmission | undefined;
  if (!item || typeof item.text !== "string" || !Array.isArray(item.images) || !Array.isArray(item.files)
    || item.images.some(image => !image || typeof image.base64 !== "string" || typeof image.mime !== "string")
    || item.files.some(file => !file || typeof file.id !== "string" || typeof file.name !== "string"
      || typeof file.base64 !== "string" || typeof file.mime !== "string")) {
    throw new ComposerPayloadStorageError("The complete original message could not be verified");
  }
  // A blob URL belongs to its old document. Derive a usable preview from bytes.
  return { ...item, images: item.images.map(image => ({ ...image,
    preview: `data:${image.mime};base64,${image.base64}` })) };
}

/** A tombstone is written before removing bytes. A crash during release may
 * leave retained bytes, but an old queue or tab can never resurrect that key.
 * Tombstones contain no message content and are never arbitrarily evicted. */
export class ComposerSubmissionPayloads {
  private readonly submissions: ComposerPayloadStore;
  private readonly envelopes: ComposerPayloadStore;
  private readonly terminals: ComposerPayloadStore;
  private readonly receipts: ComposerPayloadStore;
  private readonly attempts: ComposerPayloadStore;
  private readonly wireClaims = new Set<string>();

  constructor(databasePrefix = "llv-composer") {
    this.submissions = new ComposerPayloadStore({ databaseName: `${databasePrefix}-submissions-v1` });
    this.envelopes = new ComposerPayloadStore({ databaseName: `${databasePrefix}-envelopes-v1` });
    this.terminals = new ComposerPayloadStore({ databaseName: `${databasePrefix}-terminals-v1` });
    this.receipts = new ComposerPayloadStore({ databaseName: `${databasePrefix}-receipts-v1` });
    this.attempts = new ComposerPayloadStore({ databaseName: `${databasePrefix}-attempts-v1` });
  }

  private async locked<T>(identity: ComposerPayloadIdentity, action: () => Promise<T>): Promise<T> {
    if (!globalThis.navigator?.locks) return Promise.reject(new ComposerPayloadStorageError());
    return await navigator.locks.request(`llv-composer-payload:${JSON.stringify([identity.conversationId, identity.key])}`, action);
  }

  private async active(identity: ComposerPayloadIdentity): Promise<void> {
    if (await this.terminals.read(identity)) {
      throw new ComposerPayloadStorageError("This original message has already been settled or discarded");
    }
  }

  retain(identity: ComposerPayloadIdentity, submission: ComposerSubmission): Promise<ComposerPayloadRef> {
    const owner = { ...identity };
    const captured = snapshot(submission);
    checkedSubmission(captured);
    // Preview URLs are document-local and are never part of request identity.
    captured.images = captured.images.map(image => ({ ...image, preview: "" }));
    return this.locked(owner, async () => {
      await this.active(owner);
      return this.submissions.retain(owner, { version: 1, submission: captured });
    });
  }

  /** Called at first dispatch, after scaffolding has been decided. A replay
   * reads the saved envelope; it must never regenerate bridge/context/runtime. */
  seal(ref: ComposerPayloadRef, envelope: ComposerWireEnvelope): Promise<ComposerWireEnvelope> {
    const owner = { conversationId: ref.conversationId, key: ref.key };
    const captured = snapshot(envelope);
    if (!["runtime", "legacy"].includes(captured.route)
      || captured.body?.idempotencyKey !== owner.key
      || (captured.route !== "legacy" && captured.body?.conversationId !== owner.conversationId)
      || (captured.route === "legacy" && captured.body?.clientMessageId !== owner.key)) {
      return Promise.reject(new ComposerPayloadStorageError("The request does not match its original message identity"));
    }
    return this.locked(owner, async () => {
      await this.active(owner);
      const raw = await this.submissions.read(owner);
      if (!raw || raw.fingerprint !== ref.fingerprint) throw new ComposerPayloadStorageError();
      const submission = checkedSubmission(raw.payload.submission);
      const images = captured.body.images as { base64: string; mime: string }[] | undefined;
      const files = captured.body.files as { base64: string; name: string }[] | undefined;
      if ((images !== undefined && !Array.isArray(images)) || (files !== undefined && !Array.isArray(files))
        || (images?.length ?? 0) !== submission.images.length || (files?.length ?? 0) !== submission.files.length
        || submission.images.some((image, index) => image.base64 !== images?.[index]?.base64 || image.mime !== images?.[index]?.mime)
        || submission.files.some((file, index) => file.base64 !== files?.[index]?.base64 || file.name !== files?.[index]?.name)) {
        throw new ComposerPayloadStorageError("The request is missing original attachment bytes");
      }
      await this.envelopes.retain(owner, { version: 1, submissionFingerprint: raw.fingerprint, envelope: captured });
      return captured;
    });
  }

  restore(identity: ComposerPayloadIdentity): Promise<RestoredComposerSubmission | null> {
    const owner = { ...identity };
    return this.locked(owner, async () => {
      if (await this.terminals.read(owner)) return null;
      const raw = await this.submissions.read(owner);
      if (!raw) return null;
      const wire = await this.envelopes.read(owner);
      if (raw.payload.version !== 1 || (wire && (wire.payload.version !== 1
        || wire.payload.submissionFingerprint !== raw.fingerprint))) throw new ComposerPayloadStorageError();
      const envelope = wire?.payload.envelope as ComposerWireEnvelope | undefined;
      if (wire && (!envelope || !["runtime", "legacy"].includes(envelope.route)
        || !envelope.body || typeof envelope.body !== "object")) throw new ComposerPayloadStorageError();
      const history = await this.receiptHistory(owner);
      const attempts = await this.attemptRows(owner);
      const state = payloadAttemptState(owner.key, history);
      return { ref: { conversationId: raw.conversationId, key: raw.key, fingerprint: raw.fingerprint,
        bytes: raw.bytes, savedAt: raw.savedAt }, submission: checkedSubmission(raw.payload.submission),
      envelope: envelope ?? null, operationId: state.operationId, receipt: state.current,
      retry: retryRoute(owner.key, history, attempts),
      refusal: state.current ? null : latestAttempt(attempts)?.refusal ?? null };
    });
  }

  /** Catalog failures and individual corrupt rows remain visible to the caller.
   * Listing is inert; even a complete sealed envelope is never replay authority. */
  list(conversationId: string): Promise<ComposerPayloadRef[]> {
    return this.submissions.list(conversationId);
  }

  private async receiptHistory(identity: ComposerPayloadIdentity): Promise<ComposerPayloadReceipt[]> {
    const history: ComposerPayloadReceipt[] = [];
    for (const ref of await this.receipts.list(identity.conversationId)) {
      const key: unknown = JSON.parse(ref.key);
      if (!Array.isArray(key) || key[0] !== identity.key) continue;
      const row = await this.receipts.read(ref);
      if (!row) throw new ComposerPayloadStorageError();
      history.push(row.payload.receipt as unknown as ComposerPayloadReceipt);
    }
    return history;
  }

  private async attemptRows(identity: ComposerPayloadIdentity): Promise<PayloadAttempt[]> {
    const rows: PayloadAttempt[] = [];
    for (const ref of await this.attempts.list(identity.conversationId)) {
      const key: unknown = JSON.parse(ref.key);
      if (!Array.isArray(key) || key[0] !== identity.key) continue;
      const row = await this.attempts.read(ref);
      const refusal = row?.payload.refusal as ComposerPayloadRefusal | undefined;
      if (!row || !Number.isSafeInteger(row.payload.receiptRevision)
        || (row.payload.sequence !== undefined && !Number.isSafeInteger(row.payload.sequence))
        || (refusal !== undefined && (!Number.isSafeInteger(refusal?.status) || typeof refusal?.reason !== "string"))) {
        throw new ComposerPayloadStorageError();
      }
      // An attempt recorded before sequences existed is the first attempt.
      rows.push({ sequence: (row.payload.sequence as number | undefined) ?? 0,
        receiptRevision: row.payload.receiptRevision as number, refusal: refusal ?? null });
    }
    return rows;
  }

  /** Persist the attempt before queue eligibility. Only the claiming document
   * can consume it. A reload has no claim, so a lost response never replays.
   * Once the journal admitted the key, its operation retry contract owns every
   * later attempt; only a refusal before admission re-opens the envelope. */
  beginAttempt(ref: ComposerPayloadRef): Promise<boolean> {
    const owner = { conversationId: ref.conversationId, key: ref.key };
    return this.locked(owner, async () => {
      await this.active(owner);
      const raw = await this.submissions.read(owner);
      const wire = await this.envelopes.read(owner);
      if (!raw || raw.fingerprint !== ref.fingerprint || !wire) throw new ComposerPayloadStorageError();
      const history = await this.receiptHistory(owner);
      const attempts = await this.attemptRows(owner);
      if (payloadAttemptState(owner.key, history).current) return false;
      if (attempts.length && retryRoute(owner.key, history, attempts) !== "resend") return false;
      const sequence = (latestAttempt(attempts)?.sequence ?? -1) + 1;
      const revision = Math.max(0, ...history.map(item => item.revision));
      await this.attempts.retain({ conversationId: owner.conversationId, key: JSON.stringify([owner.key, "attempt", sequence]) },
        { receiptRevision: revision, sequence });
      this.wireClaims.add(JSON.stringify([owner.conversationId, owner.key]));
      return true;
    });
  }

  /** A response that refused the latest attempt before anything was admitted:
   * no receipt, no operation, and a status the send route only returns before
   * a reservation exists. Ambiguous answers are never recorded here. */
  refuse(ref: ComposerPayloadRef, refusal: ComposerPayloadRefusal): Promise<boolean> {
    const owner = { conversationId: ref.conversationId, key: ref.key };
    const captured = { status: refusal.status, reason: String(refusal.reason).slice(0, 500) };
    return this.locked(owner, async () => {
      await this.active(owner);
      const raw = await this.submissions.read(owner);
      if (!raw || raw.fingerprint !== ref.fingerprint || !Number.isSafeInteger(captured.status)) return false;
      if (payloadAttemptState(owner.key, await this.receiptHistory(owner)).current) return false;
      const latest = latestAttempt(await this.attemptRows(owner));
      if (!latest || latest.refusal) return false;
      await this.attempts.retain({ conversationId: owner.conversationId,
        key: JSON.stringify([owner.key, "refused", latest.sequence]) },
      { receiptRevision: latest.receiptRevision, sequence: latest.sequence, refusal: captured });
      return true;
    });
  }

  consumeAttempt(ref: ComposerPayloadIdentity): boolean {
    return this.wireClaims.delete(JSON.stringify([ref.conversationId, ref.key]));
  }

  /** Explicit removal of a copy that never reached the journal: an
   * interrupted preparation, or an attempt refused before admission. Checked
   * under the same cross-tab lock so a concurrent attempt cannot slip past. */
  discardUnprepared(ref: ComposerPayloadRef): Promise<boolean> {
    const owner = { conversationId: ref.conversationId, key: ref.key };
    return this.locked(owner, async () => {
      const raw = await this.submissions.read(owner);
      if (!raw || raw.fingerprint !== ref.fingerprint) return false;
      const history = await this.receiptHistory(owner);
      const attempts = await this.attemptRows(owner);
      const wire = await this.envelopes.read(owner);
      const unprepared = !wire && !attempts.length;
      const refused = !history.length && Boolean(latestAttempt(attempts)?.refusal);
      if (!unprepared && !refused) return false;
      await this.terminals.retain(owner, { version: 1, submissionFingerprint: raw.fingerprint });
      if (wire) await this.envelopes.release(wire);
      return this.submissions.release(raw);
    });
  }

  /** Append evidence before projecting it into ephemeral UI state. Lower
   * revisions and foreign operations cannot authorize deletion later. A
   * journal retry leaf joins when it is presented under the admitted
   * operation, which is how the retry contract's receipts reach this message. */
  observe(ref: ComposerPayloadRef, receipt: ComposerPayloadReceipt): Promise<boolean> {
    const owner = { conversationId: ref.conversationId, key: ref.key };
    const captured = presentedPayloadReceipt(snapshot(receipt));
    return this.locked(owner, async () => {
      if (captured.conversationId !== owner.conversationId
        || !captured.operationId || !Number.isSafeInteger(captured.revision) || captured.revision < 1) return false;
      const history = await this.receiptHistory(owner);
      const { operationId } = payloadAttemptState(owner.key, history);
      const leaf = Boolean(captured.retryOfOperationId);
      if (leaf ? captured.operationId !== operationId
        : captured.idempotencyKey !== owner.key || (operationId !== null && captured.operationId !== operationId)) return false;
      // One revision is one journal fact; a later projection at it is not newer.
      if (history.some(item => item.revision >= captured.revision)) return false;
      await this.receipts.retain({ conversationId: owner.conversationId,
        key: JSON.stringify([owner.key, captured.operationId, captured.revision]) }, { receipt: {
          conversationId: captured.conversationId, idempotencyKey: captured.idempotencyKey,
          operationId: captured.operationId, revision: captured.revision,
          status: captured.status, reason: captured.reason ?? null, resend: captured.resend ?? null,
          at: captured.at ?? null, retryOfOperationId: captured.retryOfOperationId ?? null,
        } });
      return true;
    });
  }

  /** Caller first verifies matching authoritative terminal evidence, or an
   * applicable explicit discard, and disables every queue owner of this key.
   * Only the latest receipt of the current attempt can settle, read in the
   * admitted operation's presentation identity. Safe rejection alone is
   * recoverable and must keep its original payload. */
  settle(ref: ComposerPayloadRef, evidence?: ComposerPayloadReceipt): Promise<boolean> {
    const expected = { ...ref };
    const owner = { conversationId: ref.conversationId, key: ref.key };
    return this.locked(owner, async () => {
      if (evidence) {
        const { current } = payloadAttemptState(owner.key, await this.receiptHistory(owner));
        const presented = presentedPayloadReceipt(evidence);
        if (!current || presented.conversationId !== owner.conversationId
          || (presented.status !== "delivered" && presented.reason !== "delivery-discarded")
          || presented.operationId !== current.operationId || presented.revision !== current.revision
          || presented.status !== current.status) return false;
      }
      const raw = await this.submissions.read(owner);
      if (!raw || raw.fingerprint !== expected.fingerprint) return false;
      const wire = await this.envelopes.read(owner);
      await this.terminals.retain(owner, { version: 1, submissionFingerprint: raw.fingerprint });
      this.wireClaims.delete(JSON.stringify([owner.conversationId, owner.key]));
      if (wire) await this.envelopes.release(wire);
      return this.submissions.release(raw);
    });
  }
}

export const composerSubmissionPayloads = new ComposerSubmissionPayloads();

// Survives a React remount while an asynchronous retention is in progress.
const saving = new Set<string>();
export function composerSubmissionSaving(conversationId: string): boolean {
  return saving.has(conversationId);
}
export async function withComposerSubmission(
  conversationId: string,
  save: () => Promise<void>,
): Promise<boolean> {
  if (saving.has(conversationId)) return false;
  saving.add(conversationId);
  try { await save(); return true; }
  finally { saving.delete(conversationId); }
}
