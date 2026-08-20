import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { scheduleTranscriptIndex, waitForTranscriptIndexIdleForTests } from "./transcriptFeed";
import { indexTranscriptSources, searchTranscripts, type TranscriptIndexSource } from "./transcriptSearch";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-transcript-feed-"));
const previousEnvironment = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  LLV_STATE_DIR: process.env.LLV_STATE_DIR,
  TMPDIR: process.env.TMPDIR,
};

beforeEach(async () => {
  await waitForTranscriptIndexIdleForTests();
  process.env.HOME = path.join(sandbox, "home");
  process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
  process.env.LLV_STATE_DIR = path.join(sandbox, "state");
  process.env.TMPDIR = path.join(sandbox, "tmp");
  fs.rmSync(process.env.LLV_STATE_DIR, { recursive: true, force: true });
  fs.mkdirSync(process.env.TMPDIR, { recursive: true });
});

afterAll(async () => {
  await waitForTranscriptIndexIdleForTests();
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("starts initial indexing after the caller returns and completes it in the background", async () => {
  const transcript = path.join(sandbox, "background-session.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "background saffron body" } }) + "\n");
  const stat = fs.statSync(transcript);
  const sources: TranscriptIndexSource[] = [{
    path: transcript,
    project: "background",
    engine: "claude",
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  }];
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const run = async (nextSources: readonly TranscriptIndexSource[], complete: boolean) => {
    markStarted();
    await gate;
    await indexTranscriptSources(nextSources, { complete });
  };

  const returned = scheduleTranscriptIndex({ sources, complete: true }, { force: true, run });

  expect(returned).toBeUndefined();
  await started;
  expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, "transcript-search.sqlite"))).toBeFalse();
  release();
  await waitForTranscriptIndexIdleForTests();
  expect(searchTranscripts({ query: "saffron" }).items).toHaveLength(1);
});
