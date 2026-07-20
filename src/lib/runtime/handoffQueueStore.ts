import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import {
  HandoffQueue,
  type HandoffQueueStore,
  type HandoffQueueStoreState,
  type HandoffRow,
} from "./handoffQueue";

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
        conversation_id TEXT,
        row_order INTEGER NOT NULL,
        value_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS handoff_history (
        operation_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        row_order INTEGER NOT NULL,
        value_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS handoff_draining_generations (
        generation TEXT PRIMARY KEY,
        row_order INTEGER NOT NULL
      );
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(handoff_rows)").all();
      if (!columns.some((column) => column.name === "conversation_id")) {
        this.db.exec("ALTER TABLE handoff_rows ADD COLUMN conversation_id TEXT");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.migrateActiveRows();
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS handoff_one_active_conversation
      ON handoff_rows(conversation_id)
      WHERE conversation_id IS NOT NULL;
    `);
    try { fs.chmodSync(filename, 0o600); } catch { /* best effort */ }
  }

  load(): HandoffRow[] {
    const rows = this.db
      .query<{ value_json: string }, []>("SELECT value_json FROM handoff_rows ORDER BY row_order ASC")
      .all();
    return rows.map((row) => JSON.parse(row.value_json) as HandoffRow);
  }

  loadHistory(): HandoffRow[] {
    const rows = this.db
      .query<{ value_json: string }, []>("SELECT value_json FROM handoff_history ORDER BY row_order ASC")
      .all();
    return rows.map((row) => JSON.parse(row.value_json) as HandoffRow);
  }

  loadDrainingGenerations(): string[] {
    return this.db
      .query<{ generation: string }, []>(
        "SELECT generation FROM handoff_draining_generations ORDER BY row_order ASC",
      )
      .all()
      .map((row) => row.generation);
  }

  private writeRows(rows: readonly HandoffRow[]): void {
    const insert = this.db.query<unknown, [string, string, number, string]>(
      "INSERT INTO handoff_rows(operation_id, conversation_id, row_order, value_json) VALUES (?, ?, ?, ?)",
    );
    this.db.exec("DELETE FROM handoff_rows");
    rows.forEach((row, index) => insert.run(row.operationId, row.conversationId, index, JSON.stringify(row)));
  }

  private writeHistory(rows: readonly HandoffRow[]): void {
    const insert = this.db.query<unknown, [string, string, number, string]>(
      "INSERT INTO handoff_history(operation_id, conversation_id, row_order, value_json) VALUES (?, ?, ?, ?)",
    );
    this.db.exec("DELETE FROM handoff_history");
    rows.forEach((row, index) => insert.run(row.operationId, row.conversationId, index, JSON.stringify(row)));
  }

  private writeDrainingGenerations(generations: readonly string[]): void {
    const insert = this.db.query<unknown, [string, number]>(
      "INSERT INTO handoff_draining_generations(generation, row_order) VALUES (?, ?)",
    );
    this.db.exec("DELETE FROM handoff_draining_generations");
    [...new Set(generations)].forEach((generation, index) => insert.run(generation, index));
  }

  private migrateActiveRows(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const activeByConversation = new Map<string, HandoffRow>();
      const history = this.loadHistory();
      const historyByOperation = new Map(history.map((row) => [row.operationId, row]));
      const drainingGenerations = new Set(this.loadDrainingGenerations());
      const active = this.load();
      for (const row of [...history, ...active]) {
        if (row.status === "draining") drainingGenerations.add(row.hostGeneration);
      }
      for (const row of active) {
        const previous = activeByConversation.get(row.conversationId);
        if (previous) historyByOperation.set(previous.operationId, previous);
        activeByConversation.set(row.conversationId, row);
      }
      this.writeRows([...activeByConversation.values()]);
      this.writeHistory([...historyByOperation.values()]);
      this.writeDrainingGenerations([...drainingGenerations]);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  save(rows: readonly HandoffRow[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.writeRows(rows);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveHistory(rows: readonly HandoffRow[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.writeHistory(rows);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveDrainingGenerations(generations: readonly string[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.writeDrainingGenerations(generations);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  transaction<T>(mutation: (state: HandoffQueueStoreState) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = {
        rows: this.load(),
        history: this.loadHistory(),
        drainingGenerations: this.loadDrainingGenerations(),
      };
      const result = mutation(state);
      this.writeRows(state.rows);
      this.writeHistory(state.history);
      this.writeDrainingGenerations(state.drainingGenerations);
      this.db.exec("COMMIT");
      return result;
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
