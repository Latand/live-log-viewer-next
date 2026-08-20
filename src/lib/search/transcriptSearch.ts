import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Database as BunDatabase } from "bun:sqlite";

import { statePath } from "@/lib/configDir";
import { SNIPPET_MATCH_CLOSE, SNIPPET_MATCH_OPEN } from "./snippet";

export const TRANSCRIPT_SEARCH_TOKENIZER = "FTS5 unicode61, remove_diacritics=0, tokenchars=#_";
export const TRANSCRIPT_SEARCH_FIELDS = ["message.body"] as const;

export interface TranscriptIndexSource {
  path: string;
  project: string;
  engine: "claude" | "codex";
  size: number;
  mtimeMs: number;
}

/** Who authored an indexed message. The operator's own prompts are `user`. */
export type TranscriptSpeaker = "user" | "assistant";

export interface TranscriptSearchItem {
  snippet: string;
  speaker: TranscriptSpeaker;
  /** Number of indexed occurrences collapsed into this result. */
  duplicateCount: number;
  /** Unix seconds, or null when the transcript record carried no valid timestamp. */
  timestamp: number | null;
  transcriptPath: string;
  byteOffset: number;
  lineNumber: number;
  project: string;
  engine: "claude" | "codex";
}

export interface TranscriptCorpusStats {
  conversationsIndexed: number;
  messagesIndexed: number;
  fieldsSearched: readonly string[];
  tokenizer: string;
}

export interface TranscriptSearchResult {
  items: TranscriptSearchItem[];
  nextCursor: string | null;
  total: number;
  stats: TranscriptCorpusStats;
}

export interface ParsedTranscriptMessage {
  body: string;
  speaker: "user" | "assistant";
  timestamp: number | null;
  byteOffset: number;
  lineNumber: number;
}

export type TranscriptMessageReader = (
  source: TranscriptIndexSource,
) => AsyncIterable<ParsedTranscriptMessage>;

export interface TranscriptIndexOptions {
  complete?: boolean;
  readMessages?: TranscriptMessageReader;
}

export interface TranscriptIndexResult {
  filesRead: number;
  filesSkipped: number;
  messagesIndexed: number;
  failures: Array<{ path: string; error: string }>;
}

export class InvalidTranscriptSearchCursorError extends Error {
  constructor() {
    super("transcript search cursor is invalid or belongs to another query");
    this.name = "InvalidTranscriptSearchCursorError";
  }
}

type Database = BunDatabase;

type FileIdentityRow = {
  size: number;
  mtime_ms: number;
  project: string;
  engine: string;
};

type SearchRow = {
  snippet: string;
  speaker: TranscriptSpeaker;
  duplicate_count: number;
  timestamp: number | null;
  transcript_path: string;
  byte_offset: number;
  line_number: number;
  project: string;
  engine: "claude" | "codex";
};

function sqliteDatabase(): typeof import("bun:sqlite").Database {
  const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
  if (!sqlite) throw new Error("Transcript search requires the Bun runtime");
  return sqlite.Database;
}

const TRANSCRIPT_SEARCH_SCHEMA_VERSION = 2;

function normalizedBodyHash(body: string): string {
  const normalized = body.trim().replace(/\s+/gu, " ");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function schemaVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
}

function hasBodyHashColumn(db: Database): boolean {
  return db.query<{ name: string }, []>("PRAGMA table_info(transcript_messages)").all()
    .some((column) => column.name === "body_hash");
}

function migrateSearchSchema(db: Database): void {
  const currentVersion = schemaVersion(db);
  if (currentVersion >= TRANSCRIPT_SEARCH_SCHEMA_VERSION && hasBodyHashColumn(db)) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!hasBodyHashColumn(db)) db.exec("ALTER TABLE transcript_messages ADD COLUMN body_hash TEXT");
    const messages = db.query<{ id: number; body: string }, []>(
      "SELECT id, body FROM transcript_messages WHERE body_hash IS NULL",
    ).all();
    const update = db.query("UPDATE transcript_messages SET body_hash = ? WHERE id = ?");
    for (const message of messages) update.run(normalizedBodyHash(message.body), message.id);
    db.exec(`
      CREATE INDEX IF NOT EXISTS transcript_messages_body_hash
        ON transcript_messages(speaker, body_hash);
      PRAGMA user_version = ${Math.max(currentVersion, TRANSCRIPT_SEARCH_SCHEMA_VERSION)};
      COMMIT;
    `);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction did not open */ }
    throw error;
  }
}

