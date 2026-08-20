import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { indexTranscriptSources } from "@/lib/search/transcriptSearch";

import { GET } from "./route";

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

test("rejects a missing query instead of returning an ambiguous empty page", async () => {
  const response = await GET(new Request("http://127.0.0.1/api/search/transcripts"));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "q is required" });
});
