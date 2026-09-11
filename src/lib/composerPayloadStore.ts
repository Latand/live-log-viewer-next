/** Complete submission envelopes kept independently of a mounted composer.
 * Callers retain before clearing a draft or sending, and release only after
 * matching terminal evidence or an explicit discard. This store never evicts.
 */
export interface ComposerPayloadIdentity {
  conversationId: string;
  key: string;
}

export interface ComposerPayloadRef extends ComposerPayloadIdentity {
  fingerprint: string;
  bytes: number;
  savedAt: number;
}

export interface StoredComposerPayload extends ComposerPayloadRef {
  payload: Record<string, unknown>;
}

interface PayloadRow extends ComposerPayloadRef {
  version: 1;
  body: Blob;
}

const STORE = "submissions";
const DATABASE = "llv-composer-payloads-v1";

export class ComposerPayloadStorageError extends Error {
  constructor(message = "Complete message storage is unavailable", options?: ErrorOptions) {
    super(message, options);
    this.name = "ComposerPayloadStorageError";
  }
}

export class ComposerPayloadConflictError extends ComposerPayloadStorageError {
  constructor() {
    super("This message key already retains a different payload");
    this.name = "ComposerPayloadConflictError";
  }
}

function identityKey(identity: ComposerPayloadIdentity): [string, string] {
  if ([identity.conversationId, identity.key].some(value =>
    typeof value !== "string" || !value.trim() || value.length > 1024 || value.includes("\0"))) {
    throw new ComposerPayloadStorageError("Message storage identity is invalid");
  }
  return [identity.conversationId, identity.key];
}

function snapshotJson(payload: Record<string, unknown>): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ComposerPayloadStorageError("Message payload is invalid");
  }
  try {
    return JSON.stringify(payload, (_key, value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new ComposerPayloadStorageError("Message payload contains unsupported data");
      }
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
    });
  } catch (cause) {
    throw new ComposerPayloadStorageError("Message payload cannot be stored", { cause });
  }
}

