import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "../types";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-links-performance-test-"));
const REAL_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const { linkEntries } = await import("./links");
const { ROOTS } = await import("./roots");

afterAll(() => {
  if (REAL_STATE !== undefined) process.env.LLV_STATE_DIR = REAL_STATE;
  else delete process.env.LLV_STATE_DIR;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function entry(pathname: string, name: string, mtime: number): FileEntry {
  const stat = fs.statSync(pathname);
  return {
    path: pathname,
    root: "claude-projects",
    name,
    project: "repo",
    title: "session",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime,
    size: stat.size,
    activity: "idle",
    derivationComplete: true,
    proc: null,
    pid: null,
    model: "sonnet-4",
    pendingQuestion: null,
    waitingInput: null,
  };
}

test("compaction lineage proof reads a bounded predecessor tail", async () => {
  const slug = "-repo-bounded-compaction";
  const predecessorPath = path.join(SANDBOX, "predecessor.jsonl");
  const successorPath = path.join(SANDBOX, "successor.jsonl");
  const logicalParentUuid = "11111111-2222-4333-8444-555555555555";
  fs.writeFileSync(predecessorPath, Buffer.concat([
    Buffer.from(`${JSON.stringify({ type: "user", uuid: "head" })}\n`),
    Buffer.alloc(8 * 1024 * 1024, 0x20),
    Buffer.from(`\n${JSON.stringify({ type: "assistant", uuid: logicalParentUuid })}\n`),
  ]));
  fs.writeFileSync(successorPath, `${JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    logicalParentUuid,
  })}\n`);
  const predecessor = entry(predecessorPath, `${slug}/predecessor.jsonl`, 1);
  const successor = entry(successorPath, `${slug}/successor.jsonl`, 2);
  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  const originalClose = fs.closeSync;
  const tracked = new Set<number>();
  let bytesRead = 0;
  fs.openSync = ((filename: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const fd = originalOpen(filename, flags, mode);
    if (path.resolve(String(filename)) === predecessorPath) tracked.add(fd);
    return fd;
  }) as typeof fs.openSync;
  fs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition) => {
    const read = originalRead(fd, buffer, offset, length, position);
    if (tracked.has(fd)) bytesRead += read;
    return read;
  }) as typeof fs.readSync;
  fs.closeSync = ((fd: number) => {
    tracked.delete(fd);
    return originalClose(fd);
  }) as typeof fs.closeSync;

  try {
    await linkEntries([predecessor, successor], { persist: false });
  } finally {
    fs.openSync = originalOpen;
    fs.readSync = originalRead;
    fs.closeSync = originalClose;
  }

  expect(predecessor.parent).toBe(successor.path);
  expect(bytesRead).toBeLessThanOrEqual(1024 * 1024);
});

