import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { TranscriptIndexFeed } from "@/lib/search/transcriptFeed";

import { discoverFilesWithProjectCatalog } from "./discover";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-search-feed-scan-"));
const previousEnvironment = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  LLV_STATE_DIR: process.env.LLV_STATE_DIR,
  TMPDIR: process.env.TMPDIR,
};

process.env.HOME = path.join(sandbox, "home");
process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.TMPDIR = path.join(sandbox, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

afterAll(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function writeCodex(root: string, name: string, cwd: string): string {
  const transcript = path.join(root, "2026", "08", "20", name);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: "session_meta", payload: { cwd, timestamp: "2026-08-20T09:00:00.000Z" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: `prompt ${name}` } }),
  ].join("\n") + "\n");
  return transcript;
}

function writeClaude(root: string, slug: string, name: string, cwd: string): string {
  const transcript = path.join(root, slug, name);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({
    type: "user",
    cwd,
    timestamp: "2026-08-20T09:00:00.000Z",
    message: { content: `prompt ${name}` },
  }) + "\n");
  return transcript;
}

test("feeds every configured Codex and Claude transcript store into one background inventory", async () => {
  const workspace = path.join(sandbox, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const codexShared = path.join(sandbox, "codex-shared");
  const codexAccount = path.join(sandbox, "codex-account");
  const claudeShared = path.join(sandbox, "claude-shared");
  const claudeNative = path.join(sandbox, "claude-native");
  const paths = [
    writeCodex(codexShared, "rollout-shared.jsonl", workspace),
    writeCodex(codexAccount, "rollout-account.jsonl", workspace),
    writeClaude(claudeShared, "workspace-a", "shared.jsonl", workspace),
    writeClaude(claudeNative, "workspace-b", "native.jsonl", workspace),
  ];
  let feed: TranscriptIndexFeed | undefined;

  const scan = await discoverFilesWithProjectCatalog([
    ["codex-sessions", codexShared],
    ["codex-sessions", codexAccount],
    ["claude-projects", claudeShared],
    ["claude-projects", claudeNative],
  ], undefined, {
    persist: false,
    transcriptIndexScheduler: (next) => { feed = next; },
  });

  expect(scan.complete).toBeTrue();
  expect(feed?.complete).toBeTrue();
  expect(feed?.sources.map((entry) => entry.path).sort()).toEqual(paths.sort());
  expect(feed?.sources.filter((entry) => entry.engine === "codex")).toHaveLength(2);
  expect(feed?.sources.filter((entry) => entry.engine === "claude")).toHaveLength(2);
});
