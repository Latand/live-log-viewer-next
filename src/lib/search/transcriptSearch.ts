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

/** One matched message as the ranking pass reads it: `values()` tuples,
    because a common word matches a third of the corpus and the objects would
    cost more than the query. */
type HitRow = [
  id: number,
  score: number,
  speaker: TranscriptSpeaker,
  bodyHash: string,
  timestamp: number | null,
  transcriptPath: string,
];

type TranscriptFileRow = {
  project: string;
  engine: "claude" | "codex";
  mtime_ms: number;
};

interface RankedHit {
  id: number;
  score: number;
  speaker: TranscriptSpeaker;
  timestamp: number | null;
  transcriptPath: string;
  mtimeMs: number;
}

/** One result row: the newest occurrence of a body, and how many the index
    holds for that speaker. */
interface CollapsedHit {
  newest: RankedHit;
  duplicateCount: number;
}

function sqliteDatabase(): typeof import("bun:sqlite").Database {
  const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
  if (!sqlite) throw new Error("Transcript search requires the Bun runtime");
  return sqlite.Database;
}

const TRANSCRIPT_SEARCH_SCHEMA_VERSION = 2;
const TRANSCRIPT_SEARCH_MIGRATION_BATCH_SIZE = 256;

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
    const pendingMessages = db.query<{ id: number; body: string }, [number, number]>(`
      SELECT id, body FROM transcript_messages WHERE body_hash IS NULL AND id > ?
      ORDER BY id
      LIMIT ?
    `);
    const update = db.query("UPDATE transcript_messages SET body_hash = ? WHERE id = ?");
    let lastId = 0;
    while (true) {
      const messages = pendingMessages.all(lastId, TRANSCRIPT_SEARCH_MIGRATION_BATCH_SIZE);
      for (const message of messages) update.run(normalizedBodyHash(message.body), message.id);
      if (messages.length < TRANSCRIPT_SEARCH_MIGRATION_BATCH_SIZE) break;
      lastId = messages.at(-1)!.id;
    }
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
  /* Every transcript's `messages_count` is committed with its rows, so one
     pass over the files table answers exactly what `COUNT(*)` over the message
     table did — minus the ~12 ms that walk cost every search, one-hit searches
     included. */
  const row = db.query<{ conversations: number; messages: number | null }, []>(
    "SELECT COUNT(*) AS conversations, SUM(messages_count) AS messages FROM transcript_files",
  ).get();
  return {
    conversationsIndexed: row?.conversations ?? 0,
    messagesIndexed: row?.messages ?? 0,
    fieldsSearched: TRANSCRIPT_SEARCH_FIELDS,
    tokenizer: TRANSCRIPT_SEARCH_TOKENIZER,
  };
}

/* Past this many distinct transcripts, reading the whole files table once
   (thousands of short rows) is cheaper than one keyed lookup per path. */
const TRANSCRIPT_FILE_LOOKUP_CAP = 512;

function transcriptFiles(db: Database, paths: ReadonlySet<string>): Map<string, TranscriptFileRow> {
  const files = new Map<string, TranscriptFileRow>();
  if (!paths.size) return files;
  if (paths.size <= TRANSCRIPT_FILE_LOOKUP_CAP) {
    const lookup = db.query<TranscriptFileRow, [string]>(
      "SELECT project, engine, mtime_ms FROM transcript_files WHERE path = ?",
    );
    for (const pathname of paths) {
      const file = lookup.get(pathname);
      if (file) files.set(pathname, file);
    }
    return files;
  }
  const rows = db.query("SELECT path, project, engine, mtime_ms FROM transcript_files").values() as Array<
    [string, string, "claude" | "codex", number]
  >;
  for (const [pathname, project, engine, mtime_ms] of rows) {
    if (paths.has(pathname)) files.set(pathname, { project, engine, mtime_ms });
  }
  return files;
}

/* Newest transcript generation first, then newest message, then highest id.
   This order picks which occurrence represents a replayed body (a resumed
   rollout retains the original message timestamp, so the transcript mtime is
   what identifies the newest generation) and breaks ties between equal bm25
   scores. */
function newerFirst(a: RankedHit, b: RankedHit): number {
  return b.mtimeMs - a.mtimeMs
    || (b.timestamp ?? 0) - (a.timestamp ?? 0)
    || b.id - a.id;
}

/* bm25 is negative and lower is better, so ascending score is best first. */
function bestFirst(a: CollapsedHit, b: CollapsedHit): number {
  return a.newest.score - b.newest.score || newerFirst(a.newest, b.newest);
}

