import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "../types";
import { entryEffort } from "./effort";
import { entryModels } from "./model";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-metadata-head-test-"));

afterAll(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

function entry(pathname: string): FileEntry {
  const stat = fs.statSync(pathname);
  return {
    path: pathname,
    root: "codex-sessions",
    name: path.basename(pathname),
    project: "proj",
    title: "session",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: stat.mtimeMs / 1000,
    size: stat.size,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

test("large append-only transcripts keep model and effort head reads bounded", () => {
  const pathname = path.join(SANDBOX, "large-codex.jsonl");
  const padding = JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", content: "x".repeat(2 * 1024 * 1024) },
  }) + "\n";
  fs.writeFileSync(pathname, [
    JSON.stringify({ type: "session_meta", payload: { model: "gpt-5.6-sol" } }),
    JSON.stringify({ type: "turn_context", payload: { effort: "xhigh" } }),
    padding,
  ].join("\n"));

  const originalReadFileSync = fs.readFileSync;
  const originalOpenSync = fs.openSync;
  const originalReadSync = fs.readSync;
  const originalCloseSync = fs.closeSync;
  const targetFds = new Set<number>();
  let wholeFileReads = 0;
  let targetOpens = 0;
  let largestRead = 0;

  fs.readFileSync = ((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (typeof target !== "number" && path.resolve(String(target)) === pathname) {
      wholeFileReads += 1;
      throw new Error("whole-file transcript read");
    }
    return Reflect.apply(originalReadFileSync, fs, [target, ...args]);
  }) as typeof fs.readFileSync;
  fs.openSync = ((target: fs.PathLike, ...args: unknown[]) => {
    const fd = Reflect.apply(originalOpenSync, fs, [target, ...args]) as number;
    if (path.resolve(String(target)) === pathname) {
      targetFds.add(fd);
      targetOpens += 1;
    }
    return fd;
  }) as typeof fs.openSync;
  fs.readSync = ((fd: number, ...args: unknown[]) => {
    if (targetFds.has(fd) && typeof args[2] === "number") largestRead = Math.max(largestRead, args[2]);
    return Reflect.apply(originalReadSync, fs, [fd, ...args]);
  }) as typeof fs.readSync;
  fs.closeSync = ((fd: number) => {
    targetFds.delete(fd);
    return originalCloseSync(fd);
  }) as typeof fs.closeSync;

  try {
    expect(entryModels(entry(pathname))).toEqual({ display: "gpt-5.6-sol", launch: "gpt-5.6-sol" });
    expect(entryEffort(entry(pathname))).toBe("xhigh");

    fs.appendFileSync(pathname, padding);
    expect(entryModels(entry(pathname))).toEqual({ display: "gpt-5.6-sol", launch: "gpt-5.6-sol" });
    expect(entryEffort(entry(pathname))).toBe("xhigh");
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.openSync = originalOpenSync;
    fs.readSync = originalReadSync;
    fs.closeSync = originalCloseSync;
  }

  expect(wholeFileReads).toBe(0);
  expect(largestRead).toBeLessThanOrEqual(128 * 1024);
  expect(targetOpens).toBe(4);
});