function openWriterDatabase(): Database {
  const filename = statePath("transcript-search.sqlite");
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const Database = sqliteDatabase();
  const db = new Database(filename, { create: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS transcript_files (
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        project TEXT NOT NULL,
        engine TEXT NOT NULL CHECK(engine IN ('claude', 'codex')),
        messages_count INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcript_messages (
        id INTEGER PRIMARY KEY,
        transcript_path TEXT NOT NULL,
        message_index INTEGER NOT NULL,
        speaker TEXT NOT NULL CHECK(speaker IN ('user', 'assistant')),
        timestamp INTEGER,
        byte_offset INTEGER NOT NULL,
        line_number INTEGER NOT NULL,
        body TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        UNIQUE(transcript_path, message_index),
        FOREIGN KEY(transcript_path) REFERENCES transcript_files(path) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS transcript_messages_path
        ON transcript_messages(transcript_path, message_index);
      CREATE VIRTUAL TABLE IF NOT EXISTS transcript_messages_fts USING fts5(
        body,
        tokenize = "unicode61 remove_diacritics 0 tokenchars '#_'"
      );
    `);
    migrateSearchSchema(db);
    secureDatabaseFiles(filename);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function openQueryDatabase(): Database {
  const filename = statePath("transcript-search.sqlite");
  if (!fs.existsSync(filename)) return openWriterDatabase();
  const Database = sqliteDatabase();
  const probe = new Database(filename, { readonly: true, strict: true });
  let needsMigration: boolean;
  try {
    needsMigration = schemaVersion(probe) < TRANSCRIPT_SEARCH_SCHEMA_VERSION || !hasBodyHashColumn(probe);
  } finally {
    probe.close();
  }
  if (needsMigration) openWriterDatabase().close();
  const db = new Database(filename, { readonly: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout = 250; PRAGMA query_only = ON; PRAGMA foreign_keys = ON;");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function secureDatabaseFiles(filename: string): void {
  for (const candidate of [filename, `${filename}-wal`, `${filename}-shm`]) {
    try {
      fs.chmodSync(candidate, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => record(item) !== null)
    : [];
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return records(value)
    .filter((part) => part.type === "text" || part.type === "input_text" || part.type === "output_text")
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function unixTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? Math.floor(millis / 1_000) : null;
}

function messageFromRecord(
  parsed: Record<string, unknown>,
  source: TranscriptIndexSource,
  byteOffset: number,
  lineNumber: number,
): (ParsedTranscriptMessage & { representation: "claude" | "response" | "event" }) | null {
  let speaker: "user" | "assistant" | null = null;
  let body = "";
  let representation: "claude" | "response" | "event" = "claude";
  if (source.engine === "claude" && (parsed.type === "user" || parsed.type === "assistant")) {
    speaker = parsed.type;
    body = textContent(record(parsed.message)?.content);
  } else if (source.engine === "codex" && parsed.type === "response_item") {
    representation = "response";
    const payload = record(parsed.payload);
    if (payload?.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
      speaker = payload.role;
      body = textContent(payload.content);
    } else if (payload?.type === "agent_message") {
      speaker = "assistant";
      body = textContent(payload.content);
    }
  } else if (source.engine === "codex" && parsed.type === "event_msg") {
    representation = "event";
    const payload = record(parsed.payload);
    if (payload?.type === "user_message") {
      speaker = "user";
      body = typeof payload.message === "string" ? payload.message.trim() : "";
    } else if (payload?.type === "agent_message") {
      speaker = "assistant";
      body = typeof payload.message === "string" ? payload.message.trim() : "";
    }
  }
  if (!speaker || !body) return null;
  return {
    body,
    speaker,
    timestamp: unixTimestamp(parsed.timestamp ?? parsed.created_at),
    byteOffset,
    lineNumber,
    representation,
  };
}

async function* transcriptLines(pathname: string): AsyncGenerator<{ bytes: Buffer; byteOffset: number; lineNumber: number }> {
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;
  let lineOffset = 0;
  let lineNumber = 1;
  let streamOffset = 0;
  for await (const chunk of fs.createReadStream(pathname)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (true) {
      const newline = bytes.indexOf(0x0a, start);
      if (newline < 0) break;
      const tail = bytes.subarray(start, newline);
      const totalBytes = fragmentBytes + tail.length;
      const combined = fragments.length
        ? Buffer.concat(tail.length ? [...fragments, tail] : fragments, totalBytes)
        : tail;
      const line = combined.at(-1) === 0x0d ? combined.subarray(0, -1) : combined;
      yield { bytes: line, byteOffset: lineOffset, lineNumber };
      lineNumber += 1;
      fragments = [];
      fragmentBytes = 0;
      start = newline + 1;
      lineOffset = streamOffset + start;
    }
    if (start < bytes.length) {
      const remainder = bytes.subarray(start);
      fragments.push(remainder);
      fragmentBytes += remainder.length;
    }
    streamOffset += bytes.length;
  }
  if (fragmentBytes) {
    const combined = fragments.length === 1 ? fragments[0]! : Buffer.concat(fragments, fragmentBytes);
    const line = combined.at(-1) === 0x0d ? combined.subarray(0, -1) : combined;
    yield { bytes: line, byteOffset: lineOffset, lineNumber };
  }
}

async function* readTranscriptMessages(source: TranscriptIndexSource): AsyncGenerator<ParsedTranscriptMessage> {
  type RecentMessage = { representation: "response" | "event"; timestamp: number | null; lineNumber: number };
  const recent = new Map<string, RecentMessage>();
  const recentOrder: Array<{ key: string; message: RecentMessage }> = [];
  for await (const line of transcriptLines(source.path)) {
    if (!line.bytes.length) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.bytes.toString("utf8"));
    } catch {
      continue;
    }
    const message = messageFromRecord(record(parsed) ?? {}, source, line.byteOffset, line.lineNumber);
    if (!message) continue;
    if (message.representation !== "claude") {
      const key = `${message.speaker}\0${message.body}`;
      const previous = recent.get(key);
      const closeInTime = previous
        && (message.timestamp !== null && previous.timestamp !== null
          ? Math.abs(message.timestamp - previous.timestamp) <= 2
          : message.lineNumber - previous.lineNumber <= 2);
      if (previous && previous.representation !== message.representation && closeInTime) continue;
      const remembered = {
        representation: message.representation,
        timestamp: message.timestamp,
        lineNumber: message.lineNumber,
      };
      recent.set(key, remembered);
      recentOrder.push({ key, message: remembered });
      while (recentOrder.length > 8) {
        const expired = recentOrder.shift()!;
        if (recent.get(expired.key) === expired.message) recent.delete(expired.key);
      }
    }
    const { representation: _representation, ...indexed } = message;
    yield indexed;
  }
}

function removeTranscript(db: Database, pathname: string): void {
  db.query("DELETE FROM transcript_messages_fts WHERE rowid IN (SELECT id FROM transcript_messages WHERE transcript_path = ?)")
    .run(pathname);
  db.query("DELETE FROM transcript_messages WHERE transcript_path = ?").run(pathname);
  db.query("DELETE FROM transcript_files WHERE path = ?").run(pathname);
}

export async function indexTranscriptSources(
  sources: readonly TranscriptIndexSource[],
  options: TranscriptIndexOptions = {},
): Promise<TranscriptIndexResult> {
  const db = openWriterDatabase();
  const readMessages = options.readMessages ?? readTranscriptMessages;
  let filesRead = 0;
  let filesSkipped = 0;
  let messagesIndexed = 0;
  const failures: TranscriptIndexResult["failures"] = [];
  try {
    const identity = db.query<FileIdentityRow, [string]>(
      "SELECT size, mtime_ms, project, engine FROM transcript_files WHERE path = ?",
    );
    const updateMetadata = db.query(
      "UPDATE transcript_files SET project = ?, engine = ? WHERE path = ?",
    );
    for (const source of sources) {
      const current = identity.get(source.path);
      if (current?.size === source.size && current.mtime_ms === source.mtimeMs) {
        if (current.project !== source.project || current.engine !== source.engine) {
          updateMetadata.run(source.project, source.engine, source.path);
        }
        filesSkipped += 1;
        continue;
      }
      filesRead += 1;
      db.exec("BEGIN IMMEDIATE");
      try {
        removeTranscript(db, source.path);
        db.query(
          "INSERT INTO transcript_files(path, size, mtime_ms, project, engine, messages_count, indexed_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
        ).run(source.path, source.size, source.mtimeMs, source.project, source.engine, Math.floor(Date.now() / 1_000));
        let messageIndex = 0;
        for await (const message of readMessages(source)) {
          const inserted = db.query(
            "INSERT INTO transcript_messages(transcript_path, message_index, speaker, timestamp, byte_offset, line_number, body, body_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
          ).get(
            source.path,
            messageIndex,
            message.speaker,
            message.timestamp,
            message.byteOffset,
            message.lineNumber,
            message.body,
            normalizedBodyHash(message.body),
          ) as { id: number };
          db.query("INSERT INTO transcript_messages_fts(rowid, body) VALUES (?, ?)").run(inserted.id, message.body);
          messageIndex += 1;
        }
        db.query("UPDATE transcript_files SET messages_count = ? WHERE path = ?").run(messageIndex, source.path);
        db.exec("COMMIT");
        messagesIndexed += messageIndex;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* transaction did not open */ }
        failures.push({
          path: source.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (options.complete) {
      const currentPaths = new Set(sources.map((source) => source.path));
      const indexed = db.query<{ path: string }, []>("SELECT path FROM transcript_files").all();
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of indexed) {
          if (!currentPaths.has(row.path)) removeTranscript(db, row.path);
        }
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* transaction did not open */ }
        throw error;
      }
    }
    return { filesRead, filesSkipped, messagesIndexed, failures };
  } finally {
    db.close();
  }
}

function ftsQuery(query: string): string | null {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

/* Every filter that changes WHICH rows the ordered result set contains is part
   of the cursor's scope: an offset minted against "my messages" addresses a
   different row sequence than the same offset over every speaker, so replaying
   one cursor under the other scope would silently page through the wrong
   corpus. A scope mismatch is rejected, not reinterpreted. */
function cursorScope(query: string, project: string | undefined, speaker: TranscriptSpeaker | undefined): string {
  return crypto.createHash("sha256")
    .update(query)
    .update("\0")
    .update(project ?? "")
    .update("\0")
    .update(speaker ?? "")
    .digest("base64url")
    .slice(0, 16);
}

function encodeCursor(offset: number, scope: string): string {
  return Buffer.from(JSON.stringify({ version: 1, offset, scope })).toString("base64url");
}

function decodeCursor(value: string | null | undefined, scope: string): number {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      version?: unknown;
      offset?: unknown;
      scope?: unknown;
    };
    if (parsed.version !== 1
      || !Number.isSafeInteger(parsed.offset)
      || (parsed.offset as number) < 1
      || parsed.scope !== scope) throw new InvalidTranscriptSearchCursorError();
    return parsed.offset as number;
  } catch (error) {
    if (error instanceof InvalidTranscriptSearchCursorError) throw error;
    throw new InvalidTranscriptSearchCursorError();
  }
}

function corpusStats(db: Database): TranscriptCorpusStats {
  const conversations = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM transcript_files").get()?.count ?? 0;
  const messages = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM transcript_messages").get()?.count ?? 0;
  return {
    conversationsIndexed: conversations,
    messagesIndexed: messages,
    fieldsSearched: TRANSCRIPT_SEARCH_FIELDS,
    tokenizer: TRANSCRIPT_SEARCH_TOKENIZER,
  };
}

export function searchTranscripts(options: {
  query: string;
  project?: string;
  /** Restrict to one side of the conversation; omitted searches both. */
  speaker?: TranscriptSpeaker;
  limit?: number;
  cursor?: string | null;
}): TranscriptSearchResult {
  const db = openQueryDatabase();
  try {
    const query = ftsQuery(options.query);
    const stats = corpusStats(db);
    if (!query) return { items: [], nextCursor: null, total: 0, stats };
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
    const scope = cursorScope(query, options.project, options.speaker);
    const offset = decodeCursor(options.cursor, scope);
    /* Filter clause and bindings are built from one list so the two queries
       below can never disagree about parameter order. */
    const filters: Array<{ clause: string; binding: string }> = [];
    if (options.project) filters.push({ clause: " AND f.project = ?", binding: options.project });
    if (options.speaker) filters.push({ clause: " AND m.speaker = ?", binding: options.speaker });
    const where = filters.map((filter) => filter.clause).join("");
    const bindings = [query, ...filters.map((filter) => filter.binding)];
    const total = (db.query(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT m.speaker, m.body_hash
        FROM transcript_messages_fts
        JOIN transcript_messages AS m ON m.id = transcript_messages_fts.rowid
        JOIN transcript_files AS f ON f.path = m.transcript_path
        WHERE transcript_messages_fts MATCH ?${where}
        GROUP BY m.speaker, m.body_hash
      ) AS collapsed
    `).get(...bindings) as { count: number } | null)?.count ?? 0;
    const rows = db.query(`
      WITH ranked AS (
        SELECT
          m.id,
          m.speaker,
          m.timestamp,
          m.transcript_path,
          m.byte_offset,
          m.line_number,
          f.project,
          f.engine,
          f.mtime_ms,
          COUNT(*) OVER (PARTITION BY m.speaker, m.body_hash) AS duplicate_count,
          ROW_NUMBER() OVER (
            PARTITION BY m.speaker, m.body_hash
            /* Replayed records retain their original message timestamp. The
               transcript mtime identifies the newest rollout generation. */
            ORDER BY f.mtime_ms DESC, COALESCE(m.timestamp, 0) DESC, m.id DESC
          ) AS duplicate_rank
        FROM transcript_messages_fts
        JOIN transcript_messages AS m ON m.id = transcript_messages_fts.rowid
        JOIN transcript_files AS f ON f.path = m.transcript_path
        WHERE transcript_messages_fts MATCH ?${where}
      )
      SELECT
        snippet(transcript_messages_fts, 0, '${SNIPPET_MATCH_OPEN}', '${SNIPPET_MATCH_CLOSE}', '…', 24) AS snippet,
        ranked.speaker,
        ranked.duplicate_count,
        ranked.timestamp,
        ranked.transcript_path,
        ranked.byte_offset,
        ranked.line_number,
        ranked.project,
        ranked.engine
      FROM ranked
      JOIN transcript_messages_fts ON transcript_messages_fts.rowid = ranked.id
      WHERE ranked.duplicate_rank = 1 AND transcript_messages_fts MATCH ?
      ORDER BY bm25(transcript_messages_fts), ranked.mtime_ms DESC,
        COALESCE(ranked.timestamp, 0) DESC, ranked.id DESC
      LIMIT ? OFFSET ?
    `).all(...bindings, query, limit, offset) as SearchRow[];
    const nextOffset = offset + rows.length;
    return {
      items: rows.map((row) => ({
        snippet: row.snippet,
        speaker: row.speaker,
        duplicateCount: row.duplicate_count,
        timestamp: row.timestamp,
        transcriptPath: row.transcript_path,
        byteOffset: row.byte_offset,
        lineNumber: row.line_number,
        project: row.project,
        engine: row.engine,
      })),
      nextCursor: nextOffset < total ? encodeCursor(nextOffset, scope) : null,
      total,
      stats,
    };
  } finally {
    db.close();
  }
}
