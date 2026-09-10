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

export interface RestoredComposerSubmission {
  ref: ComposerPayloadRef;
  submission: ComposerSubmission;
  envelope: ComposerWireEnvelope | null;
  retryAvailable: boolean;
  receipt: ComposerPayloadReceipt | null;
}

export interface ComposerPayloadReceipt {
  conversationId: string;
  idempotencyKey: string;
  operationId: string;
  revision: number;
  status: string;
  reason?: string | null;
  resend?: string;
  at?: string;
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
      return { ref: { conversationId: raw.conversationId, key: raw.key, fingerprint: raw.fingerprint,
        bytes: raw.bytes, savedAt: raw.savedAt }, submission: checkedSubmission(raw.payload.submission),
      envelope: envelope ?? null, retryAvailable: await this.retryAvailable(owner),
      receipt: (await this.receiptHistory(owner)).sort((a, b) => b.revision - a.revision)[0] ?? null };
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

  private async attemptFloor(identity: ComposerPayloadIdentity): Promise<number | null> {
    let floor: number | null = null;
    for (const ref of await this.attempts.list(identity.conversationId)) {
      const key: unknown = JSON.parse(ref.key);
      if (!Array.isArray(key) || key[0] !== identity.key) continue;
      const row = await this.attempts.read(ref);
      if (!row || !Number.isSafeInteger(row.payload.receiptRevision)) throw new ComposerPayloadStorageError();
      floor = Math.max(floor ?? 0, row.payload.receiptRevision as number);
    }
    return floor;
  }

  private async retryAvailable(identity: ComposerPayloadIdentity): Promise<boolean> {
    const history = await this.receiptHistory(identity);
    const latest = history.sort((a, b) => b.revision - a.revision)[0];
    const floor = await this.attemptFloor(identity);
    return Boolean(latest && latest.status === "failed" && latest.resend === "safe"
      && latest.reason !== "delivery-discarded" && (floor === null || latest.revision > floor));
  }

  /** Persist the attempt before queue eligibility. Only the claiming document
   * can consume it. A reload has no claim, so an old safe receipt cannot replay
   * an attempt whose response was lost. A newer safe rejection permits retry. */
  beginAttempt(ref: ComposerPayloadRef): Promise<boolean> {
    const owner = { conversationId: ref.conversationId, key: ref.key };
    return this.locked(owner, async () => {
      await this.active(owner);
      const raw = await this.submissions.read(owner);
      const wire = await this.envelopes.read(owner);
      if (!raw || raw.fingerprint !== ref.fingerprint || !wire) throw new ComposerPayloadStorageError();
      const previous = await this.attemptFloor(owner);
      if (previous !== null && !await this.retryAvailable(owner)) return false;
      const history = await this.receiptHistory(owner);
      const revision = Math.max(0, ...history.map(item => item.revision));
      await this.attempts.retain({ conversationId: owner.conversationId, key: JSON.stringify([owner.key, revision]) }, { receiptRevision: revision });
      this.wireClaims.add(JSON.stringify([owner.conversationId, owner.key]));
      return true;
    });
  }

  consumeAttempt(ref: ComposerPayloadIdentity): boolean {
    return this.wireClaims.delete(JSON.stringify([ref.conversationId, ref.key]));
  }

  /** Explicit removal of an interrupted preparation. Check under the same
   * cross-tab lock so a concurrent seal cannot turn it into a live operation. */
  discardUnprepared(ref: ComposerPayloadRef): Promise<boolean> {
    const owner = { conversationId: ref.conversationId, key: ref.key };
    return this.locked(owner, async () => {
      const raw = await this.submissions.read(owner);
      if (!raw || raw.fingerprint !== ref.fingerprint || await this.envelopes.read(owner)
        || await this.attemptFloor(owner) !== null) return false;
      await this.terminals.retain(owner, { version: 1, submissionFingerprint: raw.fingerprint });
      return this.submissions.release(raw);
    });
  }

  /** Append evidence before projecting it into ephemeral UI state. Lower
   * revisions and foreign operations cannot authorize deletion later. */
  observe(ref: ComposerPayloadRef, receipt: ComposerPayloadReceipt): Promise<boolean> {
    const owner = { conversationId: ref.conversationId, key: ref.key };
    const captured = snapshot(receipt);
    return this.locked(owner, async () => {
      if (captured.conversationId !== owner.conversationId || captured.idempotencyKey !== owner.key
        || !captured.operationId || !Number.isSafeInteger(captured.revision) || captured.revision < 1) return false;
      const history = await this.receiptHistory(owner);
      if (history.some(item => item.operationId !== captured.operationId || item.revision > captured.revision)) return false;
      await this.receipts.retain({ conversationId: owner.conversationId,
        key: JSON.stringify([owner.key, captured.operationId, captured.revision]) }, { receipt: {
          conversationId: captured.conversationId, idempotencyKey: captured.idempotencyKey,
          operationId: captured.operationId, revision: captured.revision,
          status: captured.status, reason: captured.reason ?? null, resend: captured.resend ?? null,
          at: captured.at ?? null,
        } });
      return true;
    });
  }

  /** Caller first verifies matching authoritative terminal evidence, or an
   * applicable explicit discard, and disables every queue owner of this key.
   * Safe rejection alone is recoverable and must keep its original payload. */
  settle(ref: ComposerPayloadRef, evidence?: ComposerPayloadReceipt): Promise<boolean> {
    const expected = { ...ref };
    const owner = { conversationId: ref.conversationId, key: ref.key };
    return this.locked(owner, async () => {
      if (evidence) {
        const history = await this.receiptHistory(owner);
        if (!history.length || evidence.conversationId !== owner.conversationId || evidence.idempotencyKey !== owner.key
          || (evidence.status !== "delivered" && evidence.reason !== "delivery-discarded")
          || history.some(item => item.operationId !== evidence.operationId || item.revision > evidence.revision)
          || !history.some(item => item.revision === evidence.revision && item.status === evidence.status)) return false;
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
