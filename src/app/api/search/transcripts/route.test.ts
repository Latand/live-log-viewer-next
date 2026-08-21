import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { replaceConversationCatalog } from "@/lib/scanner/conversationCatalog";
import { indexTranscriptSources } from "@/lib/search/transcriptSearch";

import { GET, type TranscriptSearchRow } from "./route";

interface Page {
  items: TranscriptSearchRow[];
  nextCursor: string | null;
  total: number;
  stats: { conversationsIndexed: number; messagesIndexed: number };
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-transcript-route-"));
const previousEnvironment = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  LLV_STATE_DIR: process.env.LLV_STATE_DIR,
  TMPDIR: process.env.TMPDIR,
};

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

test("returns indexed snippets without reopening the transcript", async () => {
  const transcript = path.join(sandbox, "route-session.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({
    type: "user",
    timestamp: "2026-08-20T14:00:00.000Z",
    message: { content: "HTTP finds #тег in the persisted body index" },
  }) + "\n");
  const stat = fs.statSync(transcript);
  await indexTranscriptSources([{
    path: transcript,
    project: "reports",
    engine: "claude",
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  }], { complete: true });
  fs.rmSync(transcript);

  const response = await GET(new Request("http://127.0.0.1/api/search/transcripts?q=%23%D1%82%D0%B5%D0%B3&limit=5"));
  const body = await response.json() as {
    items: Array<{ transcriptPath: string; speaker: string; snippet: string }>;
    total: number;
  };

  expect(response.status).toBe(200);
  expect(body.total).toBe(1);
  expect(body.items).toEqual([expect.objectContaining({
    transcriptPath: transcript,
    speaker: "user",
    snippet: expect.stringContaining("тег"),
  })]);
});

test("returns one newest row with duplicateCount for replayed messages", async () => {
  const older = path.join(sandbox, "route-replay-older.jsonl");
  const newer = path.join(sandbox, "route-replay-newer.jsonl");
  const body = (message: string) => JSON.stringify({
    type: "event_msg",
    timestamp: "2026-08-20T14:05:00.000Z",
    payload: { type: "user_message", message },
  }) + "\n";
  fs.writeFileSync(older, body("replayed   saffron message"));
  fs.writeFileSync(newer, body(" replayed saffron\nmessage "));
  await indexTranscriptSources([
    { path: older, project: "reports", engine: "codex", size: fs.statSync(older).size, mtimeMs: 1_000 },
    { path: newer, project: "reports", engine: "codex", size: fs.statSync(newer).size, mtimeMs: 2_000 },
  ], { complete: true });

  const response = await GET(new Request("http://127.0.0.1/api/search/transcripts?q=saffron"));
  const page = await response.json() as Page;

  expect(response.status).toBe(200);
  expect(page.total).toBe(1);
  expect(page.items).toEqual([
    expect.objectContaining({ transcriptPath: newer, speaker: "user", duplicateCount: 2 }),
  ]);
  expect(page.stats).toMatchObject({ conversationsIndexed: 2, messagesIndexed: 2 });
});

test("rejects a missing query instead of returning an ambiguous empty page", async () => {
  const response = await GET(new Request("http://127.0.0.1/api/search/transcripts"));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "q is required" });
});

test("speaker=user narrows the page to the operator's own messages", async () => {
  const transcript = path.join(sandbox, "route-speaker.jsonl");
  fs.writeFileSync(transcript, [
    JSON.stringify({
      type: "user",
      timestamp: "2026-08-20T14:10:00.000Z",
      message: { content: "chase the periwinkle rollout" },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-20T14:10:05.000Z",
      message: { content: "the periwinkle rollout is queued" },
    }),
  ].join("\n") + "\n");
  const stat = fs.statSync(transcript);
  await indexTranscriptSources([{
    path: transcript,
    project: "reports",
    engine: "claude",
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  }], { complete: true });

  const mine = await (await GET(new Request("http://127.0.0.1/api/search/transcripts?q=periwinkle&speaker=user"))).json() as Page;
  const everything = await (await GET(new Request("http://127.0.0.1/api/search/transcripts?q=periwinkle"))).json() as Page;

  expect(mine.total).toBe(1);
  expect(mine.items.map((item) => item.speaker)).toEqual(["user"]);
  expect(everything.total).toBe(2);
  /* Zero under the filter still reports the whole indexed corpus, so the
     operator can trust an empty answer. */
  const none = await (await GET(new Request("http://127.0.0.1/api/search/transcripts?q=absent&speaker=user"))).json() as Page;
  expect(none.items).toEqual([]);
  expect(none.stats.messagesIndexed).toBe(2);
});

test("an unrecognised speaker is rejected instead of silently searching everything", async () => {
  const response = await GET(new Request("http://127.0.0.1/api/search/transcripts?q=periwinkle&speaker=operator"));

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "speaker must be user or assistant" });
});

test("rows name the conversation they open, using the catalog title", async () => {
  const transcript = path.join(sandbox, "route-title.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({
    type: "user",
    timestamp: "2026-08-20T14:20:00.000Z",
    message: { content: "collect the marigold numbers" },
  }) + "\n");
  const stat = fs.statSync(transcript);
  await indexTranscriptSources([{
    path: transcript,
    project: "reports",
    engine: "claude",
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  }], { complete: true });
  replaceConversationCatalog([{
    path: transcript,
    root: "claude-projects",
    name: "route-title.jsonl",
    project: "reports",
    title: "Marigold weekly numbers",
    firstPrompt: "collect the marigold numbers",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    mtime: 1,
    size: stat.size,
  }]);

  const page = await (await GET(new Request("http://127.0.0.1/api/search/transcripts?q=marigold"))).json() as Page;

  expect(page.items).toEqual([expect.objectContaining({
    transcriptPath: transcript,
    title: "Marigold weekly numbers",
  })]);
});

test("a transcript the catalog has no title for still returns a row", async () => {
  const transcript = path.join(sandbox, "route-untitled.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({
    type: "user",
    timestamp: "2026-08-20T14:30:00.000Z",
    message: { content: "note the amaranth deadline" },
  }) + "\n");
  const stat = fs.statSync(transcript);
  await indexTranscriptSources([{
    path: transcript,
    project: "reports",
    engine: "claude",
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  }], { complete: true });
  replaceConversationCatalog([]);

  const page = await (await GET(new Request("http://127.0.0.1/api/search/transcripts?q=amaranth"))).json() as Page;

  expect(page.items).toEqual([expect.objectContaining({ transcriptPath: transcript, title: null })]);
});
