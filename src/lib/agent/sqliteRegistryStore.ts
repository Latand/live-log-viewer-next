import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { Database as BunDatabase } from "bun:sqlite";

import { reboundAssembledMcpGrants, rowClaimsBeyondBaselineGrant, type McpGrantPolicy } from "./mcpAllowlist";
import type { RegistryFile, SnapshotSpawnProjection } from "./registry";

/** The collections the MCP grant decision reads and writes. Touching any one of
    them requires the decision to have run over ALL of them, because an entry or
    a receipt is only decidable against the conversations and lineage edges that
    attest to it (#739). */
const GRANT_COLLECTIONS = new Set(["entries", "receipts", "conversations", "lineageEdges"]);
const SNAPSHOT_SPAWN_ALIAS_LIMIT = 64;

const ROW_COLLECTIONS = [
  "entries",
  "receipts",
  "lineageEdges",
  "memberships",
  "conversations",
  "conversationAliases",
  "migrationIntents",
  "heldDeliveries",
  "deliveryOperationOwners",
  "pendingSuccessorCleanups",
  "pendingSupersedence",
] as const satisfies ReadonlyArray<keyof RegistryFile>;

const META_FIELDS = [
  "importedResumePanes",
  "legacyResumePanes",
  "conversationRevision",
  "engineRouting",
  "autoBalance",
  "quotaObservations",
] as const satisfies ReadonlyArray<keyof RegistryFile>;

export type RowCollection = (typeof ROW_COLLECTIONS)[number];
type StoredRow = { collection: string; row_key: string; value_json: string; row_order: number };
type MetaRow = { key: string; value: string };
type CachedRow = { valueJson: string; parsed: unknown };

interface RegistryChanges {
  rows: Map<RowCollection, Set<string>>;
  meta: Set<(typeof META_FIELDS)[number]>;
  order: Set<RowCollection>;
}

export interface SqliteRegistrySnapshot {
  file: RegistryFile;
  revision: number;
}

export interface SqliteRegistryReplacement extends SqliteRegistrySnapshot {
  replaced: boolean;
}

export interface SqliteRegistryMutation<T> {
  result: T;
  file: RegistryFile | null;
  revision: number;
}

export interface SqliteRegistryStoreOptions {
  initialSnapshot: RegistryFile;
  normalize(value: unknown): RegistryFile;
  /** Grant bound for the assembled-snapshot rebound below, matching whatever
      `normalize` enforces. Production omits both; a test supplies a policy that
      HAS a grantable connector, because the shipped bound has none and an empty
      bound cannot tell an origin reset from itself (issue #739). */
  mcpGrantPolicy?: McpGrantPolicy;
  onWriterWait?(durationMs: number): void;
  onSnapshotLoad?(): void;
  onRowPayloadRead?(collection: RowCollection, count: number): void;
  onRowPayloadParse?(collection: RowCollection, count: number): void;
  onRevisionQuery?(): void;
}

/**
 * A registry file no undecided MCP grant can leave (#739).
 *
 * The three row writers below take ONLY this type, and `markDecided` is the one
 * place that mints it, so a new persist path cannot be written without the
 * decision — it is a compile error, not a convention a future path has to know
 * about. That is the difference between this and enumerating today's callers:
 * enumeration notices a fourth entry point after somebody adds it, this one
 * refuses to let it be expressed.
 *
 * A file earns the brand two ways, and they are the same guarantee reached
 * differently:
 *
 *  - `decideAssembled` has run {@link reboundAssembledMcpGrants} over the whole
 *    of it, which is what a payload arriving from OUTSIDE the store needs;
 *  - it came from the lazy loader, whose row accessors run that same decision
 *    before handing out any row that claims more than the baseline, which is
 *    what a mutation reading rows one at a time needs.
 *
 * The brand is a runtime WeakSet as well as a type, so an `as` cast that skips
 * `markDecided` still throws at the write rather than silently persisting.
 */
declare const DECIDED: unique symbol;
export type DecidedRegistryFile = RegistryFile & { readonly [DECIDED]: true };

interface LazyRegistrySnapshot extends SqliteRegistrySnapshot {
  file: DecidedRegistryFile;
  changes(): RegistryChanges;
}

