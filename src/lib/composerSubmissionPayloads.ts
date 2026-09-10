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
  route: "runtime" | "legacy" | "native-queue";
  body: Record<string, unknown>;
}

export interface RestoredComposerSubmission {
  ref: ComposerPayloadRef;
  submission: ComposerSubmission;
  envelope: ComposerWireEnvelope | null;
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

  constructor(databasePrefix = "llv-composer") {
    this.submissions = new ComposerPayloadStore({ databaseName: `${databasePrefix}-submissions-v1` });
    this.envelopes = new ComposerPayloadStore({ databaseName: `${databasePrefix}-envelopes-v1` });
    this.terminals = new ComposerPayloadStore({ databaseName: `${databasePrefix}-terminals-v1` });
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
    if (!["runtime", "legacy", "native-queue"].includes(captured.route)
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
      if (wire && (!envelope || !["runtime", "legacy", "native-queue"].includes(envelope.route)
        || !envelope.body || typeof envelope.body !== "object")) throw new ComposerPayloadStorageError();
      return { ref: { conversationId: raw.conversationId, key: raw.key, fingerprint: raw.fingerprint,
        bytes: raw.bytes, savedAt: raw.savedAt }, submission: checkedSubmission(raw.payload.submission),
      envelope: envelope ?? null };
    });
  }

  /** Catalog failures and individual corrupt rows remain visible to the caller.
   * Listing is inert; even a complete sealed envelope is never replay authority. */
  list(conversationId: string): Promise<ComposerPayloadRef[]> {
    return this.submissions.list(conversationId);
  }

  /** Caller first verifies matching authoritative terminal evidence, or an
   * applicable explicit discard, and disables every queue owner of this key.
   * Safe rejection alone is recoverable and must keep its original payload. */
  settle(ref: ComposerPayloadRef): Promise<boolean> {
    const expected = { ...ref };
    const owner = { conversationId: ref.conversationId, key: ref.key };
    return this.locked(owner, async () => {
      const raw = await this.submissions.read(owner);
      if (!raw || raw.fingerprint !== expected.fingerprint) return false;
      const wire = await this.envelopes.read(owner);
      await this.terminals.retain(owner, { version: 1, submissionFingerprint: raw.fingerprint });
      if (wire) await this.envelopes.release(wire);
      return this.submissions.release(raw);
    });
  }
}

export const composerSubmissionPayloads = new ComposerSubmissionPayloads();

// Survives a React remount while an asynchronous retention is in progress.
const saving = new Set<string>();
export async function withComposerSubmission(
  conversationId: string,
  save: () => Promise<void>,
): Promise<boolean> {
  if (saving.has(conversationId)) return false;
  saving.add(conversationId);
  try { await save(); return true; }
  finally { saving.delete(conversationId); }
}
