import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "./types";
import { projectTimeline } from "./timeline";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-timeline-cache-test-"));

afterAll(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

function entry(pathname: string): FileEntry {
  const stat = fs.statSync(pathname);
  return {
    path: pathname,
    root: "codex-sessions",
    name: path.basename(pathname),
    project: "timeline-project",
    title: "Timeline actor",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: stat.mtimeMs / 1000,
    size: stat.size,
    activity: "recent",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

function agentMessage(message: string): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    payload: { type: "agent_message", message },
  }) + "\n";
}

test("timeline cache invalidates a same-size rewrite by mtime", () => {
  const pathname = path.join(SANDBOX, "same-size.jsonl");
  fs.writeFileSync(pathname, agentMessage("alpha"));
  const first = entry(pathname);
  expect(projectTimeline([first], first.project, 10).map((event) => event.label)).toEqual(["alpha"]);

  fs.writeFileSync(pathname, agentMessage("bravo"));
  fs.utimesSync(pathname, new Date(), new Date(first.mtime * 1000 + 1_000));
  const rewritten = entry(pathname);
  expect(rewritten.size).toBe(first.size);
  expect(projectTimeline([rewritten], rewritten.project, 10).map((event) => event.label)).toEqual(["bravo"]);
});

test("an incomplete timeline read stays retryable for the same identity", () => {
  const pathname = path.join(SANDBOX, "retryable-eio.jsonl");
  fs.writeFileSync(pathname, agentMessage("recovered"));
  const file = entry(pathname);
  const originalOpenSync = fs.openSync;
  let blocked = true;
  fs.openSync = ((target: fs.PathLike, ...args: unknown[]) => {
    if (blocked && path.resolve(String(target)) === pathname) {
      const error = new Error("timeline EIO") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    }
    return Reflect.apply(originalOpenSync, fs, [target, ...args]) as number;
  }) as typeof fs.openSync;
  try {
    expect(projectTimeline([file], file.project, 10)).toEqual([]);
    blocked = false;
    expect(projectTimeline([file], file.project, 10).map((event) => event.label)).toEqual(["recovered"]);
  } finally {
    fs.openSync = originalOpenSync;
  }
});
