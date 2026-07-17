import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

import { isRenameableSessionEntry, isRenameableTranscriptPath } from "./renameEligibility";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-rename-elig-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function entry(over: Partial<FileEntry>): Pick<FileEntry, "engine" | "kind" | "path" | "size" | "mtime"> {
  return { engine: "codex", kind: "session", path: "/x.jsonl", size: 0, mtime: 0, ...over };
}

const MAIN = '{"type":"session_meta","payload":{"id":"019f0000-0000-4000-8000-000000000001"}}\n';
const SUBAGENT = '{"type":"session_meta","payload":{"parent_thread_id":"019f0000-0000-4000-8000-0000000000aa"}}\n';

function writeTranscript(name: string, contents: string): { pathname: string; size: number } {
  const pathname = path.join(dir, name);
  fs.writeFileSync(pathname, contents);
  return { pathname, size: fs.statSync(pathname).size };
}

test("main Claude/Codex sessions are renameable, non-agent engines are not", () => {
  expect(isRenameableSessionEntry(entry({ engine: "claude", path: "/home/u/.claude/projects/p/019f0000-0000-4000-8000-000000000001.jsonl" }))).toBe(true);
  expect(isRenameableSessionEntry(entry({ engine: "shell", kind: "background" }))).toBe(false);
  expect(isRenameableSessionEntry(entry({ engine: "claude", kind: "subagent", path: "/home/u/.claude/projects/p/agent-9.jsonl" }))).toBe(false);
});

test("a native Codex subagent (parent_thread_id) is rejected despite kind=session", () => {
  const { pathname, size } = writeTranscript("rollout-2026-07-12T00-00-00-019f0000-0000-4000-8000-0000000000bb.jsonl", SUBAGENT);
  expect(isRenameableSessionEntry({ engine: "codex", kind: "session", path: pathname, size })).toBe(false);
  expect(isRenameableTranscriptPath("codex", pathname)).toBe(false);
});

test("a main Codex rollout (no parent_thread_id) is renameable", () => {
  const { pathname, size } = writeTranscript("rollout-2026-07-12T00-00-00-019f0000-0000-4000-8000-000000000001.jsonl", MAIN);
  expect(isRenameableSessionEntry({ engine: "codex", kind: "session", path: pathname, size })).toBe(true);
  expect(isRenameableTranscriptPath("codex", pathname)).toBe(true);
});

test("scanner identity avoids another filesystem stat during Codex eligibility projection", () => {
  const { pathname, size } = writeTranscript("rollout-2026-07-12T00-00-00-019f0000-0000-4000-8000-0000000000cc.jsonl", SUBAGENT);
  const mtime = fs.statSync(pathname).mtimeMs / 1_000;
  const originalStat = fs.statSync.bind(fs);
  const stat = spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike, options?: unknown) => {
    if (target === pathname) throw new Error("unexpected transcript stat");
    return originalStat(target, options as never);
  }) as typeof fs.statSync);
  try {
    expect(isRenameableSessionEntry({ engine: "codex", kind: "session", path: pathname, size, mtime })).toBe(false);
  } finally {
    stat.mockRestore();
  }
});
