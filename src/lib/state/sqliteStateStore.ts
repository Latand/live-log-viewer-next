import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Database as BunDatabase, SQLQueryBindings } from "bun:sqlite";

import { procBackend } from "@/lib/proc";

import { FileTransactionBusyError } from "./fileTransaction";
import {
  hotStatePreparingWriterReady,
  hotStateSqliteWriterReady,
  hotStateWriterRevision,
  readHotStateAuthority,
  readHotStateReleaseTarget,
} from "./hotStateAuthority";

const LOCK_ATTEMPTS = 6_000;
const LOCK_WAIT_MS = 5;
const SYNC_SLEEP = new Int32Array(new SharedArrayBuffer(4));
const CHANGE_READ_CHUNK = 400;
const CHANGE_RETENTION_REVISIONS = 1_024;
const CHANGE_PRUNE_BATCH = 1_000;
const cutoverReadyDatabases = new Set<string>();
let readonlyConnectionCount = 0;
type Database = BunDatabase;

export interface StateCollectionSeed<T> {
  collection: string;
  schemaVersion: number;
  migrationId: string;
  loadRecords(): readonly T[];
  key(record: T): string;
  controllerActive?(record: T): boolean;
}

export interface SqliteStateCollectionOptions<T> {
  collection: string;
  schemaVersion: number;
  busyMessage: string;
  key(record: T): string;
  decode(value: unknown): T | null;
  clone(record: T): T;
  controllerActive?(record: T): boolean;
  validate?(record: T): void;
  strictDecode?: boolean;
  decodeError?(error: unknown): Error;
  onDecodeError?(error: unknown): void;
  onIncrementalReadSnapshot?(revision: number): void;
}

type CollectionRow = {
  row_key: string;
  value_json: string;
  row_order: number;
  row_revision: number;
  controller_active: number;
};

type CollectionMeta = {
  revision: number;
  schema_version: number;
  change_floor: number;
};

type LeaseRow = {
  owner_token: string;
  owner_pid: number;
  owner_start_identity: string | null;
};

type CachedRecord<T> = {
  valueJson: string;
  value: T;
  order: number;
  rowRevision: number;
};

interface CollectionCache<T> {
  revision: number;
  records: Map<string, CachedRecord<T>>;
  orderedKeys: readonly string[];
  ordered: readonly T[];
}

interface TrackedRoot<T> {
  originalKey: string;
  persistedJson: string;
  value: T;
}

interface MutationSession<T> {
  records: T[];
  rawRecords: T[];
  materialized: Map<number, TrackedRoot<T>>;
  structural: boolean;
}

export interface StateMutationContext<T> {
  records: T[];
  dirtyRecords: readonly T[];
  structural: boolean;
}

function sqliteDatabase(): typeof import("bun:sqlite").Database {
  const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
  if (!sqlite) throw new Error("SQLite state stores require the Bun runtime");
  return sqlite.Database;
}

export function markStateSqliteCutoverReady(filename: string): void {
  cutoverReadyDatabases.add(path.resolve(filename));
}

function collectionMarkersMatch(db: Database, seeds: readonly StateCollectionSeed<unknown>[]): boolean {
  const marker = db.query<{ schema_version: number; migration_id: string }, [string]>(
    "SELECT schema_version, migration_id FROM state_collections WHERE collection = ?",
  );
  return seeds.every((seed) => {
    const current = marker.get(seed.collection);
    return current?.schema_version === seed.schemaVersion && current.migration_id === seed.migrationId;
  });
}

