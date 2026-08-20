import { afterAll, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { snippetSegments } from "./snippet";
import {
  indexTranscriptSources,
  InvalidTranscriptSearchCursorError,
  searchTranscripts,
  type TranscriptIndexSource,
} from "./transcriptSearch";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-transcript-search-"));
const previousEnvironment = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  LLV_STATE_DIR: process.env.LLV_STATE_DIR,
  TMPDIR: process.env.TMPDIR,
};

function source(pathname: string, engine: "claude" | "codex", project: string): TranscriptIndexSource {
  const stat = fs.statSync(pathname);
  return { path: pathname, engine, project, size: stat.size, mtimeMs: stat.mtimeMs };
}

beforeEach(() => {
  process.env.HOME = path.join(sandbox, "home");
  process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
  process.env.LLV_STATE_DIR = path.join(sandbox, "state");
  process.env.TMPDIR = path.join(sandbox, "tmp");
  fs.rmSync(process.env.LLV_STATE_DIR, { recursive: true, force: true });
  fs.mkdirSync(process.env.TMPDIR, { recursive: true });
});

afterAll(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("indexes Claude and Codex message bodies with jump metadata", async () => {
  const claude = path.join(sandbox, "claude-session.jsonl");
  const codex = path.join(sandbox, "codex-session.jsonl");
  fs.writeFileSync(claude, [
    JSON.stringify({
      type: "user",
      timestamp: "2026-08-20T09:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "Prepare the cobalt daily report" }] },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-20T09:00:03.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "The cobalt report is ready" }] },
    }),
  ].join("\n") + "\n");
  fs.writeFileSync(codex, [
    JSON.stringify({ type: "session_meta", payload: { cwd: "/workspace/fixture" } }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-20T10:00:00.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Cobalt appears inside the Codex answer" }],
      },
    }),
  ].join("\n") + "\n");

  await indexTranscriptSources([
    source(claude, "claude", "project-a"),
    source(codex, "codex", "project-b"),
  ], { complete: true });
  const result = searchTranscripts({ query: "cobalt", limit: 10 });

  expect(result.items).toHaveLength(3);
  expect(result.items).toEqual(expect.arrayContaining([
    expect.objectContaining({
      speaker: "user",
      timestamp: Date.parse("2026-08-20T09:00:00.000Z") / 1_000,
      transcriptPath: claude,
      byteOffset: 0,
      lineNumber: 1,
      project: "project-a",
      engine: "claude",
      snippet: expect.stringContaining("cobalt"),
    }),
    expect.objectContaining({
      speaker: "assistant",
      transcriptPath: codex,
      lineNumber: 2,
      project: "project-b",
      engine: "codex",
    }),
  ]));
  expect(result.stats).toEqual({
    conversationsIndexed: 2,
    messagesIndexed: 3,
    fieldsSearched: ["message.body"],
    tokenizer: "FTS5 unicode61, remove_diacritics=0, tokenchars=#_",
  });
});

test("matches Cyrillic hashtags and underscore tags as exact FTS tokens", async () => {
  const transcript = path.join(sandbox, "tagged-session.jsonl");
  fs.writeFileSync(transcript, [
    JSON.stringify({
      type: "user",
      timestamp: "2026-08-20T11:00:00.000Z",
      message: { role: "user", content: "Підготуй #тег за правилом cron_tag_sample" },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-20T11:00:01.000Z",
      message: { role: "assistant", content: "Окрема #тегування використовує cron_tag_sample_extra" },
    }),
  ].join("\n") + "\n");
  await indexTranscriptSources([source(transcript, "claude", "reports")], { complete: true });

  const hashtag = searchTranscripts({ query: "#тег" });
  const underscore = searchTranscripts({ query: "cron_tag_sample" });

  expect(hashtag.items).toHaveLength(1);
  expect(hashtag.items[0]).toMatchObject({ speaker: "user", transcriptPath: transcript });
  expect(underscore.items).toHaveLength(1);
  expect(underscore.items[0]).toMatchObject({ speaker: "user", transcriptPath: transcript });
});

test("returns bounded non-overlapping result pages", async () => {
  const transcript = path.join(sandbox, "paged-session.jsonl");
  fs.writeFileSync(transcript, Array.from({ length: 3 }, (_value, index) => JSON.stringify({
    type: index % 2 ? "assistant" : "user",
    timestamp: `2026-08-20T12:00:0${index}.000Z`,
    message: { content: `paginated cobalt message ${index}` },
  })).join("\n") + "\n");
  await indexTranscriptSources([source(transcript, "claude", "pages")], { complete: true });

  const first = searchTranscripts({ query: "cobalt", limit: 2 });
  const second = searchTranscripts({ query: "cobalt", limit: 2, cursor: first.nextCursor });

  expect(first.items).toHaveLength(2);
  expect(first.nextCursor).not.toBeNull();
  expect(first.total).toBe(3);
  expect(second.items).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.items, ...second.items].map((item) => item.byteOffset)).size).toBe(3);
});

