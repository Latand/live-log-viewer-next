import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "../types";
import { activityVerdict } from "./activity";
import { describeFile } from "./describe";
import { entryEffort } from "./effort";
import { readHead } from "./head";
import { entryModels } from "./model";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-metadata-head-test-"));

afterAll(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

function entry(pathname: string, engine: "codex" | "claude" = "codex"): FileEntry {
  const stat = fs.statSync(pathname);
  return {
    path: pathname,
    root: engine === "codex" ? "codex-sessions" : "claude-projects",
    name: path.basename(pathname),
    project: "proj",
    title: "session",
    engine,
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

function splitUtf8Row(): string {
  const prefix = '{"type":"response_item","payload":{"content":"';
  const suffix = '"}}\n';
  const filler = "x".repeat(128 * 1024 - Buffer.byteLength(prefix) - 2);
  return prefix + filler + "💚" + suffix;
}

function largeTail(): string {
  return JSON.stringify({ type: "response_item", payload: { content: "z".repeat(256 * 1024) } }) + "\n";
}

function tailMetadataFixture(name: string): string {
  const pathname = path.join(SANDBOX, name);
  fs.writeFileSync(pathname, [
    JSON.stringify({ type: "session_meta", payload: { model: "gpt-head" } }),
    JSON.stringify({ type: "turn_context", payload: { effort: "low" } }),
    JSON.stringify({ type: "response_item", payload: { content: "x".repeat(300_000) } }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-tail", effort: "xhigh" } }),
  ].join("\n") + "\n");
  return pathname;
}

function withTailReadPatch<T>(
  pathname: string,
  patch: (original: typeof fs.readSync, fd: number, args: unknown[]) => number,
  run: () => T,
): T {
  const tailOffset = Math.max(0, fs.statSync(pathname).size - 131_072);
  const originalOpenSync = fs.openSync;
  const originalReadSync = fs.readSync;
  const originalCloseSync = fs.closeSync;
  const targetFds = new Set<number>();
  const tailFds = new Set<number>();
  fs.openSync = ((target: fs.PathLike, ...args: unknown[]) => {
    const fd = Reflect.apply(originalOpenSync, fs, [target, ...args]) as number;
    if (path.resolve(String(target)) === pathname) targetFds.add(fd);
    return fd;
  }) as typeof fs.openSync;
  fs.readSync = ((fd: number, ...args: unknown[]) => {
    if (targetFds.has(fd) && !tailFds.has(fd) && args[3] === tailOffset) tailFds.add(fd);
    if (tailFds.has(fd)) return patch(originalReadSync, fd, args);
    return Reflect.apply(originalReadSync, fs, [fd, ...args]);
  }) as typeof fs.readSync;
  fs.closeSync = ((fd: number) => {
    targetFds.delete(fd);
    tailFds.delete(fd);
    return originalCloseSync(fd);
  }) as typeof fs.closeSync;
  try {
    return run();
  } finally {
    fs.openSync = originalOpenSync;
    fs.readSync = originalReadSync;
    fs.closeSync = originalCloseSync;
  }
}

test("metadata after a large UTF-8-splitting early row preserves Codex and Claude projections", () => {
  const codexPath = path.join(SANDBOX, "large-first-row-codex.jsonl");
  fs.writeFileSync(codexPath, splitUtf8Row() + [
    JSON.stringify({ type: "session_meta", payload: { model: "gpt-5.6-sol" } }),
    JSON.stringify({ type: "turn_context", payload: { effort: "xhigh" } }),
  ].join("\n") + "\n" + largeTail());

  expect(entryModels(entry(codexPath))).toEqual({ display: "gpt-5.6-sol", launch: "gpt-5.6-sol" });
  expect(entryEffort(entry(codexPath))).toBe("xhigh");

  const claudePath = path.join(SANDBOX, "large-first-row-claude.jsonl");
  fs.writeFileSync(claudePath, splitUtf8Row() + JSON.stringify({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-20250514",
      content: [{ type: "thinking", thinking: "", signature: "sig" }],
    },
  }) + "\n" + largeTail());

  expect(entryModels(entry(claudePath, "claude"))).toEqual({
    display: "sonnet-4",
    launch: "claude-sonnet-4-20250514",
  });
  expect(entryEffort(entry(claudePath, "claude"))).toBe("high");
});

test("one shared prefix serves cold, append, and same-size rewrite projections", () => {
  const pathname = path.join(SANDBOX, "shared-prefix.jsonl");
  const transcript = (model: string, effort: string) => [
    JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/shared", model } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "Shared title" } }),
    JSON.stringify({ type: "turn_context", payload: { effort } }),
    largeTail().trimEnd(),
  ].join("\n") + "\n";
  fs.writeFileSync(pathname, transcript("gpt-5.6-sol", "xhigh"));

  const originalOpenSync = fs.openSync;
  const originalReadSync = fs.readSync;
  const originalCloseSync = fs.closeSync;
  const targetFds = new Set<number>();
  let positionZeroReads = 0;
  let tailReads = 0;
  fs.openSync = ((target: fs.PathLike, ...args: unknown[]) => {
    const fd = Reflect.apply(originalOpenSync, fs, [target, ...args]) as number;
    if (path.resolve(String(target)) === pathname) targetFds.add(fd);
    return fd;
  }) as typeof fs.openSync;
  fs.readSync = ((fd: number, ...args: unknown[]) => {
    if (targetFds.has(fd) && args[3] === 0) positionZeroReads += 1;
    if (targetFds.has(fd)) {
      const tailOffset = Math.max(0, fs.fstatSync(fd).size - 131_072);
      if (args[3] === tailOffset) tailReads += 1;
    }
    return Reflect.apply(originalReadSync, fs, [fd, ...args]);
  }) as typeof fs.readSync;
  fs.closeSync = ((fd: number) => {
    targetFds.delete(fd);
    return originalCloseSync(fd);
  }) as typeof fs.closeSync;

  const derive = () => {
    const stat = fs.statSync(pathname);
    activityVerdict("codex-sessions", pathname, stat.mtimeMs / 1000, stat.size);
    describeFile("codex-sessions", SANDBOX, pathname, stat);
    return { model: entryModels(entry(pathname)), effort: entryEffort(entry(pathname)) };
  };

  try {
    expect(derive()).toEqual({
      model: { display: "gpt-5.6-sol", launch: "gpt-5.6-sol" },
      effort: "xhigh",
    });

    const rewritten = transcript("gpt-5.5-sol", "ultra");
    fs.writeFileSync(pathname, rewritten);
    const nextMtime = Date.now() / 1000 + 2;
    fs.utimesSync(pathname, nextMtime, nextMtime);
    expect(derive()).toEqual({
      model: { display: "gpt-5.5-sol", launch: "gpt-5.5-sol" },
      effort: "ultra",
    });

    fs.appendFileSync(pathname, JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant" } }) + "\n");
    expect(derive().effort).toBe("ultra");
  } finally {
    fs.openSync = originalOpenSync;
    fs.readSync = originalReadSync;
    fs.closeSync = originalCloseSync;
  }

  expect(positionZeroReads).toBe(3);
  expect(tailReads).toBe(3);
});

test("legal short tail reads retain newest model and effort precedence", () => {
  const pathname = tailMetadataFixture("short-tail-codex.jsonl");
  const value = withTailReadPatch(pathname, (original, fd, args) => {
    return Reflect.apply(original, fs, [fd, args[0], args[1], Math.min(args[2] as number, 7), args[3]]) as number;
  }, () => ({ model: entryModels(entry(pathname)), effort: entryEffort(entry(pathname)) }));

  expect(value).toEqual({
    model: { display: "gpt-tail", launch: "gpt-tail" },
    effort: "xhigh",
  });
});

for (const [name, mode] of [["early EOF", "eof"], ["transient error", "error"]] as const) {
  test(`${name} during a tail read leaves same-identity recovery uncached`, () => {
    const pathname = tailMetadataFixture(`interrupted-tail-${mode}.jsonl`);
    let blocked = true;
    const values = withTailReadPatch(pathname, (original, fd, args) => {
      if (!blocked) return Reflect.apply(original, fs, [fd, ...args]) as number;
      if (mode === "eof") return 0;
      const error = new Error("transient tail failure") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    }, () => {
      const first = { model: entryModels(entry(pathname)), effort: entryEffort(entry(pathname)) };
      blocked = false;
      const retry = { model: entryModels(entry(pathname)), effort: entryEffort(entry(pathname)) };
      return { first, retry };
    });

    expect(values.first).toEqual({
      model: { display: "gpt-head", launch: "gpt-head" },
      effort: "low",
    });
    expect(values.retry).toEqual({
      model: { display: "gpt-tail", launch: "gpt-tail" },
      effort: "xhigh",
    });
  });
}

test("legal short reads fill the bounded metadata prefix", () => {
  const pathname = path.join(SANDBOX, "short-read-codex.jsonl");
  const rows: unknown[] = [
    { type: "session_meta", payload: { model: "gpt-5.6-sol" } },
    { type: "turn_context", payload: { effort: "xhigh" } },
  ];
  while (rows.length < 41) rows.push({ type: "response_item", payload: { type: "message", role: "assistant" } });
  fs.writeFileSync(pathname, rows.map((row) => JSON.stringify(row)).join("\n") + "\n" + largeTail());

  const originalOpenSync = fs.openSync;
  const originalReadSync = fs.readSync;
  const originalCloseSync = fs.closeSync;
  const targetFds = new Set<number>();
  let headBytesRead = 0;
  let shortReadCalls = 0;
  fs.openSync = ((target: fs.PathLike, ...args: unknown[]) => {
    const fd = Reflect.apply(originalOpenSync, fs, [target, ...args]) as number;
    if (path.resolve(String(target)) === pathname) targetFds.add(fd);
    return fd;
  }) as typeof fs.openSync;
  fs.readSync = ((fd: number, ...args: unknown[]) => {
    const position = typeof args[3] === "number" ? args[3] : -1;
    if (!targetFds.has(fd) || position < 0 || position >= 128 * 1024) {
      return Reflect.apply(originalReadSync, fs, [fd, ...args]);
    }
    const requested = args[2] as number;
    const returned = Reflect.apply(originalReadSync, fs, [fd, args[0], args[1], Math.min(requested, 7), position]) as number;
    headBytesRead += returned;
    shortReadCalls += 1;
    return returned;
  }) as typeof fs.readSync;
  fs.closeSync = ((fd: number) => {
    targetFds.delete(fd);
    return originalCloseSync(fd);
  }) as typeof fs.closeSync;

  try {
    expect(entryModels(entry(pathname))).toEqual({ display: "gpt-5.6-sol", launch: "gpt-5.6-sol" });
    expect(entryEffort(entry(pathname))).toBe("xhigh");
  } finally {
    fs.openSync = originalOpenSync;
    fs.readSync = originalReadSync;
    fs.closeSync = originalCloseSync;
  }

  expect(shortReadCalls).toBeGreaterThan(1);
  expect(headBytesRead).toBeLessThanOrEqual(4 * 1024 * 1024);
});

test("a transient head read failure remains retryable for the same file identity", () => {
  const pathname = path.join(SANDBOX, "transient-head-codex.jsonl");
  fs.writeFileSync(pathname, [
    JSON.stringify({ type: "session_meta", payload: { model: "gpt-5.6-sol" } }),
    largeTail().trimEnd(),
  ].join("\n") + "\n");

  const originalOpenSync = fs.openSync;
  const originalReadSync = fs.readSync;
  const originalCloseSync = fs.closeSync;
  const targetFds = new Set<number>();
  let failed = false;
  fs.openSync = ((target: fs.PathLike, ...args: unknown[]) => {
    const fd = Reflect.apply(originalOpenSync, fs, [target, ...args]) as number;
    if (path.resolve(String(target)) === pathname) targetFds.add(fd);
    return fd;
  }) as typeof fs.openSync;
  fs.readSync = ((fd: number, ...args: unknown[]) => {
    if (targetFds.has(fd) && args[3] === 0 && !failed) {
      failed = true;
      const error = new Error("transient head failure") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    }
    return Reflect.apply(originalReadSync, fs, [fd, ...args]);
  }) as typeof fs.readSync;
  fs.closeSync = ((fd: number) => {
    targetFds.delete(fd);
    return originalCloseSync(fd);
  }) as typeof fs.closeSync;

  try {
    expect(entryModels(entry(pathname))).toEqual({ display: null, launch: null });
    expect(entryModels(entry(pathname))).toEqual({ display: "gpt-5.6-sol", launch: "gpt-5.6-sol" });
  } finally {
    fs.openSync = originalOpenSync;
    fs.readSync = originalReadSync;
    fs.closeSync = originalCloseSync;
  }
});

test("the shared head cache keeps private bytes and honors a zero-byte request", () => {
  const pathname = path.join(SANDBOX, "private-head-bytes.jsonl");
  fs.writeFileSync(pathname, "immutable\n");
  const stat = fs.statSync(pathname);

  const first = readHead(pathname, stat.size, stat.mtimeMs, { maxBytes: 8 });
  expect(first.value?.text).toBe("immutabl");
  first.value!.bytes[0] = "X".charCodeAt(0);

  const second = readHead(pathname, stat.size, stat.mtimeMs, { maxBytes: 8 });
  expect(second.value?.text).toBe("immutabl");
  expect(readHead(pathname, stat.size, stat.mtimeMs, { maxBytes: 0 }).value?.bytes).toHaveLength(0);
});

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
