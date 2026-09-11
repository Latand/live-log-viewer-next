/**
 * Process-local IndexedDB and Web Locks for DOM suites. happy-dom provides
 * neither, and the composer keeps complete attachment submissions in
 * IndexedDB under a cross-tab lock before any of them reaches the wire. This
 * covers exactly what `ComposerPayloadStore` uses: one object store with an
 * array key path and one index, get/add/put/delete/getAll, and transactions
 * that commit after their last request or roll back when aborted.
 */
type Row = Record<string, unknown>;

interface StoreData {
  keyPath: string[];
  indexes: Map<string, string>;
  rows: Map<string, Row>;
}

class MemoryRequest {
  result: unknown;
  error: unknown = null;
  onsuccess: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onupgradeneeded: ((event: unknown) => void) | null = null;
  onblocked: ((event: unknown) => void) | null = null;
}

class MemoryTransaction {
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: unknown = null;
  private pending = 0;
  private finished = false;
  private readonly before: Map<string, Row>;

  constructor(private readonly data: StoreData) {
    this.before = new Map(data.rows);
    this.settleSoon();
  }

  objectStore(): MemoryObjectStore {
    return new MemoryObjectStore(this, this.data);
  }

  abort(): void {
    if (this.finished) return;
    this.finished = true;
    this.data.rows = new Map(this.before);
    queueMicrotask(() => this.onabort?.());
  }

  request(work: () => unknown): MemoryRequest {
    const request = new MemoryRequest();
    this.pending += 1;
    queueMicrotask(() => {
      if (this.finished) return;
      try {
        request.result = work();
        request.onsuccess?.({});
      } catch (error) {
        request.error = error;
        this.error = error;
        request.onerror?.({});
        this.abort();
      }
      this.pending -= 1;
      this.settleSoon();
    });
    return request;
  }

  private settleSoon(): void {
    queueMicrotask(() => {
      if (this.finished || this.pending > 0) return;
      this.finished = true;
      this.oncomplete?.();
    });
  }
}

class MemoryObjectStore {
  constructor(private readonly transaction: MemoryTransaction, private readonly data: StoreData) {}

  private keyOf(value: Row): string {
    return JSON.stringify(this.data.keyPath.map((part) => value[part]));
  }

  get(key: unknown): MemoryRequest {
    return this.transaction.request(() => this.data.rows.get(JSON.stringify(key)));
  }

  add(value: Row): MemoryRequest {
    return this.transaction.request(() => {
      const key = this.keyOf(value);
      if (this.data.rows.has(key)) throw new DOMException("Key already exists", "ConstraintError");
      this.data.rows.set(key, { ...value });
    });
  }

  put(value: Row): MemoryRequest {
    return this.transaction.request(() => { this.data.rows.set(this.keyOf(value), { ...value }); });
  }

  delete(key: unknown): MemoryRequest {
    return this.transaction.request(() => { this.data.rows.delete(JSON.stringify(key)); });
  }

  index(name: string): { getAll(value: unknown): MemoryRequest } {
    const field = this.data.indexes.get(name);
    return {
      getAll: (value) => this.transaction.request(() =>
        [...this.data.rows.values()].filter((row) => field !== undefined && row[field] === value)),
    };
  }
}

class MemoryDatabase {
  onversionchange: (() => void) | null = null;
  readonly stores = new Map<string, StoreData>();
  readonly objectStoreNames = { contains: (name: string) => this.stores.has(name) };

  createObjectStore(name: string, options: { keyPath: string[] }): { createIndex(index: string, keyPath: string): void } {
    const data: StoreData = { keyPath: options.keyPath, indexes: new Map(), rows: new Map() };
    this.stores.set(name, data);
    return { createIndex: (index, keyPath) => { data.indexes.set(index, keyPath); } };
  }

  transaction(name: string): MemoryTransaction {
    const data = this.stores.get(name);
    if (!data) throw new DOMException("No such object store", "NotFoundError");
    return new MemoryTransaction(data);
  }

  close(): void {}
}

export interface ComposerStorageForTests {
  /** Empties every database while keeping open handles valid. */
  reset(): void;
  uninstall(): void;
}

export function installComposerStorageForTests(): ComposerStorageForTests {
  const databases = new Map<string, MemoryDatabase>();
  const chains = new Map<string, Promise<unknown>>();
  const factory = {
    open(name: string): MemoryRequest {
      const request = new MemoryRequest();
      queueMicrotask(() => {
        let database = databases.get(name);
        const created = !database;
        if (!database) {
          database = new MemoryDatabase();
          databases.set(name, database);
        }
        request.result = database;
        if (created) request.onupgradeneeded?.({});
        request.onsuccess?.({});
      });
      return request;
    },
  };
  const locks = {
    request<T>(name: string, callback: (lock: { name: string; mode: "exclusive" }) => Promise<T> | T): Promise<T> {
      const run = (chains.get(name) ?? Promise.resolve()).then(() => callback({ name, mode: "exclusive" }));
      chains.set(name, run.catch(() => undefined));
      return run;
    },
  };
  const target = globalThis as { indexedDB?: unknown; navigator?: object };
  const previousFactory = target.indexedDB;
  const navigator = target.navigator;
  const previousLocks = navigator ? Object.getOwnPropertyDescriptor(navigator, "locks") : undefined;
  target.indexedDB = factory;
  if (navigator) Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
  return {
    reset() {
      for (const database of databases.values()) {
        for (const store of database.stores.values()) store.rows.clear();
      }
      chains.clear();
    },
    uninstall() {
      target.indexedDB = previousFactory;
      if (!navigator) return;
      if (previousLocks) Object.defineProperty(navigator, "locks", previousLocks);
      else delete (navigator as { locks?: unknown }).locks;
    },
  };
}