async function fingerprint(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new ComposerPayloadStorageError();
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function checkedRow(value: unknown, identity?: ComposerPayloadIdentity): PayloadRow {
  const row = value as Partial<PayloadRow> | null;
  if (!row || row.version !== 1 || typeof row.conversationId !== "string" || typeof row.key !== "string"
    || typeof row.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(row.fingerprint)
    || !Number.isSafeInteger(row.bytes) || row.bytes! < 0 || !Number.isFinite(row.savedAt)
    || !(row.body instanceof Blob) || row.body.size !== row.bytes
    || (identity && (row.conversationId !== identity.conversationId || row.key !== identity.key))) {
    throw new ComposerPayloadStorageError("Stored message payload could not be verified");
  }
  return row as PayloadRow;
}

function reference(row: PayloadRow): ComposerPayloadRef {
  return { conversationId: row.conversationId, key: row.key, fingerprint: row.fingerprint,
    bytes: row.bytes, savedAt: row.savedAt };
}

export class ComposerPayloadStore {
  private opening: Promise<IDBDatabase> | undefined;

  constructor(private readonly options: { databaseName?: string; indexedDB?: IDBFactory; now?: () => number } = {}) {}

  private database(): Promise<IDBDatabase> {
    if (this.opening) return this.opening;
    const factory = this.options.indexedDB ?? globalThis.indexedDB;
    if (!factory) return Promise.reject(new ComposerPayloadStorageError());
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let finished = false;
      const refuse = (cause?: unknown) => {
        finished = true;
        reject(new ComposerPayloadStorageError(undefined, { cause }));
      };
      const request = factory.open(this.options.databaseName ?? DATABASE, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: ["conversationId", "key"] });
        store.createIndex("conversation", "conversationId");
      };
      request.onerror = () => refuse(request.error);
      request.onblocked = () => refuse();
      request.onsuccess = () => {
        const db = request.result;
        if (finished || !db.objectStoreNames.contains(STORE)) {
          db.close();
          if (!finished) refuse();
          return;
        }
        db.onversionchange = () => { db.close(); this.opening = undefined; };
        finished = true;
        resolve(db);
      };
    });
    this.opening = opening;
    void opening.catch(() => { if (this.opening === opening) this.opening = undefined; });
    return opening;
  }

  private async transaction<T>(
    mode: IDBTransactionMode,
    perform: (store: IDBObjectStore, result: (value: T) => void, fail: (error: unknown) => void) => void,
  ): Promise<T> {
    const db = await this.database();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode, { durability: "strict" });
      let value: T;
      let failure: unknown;
      const fail = (error: unknown) => { failure = error; tx.abort(); };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(failure instanceof ComposerPayloadStorageError
        ? failure : new ComposerPayloadStorageError(undefined, { cause: failure ?? tx.error }));
      try { perform(tx.objectStore(STORE), result => { value = result; }, fail); }
      catch (error) { fail(error); }
    });
  }

  async retain(identity: ComposerPayloadIdentity, payload: Record<string, unknown>): Promise<ComposerPayloadRef> {
    // Capture before the first await: navigation and edits cannot change this submission.
    const key = identityKey(identity);
    const owner = { conversationId: key[0], key: key[1] };
    const bytes = new TextEncoder().encode(snapshotJson(payload));
    const digest = await fingerprint(bytes);
    const row: PayloadRow = { ...owner, version: 1, fingerprint: digest, bytes: bytes.byteLength,
      savedAt: (this.options.now ?? Date.now)(), body: new Blob([bytes], { type: "application/json" }) };
    const retained = await this.transaction<{ row: PayloadRow; existing: boolean }>("readwrite", (store, done, fail) => {
      const read = store.get(key);
      read.onsuccess = () => {
        try {
          if (read.result !== undefined) {
            const existing = checkedRow(read.result, owner);
            if (existing.fingerprint !== digest) throw new ComposerPayloadConflictError();
            done({ row: existing, existing: true });
          } else {
            store.add(row);
            done({ row, existing: false });
          }
        } catch (error) { fail(error); }
      };
    });
    if (retained.existing && await fingerprint(new Uint8Array(await retained.row.body.arrayBuffer())) !== digest) {
      throw new ComposerPayloadStorageError("Stored message payload could not be verified");
    }
    return reference(retained.row);
  }

  async read(identity: ComposerPayloadIdentity): Promise<StoredComposerPayload | null> {
    const key = identityKey(identity);
    const owner = { conversationId: key[0], key: key[1] };
    const raw = await this.transaction<unknown>("readonly", (store, done) => {
      const request = store.get(key);
      request.onsuccess = () => done(request.result);
    });
    if (raw === undefined) return null;
    const row = checkedRow(raw, owner);
    const bytes = new Uint8Array(await row.body.arrayBuffer());
    if (await fingerprint(bytes) !== row.fingerprint) {
      throw new ComposerPayloadStorageError("Stored message payload could not be verified");
    }
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ComposerPayloadStorageError("Stored message payload could not be verified");
    }
    return { ...reference(row), payload: payload as Record<string, unknown> };
  }

  async list(conversationId: string): Promise<ComposerPayloadRef[]> {
    identityKey({ conversationId, key: "list" });
    return this.transaction<ComposerPayloadRef[]>("readonly", (store, done, fail) => {
      // Blob handles keep this catalog read from decoding every retained attachment.
      const request = store.index("conversation").getAll(conversationId);
      request.onsuccess = () => {
        try { done(request.result.map(value => reference(checkedRow(value)))); }
        catch (error) { fail(error); }
      };
    });
  }

  /** The caller must first verify terminal evidence or obtain an explicit discard. */
  async release(ref: ComposerPayloadRef): Promise<boolean> {
    const key = identityKey(ref);
    const expected = { ...ref };
    return this.transaction<boolean>("readwrite", (store, done, fail) => {
      const request = store.get(key);
      request.onsuccess = () => {
        try {
          if (request.result === undefined) { done(false); return; }
          const row = checkedRow(request.result, expected);
          if (row.fingerprint !== expected.fingerprint) { done(false); return; }
          store.delete(key);
          done(true);
        } catch (error) { fail(error); }
      };
    });
  }
}

export const composerPayloadStore = new ComposerPayloadStore();