test("collapses resume-replayed bodies after whitespace normalization and keeps the newest rollout", async () => {
  const oldest = path.join(sandbox, "rollout-oldest.jsonl");
  const middle = path.join(sandbox, "rollout-middle.jsonl");
  const newest = path.join(sandbox, "rollout-newest.jsonl");
  fs.writeFileSync(oldest, JSON.stringify({
    type: "event_msg",
    timestamp: "2026-08-20T08:00:00.000Z",
    payload: { type: "user_message", message: "  resume   cobalt\nrequest  " },
  }) + "\n");
  fs.writeFileSync(middle, [
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-20T08:00:00.000Z",
      payload: { type: "user_message", message: "resume cobalt\trequest" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-20T08:01:00.000Z",
      payload: { type: "agent_message", message: "resume cobalt request" },
    }),
  ].join("\n") + "\n");
  fs.writeFileSync(newest, [
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-20T08:00:00.000Z",
      payload: { type: "user_message", message: "resume cobalt request" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-20T08:02:00.000Z",
      payload: { type: "user_message", message: "Resume cobalt request" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-20T08:03:00.000Z",
      payload: { type: "user_message", message: "cobalt follow-up" },
    }),
  ].join("\n") + "\n");
  const sources = [
    { ...source(oldest, "codex", "resume"), mtimeMs: 1_000 },
    { ...source(middle, "codex", "resume"), mtimeMs: 2_000 },
    { ...source(newest, "codex", "resume"), mtimeMs: 3_000 },
  ];
  await indexTranscriptSources(sources, { complete: true });

  const first = searchTranscripts({ query: "cobalt", limit: 2 });
  const second = searchTranscripts({ query: "cobalt", limit: 2, cursor: first.nextCursor });
  const items = [...first.items, ...second.items];
  const replay = items.find((item) => item.duplicateCount === 3);

  expect(first.total).toBe(4);
  expect(second.total).toBe(4);
  expect(first.items).toHaveLength(2);
  expect(second.items).toHaveLength(2);
  expect(second.nextCursor).toBeNull();
  expect(replay).toMatchObject({
    speaker: "user",
    transcriptPath: newest,
    duplicateCount: 3,
  });
  expect(items.filter((item) => item.duplicateCount === 1)).toHaveLength(3);
  expect(new Set(items.map((item) => `${item.speaker}:${item.transcriptPath}:${item.lineNumber}`)).size).toBe(4);
  expect(first.stats).toMatchObject({ conversationsIndexed: 3, messagesIndexed: 6 });
});

test("migrates a version-one on-disk index before serving collapsed rows", () => {
  const filename = statePath("transcript-search.sqlite");
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename, { create: true, strict: true });
  db.exec(`
    CREATE TABLE transcript_files (
      path TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      project TEXT NOT NULL,
      engine TEXT NOT NULL CHECK(engine IN ('claude', 'codex')),
      messages_count INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL
    );
    CREATE TABLE transcript_messages (
      id INTEGER PRIMARY KEY,
      transcript_path TEXT NOT NULL,
      message_index INTEGER NOT NULL,
      speaker TEXT NOT NULL CHECK(speaker IN ('user', 'assistant')),
      timestamp INTEGER,
      byte_offset INTEGER NOT NULL,
      line_number INTEGER NOT NULL,
      body TEXT NOT NULL,
      UNIQUE(transcript_path, message_index),
      FOREIGN KEY(transcript_path) REFERENCES transcript_files(path) ON DELETE CASCADE
    );
    CREATE VIRTUAL TABLE transcript_messages_fts USING fts5(
      body,
      tokenize = "unicode61 remove_diacritics 0 tokenchars '#_'"
    );
    INSERT INTO transcript_files VALUES ('/fixtures/legacy.jsonl', 10, 1000, 'legacy', 'codex', 1, 1);
    INSERT INTO transcript_messages VALUES (1, '/fixtures/legacy.jsonl', 0, 'user', 1, 0, 1, 'legacy cobalt body');
    INSERT INTO transcript_messages_fts(rowid, body) VALUES (1, 'legacy cobalt body');
    PRAGMA user_version = 1;
  `);
  db.close();

  expect(searchTranscripts({ query: "cobalt" }).items).toEqual([
    expect.objectContaining({ transcriptPath: "/fixtures/legacy.jsonl", duplicateCount: 1 }),
  ]);

  const migrated = new Database(filename, { readonly: true, strict: true });
  expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(2);
  expect(migrated.query<{ body_hash: string }, []>("SELECT body_hash FROM transcript_messages").get()?.body_hash)
    .toMatch(/^[0-9a-f]{64}$/);
  migrated.close();
});

