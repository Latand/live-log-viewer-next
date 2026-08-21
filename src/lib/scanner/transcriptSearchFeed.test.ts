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

test("feeds a dual-root Codex rollout once and keeps the account-root copy", async () => {
  const workspace = path.join(sandbox, "dual-root-workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const codexNative = path.join(sandbox, "dual-root-native");
  const codexAccount = path.join(sandbox, "dual-root-account");
  const rollout = "rollout-dual-root-fixture.jsonl";
  const nativePath = writeCodex(codexNative, rollout, workspace);
  const accountPath = writeCodex(codexAccount, rollout, workspace);
  let feed: TranscriptIndexFeed | undefined;

  await discoverFilesWithProjectCatalog([
    ["codex-sessions", codexNative],
    ["codex-sessions", codexAccount],
  ], undefined, {
    persist: false,
    transcriptIndexScheduler: (next) => { feed = next; },
  });

  expect(feed?.complete).toBeTrue();
  expect(feed?.sources).toHaveLength(1);
  expect(feed?.sources[0]?.path).toBe(accountPath);
  expect(feed?.sources[0]?.path).not.toBe(nativePath);
});

test("a direct scan invalidated by a newer generation does not publish its stale inventory", async () => {
  const workspace = path.join(sandbox, "overlap-workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const olderRoot = path.join(sandbox, "overlap-older");
  const newerRoot = path.join(sandbox, "overlap-newer");
  const olderPath = writeCodex(olderRoot, "rollout-older.jsonl", workspace);
  const newerPath = writeCodex(newerRoot, "rollout-newer.jsonl", workspace);
  let olderFeed: TranscriptIndexFeed | undefined;
  let newerFeed: TranscriptIndexFeed | undefined;
  let newerScan: ReturnType<typeof discoverFilesWithProjectCatalog> | undefined;
  let markNewerStarted: (() => void) | undefined;
  const newerStarted = new Promise<void>((resolve) => { markNewerStarted = resolve; });

  const olderScan = discoverFilesWithProjectCatalog(
    [["codex-sessions", olderRoot]],
    undefined,
    {
      persist: false,
      onResourceSnapshot: () => {
        newerScan = discoverFilesWithProjectCatalog(
          [["codex-sessions", newerRoot]],
          undefined,
          {
            persist: false,
            transcriptIndexScheduler: (feed) => { newerFeed = feed; },
          },
        );
        markNewerStarted?.();
      },
      transcriptIndexScheduler: (feed) => { olderFeed = feed; },
    },
  );

  await newerStarted;
  await Promise.all([olderScan, newerScan!]);

  expect(olderFeed).toBeUndefined();
  expect(newerFeed?.sources.map((entry) => entry.path)).toEqual([newerPath]);
  expect(newerFeed?.sources.map((entry) => entry.path)).not.toContain(olderPath);
});