function collectionsAlreadyInitialized(filename: string, seeds: readonly StateCollectionSeed<unknown>[]): boolean {
  if (!fs.existsSync(filename)) return false;
  let db: Database | null = null;
  try {
    db = connectReadonlyDatabase(filename);
    return collectionMarkersMatch(db, seeds);
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

function ensureFirstSqliteCutover(filename: string, seeds: readonly StateCollectionSeed<unknown>[]): void {
  const resolved = path.resolve(filename);
  if (cutoverReadyDatabases.has(resolved) || collectionsAlreadyInitialized(filename, seeds)) return;
  const directory = path.dirname(filename);
  if (readHotStateReleaseTarget(directory) === null) {
    cutoverReadyDatabases.add(resolved);
    return;
  }
  if (!hotStateSqliteWriterReady(directory)) {
    throw new FileTransactionBusyError("hot state migration is waiting for release promotion");
  }
  cutoverReadyDatabases.add(resolved);
}

function assertSqliteWriteAuthority(filename: string): void {
  if (!hotStateSqliteWriterReady(path.dirname(filename))) {
    throw new FileTransactionBusyError("hot state writes are fenced during release handoff");
  }
}

function assertSqliteInitializationAuthority(filename: string, allowFencedExisting = false): void {
  if (hotStateSqliteWriterReady(path.dirname(filename))) return;
  if (cutoverReadyDatabases.has(path.resolve(filename))
    && hotStatePreparingWriterReady(path.dirname(filename))) return;
  const revision = hotStateWriterRevision(path.dirname(filename));
  const authority = readHotStateAuthority(path.dirname(filename));
  if (allowFencedExisting
    && revision !== null
    && authority?.mode === "fencing"
    && authority.releaseRevision === revision) return;
  throw new FileTransactionBusyError("hot state migration is waiting for release promotion");
}

function connectDatabase(filename: string): Database {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const Database = sqliteDatabase();
  const db = new Database(filename, { create: true, strict: true });
  try {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      try {
        db.exec("PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
        return db;
      } catch (error) {
        if (!isBusyError(error)) throw error;
        Atomics.wait(SYNC_SLEEP, 0, 0, LOCK_WAIT_MS);
      }
    }
    throw new FileTransactionBusyError("state database connection is busy");
  } catch (error) {
    db.close();
    throw error;
  }
}

function connectReadonlyDatabase(filename: string): Database {
  readonlyConnectionCount += 1;
  const Database = sqliteDatabase();
  const db = new Database(filename, { readonly: true, strict: true });
  db.exec("PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON;");
  return db;
}

function openDatabase(filename: string): Database {
  const db = connectDatabase(filename);
  try {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      try {
        db.exec("PRAGMA journal_mode = WAL; PRAGMA auto_vacuum = INCREMENTAL;");
        db.exec("BEGIN IMMEDIATE");
        db.exec(`
          CREATE TABLE IF NOT EXISTS state_collections (
            collection TEXT PRIMARY KEY,
            schema_version INTEGER NOT NULL,
            revision INTEGER NOT NULL,
            change_floor INTEGER NOT NULL DEFAULT 0,
            migration_id TEXT NOT NULL,
            imported_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS state_rows (
            collection TEXT NOT NULL,
            row_key TEXT NOT NULL,
            value_json TEXT NOT NULL,
            row_order INTEGER NOT NULL,
            row_revision INTEGER NOT NULL,
            controller_active INTEGER NOT NULL CHECK(controller_active IN (0, 1)),
            PRIMARY KEY(collection, row_key),
            FOREIGN KEY(collection) REFERENCES state_collections(collection) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS state_rows_collection_order
            ON state_rows(collection, row_order);
          CREATE INDEX IF NOT EXISTS state_rows_controller_active
            ON state_rows(collection, controller_active, row_order);
          CREATE TABLE IF NOT EXISTS state_changes (
            collection TEXT NOT NULL,
            revision INTEGER NOT NULL,
            row_key TEXT NOT NULL,
            operation TEXT NOT NULL CHECK(operation IN ('upsert', 'delete')),
            PRIMARY KEY(collection, revision, row_key),
            FOREIGN KEY(collection) REFERENCES state_collections(collection) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS state_changes_collection_revision
            ON state_changes(collection, revision);
          CREATE TABLE IF NOT EXISTS state_leases (
            collection TEXT PRIMARY KEY,
            owner_token TEXT NOT NULL,
            owner_pid INTEGER NOT NULL,
            owner_start_identity TEXT,
            acquired_at INTEGER NOT NULL
          );
        `);
        const collectionColumns = db.query<{ name: string }, []>("PRAGMA table_info(state_collections)").all();
        if (!collectionColumns.some((column) => column.name === "change_floor")) {
          db.exec("ALTER TABLE state_collections ADD COLUMN change_floor INTEGER NOT NULL DEFAULT 0");
        }
        db.exec("COMMIT");
        secureDatabaseFiles(filename);
        return db;
      } catch (error) {
        rollbackQuietly(db);
        if (!isBusyError(error)) throw error;
        Atomics.wait(SYNC_SLEEP, 0, 0, LOCK_WAIT_MS);
      }
    }
    throw new FileTransactionBusyError("state database initialization is busy");
  } catch (error) {
    db.close();
    throw error;
  }
}

function secureDatabaseFiles(filename: string): void {
  for (const candidate of [filename, `${filename}-wal`, `${filename}-shm`]) {
    try { fs.chmodSync(candidate, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function rollbackQuietly(db: Database): void {
  try { db.exec("ROLLBACK"); } catch { /* transaction never opened or already closed */ }
}

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is (?:locked|busy)|SQLITE_BUSY/i.test(message);
}

function withImmediateTransaction<T>(db: Database, busyMessage: string, operation: () => T): T {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      db.exec("BEGIN IMMEDIATE");
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      rollbackQuietly(db);
      if (!isBusyError(error)) throw error;
      Atomics.wait(SYNC_SLEEP, 0, 0, LOCK_WAIT_MS);
    }
  }
  throw new FileTransactionBusyError(busyMessage);
}

function processAlive(pid: number, expectedStartIdentity: string | null): boolean {
  if (!procBackend.pidAlive(pid)) return false;
  if (expectedStartIdentity === null) return true;
  const current = procBackend.processIdentity(pid);
  return current === null || current === expectedStartIdentity;
}

export function stateLeaseOwnerAlive(owner: { pid: number; startIdentity: string | null }): boolean {
  return Number.isInteger(owner.pid) && owner.pid > 0 && processAlive(owner.pid, owner.startIdentity);
}

function leaseIsStale(lease: LeaseRow): boolean {
  return !stateLeaseOwnerAlive({ pid: lease.owner_pid, startIdentity: lease.owner_start_identity });
}

function insertSeed<T>(db: Database, seed: StateCollectionSeed<T>): void {
  const records = seed.loadRecords();
  const revision = records.length > 0 ? 1 : 0;
  db.query(`
    INSERT INTO state_collections(collection, schema_version, revision, migration_id, imported_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(seed.collection, seed.schemaVersion, revision, seed.migrationId, new Date().toISOString());
  const insert = db.query(`
    INSERT INTO state_rows(collection, row_key, value_json, row_order, row_revision, controller_active)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const seen = new Set<string>();
  records.forEach((record, index) => {
    const key = seed.key(record);
    if (!key || seen.has(key)) throw new Error(`duplicate or empty ${seed.collection} migration key: ${key}`);
    seen.add(key);
    insert.run(seed.collection, key, JSON.stringify(record), index, revision, seed.controllerActive?.(record) === false ? 0 : 1);
  });
}

/** Import one or more legacy collections in one durable first-boot transaction. */
export function initializeStateCollections(
  filename: string,
  seeds: readonly StateCollectionSeed<unknown>[],
  options: {
    reimportExisting?: boolean;
    afterCollectionImport?: (collection: string) => void;
  } = {},
): void {
  ensureFirstSqliteCutover(filename, seeds);
  const allowFencedExisting = !options.reimportExisting && collectionsAlreadyInitialized(filename, seeds);
  const db = openDatabase(filename);
  try {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      try {
        db.exec("BEGIN IMMEDIATE");
        assertSqliteInitializationAuthority(filename, allowFencedExisting);
        if (options.reimportExisting && !collectionMarkersMatch(db, seeds)) {
          const removeLease = db.query("DELETE FROM state_leases WHERE collection = ?");
          const removeCollection = db.query("DELETE FROM state_collections WHERE collection = ?");
          for (const seed of seeds) {
            removeLease.run(seed.collection);
            removeCollection.run(seed.collection);
          }
        }
        for (const seed of seeds) {
          const current = db.query<{ schema_version: number; migration_id: string }, [string]>(
            "SELECT schema_version, migration_id FROM state_collections WHERE collection = ?",
          ).get(seed.collection);
          if (current) {
            if (current.schema_version !== seed.schemaVersion) {
              throw new Error(`unsupported ${seed.collection} SQLite schema: ${current.schema_version}`);
            }
            if (current.migration_id !== seed.migrationId) {
              throw new Error(`unsupported ${seed.collection} SQLite migration: ${current.migration_id}`);
            }
            continue;
          }
          insertSeed(db, seed);
          options.afterCollectionImport?.(seed.collection);
        }
        assertSqliteInitializationAuthority(filename, allowFencedExisting);
        db.exec("COMMIT");
        secureDatabaseFiles(filename);
        return;
      } catch (error) {
        rollbackQuietly(db);
        if (!isBusyError(error)) throw error;
        Atomics.wait(SYNC_SLEEP, 0, 0, LOCK_WAIT_MS);
      }
    }
    throw new FileTransactionBusyError("state migration is busy");
  } finally {
    db.close();
  }
}

/** A cheap invalidation signature that also observes uncheckpointed WAL writes. */
export function stateDatabaseSignature(filename: string): string {
  const parts = [filename];
  for (const candidate of [filename, `${filename}-wal`]) {
    try {
      const stat = fs.statSync(candidate, { bigint: true });
      parts.push(`${path.basename(candidate)}:${stat.mtimeNs}:${stat.size}`);
    } catch {
      parts.push(`${path.basename(candidate)}:missing`);
    }
  }
  return parts.join("|");
}

/** Read raw authoritative rows for compatibility projections, with JSON fallback before migration. */
export function readStateCollectionRows(filename: string, collection: string): unknown[] | null {
  return readStateCollectionsRows(filename, [collection]).get(collection) ?? null;
}

/** Read several authoritative collections through one snapshot connection. */
export function readStateCollectionsRows(
  filename: string,
  collections: readonly string[],
): Map<string, unknown[] | null> {
  const result = new Map<string, unknown[] | null>(collections.map((collection) => [collection, null]));
  if (!fs.existsSync(filename) || collections.length === 0) return result;
  const db = connectReadonlyDatabase(filename);
  try {
    const placeholders = collections.map(() => "?").join(", ");
    const rows = db.query<{
      collection: string;
      row_key: string | null;
      value_json: string | null;
    }, SQLQueryBindings[]>(`
      SELECT collections.collection, rows.row_key, rows.value_json
      FROM state_collections AS collections
      LEFT JOIN state_rows AS rows ON rows.collection = collections.collection
      WHERE collections.collection IN (${placeholders})
      ORDER BY collections.collection, rows.row_order, rows.row_key
    `).all(...collections as SQLQueryBindings[]);
    for (const row of rows) {
      const records = result.get(row.collection) ?? [];
      result.set(row.collection, records);
      if (row.row_key === null || row.value_json === null) continue;
      try { records.push(JSON.parse(row.value_json) as unknown); }
      catch (error) {
        throw new Error(`corrupt ${row.collection} SQLite row: ${row.row_key}`, { cause: error });
      }
    }
    return result;
  } catch (error) {
    if (/no such table/i.test(error instanceof Error ? error.message : String(error))) return result;
    throw error;
  } finally {
    db.close();
  }
}

/** Authoritative revision for cache keys, or null until this collection migrates. */
export function readStateCollectionRevision(filename: string, collection: string): number | null {
  return readStateCollectionRevisions(filename, [collection]).get(collection) ?? null;
}

/** Read several collection revisions through one read-only connection. */
export function readStateCollectionRevisions(
  filename: string,
  collections: readonly string[],
): Map<string, number | null> {
  const revisions = new Map<string, number | null>(collections.map((collection) => [collection, null]));
  if (!fs.existsSync(filename)) return revisions;
  const db = connectReadonlyDatabase(filename);
  try {
    if (collections.length === 0) return revisions;
    const placeholders = collections.map(() => "?").join(", ");
    const rows = db.query<{ collection: string; revision: number }, SQLQueryBindings[]>(`
      SELECT collection, revision FROM state_collections
      WHERE collection IN (${placeholders})
    `).all(...collections as SQLQueryBindings[]);
    for (const row of rows) revisions.set(row.collection, row.revision);
    return revisions;
  } catch (error) {
    if (/no such table/i.test(error instanceof Error ? error.message : String(error))) return revisions;
    throw error;
  } finally {
    db.close();
  }
}

export function resetStateReadonlyConnectionCountForTests(): void {
  readonlyConnectionCount = 0;
}

export function stateReadonlyConnectionCountForTests(): number {
  return readonlyConnectionCount;
}

export class SqliteStateCollection<T> {
  private readonly readDb: Database;
  private cache: CollectionCache<T> | null = null;
  private revisionCache: { signature: string; revision: number } | null = null;

  constructor(readonly filename: string, private readonly options: SqliteStateCollectionOptions<T>) {
    this.readDb = openDatabase(filename);
    const meta = this.collectionMeta();
    if (!meta) throw new Error(`SQLite state collection is not initialized: ${options.collection}`);
    if (meta.schema_version !== options.schemaVersion) {
      throw new Error(`unsupported ${options.collection} SQLite schema: ${meta.schema_version}`);
    }
  }

  revision(): number {
    const signature = stateDatabaseSignature(this.filename);
    if (this.revisionCache?.signature === signature) return this.revisionCache.revision;
    const revision = this.collectionMeta()?.revision ?? 0;
    const after = stateDatabaseSignature(this.filename);
    if (after === signature) this.revisionCache = { signature: after, revision };
    return revision;
  }

  signature(): string {
    return `${this.filename}:${this.options.collection}:${this.revision()}`;
  }

  snapshot(): T[] {
    return this.loadReadonly().map(this.options.clone);
  }

  snapshotForController(): T[] {
    return this.loadControllerReadonly().map(this.options.clone);
  }

  get(rowKey: string): T | null {
    const row = this.readDb.query<Pick<CollectionRow, "value_json">, [string, string]>(
      "SELECT value_json FROM state_rows WHERE collection = ? AND row_key = ?",
    ).get(this.options.collection, rowKey);
    if (!row) return null;
    const decoded = this.decodeRow(row.value_json);
    return decoded === null ? null : this.options.clone(decoded);
  }

  loadReadonly(): readonly T[] {
    this.readDb.exec("BEGIN");
    try {
      const meta = this.collectionMeta();
      if (!meta) throw new Error(`SQLite state collection disappeared: ${this.options.collection}`);
      const revision = meta.revision;
      if (this.cache?.revision === revision) {
        this.readDb.exec("COMMIT");
        return this.cache.ordered;
      }
      if (!this.cache || this.cache.revision > revision || this.cache.revision < meta.change_floor) {
        const full = this.loadFull(revision);
        this.readDb.exec("COMMIT");
        return full;
      }

      const changes = this.readDb.query<{ row_key: string }, [string, number, number]>(`
        SELECT DISTINCT row_key FROM state_changes
        WHERE collection = ? AND revision > ? AND revision <= ?
        ORDER BY revision, row_key
      `).all(this.options.collection, this.cache.revision, revision);
      if (changes.length === 0) {
        const full = this.loadFull(revision);
        this.readDb.exec("COMMIT");
        return full;
      }
      this.options.onIncrementalReadSnapshot?.(revision);

      const changedKeys = [...new Set(changes.map((change) => change.row_key))];
      const rows = new Map<string, CollectionRow>();
      for (let start = 0; start < changedKeys.length; start += CHANGE_READ_CHUNK) {
        const chunk = changedKeys.slice(start, start + CHANGE_READ_CHUNK);
        const placeholders = chunk.map(() => "?").join(", ");
        const bindings = [this.options.collection, ...chunk] as SQLQueryBindings[];
        for (const row of this.readDb.query<CollectionRow, SQLQueryBindings[]>(`
          SELECT row_key, value_json, row_order, row_revision, controller_active
          FROM state_rows WHERE collection = ? AND row_key IN (${placeholders})
        `).all(...bindings)) rows.set(row.row_key, row);
      }
      const next = new Map(this.cache.records);
      let orderChanged = false;
      for (const key of changedKeys) {
        const row = rows.get(key);
        if (!row) {
          if (next.has(key)) orderChanged = true;
          next.delete(key);
          continue;
        }
        const held = next.get(key);
        if (!held || held.order !== row.row_order) orderChanged = true;
        if (held?.valueJson === row.value_json) {
          next.set(key, { ...held, order: row.row_order, rowRevision: row.row_revision });
          continue;
        }
        const decoded = this.decodeRow(row.value_json);
        if (decoded === null) next.delete(key);
        else next.set(key, {
          valueJson: row.value_json,
          value: decoded,
          order: row.row_order,
          rowRevision: row.row_revision,
        });
      }
      const ordered = orderChanged
        ? this.rememberCache(revision, next)
        : this.rememberCacheWithOrder(revision, next, this.cache.orderedKeys);
      this.readDb.exec("COMMIT");
      return ordered;
    } catch (error) {
      rollbackQuietly(this.readDb);
      throw error;
    }
  }

  /** Move selected rows to another collection in one SQLite commit. */
  moveMatchingTo(
    target: SqliteStateCollection<T>,
    predicate: (record: T) => boolean,
    options: { beforeCommit?: () => void } = {},
  ): number {
    if (target === this || target.filename !== this.filename) {
      throw new Error("atomic state moves require two collections in one database");
    }
    assertSqliteWriteAuthority(this.filename);
    const ordered = [this, target].sort((left, right) => left.options.collection.localeCompare(right.options.collection));
    const leases = new Map<SqliteStateCollection<T>, string>();
    try {
      for (const collection of ordered) leases.set(collection, collection.acquireLeaseSync());
      const db = connectDatabase(this.filename);
      try {
        const moved = withImmediateTransaction(db, this.options.busyMessage, () => {
          assertSqliteWriteAuthority(this.filename);
          this.assertLease(db, leases.get(this)!);
          target.assertLease(db, leases.get(target)!);
          const sourceRows = db.query<CollectionRow, [string]>(`
            SELECT row_key, value_json, row_order, row_revision, controller_active
            FROM state_rows WHERE collection = ? ORDER BY row_order, row_key
          `).all(this.options.collection);
          const selected = sourceRows.flatMap((row) => {
            const decoded = this.decodeRow(row.value_json);
            return decoded !== null && predicate(decoded) ? [{ row, record: decoded }] : [];
          });
          if (selected.length === 0) return 0;
          for (const entry of selected) target.validate(entry.record);

          const sourceRevision = this.collectionMeta(db)!.revision + 1;
          const targetMeta = target.collectionMeta(db)!;
          const targetRows = new Map(db.query<CollectionRow, [string]>(`
            SELECT row_key, value_json, row_order, row_revision, controller_active
            FROM state_rows WHERE collection = ?
          `).all(target.options.collection).map((row) => [row.row_key, row] as const));
          let targetOrder = Math.max(-1, ...[...targetRows.values()].map((row) => row.row_order)) + 1;
          const targetPrepared = selected.map(({ record }) => {
            const key = target.options.key(record);
            const valueJson = JSON.stringify(record);
            const controllerActive = target.options.controllerActive?.(record) === false ? 0 : 1;
            const held = targetRows.get(key);
            return { key, valueJson, controllerActive, held, order: held?.row_order ?? targetOrder++ };
          });
          const targetChanged = targetPrepared.filter((entry) => (
            entry.held?.value_json !== entry.valueJson
            || entry.held.controller_active !== entry.controllerActive
          ));
          const targetRevision = targetChanged.length > 0 ? targetMeta.revision + 1 : targetMeta.revision;
          const upsert = db.query(`
            INSERT INTO state_rows(collection, row_key, value_json, row_order, row_revision, controller_active)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(collection, row_key) DO UPDATE SET
              value_json = excluded.value_json,
              row_revision = excluded.row_revision,
              controller_active = excluded.controller_active
          `);
          const change = db.query(`
            INSERT INTO state_changes(collection, revision, row_key, operation)
            VALUES (?, ?, ?, ?)
          `);
          for (const entry of targetChanged) {
            upsert.run(target.options.collection, entry.key, entry.valueJson, entry.order, targetRevision, entry.controllerActive);
            change.run(target.options.collection, targetRevision, entry.key, "upsert");
          }
          const remove = db.query("DELETE FROM state_rows WHERE collection = ? AND row_key = ?");
          for (const { row } of selected) {
            remove.run(this.options.collection, row.row_key);
            change.run(this.options.collection, sourceRevision, row.row_key, "delete");
          }
          db.query("UPDATE state_collections SET revision = ? WHERE collection = ?")
            .run(sourceRevision, this.options.collection);
          if (targetChanged.length > 0) {
            db.query("UPDATE state_collections SET revision = ? WHERE collection = ?")
              .run(targetRevision, target.options.collection);
          }
          this.pruneChanges(db, sourceRevision);
          if (targetChanged.length > 0) target.pruneChanges(db, targetRevision);
          options.beforeCommit?.();
          return selected.length;
        });
        if (moved > 0) {
          secureDatabaseFiles(this.filename);
          this.invalidateAfterCommit();
          target.invalidateAfterCommit();
        }
        return moved;
      } finally {
        db.close();
      }
    } finally {
      for (const collection of [...ordered].reverse()) {
        const lease = leases.get(collection);
        if (lease) collection.releaseLeaseSync(lease);
      }
    }
  }

  replaceSync(records: readonly T[], options: {
    mergeOmitted?: boolean;
    deleteKeys?: readonly string[];
    beforePersist?: (records: readonly T[]) => void;
  } = {}): void {
    assertSqliteWriteAuthority(this.filename);
    const lease = this.acquireLeaseSync();
    try {
      options.beforePersist?.(records);
      this.persistReplacement(lease, records, options.mergeOmitted === true, options.deleteKeys ?? []);
    } finally {
      this.releaseLeaseSync(lease);
    }
  }

  patchSync(prepare: () => { records: readonly T[]; deleteKeys?: readonly string[] }): void {
    assertSqliteWriteAuthority(this.filename);
    const lease = this.acquireLeaseSync();
    try {
      const patch = prepare();
      this.persistReplacement(lease, patch.records, true, patch.deleteKeys ?? []);
    } finally {
      this.releaseLeaseSync(lease);
    }
  }

  withSnapshotSync<R>(read: (records: readonly T[]) => R): R {
    const lease = this.acquireLeaseSync();
    try {
      return read(this.snapshot());
    } finally {
      this.releaseLeaseSync(lease);
    }
  }

  async mutate<R>(
    operation: (records: T[], persist: (records?: readonly T[]) => void) => Promise<R> | R,
    beforePersist?: (context: StateMutationContext<T>) => void,
    controllerOnly = false,
  ): Promise<R> {
    assertSqliteWriteAuthority(this.filename);
    const lease = await this.acquireLease();
    try {
      const source = controllerOnly ? this.loadControllerReadonly() : this.loadReadonly();
      const session = this.track(source);
      return await operation(session.records, (records) => {
        this.persistSession(lease, session, beforePersist, records);
      });
    } finally {
      await this.releaseLease(lease);
    }
  }

  checkpointMirror(write: (records: readonly T[], revision: number) => void): void {
    const lease = this.acquireLeaseSync();
    try {
      const records = this.snapshot();
      write(records, this.revision());
    } finally {
      this.releaseLeaseSync(lease);
    }
  }

  checkpointMirrorForDemotion(write: (records: readonly T[], revision: number) => void, maxAttempts = 2): number {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let checkpointRevision = -1;
      this.checkpointMirror((records, revision) => {
        checkpointRevision = revision;
        write(records, revision);
      });
      if (this.revision() === checkpointRevision) return checkpointRevision;
    }
    throw new Error(`${this.options.collection} rollback checkpoint did not converge`);
  }

  private collectionMeta(db = this.readDb): CollectionMeta | null {
    return db.query<CollectionMeta, [string]>(
      "SELECT revision, schema_version, change_floor FROM state_collections WHERE collection = ?",
    ).get(this.options.collection) ?? null;
  }

  private decodeRow(valueJson: string): T | null {
    try {
      const decoded = this.options.decode(JSON.parse(valueJson) as unknown);
      if (decoded === null && this.options.strictDecode) {
        throw new Error(`${this.options.collection} SQLite row is malformed`);
      }
      return decoded;
    } catch (error) {
      if (this.options.strictDecode) {
        throw this.options.decodeError?.(error) ?? error;
      }
      this.options.onDecodeError?.(error);
      return null;
    }
  }

  private loadControllerReadonly(): readonly T[] {
    return this.readDb.query<Pick<CollectionRow, "value_json">, [string]>(`
      SELECT value_json FROM state_rows
      WHERE collection = ? AND controller_active = 1
      ORDER BY row_order, row_key
    `).all(this.options.collection).flatMap((row) => {
      const decoded = this.decodeRow(row.value_json);
      return decoded === null ? [] : [decoded];
    });
  }

  private loadFull(revision: number): readonly T[] {
    const records = new Map<string, CachedRecord<T>>();
    for (const row of this.readDb.query<CollectionRow, [string]>(`
      SELECT row_key, value_json, row_order, row_revision
      FROM state_rows WHERE collection = ? ORDER BY row_order, row_key
    `).all(this.options.collection)) {
      const decoded = this.decodeRow(row.value_json);
      if (decoded === null) continue;
      records.set(row.row_key, {
        valueJson: row.value_json,
        value: decoded,
        order: row.row_order,
        rowRevision: row.row_revision,
      });
    }
    return this.rememberCache(revision, records);
  }

  private rememberCache(revision: number, records: Map<string, CachedRecord<T>>): readonly T[] {
    const entries = [...records.entries()]
      .sort((left, right) => left[1].order - right[1].order || left[0].localeCompare(right[0]));
    const orderedKeys = entries.map((entry) => entry[0]);
    const ordered = entries.map((entry) => entry[1].value);
    this.cache = { revision, records, orderedKeys, ordered };
    this.revisionCache = null;
    return ordered;
  }

  private rememberCacheWithOrder(
    revision: number,
    records: Map<string, CachedRecord<T>>,
    orderedKeys: readonly string[],
  ): readonly T[] {
    const ordered = orderedKeys.flatMap((key) => {
      const held = records.get(key);
      return held ? [held.value] : [];
    });
    this.cache = { revision, records, orderedKeys, ordered };
    this.revisionCache = null;
    return ordered;
  }

  private invalidateAfterCommit(): void {
    this.revisionCache = null;
  }

  private track(records: readonly T[]): MutationSession<T> {
    const materialized = new Map<number, TrackedRoot<T>>();
    const tracked = [...records];
    const session: MutationSession<T> = { records: [], rawRecords: tracked, materialized, structural: false };
    const indexOf = (property: string | symbol): number | null => {
      if (typeof property !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(property)) return null;
      const index = Number(property);
      return Number.isSafeInteger(index) ? index : null;
    };
    session.records = new Proxy(tracked, {
      get: (target, property, receiver) => {
        const index = indexOf(property);
        if (index === null || index >= target.length) return Reflect.get(target, property, receiver);
        if (!materialized.has(index)) {
          const cloned = this.options.clone(target[index]!);
          target[index] = cloned;
          materialized.set(index, {
            originalKey: this.options.key(cloned),
            persistedJson: JSON.stringify(cloned),
            value: cloned,
          });
        }
        return target[index];
      },
      set: (target, property, value) => {
        session.structural = true;
        const index = indexOf(property);
        if (index !== null) materialized.delete(index);
        return Reflect.set(target, property, value);
      },
      deleteProperty: (target, property) => {
        session.structural = true;
        const index = indexOf(property);
        if (index !== null) materialized.delete(index);
        return Reflect.deleteProperty(target, property);
      },
      defineProperty: (target, property, descriptor) => {
        session.structural = true;
        const index = indexOf(property);
        if (index !== null) materialized.delete(index);
        return Reflect.defineProperty(target, property, descriptor);
      },
    });
    return session;
  }

  private persistSession(
    ownerToken: string,
    session: MutationSession<T>,
    beforePersist?: (context: StateMutationContext<T>) => void,
    explicitRecords?: readonly T[],
  ): void {
    if (explicitRecords) {
      if (explicitRecords.length === 0) return;
      beforePersist?.({ records: session.records, dirtyRecords: explicitRecords, structural: false });
      this.persistChangedRows(ownerToken, explicitRecords);
      const explicitKeys = new Set(explicitRecords.map((record) => this.options.key(record)));
      for (const tracked of session.materialized.values()) {
        const currentKey = this.options.key(tracked.value);
        if (explicitKeys.has(currentKey)) {
          tracked.originalKey = currentKey;
          tracked.persistedJson = JSON.stringify(tracked.value);
        }
      }
      return;
    }
    const changed: T[] = [];
    if (session.structural) {
      for (const record of session.records) changed.push(record);
      beforePersist?.({ records: session.records, dirtyRecords: changed, structural: true });
      this.persistReplacement(ownerToken, changed, false);
      session.structural = false;
      session.materialized.clear();
      session.rawRecords.forEach((record, index) => session.materialized.set(index, {
        originalKey: this.options.key(record),
        persistedJson: JSON.stringify(record),
        value: record,
      }));
      return;
    }
    for (const tracked of session.materialized.values()) {
      const currentKey = this.options.key(tracked.value);
      if (currentKey !== tracked.originalKey) {
        session.structural = true;
        return this.persistSession(ownerToken, session, beforePersist);
      }
      if (JSON.stringify(tracked.value) !== tracked.persistedJson) changed.push(tracked.value);
    }
    if (changed.length === 0) return;
    beforePersist?.({ records: session.records, dirtyRecords: changed, structural: false });
    this.persistChangedRows(ownerToken, changed);
    for (const tracked of session.materialized.values()) {
      tracked.originalKey = this.options.key(tracked.value);
      tracked.persistedJson = JSON.stringify(tracked.value);
    }
  }

  private validate(record: T): void {
    const key = this.options.key(record);
    if (!key) throw new Error(`refusing to persist an empty ${this.options.collection} row key`);
    this.options.validate?.(record);
  }

  private persistChangedRows(ownerToken: string, records: readonly T[]): void {
    for (const record of records) this.validate(record);
    const db = connectDatabase(this.filename);
    try {
      const revision = withImmediateTransaction(db, this.options.busyMessage, () => {
        assertSqliteWriteAuthority(this.filename);
        this.assertLease(db, ownerToken);
        const meta = this.collectionMeta(db)!;
        const current = db.query<CollectionRow, [string, string]>(`
          SELECT row_key, value_json, row_order, row_revision, controller_active
          FROM state_rows WHERE collection = ? AND row_key = ?
        `);
        const prepared = records.map((record) => {
          const key = this.options.key(record);
          const valueJson = JSON.stringify(record);
          const controllerActive = this.options.controllerActive?.(record) === false ? 0 : 1;
          return { key, valueJson, controllerActive, row: current.get(this.options.collection, key) };
        });
        const actual = prepared.filter((entry) => (
          entry.row?.value_json !== entry.valueJson
          || entry.row.controller_active !== entry.controllerActive
        ));
        if (actual.length === 0) return null;
        const nextRevision = meta.revision + 1;
        const maxOrder = db.query<{ value: number }, [string]>(
          "SELECT COALESCE(MAX(row_order), -1) AS value FROM state_rows WHERE collection = ?",
        ).get(this.options.collection)?.value ?? -1;
        let appendOrder = maxOrder + 1;
        const upsert = db.query(`
          INSERT INTO state_rows(collection, row_key, value_json, row_order, row_revision, controller_active)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(collection, row_key) DO UPDATE SET
            value_json = excluded.value_json,
            row_revision = excluded.row_revision,
            controller_active = excluded.controller_active
        `);
        const change = db.query(`
          INSERT INTO state_changes(collection, revision, row_key, operation)
          VALUES (?, ?, ?, 'upsert')
        `);
        for (const entry of actual) {
          const order = entry.row?.row_order ?? appendOrder++;
          upsert.run(this.options.collection, entry.key, entry.valueJson, order, nextRevision, entry.controllerActive);
          change.run(this.options.collection, nextRevision, entry.key);
        }
        db.query("UPDATE state_collections SET revision = ? WHERE collection = ?")
          .run(nextRevision, this.options.collection);
        this.pruneChanges(db, nextRevision);
        return nextRevision;
      });
      if (revision !== null) {
        secureDatabaseFiles(this.filename);
        this.invalidateAfterCommit();
      }
    } finally {
      db.close();
    }
  }

  private persistReplacement(
    ownerToken: string,
    records: readonly T[],
    mergeOmitted: boolean,
    deleteKeys: readonly string[] = [],
  ): void {
    for (const record of records) this.validate(record);
    const seen = new Set<string>();
    for (const record of records) {
      const key = this.options.key(record);
      if (seen.has(key)) throw new Error(`duplicate ${this.options.collection} row key: ${key}`);
      seen.add(key);
    }
    const requestedDeletes = new Set(deleteKeys);
    if (requestedDeletes.size !== deleteKeys.length || [...requestedDeletes].some((key) => !key || seen.has(key))) {
      throw new Error(`invalid ${this.options.collection} row deletion`);
    }
    const db = connectDatabase(this.filename);
    try {
      const revision = withImmediateTransaction(db, this.options.busyMessage, () => {
        assertSqliteWriteAuthority(this.filename);
        this.assertLease(db, ownerToken);
        const meta = this.collectionMeta(db)!;
        const current = new Map(db.query<CollectionRow, [string]>(`
          SELECT row_key, value_json, row_order, row_revision, controller_active
          FROM state_rows WHERE collection = ?
        `).all(this.options.collection).map((row) => [row.row_key, row] as const));
        const encoded = records.map((record, index) => ({
          key: this.options.key(record),
          valueJson: JSON.stringify(record),
          order: index,
          controllerActive: this.options.controllerActive?.(record) === false ? 0 : 1,
        }));
        const changed = encoded.filter((entry) => {
          const held = current.get(entry.key);
          return !held
            || held.value_json !== entry.valueJson
            || held.controller_active !== entry.controllerActive
            || (!mergeOmitted && held.row_order !== entry.order);
        });
        const deleted = mergeOmitted
          ? [...requestedDeletes].filter((key) => current.has(key))
          : [...current.keys()].filter((key) => !seen.has(key));
        if (changed.length === 0 && deleted.length === 0) return null;
        const nextRevision = meta.revision + 1;
        const nextOrder = mergeOmitted
          ? (Math.max(-1, ...[...current.values()].map((row) => row.row_order)) + 1)
          : 0;
        let appended = nextOrder;
        const upsert = db.query(`
          INSERT INTO state_rows(collection, row_key, value_json, row_order, row_revision, controller_active)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(collection, row_key) DO UPDATE SET
            value_json = excluded.value_json,
            row_order = excluded.row_order,
            row_revision = excluded.row_revision,
            controller_active = excluded.controller_active
        `);
        const change = db.query(`
          INSERT INTO state_changes(collection, revision, row_key, operation)
          VALUES (?, ?, ?, ?)
        `);
        for (const entry of changed) {
          const held = current.get(entry.key);
          const order = mergeOmitted ? held?.row_order ?? appended++ : entry.order;
          upsert.run(this.options.collection, entry.key, entry.valueJson, order, nextRevision, entry.controllerActive);
          change.run(this.options.collection, nextRevision, entry.key, "upsert");
        }
        const remove = db.query("DELETE FROM state_rows WHERE collection = ? AND row_key = ?");
        for (const key of deleted) {
          remove.run(this.options.collection, key);
          change.run(this.options.collection, nextRevision, key, "delete");
        }
        db.query("UPDATE state_collections SET revision = ? WHERE collection = ?")
          .run(nextRevision, this.options.collection);
        this.pruneChanges(db, nextRevision);
        return nextRevision;
      });
      if (revision !== null) {
        secureDatabaseFiles(this.filename);
        this.invalidateAfterCommit();
      }
    } finally {
      db.close();
    }
  }

  private assertLease(db: Database, ownerToken: string): void {
    const lease = db.query<Pick<LeaseRow, "owner_token">, [string]>(
      "SELECT owner_token FROM state_leases WHERE collection = ?",
    ).get(this.options.collection);
    if (lease?.owner_token !== ownerToken) throw new FileTransactionBusyError(this.options.busyMessage);
  }

  private pruneChanges(db: Database, revision: number): void {
    const cutoff = revision - CHANGE_RETENTION_REVISIONS;
    if (cutoff <= 0) return;
    db.query(`
      DELETE FROM state_changes WHERE rowid IN (
        SELECT rowid FROM state_changes
        WHERE collection = ? AND revision <= ?
        ORDER BY revision, row_key LIMIT ?
      )
    `).run(this.options.collection, cutoff, CHANGE_PRUNE_BATCH);
    db.query(`
      UPDATE state_collections SET change_floor = MAX(change_floor, ?)
      WHERE collection = ?
    `).run(cutoff, this.options.collection);
  }

  private tryAcquireLease(db: Database, ownerToken: string): boolean {
    try {
      db.exec("BEGIN IMMEDIATE");
      const held = db.query<LeaseRow, [string]>(`
        SELECT owner_token, owner_pid, owner_start_identity
        FROM state_leases WHERE collection = ?
      `).get(this.options.collection);
      if (held && !leaseIsStale(held)) {
        db.exec("ROLLBACK");
        return false;
      }
      if (held) db.query("DELETE FROM state_leases WHERE collection = ?").run(this.options.collection);
      db.query(`
        INSERT INTO state_leases(collection, owner_token, owner_pid, owner_start_identity, acquired_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(this.options.collection, ownerToken, process.pid, procBackend.processIdentity(process.pid), Date.now());
      db.exec("COMMIT");
      return true;
    } catch (error) {
      rollbackQuietly(db);
      if (isBusyError(error)) return false;
      throw error;
    }
  }

  private acquireLeaseSync(): string {
    const db = connectDatabase(this.filename);
    const ownerToken = crypto.randomUUID();
    try {
      for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
        if (this.tryAcquireLease(db, ownerToken)) return ownerToken;
        Atomics.wait(SYNC_SLEEP, 0, 0, LOCK_WAIT_MS);
      }
      throw new FileTransactionBusyError(this.options.busyMessage);
    } finally {
      db.close();
    }
  }

  private async acquireLease(): Promise<string> {
    const db = connectDatabase(this.filename);
    const ownerToken = crypto.randomUUID();
    try {
      for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
        if (this.tryAcquireLease(db, ownerToken)) return ownerToken;
        await new Promise<void>((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
      }
      throw new FileTransactionBusyError(this.options.busyMessage);
    } finally {
      db.close();
    }
  }

  private releaseLeaseSync(ownerToken: string): void {
    const db = connectDatabase(this.filename);
    try {
      for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
        try {
          db.exec("BEGIN IMMEDIATE");
          db.query("DELETE FROM state_leases WHERE collection = ? AND owner_token = ?")
            .run(this.options.collection, ownerToken);
          db.exec("COMMIT");
          return;
        } catch (error) {
          rollbackQuietly(db);
          if (!isBusyError(error)) throw error;
          Atomics.wait(SYNC_SLEEP, 0, 0, LOCK_WAIT_MS);
        }
      }
      throw new FileTransactionBusyError(this.options.busyMessage);
    } finally {
      db.close();
    }
  }

  private async releaseLease(ownerToken: string): Promise<void> {
    const db = connectDatabase(this.filename);
    try {
      for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
        try {
          db.exec("BEGIN IMMEDIATE");
          db.query("DELETE FROM state_leases WHERE collection = ? AND owner_token = ?")
            .run(this.options.collection, ownerToken);
          db.exec("COMMIT");
          return;
        } catch (error) {
          rollbackQuietly(db);
          if (!isBusyError(error)) throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
        }
      }
      throw new FileTransactionBusyError(this.options.busyMessage);
    } finally {
      db.close();
    }
  }
}