test("searches all projects by default and explains a scoped empty result", async () => {
  const firstPath = path.join(sandbox, "first-project.jsonl");
  const secondPath = path.join(sandbox, "second-project.jsonl");
  fs.writeFileSync(firstPath, JSON.stringify({ type: "user", message: { content: "shared heliotrope term" } }) + "\n");
  fs.writeFileSync(secondPath, JSON.stringify({ type: "assistant", message: { content: "shared heliotrope term" } }) + "\n");
  await indexTranscriptSources([
    source(firstPath, "claude", "project-a"),
    source(secondPath, "claude", "project-b"),
  ], { complete: true });

  expect(searchTranscripts({ query: "heliotrope" }).items).toHaveLength(2);
  expect(searchTranscripts({ query: "heliotrope", project: "project-a" }).items)
    .toEqual([expect.objectContaining({ project: "project-a" })]);

  const empty = searchTranscripts({ query: "missing", project: "project-a" });
  expect(empty.items).toEqual([]);
  expect(empty.stats).toEqual({
    conversationsIndexed: 2,
    messagesIndexed: 2,
    fieldsSearched: ["message.body"],
    tokenizer: "FTS5 unicode61, remove_diacritics=0, tokenchars=#_",
  });
});

test("does not reopen an unchanged transcript on the next index pass", async () => {
  const transcript = path.join(sandbox, "unchanged-session.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "fixture" } }) + "\n");
  const indexedSource = source(transcript, "claude", "performance");
  let opens = 0;
  const readMessages = async function* () {
    opens += 1;
    yield {
      body: "incremental heliotrope fixture",
      speaker: "user" as const,
      timestamp: null,
      byteOffset: 0,
      lineNumber: 1,
    };
  };

  const first = await indexTranscriptSources([indexedSource], { complete: true, readMessages });
  const second = await indexTranscriptSources([indexedSource], { complete: true, readMessages });
  await indexTranscriptSources([{ ...indexedSource, project: "performance-renamed" }], { complete: true, readMessages });

  expect(first).toMatchObject({ filesRead: 1, filesSkipped: 0 });
  expect(second).toMatchObject({ filesRead: 0, filesSkipped: 1 });
  expect(opens).toBe(1);
  expect(searchTranscripts({ query: "heliotrope", project: "performance" }).items).toEqual([]);
  expect(searchTranscripts({ query: "heliotrope", project: "performance-renamed" }).items).toHaveLength(1);
});

test("indexes Codex event messages while collapsing their response-item mirrors", async () => {
  const transcript = path.join(sandbox, "codex-event-session.jsonl");
  fs.writeFileSync(transcript, [
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-20T13:00:00.000Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "duplicate user body" }] },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-20T13:00:00.001Z",
      payload: { type: "user_message", message: "duplicate user body" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-20T13:00:01.000Z",
      payload: { type: "agent_message", message: "event-only answer with #тег" },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-20T13:00:02.000Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "duplicated assistant body" }] },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-20T13:00:02.001Z",
      payload: { type: "agent_message", message: "duplicated assistant body" },
    }),
  ].join("\n") + "\n");

  await indexTranscriptSources([source(transcript, "codex", "events")], { complete: true });

  expect(searchTranscripts({ query: "duplicate" }).items).toHaveLength(1);
  expect(searchTranscripts({ query: "duplicated" }).items).toHaveLength(1);
  expect(searchTranscripts({ query: "#тег" }).items)
    .toEqual([expect.objectContaining({ speaker: "assistant", lineNumber: 3 })]);
  expect(searchTranscripts({ query: "body" }).stats.messagesIndexed).toBe(3);
});

test("serves the committed index while a changed transcript is rebuilding", async () => {
  const transcript = path.join(sandbox, "rebuilding-session.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "old marigold body" } }) + "\n");
  await indexTranscriptSources([source(transcript, "claude", "rebuild")], { complete: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "new marigold body" } }) + "\n");
  const changed = source(transcript, "claude", "rebuild");
  changed.mtimeMs += 1_000;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const readMessages = async function* () {
    markStarted();
    await gate;
    yield {
      body: "new marigold body",
      speaker: "user" as const,
      timestamp: null,
      byteOffset: 0,
      lineNumber: 1,
    };
  };
  const rebuilding = indexTranscriptSources([changed], { complete: true, readMessages });
  await started;

  const queryStartedAt = performance.now();
  const during = searchTranscripts({ query: "old" });

  expect(performance.now() - queryStartedAt).toBeLessThan(250);
  expect(during.items).toHaveLength(1);
  release();
  await rebuilding;
  expect(searchTranscripts({ query: "old" }).items).toEqual([]);
  expect(searchTranscripts({ query: "new" }).items).toHaveLength(1);
});

