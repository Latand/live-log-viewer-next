import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import { HandoffQueue, type HandoffQueueStore, type HandoffRow } from "./handoffQueue";

/**
 * SQLite-backed durable store for the blue-green handoff queue (issue #253).
 *
 * The queue must survive the same container replace it exists to protect, so it
 * is persisted with WAL journaling and FULL synchronous durability like the
 * agent registry. Rows are written in a single transaction so a crash mid-save
 * never leaves a partially-written generation fence.
 */
export class SqliteHandoffQueueStore implements HandoffQueueStore {
  private readonly db: import("bun:sqlite").Database;

  constructor(readonly filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
    if (!sqlite) throw new Error("SQLite handoff queue requires the Bun runtime");
    this.db = new sqlite.Database(filename, { create: true, strict: true });
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS handoff_rows (
        operation_id TEXT PRIMARY KEY,
        row_order INTEGER NOT NULL,
        value_json TEXT NOT NULL
      );
    `);
    try { fs.chmodSync(filename, 0o600); } catch { /* best effort */ }
  }

  load(): HandoffRow[] {
    const rows = this.db
      .query<{ value_json: string }, []>("SELECT value_json FROM handoff_rows ORDER BY row_order ASC")
      .all();
    return rows.map((row) => JSON.parse(row.value_json) as HandoffRow);
  }

  save(rows: readonly HandoffRow[]): void {
    const insert = this.db.query<unknown, [string, number, string]>(
      "INSERT INTO handoff_rows(operation_id, row_order, value_json) VALUES (?, ?, ?)",
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM handoff_rows");
      rows.forEach((row, index) => insert.run(row.operationId, index, JSON.stringify(row)));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

let queue: HandoffQueue | null = null;

/** Process-wide durable handoff queue backed by SQLite state. */
export function handoffQueue(): HandoffQueue {
  queue ??= new HandoffQueue(new SqliteHandoffQueueStore(statePath("handoff-queue.sqlite")));
  return queue;
}

export function setHandoffQueueForTests(value: HandoffQueue | null): void {
  queue = value;
}