function trackMutableJson<T>(
  value: T,
  markDirty: () => void,
  seen: WeakMap<object, object>,
): T {
  if (value === null || typeof value !== "object") return value;
  const object = value as object;
  const cached = seen.get(object);
  if (cached) return cached as T;
  const proxy = new Proxy(object, {
    get: (target, property, receiver) => trackMutableJson(Reflect.get(target, property, receiver), markDirty, seen),
    set: (target, property, next) => {
      markDirty();
      return Reflect.set(target, property, next);
    },
    deleteProperty: (target, property) => {
      markDirty();
      return Reflect.deleteProperty(target, property);
    },
    defineProperty: (target, property, descriptor) => {
      markDirty();
      return Reflect.defineProperty(target, property, descriptor);
    },
  });
  seen.set(object, proxy);
  return proxy as T;
}

export class SqliteAgentRegistryStore {
  private readonly db: BunDatabase;
  private readonly normalize: (value: unknown) => RegistryFile;
  private readonly onWriterWait: ((durationMs: number) => void) | undefined;
  private readonly onSnapshotLoad: (() => void) | undefined;
  private readonly onRowPayloadRead: ((collection: RowCollection, count: number) => void) | undefined;
  private readonly onRowPayloadParse: ((collection: RowCollection, count: number) => void) | undefined;
  private readonly onRevisionQuery: (() => void) | undefined;
  private readonly rowCache = new Map<RowCollection, Map<string, CachedRow>>();
  private revisionCache: { signature: string; revision: number } | null = null;
  private readOnlyCache: SqliteRegistrySnapshot | null = null;

  private readonly mcpGrantPolicy: McpGrantPolicy | undefined;
  /** Runtime half of {@link DecidedRegistryFile}: the files this store has
      actually seen the decision run over, so an `as` cast cannot mint one. */
  private readonly decidedFiles = new WeakSet<object>();

  /** The sole mint. Everything that reaches a row writer passes through here. */
  private markDecided(file: RegistryFile): DecidedRegistryFile {
    this.decidedFiles.add(file);
    return file as DecidedRegistryFile;
  }

  /** For a payload arriving from outside the store, which has had no accessor
      gate applied to it: run the assembled decision over the whole file. */
  private decideAssembled(file: RegistryFile): DecidedRegistryFile {
    reboundAssembledMcpGrants(file, this.mcpGrantPolicy);
    return this.markDecided(file);
  }

  private assertDecided(file: DecidedRegistryFile): void {
    if (this.decidedFiles.has(file)) return;
    throw new Error("agent registry rows cannot be persisted before the MCP grant decision has run (#739)");
  }