test("background command recovery advances within one bounded read budget", async () => {
  const projectRoot = path.join(SANDBOX, "background-projects");
  const taskRoot = path.join(SANDBOX, "background-tasks");
  const previousProjectRoot = ROOTS["claude-projects"];
  const previousTaskRoot = ROOTS["claude-tasks"];
  ROOTS["claude-projects"] = projectRoot;
  ROOTS["claude-tasks"] = taskRoot;
  const slug = "-repo-bounded-background";
  const sid = "session-bounded-background";
  const tid = "task-bounded-background";
  const toolUseId = "toolu_bounded_background";
  const mainPath = path.join(projectRoot, slug, `${sid}.jsonl`);
  const taskPath = path.join(taskRoot, slug, sid, "tasks", `${tid}.output`);
  fs.mkdirSync(path.dirname(mainPath), { recursive: true });
  fs.mkdirSync(path.dirname(taskPath), { recursive: true });
  const toolUse = JSON.stringify({
    type: "assistant",
    message: {
      content: [{
        type: "tool_use",
        id: toolUseId,
        name: "Bash",
        input: { command: "bun run bounded-worker", description: "Run bounded worker" },
      }],
    },
  });
  const filler = `${JSON.stringify({ type: "progress", payload: "x".repeat(64 * 1024) })}\n`.repeat(128);
  const banner = JSON.stringify({
    type: "user",
    tool_use_id: toolUseId,
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: toolUseId,
        content: `background with ID: ${tid}`,
      }],
    },
  });
  fs.writeFileSync(mainPath, `${toolUse}\n${filler}${banner}\n`);
  fs.writeFileSync(taskPath, "complete\n");
  const main = entry(mainPath, `${slug}/${sid}.jsonl`, 1);
  const task: FileEntry = {
    ...entry(taskPath, `${slug}/${sid}/tasks/${tid}.output`, 2),
    root: "claude-tasks",
    engine: "shell",
    fmt: "plain",
    kind: "task",
  };

  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  const originalReadFile = fs.readFileSync;
  const originalClose = fs.closeSync;
  const tracked = new Set<number>();
  let bytesRead = 0;
  try {
    await linkEntries([main], { persist: false });
    fs.openSync = ((filename: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = originalOpen(filename, flags, mode);
      if (path.resolve(String(filename)) === mainPath) tracked.add(fd);
      return fd;
    }) as typeof fs.openSync;
    fs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition) => {
      const read = originalRead(fd, buffer, offset, length, position);
      if (tracked.has(fd)) bytesRead += read;
      return read;
    }) as typeof fs.readSync;
    fs.readFileSync = ((filename: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const value = Reflect.apply(originalReadFile, fs, [filename, ...args]) as Buffer | string;
      if (typeof filename !== "number" && path.resolve(String(filename)) === mainPath) {
        bytesRead += typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
      }
      return value;
    }) as typeof fs.readFileSync;
    fs.closeSync = ((fd: number) => {
      tracked.delete(fd);
      return originalClose(fd);
    }) as typeof fs.closeSync;

    const readsByPass: number[] = [];
    for (let attempt = 0; attempt < 40 && task.cmd !== "bun run bounded-worker"; attempt += 1) {
      const before = bytesRead;
      await linkEntries([main, task], { persist: false });
      readsByPass.push(bytesRead - before);
    }

    expect(task).toMatchObject({
      parent: mainPath,
      cmd: "bun run bounded-worker",
      cmdDesc: "Run bounded worker",
      title: "Run bounded worker",
    });
    expect(Math.max(...readsByPass)).toBeLessThanOrEqual(256 * 1024);
  } finally {
    fs.openSync = originalOpen;
    fs.readSync = originalRead;
    fs.readFileSync = originalReadFile;
    fs.closeSync = originalClose;
    ROOTS["claude-projects"] = previousProjectRoot;
    ROOTS["claude-tasks"] = previousTaskRoot;
  }
});

test("proven background commands survive restart without source transcript reads", async () => {
  const projectRoot = path.join(SANDBOX, "restart-projects");
  const taskRoot = path.join(SANDBOX, "restart-tasks");
  const previousProjectRoot = ROOTS["claude-projects"];
  const previousTaskRoot = ROOTS["claude-tasks"];
  ROOTS["claude-projects"] = projectRoot;
  ROOTS["claude-tasks"] = taskRoot;
  const slug = "-repo-restart-background";
  const sid = "session-restart-background";
  const tid = "task-restart-background";
  const toolUseId = "toolu_restart_background";
  const mainPath = path.join(projectRoot, slug, `${sid}.jsonl`);
  const taskPath = path.join(taskRoot, slug, sid, "tasks", `${tid}.output`);
  fs.mkdirSync(path.dirname(mainPath), { recursive: true });
  fs.mkdirSync(path.dirname(taskPath), { recursive: true });
  fs.writeFileSync(mainPath, [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: toolUseId,
          name: "Bash",
          input: { command: "bun run restart-worker", description: "Run restart worker" },
        }],
      },
    }),
    `${JSON.stringify({ type: "progress", payload: "y".repeat(64 * 1024) })}\n`.repeat(32).trimEnd(),
    JSON.stringify({
      type: "user",
      tool_use_id: toolUseId,
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: toolUseId,
          content: `background with ID: ${tid}`,
        }],
      },
    }),
    "",
  ].join("\n"));
  fs.writeFileSync(taskPath, "complete\n");
  const main = entry(mainPath, `${slug}/${sid}.jsonl`, 1);
  const task: FileEntry = {
    ...entry(taskPath, `${slug}/${sid}/tasks/${tid}.output`, 2),
    root: "claude-tasks",
    engine: "shell",
    fmt: "plain",
    kind: "task",
  };
  const cacheStore = globalThis as typeof globalThis & { __llvCaches?: Record<string, Map<string, unknown>> };
  for (const cache of Object.values(cacheStore.__llvCaches ?? {})) cache.clear();

  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  const originalReadFile = fs.readFileSync;
  const originalClose = fs.closeSync;
  const tracked = new Set<number>();
  let bytesRead = 0;
  try {
    for (let attempt = 0; attempt < 12 && task.cmd !== "bun run restart-worker"; attempt += 1) {
      await linkEntries([main, task], { persist: true });
    }
    expect(task.cmd).toBe("bun run restart-worker");
    expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, "bg-commands.json"))).toBe(true);

    for (const cache of Object.values(cacheStore.__llvCaches ?? {})) cache.clear();
    task.parent = null;
    task.cmd = "";
    task.cmdDesc = "";
    task.title = "Background task after restart";
    await linkEntries([main], { persist: false });

    fs.appendFileSync(mainPath, `${JSON.stringify({ type: "progress", payload: "late growth" })}\n`);
    fs.openSync = ((filename: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = originalOpen(filename, flags, mode);
      if (path.resolve(String(filename)) === mainPath) tracked.add(fd);
      return fd;
    }) as typeof fs.openSync;
    fs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition) => {
      const read = originalRead(fd, buffer, offset, length, position);
      if (tracked.has(fd)) bytesRead += read;
      return read;
    }) as typeof fs.readSync;
    fs.readFileSync = ((filename: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const value = Reflect.apply(originalReadFile, fs, [filename, ...args]) as Buffer | string;
      if (typeof filename !== "number" && path.resolve(String(filename)) === mainPath) {
        bytesRead += typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
      }
      return value;
    }) as typeof fs.readFileSync;
    fs.closeSync = ((fd: number) => {
      tracked.delete(fd);
      return originalClose(fd);
    }) as typeof fs.closeSync;

    await linkEntries([main, task], { persist: false });

    expect(task).toMatchObject({
      parent: mainPath,
      cmd: "bun run restart-worker",
      cmdDesc: "Run restart worker",
      title: "Run restart worker",
    });
    expect(bytesRead).toBe(0);
  } finally {
    fs.openSync = originalOpen;
    fs.readSync = originalRead;
    fs.readFileSync = originalReadFile;
    fs.closeSync = originalClose;
    ROOTS["claude-projects"] = previousProjectRoot;
    ROOTS["claude-tasks"] = previousTaskRoot;
  }
});

