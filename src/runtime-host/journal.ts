import { createHash } from "node:crypto";

import { Database } from "bun:sqlite";

import { assertRuntimeEvent, type RuntimeEffect, type RuntimeEvent, type RuntimeEventInput, type RuntimeReplay, type RuntimeSnapshot } from "@/lib/runtime/contracts";

export class RuntimeJournalFault extends Error {}

type EventRow = {
  seq: number;
  scope: string;
  revision: number;
  kind: string;
  payload_json: string;
  created_at: number;
  producer_key: string | null;
  operation_id: string | null;
  prev_hash: string;
  hash: string;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function recordHash(previous: string, row: Pick<EventRow, "seq" | "scope" | "revision" | "kind" | "payload_json">): string {
  return createHash("sha256").update(`${previous}\n${row.seq}\n${row.scope}\n${row.revision}\n${row.kind}\n${row.payload_json}`).digest("hex");
}

function toEvent(row: EventRow): RuntimeEvent {
  return {
    seq: row.seq,
    scope: row.scope as RuntimeEvent["scope"],
    revision: row.revision,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    ...(row.producer_key ? { producerKey: row.producer_key } : {}),
    ...(row.operation_id ? { operationId: row.operation_id } : {}),
    createdAt: row.created_at,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

export interface RuntimeJournalOptions {
  maxEvents?: number;
  now?: () => number;
}

/**
 * Sole durable writer. Every append commits event, projection, checkpoint and
 * optional effect row in one SQLite transaction.
 */
export class RuntimeJournal {
  private readonly db: Database;
  private readonly maxEvents: number;
  private readonly now: () => number;
  private fault: string | null = null;

  constructor(filename: string, options: RuntimeJournalOptions = {}) {
    this.db = new Database(filename, { create: true, strict: true });
    this.maxEvents = options.maxEvents ?? 20_000;
    this.now = options.now ?? (() => Date.now());
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS journal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY, scope TEXT NOT NULL, revision INTEGER NOT NULL,
        kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        producer_key TEXT UNIQUE, operation_id TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scope_revisions (scope TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS projections (scope TEXT PRIMARY KEY, revision INTEGER NOT NULL, state_json TEXT NOT NULL, checkpoint_seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL, event_seq INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_receipts (operation_id TEXT PRIMARY KEY, event_seq INTEGER NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL);
    `);
    this.metaSetDefault("seq", "0");
    this.metaSetDefault("hash", "0".repeat(64));
    this.metaSetDefault("anchor_seq", "0");
    this.metaSetDefault("anchor_hash", "0".repeat(64));
    this.verify();
  }

  append(input: RuntimeEventInput): RuntimeEvent {
    assertRuntimeEvent(input);
    this.assertHealthy();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (input.producerKey) {
        const duplicate = this.db.query<EventRow, [string]>("SELECT * FROM events WHERE producer_key = ?").get(input.producerKey);
        if (duplicate) {
          this.db.exec("COMMIT");
          return toEvent(duplicate);
        }
      }
      const seq = Number(this.meta("seq")) + 1;
      const revision = Number(this.db.query<{ revision: number }, [string]>("SELECT revision FROM scope_revisions WHERE scope = ?").get(input.scope)?.revision ?? 0) + 1;
      const payloadJson = stableJson(input.payload);
      const previous = this.meta("hash");
      const base = { seq, scope: input.scope, revision, kind: input.kind, payload_json: payloadJson };
      const hash = recordHash(previous, base);
      const event: EventRow = { ...base, created_at: this.now(), producer_key: input.producerKey ?? null, operation_id: input.operationId ?? null, prev_hash: previous, hash };
      this.db.query("INSERT INTO events VALUES ($seq, $scope, $revision, $kind, $payload_json, $created_at, $producer_key, $operation_id, $prev_hash, $hash)").run(event);
      this.db.query("INSERT INTO scope_revisions(scope, revision) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision").run(input.scope, revision);
      const state = stableJson({ revision, lastKind: input.kind, payload: input.payload });
      this.db.query("INSERT INTO projections(scope, revision, state_json, checkpoint_seq) VALUES (?, ?, ?, ?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision, state_json=excluded.state_json, checkpoint_seq=excluded.checkpoint_seq").run(input.scope, revision, state, seq);
      if (input.effect) this.insertEffect(input.effect, seq);
      if (input.operationId) this.db.query("INSERT INTO operation_receipts(operation_id, event_seq, revision, state) VALUES (?, ?, ?, 'accepted') ON CONFLICT(operation_id) DO NOTHING").run(input.operationId, seq, revision);
      this.metaSet("seq", String(seq));
      this.metaSet("hash", hash);
      this.db.exec("COMMIT");
      this.compactIfNeeded();
      return toEvent(event);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  snapshot(): RuntimeSnapshot {
    this.assertHealthy();
    this.db.exec("BEGIN");
    try {
      const snapshotSeq = Number(this.meta("seq"));
      const scopes: RuntimeSnapshot["scopes"] = {};
      for (const row of this.db.query<{ scope: string; revision: number; state_json: string }, []>("SELECT scope, revision, state_json FROM projections ORDER BY scope").all()) {
        scopes[row.scope] = { revision: row.revision, state: JSON.parse(row.state_json) as Record<string, unknown> };
      }
      this.db.exec("COMMIT");
      return { snapshotSeq, scopes };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  replay(after: number, limit = 500): RuntimeReplay {
    this.assertHealthy();
    const floorSeq = Number(this.meta("anchor_seq"));
    if (!Number.isInteger(after) || after < 0 || after < floorSeq) return { reset: true, floorSeq, events: [] };
    const rows = this.db.query<EventRow, [number, number]>("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(after, Math.min(Math.max(limit, 1), 2_000));
    return { reset: false, floorSeq, events: rows.map(toEvent) };
  }

  effectBatch(limit = 100): Array<RuntimeEffect & { eventSeq: number }> {
    return this.db.query<{ id: string; kind: string; payload_json: string; event_seq: number }, [number]>("SELECT id, kind, payload_json, event_seq FROM outbox WHERE state = 'pending' ORDER BY event_seq LIMIT ?").all(limit).map((row) => ({ id: row.id, kind: row.kind, payload: JSON.parse(row.payload_json) as Record<string, unknown>, eventSeq: row.event_seq }));
  }

  acknowledgeEffect(id: string): void {
    this.assertHealthy();
    this.db.query("UPDATE outbox SET state = 'completed' WHERE id = ? AND state = 'pending'").run(id);
  }

  compact(maxEvents = this.maxEvents): void {
    this.assertHealthy();
    const count = Number(this.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count ?? 0);
    if (count <= maxEvents) return;
    const remove = count - maxEvents;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const anchor = this.db.query<{ seq: number; hash: string }, [number]>("SELECT seq, hash FROM events ORDER BY seq LIMIT 1 OFFSET ?").get(remove - 1);
      if (!anchor) throw new RuntimeJournalFault("journal compaction anchor is missing");
      this.db.query("DELETE FROM events WHERE seq <= ?").run(anchor.seq);
      this.metaSet("anchor_seq", String(anchor.seq));
      this.metaSet("anchor_hash", anchor.hash);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already ended */ }
      throw error;
    }
  }

  close(): void { this.db.close(); }

  private insertEffect(effect: RuntimeEffect, seq: number): void {
    if (!effect.id || !effect.kind) throw new Error("runtime effect is invalid");
    this.db.query("INSERT INTO outbox(id, kind, payload_json, event_seq, state) VALUES (?, ?, ?, ?, 'pending') ON CONFLICT(id) DO NOTHING").run(effect.id, effect.kind, stableJson(effect.payload), seq);
  }

  private compactIfNeeded(): void { this.compact(this.maxEvents); }

  private verify(): void {
    try {
      let previous = this.meta("anchor_hash");
      let expected = Number(this.meta("anchor_seq")) + 1;
      for (const row of this.db.query<EventRow, []>("SELECT * FROM events ORDER BY seq").all()) {
        if (row.seq !== expected || row.prev_hash !== previous || row.hash !== recordHash(previous, row)) throw new RuntimeJournalFault("runtime journal hash chain is corrupt");
        previous = row.hash;
        expected += 1;
      }
      if (previous !== this.meta("hash") || Number(this.meta("seq")) !== expected - 1) throw new RuntimeJournalFault("runtime journal tail is corrupt");
    } catch (error) {
      this.fault = error instanceof Error ? error.message : "runtime journal verification failed";
    }
  }

  private assertHealthy(): void {
    if (this.fault) throw new RuntimeJournalFault(`runtime journal is read-only: ${this.fault}`);
  }

  private meta(key: string): string {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM journal_meta WHERE key = ?").get(key);
    if (!row) throw new RuntimeJournalFault(`runtime journal metadata is missing: ${key}`);
    return row.value;
  }

  private metaSetDefault(key: string, value: string): void { this.db.query("INSERT INTO journal_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").run(key, value); }
  private metaSet(key: string, value: string): void { this.db.query("UPDATE journal_meta SET value = ? WHERE key = ?").run(value, key); }
}