  constructor(readonly filename: string, options: SqliteRegistryStoreOptions) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
    if (!sqlite) throw new Error("SQLite registry modes require the Bun runtime");
    const { Database } = sqlite;
    this.db = new Database(filename, { create: true, strict: true });
    this.normalize = options.normalize;
    this.onWriterWait = options.onWriterWait;
    this.onSnapshotLoad = options.onSnapshotLoad;
    this.onRowPayloadRead = options.onRowPayloadRead;
    this.onRowPayloadParse = options.onRowPayloadParse;
    this.onRevisionQuery = options.onRevisionQuery;
    this.mcpGrantPolicy = options.mcpGrantPolicy;
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA auto_vacuum = INCREMENTAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS registry_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS registry_rows (
        collection TEXT NOT NULL,
        row_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        row_order INTEGER NOT NULL,
        PRIMARY KEY(collection, row_key)
      );
    `);
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(registry_rows)").all();
    if (!columns.some((column) => column.name === "row_order")) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE registry_rows ADD COLUMN row_order INTEGER NOT NULL DEFAULT 0;
        WITH ordered AS (
          SELECT rowid, ROW_NUMBER() OVER (PARTITION BY collection ORDER BY rowid) - 1 AS position
          FROM registry_rows
        )
        UPDATE registry_rows
        SET row_order = (SELECT position FROM ordered WHERE ordered.rowid = registry_rows.rowid);
        INSERT INTO registry_meta(key, value) VALUES ('schema_version', '2')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;
        COMMIT;
      `);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS registry_rows_collection_order
      ON registry_rows(collection, row_order);
    `);
    this.secureFiles();
    this.importFirstBoot(options.initialSnapshot);
  }

  snapshot(): SqliteRegistrySnapshot {
    return this.loadSnapshot(false);
  }

  private loadSnapshot(useRowCache: boolean): SqliteRegistrySnapshot {
    this.onSnapshotLoad?.();
    this.db.exec("BEGIN");
    try {
      const snapshot = this.loadInTransaction(useRowCache);
      this.db.exec("COMMIT");
      return snapshot;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  revision(): number {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = this.storageSignature();
      if (this.revisionCache?.signature === before) return this.revisionCache.revision;
      this.onRevisionQuery?.();
      const revision = Number(this.meta("revision") ?? 0);
      const after = this.storageSignature();
      if (before !== after) continue;
      this.revisionCache = { signature: after, revision };
      return revision;
    }
    this.onRevisionQuery?.();
    const revision = Number(this.meta("revision") ?? 0);
    this.rememberRevision(revision);
    return revision;
  }

  readOnlySnapshot(): SqliteRegistrySnapshot {
    const revision = this.revision();
    if (this.readOnlyCache?.revision === revision) return this.readOnlyCache;
    this.readOnlyCache = this.loadSnapshot(true);
    return this.readOnlyCache;
  }

  /** One transaction and keyed row reads for the at-most-bounded spawn paths in
      a Viewer snapshot. No collection enumeration or whole snapshot occurs. */
  snapshotSpawns(launchIds: readonly string[]): SnapshotSpawnProjection {
    this.db.exec("BEGIN");
    try {
      const readRow = (collection: RowCollection, key: string): unknown => {
        const stored = this.db.query<Pick<StoredRow, "value_json">, [string, string]>(
          "SELECT value_json FROM registry_rows WHERE collection = ? AND row_key = ?",
        ).get(collection, key);
        this.onRowPayloadRead?.(collection, stored ? 1 : 0);
        return stored ? this.parseRow(collection, key, stored.value_json, true) : undefined;
      };
      const normalizeRow = <Collection extends "receipts" | "conversations">(
        collection: Collection,
        key: string,
        value: unknown,
      ): RegistryFile[Collection][string] | undefined => {
        const input: Record<string, unknown> = { version: 2, entries: {}, receipts: {} };
        input[collection] = { [key]: value };
        return this.normalize(input)[collection][key] as RegistryFile[Collection][string] | undefined;
      };
      const projection: SnapshotSpawnProjection = {};
      for (const launchId of new Set(launchIds)) {
        const rawReceipt = readRow("receipts", launchId);
        if (rawReceipt === undefined) continue;
        const receipt = normalizeRow("receipts", launchId, rawReceipt);
        if (!receipt) continue;

        const seen = new Set<string>();
        let conversationId: string = receipt.conversationId;
        let aliasLimitReached = false;
        while (!seen.has(conversationId) && seen.size < SNAPSHOT_SPAWN_ALIAS_LIMIT) {
          seen.add(conversationId);
          const alias = readRow("conversationAliases", conversationId);
          if (typeof alias !== "string" || !alias.startsWith("conversation_")) break;
          conversationId = alias;
          aliasLimitReached = seen.size === SNAPSHOT_SPAWN_ALIAS_LIMIT;
        }
        const rawConversation = aliasLimitReached ? undefined : readRow("conversations", conversationId);
        const conversation = rawConversation === undefined
          ? undefined
          : normalizeRow("conversations", conversationId, rawConversation);
        projection[launchId] = {
          launchId: receipt.launchId,
          state: receipt.state,
          error: receipt.error,
          engine: receipt.engine,
          cwd: receipt.cwd,
          createdAt: receipt.createdAt,
          materializedPath: conversation?.generations.at(-1)?.path ?? receipt.artifactPath,
        };
      }
      this.db.exec("COMMIT");
      return projection;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  mutate<T>(operation: (file: RegistryFile) => T, includeSnapshot = true): SqliteRegistryMutation<T> {
    for (;;) {
      this.db.exec("BEGIN");
      let current: LazyRegistrySnapshot;
      let changes: RegistryChanges;
      let result: T;
      try {
        current = this.loadLazyInTransaction();
        result = operation(current.file);
        changes = current.changes();
        this.db.exec("COMMIT");
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
        throw error;
      }
      const waitStartedAt = performance.now();
      this.db.exec("BEGIN IMMEDIATE");
      let revision: number;
      const changed = changes.rows.size > 0 || changes.meta.size > 0 || changes.order.size > 0;
      try {
        this.onWriterWait?.(performance.now() - waitStartedAt);
        if (Number(this.meta("revision") ?? 0) !== current.revision) {
          this.db.exec("ROLLBACK");
          continue;
        }
        revision = changed ? current.revision + 1 : current.revision;
        if (changed) this.persistChanges(current.file, changes, revision);
        this.db.exec("COMMIT");
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
        throw error;
      }
      if (changed) {
        this.secureFiles();
        this.updateCachesAfterCommit(current.file, changes, revision);
        this.rememberRevision(revision);
      }
      if (includeSnapshot) {
        const committed = this.snapshot();
        return { result, file: committed.file, revision: committed.revision };
      }
      return { result, file: null, revision };
    }
  }

  replace(file: RegistryFile, expectedRevision?: number): SqliteRegistryReplacement {
    /* A wholesale replacement is a mutation like any other, and its payload
       arrives from outside this store, so it is re-decided before it lands
       rather than on the way back out (#739). `persistDiff` takes only a
       DecidedRegistryFile, so this line cannot be dropped without the store
       failing to compile. */
    const decided = this.decideAssembled(file);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.loadInTransaction();
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        this.db.exec("ROLLBACK");
        return { ...current, replaced: false };
      }
      const revision = current.revision + 1;
      this.persistDiff(current.file, decided, revision);
      this.db.exec("COMMIT");
      this.secureFiles();
      this.rowCache.clear();
      this.readOnlyCache = null;
      this.rememberRevision(revision);
      return { file, revision, replaced: true };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  private importFirstBoot(initialSnapshot: RegistryFile): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const complete = this.meta("migration_complete");
      if (complete !== "1") {
        this.persistAll(this.decideAssembled(initialSnapshot), 1);
        this.setMeta("schema_version", "2");
        this.setMeta("migration_complete", "1");
      }
      this.db.exec("COMMIT");
      this.secureFiles();
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  private loadInTransaction(useRowCache = false): SqliteRegistrySnapshot {
    const snapshot = this.loadLazyInTransaction(false, useRowCache);
    /* Touching the grant-bearing collections runs the assembled re-decision
       through the same gate every other path goes through (#739); the rest are
       materialized because a snapshot is by definition complete. */
    for (const collection of ROW_COLLECTIONS) void snapshot.file[collection];
    for (const field of META_FIELDS) void snapshot.file[field];
    return snapshot;
  }

  private loadLazyInTransaction(trackMutations = true, useRowCache = trackMutations): LazyRegistrySnapshot {
    /* Branded here because the row ACCESSORS below carry the guarantee: every
       row this file can hand out goes through `admitRow`, which runs the
       assembled decision before returning anything claiming more than the
       baseline. The brand is what lets `persistChanges` accept it. */
    const file = this.markDecided(this.normalize({ version: 2, entries: {}, receipts: {} }));
    /* The assembled origin re-decision is a PRECONDITION of observing a grant,
       not a step some paths reach later (#739). Rows are normalized one
       collection — one row, even — at a time, so a row loaded lazily has had
       only the global bound applied; the origin half needs the conversations,
       lineage edges and receipts together. `mutate` used to hand its operation
       the lazily normalized file directly, which put every store mutation —
       settlement, structured claim, upsert — underneath the gate that `snapshot`
       passed through.
       Gating the ACCESSORS rather than a call site means the ordering cannot be
       got wrong by a future path. The gate hangs off the ROW, not the
       collection: a row already at the baseline is returned byte-identical by
       the decision, so skipping it there is the gate answering trivially rather
       than a way around it, and a keyed mutation still reads exactly the one row
       it asked for. The first row that claims anything MORE runs the decision
       over the whole file before it is handed out. */
    let grantsDecided = false;
    let decidingGrants = false;
    const decideGrants = () => {
      if (grantsDecided || decidingGrants) return;
      decidingGrants = true;
      try {
        reboundAssembledMcpGrants(file, this.mcpGrantPolicy);
        grantsDecided = true;
      } finally {
        decidingGrants = false;
      }
    };
    /* Every row leaves a loader through here. A row at the baseline is admitted
       untouched; anything claiming more is only returned once the decision has
       run over the whole file, including the rows attesting to this one. */
    const admitRow = <T>(collection: RowCollection, row: T): T => {
      if (GRANT_COLLECTIONS.has(collection) && rowClaimsBeyondBaselineGrant(row)) decideGrants();
      return row;
    };
    const loadedCollections = new Map<RowCollection, RegistryFile[RowCollection]>();
    const baselineCollections = new Map<RowCollection, Map<string, string | null>>();
    const dirtyRows = new Map<RowCollection, Set<string>>();
    const reorderedCollections = new Set<RowCollection>();
    for (const collection of ROW_COLLECTIONS) {
      let loaded = false;
      let value = file[collection];
      let loadAllBaseline = () => {};
      const load = () => {
        if (loaded) return;
        const dirty = new Set<string>();
        const baseline = new Map<string, string | null>();
        if (!trackMutations || collection === "deliveryOperationOwners") {
          const storedValue = {} as typeof value;
          const storedRows = this.db.query<StoredRow, [string]>(
            "SELECT collection, row_key, value_json, row_order FROM registry_rows WHERE collection = ? ORDER BY row_order",
          ).all(collection);
          this.onRowPayloadRead?.(collection, storedRows.length);
          for (const row of storedRows) {
            const parsed = this.parseRow(collection, row.row_key, row.value_json, useRowCache);
            (storedValue as Record<string, unknown>)[row.row_key] = trackMutations
              ? structuredClone(parsed)
              : parsed;
            baseline.set(row.row_key, row.value_json);
          }
          const input: Record<string, unknown> = { version: 2, entries: {}, receipts: {} };
          input[collection] = storedValue;
          if (collection === "deliveryOperationOwners") input.heldDeliveries = file.heldDeliveries;
          value = this.normalize(input)[collection] as typeof value;
          if (trackMutations) {
            const rowProxies = new Map<string, WeakMap<object, object>>();
            value = new Proxy(value as Record<string, unknown>, {
              get: (target, property, receiver) => {
                const row = Reflect.get(target, property, receiver);
                if (typeof property !== "string" || !Object.hasOwn(target, property)) return row;
                let seen = rowProxies.get(property);
                if (!seen) {
                  seen = new WeakMap<object, object>();
                  rowProxies.set(property, seen);
                }
                return trackMutableJson(row, () => dirty.add(property), seen);
              },
              set: (target, property, next) => {
                if (typeof property === "string") dirty.add(property);
                return Reflect.set(target, property, next);
              },
              deleteProperty: (target, property) => {
                if (typeof property === "string") dirty.add(property);
                return Reflect.deleteProperty(target, property);
              },
              defineProperty: (target, property, descriptor) => {
                if (typeof property === "string") dirty.add(property);
                return Reflect.defineProperty(target, property, descriptor);
              },
            }) as typeof value;
          }
          loadAllBaseline = () => {};
        } else {
          const rows = {} as Record<string, unknown>;
          const deleted = new Set<string>();
          let orderedKeys: string[] | null = null;
          let storedKeySet: Set<string> | null = null;
          let allRowsLoaded = false;
          let storedPayloadRows: Pick<StoredRow, "row_key" | "value_json">[] | null = null;
          const rowProxies = new Map<string, WeakMap<object, object>>();
          const storedRow = this.db.query<Pick<StoredRow, "value_json">, [string, string]>(
            "SELECT value_json FROM registry_rows WHERE collection = ? AND row_key = ?",
          );
          const storedRows = this.db.query<Pick<StoredRow, "row_key" | "value_json">, [string]>(
            "SELECT row_key, value_json FROM registry_rows WHERE collection = ? ORDER BY row_order",
          );
          const readAllStoredRows = () => {
            if (storedPayloadRows) return storedPayloadRows;
            storedPayloadRows = storedRows.all(collection);
            this.onRowPayloadRead?.(collection, storedPayloadRows.length);
            orderedKeys = storedPayloadRows.map((row) => row.row_key);
            storedKeySet = new Set(orderedKeys);
            for (const row of storedPayloadRows) baseline.set(row.row_key, row.value_json);
            return storedPayloadRows;
          };
          loadAllBaseline = () => {
            readAllStoredRows();
          };
          const readBaseline = (key: string): string | null => {
            if (baseline.has(key)) return baseline.get(key)!;
            const stored = storedRow.get(collection, key)?.value_json ?? null;
            this.onRowPayloadRead?.(collection, stored === null ? 0 : 1);
            baseline.set(key, stored);
            return stored;
          };
          /* Every row this collection hands out leaves through here — the keyed
             read below, and equally the rows `loadAllRows` has already cached,
             which an enumeration reaches through `getOwnPropertyDescriptor`. So
             the gate sits on the single exit rather than on the load, and no
             route to a row can arrive before the decision it needs. */
          const readRow = (key: string): unknown => {
            if (!Object.hasOwn(rows, key)) {
              if (deleted.has(key)) return undefined;
              const stored = readBaseline(key);
              if (stored === null) return undefined;
              const input: Record<string, unknown> = { version: 2, entries: {}, receipts: {} };
              input[collection] = { [key]: structuredClone(this.parseRow(collection, key, stored, useRowCache)) };
              const normalized = this.normalize(input)[collection] as Record<string, unknown>;
              if (!Object.hasOwn(normalized, key)) return undefined;
              rows[key] = normalized[key];
            }
            /* The decision rewrites `rows[key]` in place where it denies, so the
               caller never holds the undecided object. */
            return admitRow(collection, rows[key]);
          };
          const loadAllRows = () => {
            if (allRowsLoaded) return;
            const stored = readAllStoredRows();
            const unloaded: Record<string, unknown> = {};
            for (const row of stored) {
              if (!Object.hasOwn(rows, row.row_key) && !deleted.has(row.row_key)) {
                unloaded[row.row_key] = structuredClone(this.parseRow(
                  collection,
                  row.row_key,
                  row.value_json,
                  useRowCache,
                ));
              }
            }
            const input: Record<string, unknown> = { version: 2, entries: {}, receipts: {} };
            input[collection] = unloaded;
            const normalized = this.normalize(input)[collection] as Record<string, unknown>;
            for (const [key, row] of Object.entries(normalized)) rows[key] = row;
            allRowsLoaded = true;
          };
          const keys = (): string[] => {
            loadAllRows();
            return [
              ...orderedKeys!.filter((key) => !deleted.has(key)),
              ...Object.keys(rows).filter((key) => !storedKeySet!.has(key)),
            ];
          };
          value = new Proxy(rows, {
            get: (target, property, receiver) => {
              if (typeof property !== "string") return Reflect.get(target, property, receiver);
              const row = readRow(property);
              if (row === undefined) return undefined;
              let seen = rowProxies.get(property);
              if (!seen) {
                seen = new WeakMap<object, object>();
                rowProxies.set(property, seen);
              }
              return trackMutableJson(row, () => dirty.add(property), seen);
            },
            set: (target, property, next) => {
              if (typeof property === "string") {
                readBaseline(property);
                dirty.add(property);
                deleted.delete(property);
                rowProxies.delete(property);
              }
              return Reflect.set(target, property, next);
            },
            deleteProperty: (target, property) => {
              if (typeof property === "string") {
                readBaseline(property);
                dirty.add(property);
                deleted.add(property);
                rowProxies.delete(property);
              }
              return Reflect.deleteProperty(target, property);
            },
            defineProperty: (target, property, descriptor) => {
              if (typeof property === "string") {
                readBaseline(property);
                dirty.add(property);
                deleted.delete(property);
                rowProxies.delete(property);
              }
              return Reflect.defineProperty(target, property, descriptor);
            },
            has: (_target, property) => typeof property === "string"
              ? readRow(property) !== undefined
              : Reflect.has(rows, property),
            ownKeys: () => keys(),
            getOwnPropertyDescriptor: (_target, property) => {
              if (typeof property !== "string") return undefined;
              const row = readRow(property);
              if (row === undefined) return undefined;
              return { configurable: true, enumerable: true, writable: true, value: row };
            },
          }) as typeof value;
        }
        loaded = true;
        loadedCollections.set(collection, value);
        baselineCollections.set(collection, baseline);
        dirtyRows.set(collection, dirty);
      };
      Object.defineProperty(file, collection, {
        configurable: true,
        enumerable: true,
        get: () => {
          load();
          /* The eager loader has materialized the whole collection by now, so
             there is no laziness left to protect and the decision runs on the
             collection. The lazy loader gates each ROW instead, on `readRow`'s
             single exit, so a keyed read stays keyed. */
          if (!trackMutations && GRANT_COLLECTIONS.has(collection)) decideGrants();
          return value;
        },
        set: (next: typeof value) => {
          load();
          loadAllBaseline();
          value = next;
          loadedCollections.set(collection, value);
          reorderedCollections.add(collection);
        },
      });
    }
    const loadedMeta = new Map<(typeof META_FIELDS)[number], RegistryFile[(typeof META_FIELDS)[number]]>();
    const baselineMeta = new Map<(typeof META_FIELDS)[number], RegistryFile[(typeof META_FIELDS)[number]]>();
    for (const field of META_FIELDS) {
      let loaded = false;
      let value = file[field];
      const load = () => {
        if (loaded) return;
        const stored = this.meta(field);
        if (stored !== null) value = JSON.parse(stored) as typeof value;
        loaded = true;
        loadedMeta.set(field, value);
        baselineMeta.set(field, structuredClone(value));
      };
      Object.defineProperty(file, field, {
        configurable: true,
        enumerable: true,
        get: () => {
          load();
          return value;
        },
        set: (next: typeof value) => {
          load();
          value = next;
          loadedMeta.set(field, value);
        },
      });
    }
    return {
      file,
      revision: Number(this.meta("revision") ?? 0),
      changes: () => {
        const changes: RegistryChanges = { rows: new Map(), meta: new Set(), order: new Set() };
        for (const [collection, value] of loadedCollections) {
          const baseline = baselineCollections.get(collection)!;
          const current = value as Record<string, unknown>;
          const candidates = reorderedCollections.has(collection)
            ? new Set([...baseline.keys(), ...Object.keys(current)])
            : dirtyRows.get(collection)!;
          const changed = new Set([...candidates].filter((key) => {
            if (!Object.hasOwn(current, key)) return baseline.has(key);
            const previous = baseline.get(key);
            return previous === undefined || JSON.stringify(current[key]) !== previous;
          }));
          if (changed.size > 0) changes.rows.set(collection, changed);
          if (reorderedCollections.has(collection)) {
            changes.rows.set(collection, new Set([...Object.keys(baseline), ...Object.keys(current)]));
            changes.order.add(collection);
          }
        }
        for (const [field, value] of loadedMeta) {
          if (!isDeepStrictEqual(baselineMeta.get(field), value)) changes.meta.add(field);
        }
        return changes;
      },
    };
  }

  private parseRow(
    collection: RowCollection,
    key: string,
    valueJson: string,
    useCache: boolean,
  ): unknown {
    if (!useCache) {
      this.onRowPayloadParse?.(collection, 1);
      return JSON.parse(valueJson);
    }
    let collectionCache = this.rowCache.get(collection);
    if (!collectionCache) {
      collectionCache = new Map();
      this.rowCache.set(collection, collectionCache);
    }
    const cached = collectionCache.get(key);
    if (cached?.valueJson === valueJson) return cached.parsed;
    const parsed = JSON.parse(valueJson);
    this.onRowPayloadParse?.(collection, 1);
    collectionCache.set(key, { valueJson, parsed });
    return parsed;
  }

  private updateCachesAfterCommit(
    file: RegistryFile,
    changes: RegistryChanges,
    revision: number,
  ): void {
    const cachedSnapshot = this.readOnlyCache?.revision === revision - 1
      ? this.readOnlyCache
      : null;
    const nextFile = cachedSnapshot ? { ...cachedSnapshot.file } : null;

    for (const [collection, keys] of changes.rows) {
      const currentRows = file[collection] as Record<string, unknown>;
      let collectionCache = this.rowCache.get(collection);
      if (!collectionCache) {
        collectionCache = new Map();
        this.rowCache.set(collection, collectionCache);
      }
      const nextRows = nextFile
        ? { ...(cachedSnapshot!.file[collection] as Record<string, unknown>) }
        : null;
      for (const key of keys) {
        if (!Object.hasOwn(currentRows, key)) {
          collectionCache.delete(key);
          if (nextRows) delete nextRows[key];
          continue;
        }
        const valueJson = JSON.stringify(currentRows[key]);
        const parsed = JSON.parse(valueJson) as unknown;
        collectionCache.set(key, { valueJson, parsed });
        if (nextRows) nextRows[key] = parsed;
      }
      if (nextFile && nextRows) {
        if (changes.order.has(collection)) {
          const ordered: Record<string, unknown> = {};
          for (const key of Object.keys(currentRows)) {
            if (Object.hasOwn(nextRows, key)) ordered[key] = nextRows[key];
          }
          (nextFile as unknown as Record<string, unknown>)[collection] = ordered;
        } else {
          (nextFile as unknown as Record<string, unknown>)[collection] = nextRows;
        }
      }
    }

    if (nextFile) {
      for (const field of changes.meta) {
        (nextFile as unknown as Record<string, unknown>)[field] = structuredClone(file[field]);
      }
      this.readOnlyCache = { file: nextFile, revision };
    } else {
      this.readOnlyCache = null;
    }
  }

  private persistAll(file: DecidedRegistryFile, revision: number): void {
    this.assertDecided(file);
    this.db.exec("DELETE FROM registry_rows");
    for (const collection of ROW_COLLECTIONS) {
      for (const [order, [key, value]] of Object.entries(file[collection]).entries()) {
        this.upsertRow(collection, key, value, order);
      }
    }
    for (const field of META_FIELDS) this.setMeta(field, JSON.stringify(file[field]));
    this.setMeta("revision", String(revision));
  }

  private persistDiff(before: RegistryFile, after: DecidedRegistryFile, revision: number): void {
    this.assertDecided(after);
    for (const collection of ROW_COLLECTIONS) {
      const previous = before[collection] as Record<string, unknown>;
      const next = after[collection] as Record<string, unknown>;
      const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
      for (const key of keys) {
        if (!(key in next)) {
          this.db.query("DELETE FROM registry_rows WHERE collection = ? AND row_key = ?").run(collection, key);
          continue;
        }
        if (key in previous && isDeepStrictEqual(previous[key], next[key])) continue;
        this.upsertRow(collection, key, next[key]);
      }
      this.persistRowOrder(collection, Object.keys(next));
    }
    for (const field of META_FIELDS) {
      if (isDeepStrictEqual(before[field], after[field])) continue;
      this.setMeta(field, JSON.stringify(after[field]));
    }
    this.setMeta("revision", String(revision));
  }

  private persistChanges(file: DecidedRegistryFile, changes: RegistryChanges, revision: number): void {
    this.assertDecided(file);
    for (const [collection, keys] of changes.rows) {
      const rows = file[collection] as Record<string, unknown>;
      for (const key of keys) {
        if (key in rows) this.upsertRow(collection, key, rows[key]);
        else this.db.query("DELETE FROM registry_rows WHERE collection = ? AND row_key = ?").run(collection, key);
      }
    }
    for (const collection of changes.order) this.persistRowOrder(collection, Object.keys(file[collection]));
    for (const field of changes.meta) this.setMeta(field, JSON.stringify(file[field]));
    this.setMeta("revision", String(revision));
  }

  private upsertRow(collection: RowCollection, key: string, value: unknown, order?: number): void {
    if (order !== undefined) {
      this.db.query(`
        INSERT INTO registry_rows(collection, row_key, value_json, row_order) VALUES (?, ?, ?, ?)
        ON CONFLICT(collection, row_key) DO UPDATE SET value_json = excluded.value_json, row_order = excluded.row_order
      `).run(collection, key, JSON.stringify(value), order);
      return;
    }
    this.db.query(`
      INSERT INTO registry_rows(collection, row_key, value_json, row_order)
      SELECT ?, ?, ?, COALESCE(MAX(row_order) + 1, 0) FROM registry_rows WHERE collection = ?
      ON CONFLICT(collection, row_key) DO UPDATE SET value_json = excluded.value_json
    `).run(collection, key, JSON.stringify(value), collection);
  }

  private persistRowOrder(collection: RowCollection, keys: string[]): void {
    for (const [order, key] of keys.entries()) {
      this.db.query("UPDATE registry_rows SET row_order = ? WHERE collection = ? AND row_key = ?")
        .run(order, collection, key);
    }
  }

  private meta(key: string): string | null {
    return this.db.query<MetaRow, [string]>("SELECT key, value FROM registry_meta WHERE key = ?").get(key)?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db.query(`
      INSERT INTO registry_meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  private secureFiles(): void {
    for (const candidate of [this.filename, `${this.filename}-wal`, `${this.filename}-shm`]) {
      if (fs.existsSync(candidate)) fs.chmodSync(candidate, 0o600);
    }
  }

  private storageSignature(): string {
    return [this.filename, `${this.filename}-wal`].map((candidate) => {
      try {
        const stat = fs.statSync(candidate, { bigint: true });
        return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
        throw error;
      }
    }).join("|");
  }

  private rememberRevision(revision: number): void {
    this.revisionCache = { signature: this.storageSignature(), revision };
  }
}