test("proven compaction chains survive restart after predecessor growth", async () => {
  const slug = "-repo-restart-compaction";
  const predecessorPath = path.join(SANDBOX, "restart-predecessor.jsonl");
  const successorPath = path.join(SANDBOX, "restart-successor.jsonl");
  const logicalParentUuid = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  fs.writeFileSync(predecessorPath, Buffer.concat([
    Buffer.alloc(2 * 1024 * 1024, 0x20),
    Buffer.from(`\n${JSON.stringify({ type: "assistant", uuid: logicalParentUuid })}\n`),
  ]));
  fs.writeFileSync(successorPath, `${JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    logicalParentUuid,
  })}\n`);
  const predecessor = entry(predecessorPath, `${slug}/restart-predecessor.jsonl`, 1);
  const successor = entry(successorPath, `${slug}/restart-successor.jsonl`, 2);
  const cacheStore = globalThis as typeof globalThis & { __llvCaches?: Record<string, Map<string, unknown>> };
  for (const cache of Object.values(cacheStore.__llvCaches ?? {})) cache.clear();

  await linkEntries([predecessor, successor], { persist: true });
  expect(predecessor.parent).toBe(successor.path);
  expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, "compact-chains.json"))).toBe(true);

  for (const cache of Object.values(cacheStore.__llvCaches ?? {})) cache.clear();
  predecessor.parent = null;
  fs.appendFileSync(predecessorPath, Buffer.alloc(2 * 1024 * 1024, 0x20));
  predecessor.size = fs.statSync(predecessorPath).size;
  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  const originalClose = fs.closeSync;
  const tracked = new Set<number>();
  let bytesRead = 0;
  fs.openSync = ((filename: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const fd = originalOpen(filename, flags, mode);
    if (path.resolve(String(filename)) === predecessorPath) tracked.add(fd);
    return fd;
  }) as typeof fs.openSync;
  fs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition) => {
    const read = originalRead(fd, buffer, offset, length, position);
    if (tracked.has(fd)) bytesRead += read;
    return read;
  }) as typeof fs.readSync;
  fs.closeSync = ((fd: number) => {
    tracked.delete(fd);
    return originalClose(fd);
  }) as typeof fs.closeSync;

  try {
    await linkEntries([predecessor, successor], { persist: false });
  } finally {
    fs.openSync = originalOpen;
    fs.readSync = originalRead;
    fs.closeSync = originalClose;
  }

  expect(predecessor.parent).toBe(successor.path);
  expect(bytesRead).toBeLessThanOrEqual(512 * 1024);
});