test("continues the backfill when one discovered transcript becomes unreadable", async () => {
  const vanished = path.join(sandbox, "vanished-session.jsonl");
  const readable = path.join(sandbox, "readable-session.jsonl");
  fs.writeFileSync(vanished, "fixture\n");
  fs.writeFileSync(readable, "fixture\n");
  const sources = [
    source(vanished, "claude", "resilient"),
    source(readable, "claude", "resilient"),
  ];
  const readMessages = async function* (indexed: TranscriptIndexSource) {
    if (indexed.path === vanished) throw new Error("transcript disappeared");
    yield {
      body: "resilient periwinkle body",
      speaker: "assistant" as const,
      timestamp: null,
      byteOffset: 0,
      lineNumber: 1,
    };
  };

  const indexed = await indexTranscriptSources(sources, { complete: true, readMessages });

  expect(indexed.failures).toEqual([{ path: vanished, error: "transcript disappeared" }]);
  expect(searchTranscripts({ query: "periwinkle" }).items)
    .toEqual([expect.objectContaining({ transcriptPath: readable })]);
});

test("speaker=user searches only the operator's own messages", async () => {
  const transcript = path.join(sandbox, "speaker-session.jsonl");
  fs.writeFileSync(transcript, [
    JSON.stringify({
      type: "user",
      timestamp: "2026-08-20T15:00:00.000Z",
      message: { content: "find the marigold invoice I sent" },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-20T15:00:04.000Z",
      message: { content: "the marigold invoice is attached" },
    }),
  ].join("\n") + "\n");
  await indexTranscriptSources([source(transcript, "claude", "speakers")], { complete: true });

  const mine = searchTranscripts({ query: "marigold", speaker: "user" });
  const theirs = searchTranscripts({ query: "marigold", speaker: "assistant" });
  const both = searchTranscripts({ query: "marigold" });

  expect(mine.total).toBe(1);
  expect(mine.items).toEqual([expect.objectContaining({ speaker: "user" })]);
  expect(theirs.total).toBe(1);
  expect(theirs.items).toEqual([expect.objectContaining({ speaker: "assistant" })]);
  expect(both.total).toBe(2);
  /* The zero answer stays trustworthy: the corpus line reports the whole
     index, not the filtered slice. */
  expect(searchTranscripts({ query: "absent", speaker: "user" }).stats.messagesIndexed).toBe(2);
});

test("a cursor minted for one speaker scope cannot replay under another", async () => {
  const transcript = path.join(sandbox, "speaker-pages.jsonl");
  fs.writeFileSync(transcript, Array.from({ length: 4 }, (_value, index) => JSON.stringify({
    type: index % 2 ? "assistant" : "user",
    timestamp: `2026-08-20T16:00:0${index}.000Z`,
    message: { content: `periwinkle page ${index}` },
  })).join("\n") + "\n");
  await indexTranscriptSources([source(transcript, "claude", "speaker-pages")], { complete: true });

  const first = searchTranscripts({ query: "periwinkle", speaker: "user", limit: 1 });
  expect(first.total).toBe(2);
  expect(first.nextCursor).not.toBeNull();

  const second = searchTranscripts({ query: "periwinkle", speaker: "user", limit: 1, cursor: first.nextCursor });
  expect(second.items).toEqual([expect.objectContaining({ speaker: "user" })]);
  expect(second.nextCursor).toBeNull();

  expect(() => searchTranscripts({ query: "periwinkle", limit: 1, cursor: first.nextCursor }))
    .toThrow(InvalidTranscriptSearchCursorError);
  expect(() => searchTranscripts({ query: "periwinkle", speaker: "assistant", limit: 1, cursor: first.nextCursor }))
    .toThrow(InvalidTranscriptSearchCursorError);
});

test("snippets mark matched terms with sentinels a message body cannot contain", async () => {
  const transcript = path.join(sandbox, "snippet-markers.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({
    type: "user",
    timestamp: "2026-08-20T17:00:00.000Z",
    message: { content: "read rows[0] then log the cobalt totals" },
  }) + "\n");
  await indexTranscriptSources([source(transcript, "claude", "markers")], { complete: true });

  const snippet = searchTranscripts({ query: "cobalt" }).items[0]!.snippet;

  expect(snippetSegments(snippet)).toEqual(expect.arrayContaining([
    { text: "cobalt", match: true },
  ]));
  /* The brackets the operator typed stay plain text — the defect the sentinel
     delimiters exist to kill. */
  expect(snippet).toContain("rows[0]");
  expect(snippetSegments(snippet).filter((segment) => segment.match))
    .toEqual([{ text: "cobalt", match: true }]);
});
