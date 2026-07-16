import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { Database as BunDatabase } from "bun:sqlite";

import type { RegistryFile } from "./registry";

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
] as const satisfies ReadonlyArray<keyof RegistryFile>;

const META_FIELDS = [
  "importedResumePanes",
  "legacyResumePanes",
  "conversationRevision",
  "engineRouting",
  "autoBalance",
  "quotaObservations",
] as const satisfies ReadonlyArray<keyof RegistryFile>;

type RowCollection = (typeof ROW_COLLECTIONS)[number];
type StoredRow = { collection: string; row_key: string; value_json: string; row_order: number };
type MetaRow = { key: string; value: string };

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
  onWriterWait?(durationMs: number): void;
}

interface LazyRegistrySnapshot extends SqliteRegistrySnapshot {
  changes(): RegistryChanges;
}

export class SqliteAgentRegistryStore {
  private readonly db: BunDatabase;
  private readonly normalize: (value: unknown) => RegistryFile;
  private readonly onWriterWait: ((durationMs: number) => void) | undefined;

  constructor(readonly filename: string, options: SqliteRegistryStoreOptions) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
    if (!sqlite) throw new Error("SQLite registry modes require the Bun runtime");
    const { Database } = sqlite;
    this.db = new Database(filename, { create: true, strict: true });
    this.normalize = options.normalize;
    this.onWriterWait = options.onWriterWait;
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
    this.secureFiles();
    this.importFirstBoot(options.initialSnapshot);
  }

  snapshot(): SqliteRegistrySnapshot {
    this.db.exec("BEGIN");
    try {
      const snapshot = this.loadInTransaction();
      this.db.exec("COMMIT");
      return snapshot;
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
      try {
        this.onWriterWait?.(performance.now() - waitStartedAt);
        if (Number(this.meta("revision") ?? 0) !== current.revision) {
          this.db.exec("ROLLBACK");
          continue;
        }
        revision = current.revision + 1;
        this.persistChanges(current.file, changes, revision);
        this.db.exec("COMMIT");
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
        throw error;
      }
      this.secureFiles();
      if (includeSnapshot) {
        const committed = this.snapshot();
        return { result, file: committed.file, revision: committed.revision };
      }
      return { result, file: null, revision };
    }
  }

  replace(file: RegistryFile, expectedRevision?: number): SqliteRegistryReplacement {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.loadInTransaction();
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        this.db.exec("ROLLBACK");
        return { ...current, replaced: false };
      }
      const revision = current.revision + 1;
      this.persistDiff(current.file, file, revision);
      this.db.exec("COMMIT");
      this.secureFiles();
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
        this.persistAll(initialSnapshot, 1);
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

  private loadInTransaction(): SqliteRegistrySnapshot {
    const snapshot = this.loadLazyInTransaction();
    for (const collection of ROW_COLLECTIONS) void snapshot.file[collection];
    for (const field of META_FIELDS) void snapshot.file[field];
    return snapshot;
  }

  private loadLazyInTransaction(): LazyRegistrySnapshot {
    const file = this.normalize({ version: 2, entries: {}, receipts: {} });
    const loadedCollections = new Map<RowCollection, RegistryFile[RowCollection]>();
    const baselineCollections = new Map<RowCollection, RegistryFile[RowCollection]>();
    const reorderedCollections = new Set<RowCollection>();
    for (const collection of ROW_COLLECTIONS) {
      let loaded = false;
      let value = file[collection];
      const load = () => {
        if (loaded) return;
        const storedValue = {} as typeof value;
        for (const row of this.db.query<StoredRow, [string]>(
          "SELECT collection, row_key, value_json, row_order FROM registry_rows WHERE collection = ? ORDER BY row_order",
        ).all(collection)) {
          (storedValue as Record<string, unknown>)[row.row_key] = JSON.parse(row.value_json);
        }
        const input: Record<string, unknown> = { version: 2, entries: {}, receipts: {} };
        input[collection] = storedValue;
        if (collection === "deliveryOperationOwners") input.heldDeliveries = file.heldDeliveries;
        value = this.normalize(input)[collection] as typeof value;
        loaded = true;
        loadedCollections.set(collection, value);
        baselineCollections.set(collection, structuredClone(
          collection === "deliveryOperationOwners" ? storedValue : value,
        ) as typeof value);
      };
      Object.defineProperty(file, collection, {
        configurable: true,
        enumerable: true,
        get: () => {
          load();
          return value;
        },
        set: (next: typeof value) => {
          load();
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
          const baseline = baselineCollections.get(collection)! as Record<string, unknown>;
          const current = value as Record<string, unknown>;
          const keys = new Set([...Object.keys(baseline), ...Object.keys(current)]);
          const changed = new Set([...keys].filter((key) => !isDeepStrictEqual(baseline[key], current[key])));
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

  private persistAll(file: RegistryFile, revision: number): void {
    this.db.exec("DELETE FROM registry_rows");
    for (const collection of ROW_COLLECTIONS) {
      for (const [order, [key, value]] of Object.entries(file[collection]).entries()) {
        this.upsertRow(collection, key, value, order);
      }
    }
    for (const field of META_FIELDS) this.setMeta(field, JSON.stringify(file[field]));
    this.setMeta("revision", String(revision));
  }

  private persistDiff(before: RegistryFile, after: RegistryFile, revision: number): void {
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

  private persistChanges(file: RegistryFile, changes: RegistryChanges, revision: number): void {
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
}
