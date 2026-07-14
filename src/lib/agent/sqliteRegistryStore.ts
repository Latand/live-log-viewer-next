import fs from "node:fs";
import path from "node:path";

import { Database } from "bun:sqlite";

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
type StoredRow = { collection: string; row_key: string; value_json: string };
type MetaRow = { key: string; value: string };

interface RegistryChanges {
  rows: Map<RowCollection, Set<string>>;
  meta: Set<(typeof META_FIELDS)[number]>;
}

function trackedRegistry(file: RegistryFile): { file: RegistryFile; changes: RegistryChanges } {
  const changes: RegistryChanges = { rows: new Map(), meta: new Set() };
  const proxies = new WeakMap<object, object>();
  const rowCollections = new Set<string>(ROW_COLLECTIONS);
  const metaFields = new Set<string>(META_FIELDS);
  const markRow = (collection: RowCollection, key: PropertyKey) => {
    if (typeof key !== "string") return;
    let keys = changes.rows.get(collection);
    if (!keys) {
      keys = new Set();
      changes.rows.set(collection, keys);
    }
    keys.add(key);
  };
  const wrap = (value: unknown, path: string[]): unknown => {
    if (!value || typeof value !== "object") return value;
    const cached = proxies.get(value);
    if (cached) return cached;
    const proxy = new Proxy(value, {
      get(target, property, receiver) {
        return wrap(Reflect.get(target, property, receiver), [...path, String(property)]);
      },
      set(target, property, next, receiver) {
        const root = path[0] ?? String(property);
        if (rowCollections.has(root)) {
          if (path.length === 0) {
            const previousRows = Reflect.get(target, property, receiver) as Record<string, unknown> | undefined;
            for (const key of Object.keys(previousRows ?? {})) markRow(root as RowCollection, key);
            if (next && typeof next === "object") {
              for (const key of Object.keys(next as object)) markRow(root as RowCollection, key);
            }
          } else {
            markRow(root as RowCollection, path.length === 1 ? property : path[1]!);
          }
        } else if (metaFields.has(root)) {
          changes.meta.add(root as (typeof META_FIELDS)[number]);
        }
        return Reflect.set(target, property, next, receiver);
      },
      deleteProperty(target, property) {
        const root = path[0] ?? String(property);
        if (rowCollections.has(root)) {
          if (path.length === 0) {
            const previousRows = Reflect.get(target, property) as Record<string, unknown> | undefined;
            for (const key of Object.keys(previousRows ?? {})) markRow(root as RowCollection, key);
          } else {
            markRow(root as RowCollection, path.length === 1 ? property : path[1]!);
          }
        } else if (metaFields.has(root)) {
          changes.meta.add(root as (typeof META_FIELDS)[number]);
        }
        return Reflect.deleteProperty(target, property);
      },
    });
    proxies.set(value, proxy);
    return proxy;
  };
  return { file: wrap(file, []) as RegistryFile, changes };
}

export interface SqliteRegistrySnapshot {
  file: RegistryFile;
  revision: number;
}

export interface SqliteRegistryMutation<T> extends SqliteRegistrySnapshot {
  result: T;
}

export interface SqliteRegistryStoreOptions {
  initialSnapshot: RegistryFile;
  normalize(value: unknown): RegistryFile;
}

export class SqliteAgentRegistryStore {
  private readonly db: Database;
  private readonly normalize: (value: unknown) => RegistryFile;

  constructor(readonly filename: string, options: SqliteRegistryStoreOptions) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new Database(filename, { create: true, strict: true });
    this.normalize = options.normalize;
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
        PRIMARY KEY(collection, row_key)
      );
    `);
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

  mutate<T>(operation: (file: RegistryFile) => T): SqliteRegistryMutation<T> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.loadInTransaction();
      const tracked = trackedRegistry(current.file);
      const result = operation(tracked.file);
      const revision = current.revision + 1;
      this.persistChanges(current.file, tracked.changes, revision);
      this.db.exec("COMMIT");
      this.secureFiles();
      return { result, file: current.file, revision };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  replace(file: RegistryFile): SqliteRegistrySnapshot {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.loadInTransaction();
      const revision = current.revision + 1;
      this.persistDiff(current.file, file, revision);
      this.db.exec("COMMIT");
      this.secureFiles();
      return { file, revision };
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
        this.setMeta("schema_version", "1");
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
    const raw: Record<string, unknown> = { version: 2, entries: {}, receipts: {} };
    for (const collection of ROW_COLLECTIONS) raw[collection] = {};
    for (const row of this.db.query<StoredRow, []>("SELECT collection, row_key, value_json FROM registry_rows").all()) {
      if (!ROW_COLLECTIONS.includes(row.collection as RowCollection)) continue;
      (raw[row.collection] as Record<string, unknown>)[row.row_key] = JSON.parse(row.value_json);
    }
    for (const field of META_FIELDS) {
      const value = this.meta(field);
      if (value !== null) raw[field] = JSON.parse(value);
    }
    return {
      file: this.normalize(raw),
      revision: Number(this.meta("revision") ?? 0),
    };
  }

  private persistAll(file: RegistryFile, revision: number): void {
    this.db.exec("DELETE FROM registry_rows");
    for (const collection of ROW_COLLECTIONS) {
      for (const [key, value] of Object.entries(file[collection])) this.upsertRow(collection, key, value);
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
        if (key in previous && JSON.stringify(previous[key]) === JSON.stringify(next[key])) continue;
        this.upsertRow(collection, key, next[key]);
      }
    }
    for (const field of META_FIELDS) {
      if (JSON.stringify(before[field]) === JSON.stringify(after[field])) continue;
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
    for (const field of changes.meta) this.setMeta(field, JSON.stringify(file[field]));
    this.setMeta("revision", String(revision));
  }

  private upsertRow(collection: RowCollection, key: string, value: unknown): void {
    this.db.query(`
      INSERT INTO registry_rows(collection, row_key, value_json) VALUES (?, ?, ?)
      ON CONFLICT(collection, row_key) DO UPDATE SET value_json = excluded.value_json
    `).run(collection, key, JSON.stringify(value));
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
