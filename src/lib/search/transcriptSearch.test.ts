import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  indexTranscriptSources,
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