function pageItems(
  db: Database,
  query: string,
  page: readonly CollapsedHit[],
  files: ReadonlyMap<string, TranscriptFileRow>,
): TranscriptSearchItem[] {
  if (!page.length) return [];
  const ids = page.map((group) => group.newest.id);
  /* `+rowid` keeps FTS5 from turning the id list into one doclist seek per row,
     which on a common term costs ~14 ms EACH; an ordinary match scan filtered
     in place is a fraction of that, and `snippet` runs only for the rows that
     pass the filter. */
  const snippets = new Map<number, string>();
  const snippetRows = db.query(`
    SELECT rowid, snippet(transcript_messages_fts, 0, '${SNIPPET_MATCH_OPEN}', '${SNIPPET_MATCH_CLOSE}', '…', 24)
    FROM transcript_messages_fts
    WHERE transcript_messages_fts MATCH ? AND +rowid IN (${ids.map(() => "?").join(", ")})
  `).values(query, ...ids) as Array<[number, string]>;
  for (const [id, snippet] of snippetRows) snippets.set(id, snippet);
  const location = db.query<{ byte_offset: number; line_number: number }, [number]>(
    "SELECT byte_offset, line_number FROM transcript_messages WHERE id = ?",
  );
  return page.map(({ newest, duplicateCount }) => {
    const where = location.get(newest.id);
    const file = files.get(newest.transcriptPath);
    if (!where || !file) throw new Error("transcript search page row vanished within its read snapshot");
    return {
      snippet: snippets.get(newest.id) ?? "",
      speaker: newest.speaker,
      duplicateCount,
      timestamp: newest.timestamp,
      transcriptPath: newest.transcriptPath,
      byteOffset: where.byte_offset,
      lineNumber: where.line_number,
      project: file.project,
      engine: file.engine,
    };
  });
}

/**
 * Ranking happens here rather than in SQL, and on purpose (#1429).
 *
 * The previous shape — a window function over the joined match set to collapse
 * duplicates, a second `COUNT(*)` over the same join for the total, and a
 * re-scan of the match set to attach snippets — cost, on a 250k-message index,
 * 1.5 s for a word in a third of the messages and 0.4 s for the operator's own
 * messages alone, most of it in one place: the join to `transcript_files` by
 * path, ~5 µs for every one of a hundred thousand matched rows, paid twice.
 *
 * Now one match scan reads the six columns ranking needs; the files a page can
 * name are read once; duplicate collapsing, the total and the page order are
 * computed in memory in exactly the order the SQL used (bm25, then newest
 * transcript, newest message, highest id); and snippets are cut for the page's
 * rows only. Same rows, same order, same snippets, same totals — pinned by the
 * differential test against the old SQL — at roughly a third of the time.
 *
 * All of it runs inside one read transaction, so the passes see one snapshot
 * even while the background indexer commits between them.
 */
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
    db.exec("BEGIN");
    try {
      const query = ftsQuery(options.query);
      const stats = corpusStats(db);
      if (!query) return { items: [], nextCursor: null, total: 0, stats };
      const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
      const scope = cursorScope(query, options.project, options.speaker);
      const offset = decodeCursor(options.cursor, scope);
      const hits = db.query(`
        SELECT transcript_messages_fts.rowid, bm25(transcript_messages_fts), m.speaker, m.body_hash, m.timestamp, m.transcript_path
        FROM transcript_messages_fts
        JOIN transcript_messages AS m ON m.id = transcript_messages_fts.rowid
        WHERE transcript_messages_fts MATCH ?${options.speaker ? " AND m.speaker = ?" : ""}
      `).values(...(options.speaker ? [query, options.speaker] : [query])) as HitRow[];
      const paths = new Set<string>();
      for (const hit of hits) paths.add(hit[5]);
      const files = transcriptFiles(db, paths);
      const groups = new Map<string, CollapsedHit>();
      for (const [id, score, speaker, bodyHash, timestamp, transcriptPath] of hits) {
        const file = files.get(transcriptPath);
        /* A message whose transcript row is gone, or outside the requested
           project, is not a result — the inner join used to drop it. */
        if (!file || (options.project && file.project !== options.project)) continue;
        const hit: RankedHit = { id, score, speaker, timestamp, transcriptPath, mtimeMs: file.mtime_ms };
        const key = `${speaker}\0${bodyHash}`;
        const group = groups.get(key);
        if (!group) {
          groups.set(key, { newest: hit, duplicateCount: 1 });
          continue;
        }
        group.duplicateCount += 1;
        if (newerFirst(hit, group.newest) < 0) group.newest = hit;
      }
      const ranked = [...groups.values()].sort(bestFirst);
      const total = ranked.length;
      const items = pageItems(db, query, ranked.slice(offset, offset + limit), files);
      const nextOffset = offset + items.length;
      return {
        items,
        nextCursor: nextOffset < total ? encodeCursor(nextOffset, scope) : null,
        total,
        stats,
      };
    } finally {
      db.exec("COMMIT");
    }
  } finally {
    db.close();
  }
}
