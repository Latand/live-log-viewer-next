import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "../types";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-links-performance-test-"));
const REAL_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const { linkEntries, primePersistedLineageFacts } = await import("./links");
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
  const logicalParentUuid = "11111111-2222-0333-0444-555555555555";
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

test("many compaction probes share one bounded tail read for a growing candidate", async () => {
  const slug = "-repo-shared-compaction-tail";
  const candidatePath = path.join(SANDBOX, "shared-growing-candidate.jsonl");
  fs.writeFileSync(candidatePath, Buffer.concat([
    Buffer.from(`${JSON.stringify({ type: "user", uuid: "head" })}\n`),
    Buffer.alloc(8 * 1024 * 1024, 0x20),
    Buffer.from(`\n${JSON.stringify({ type: "assistant", uuid: "aaaaaaaa-bbbb-0ccc-0ddd-eeeeeeeeeeee" })}\n`),
  ]));
  const candidate = entry(candidatePath, `${slug}/candidate.jsonl`, 1);
  const successors = Array.from({ length: 32 }, (_, index) => {
    const logicalParentUuid = `11111111-2222-0333-0444-${String(index).padStart(12, "0")}`;
    const successorPath = path.join(SANDBOX, `shared-successor-${index}.jsonl`);
    fs.writeFileSync(successorPath, `${JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      logicalParentUuid,
    })}\n`);
    return entry(successorPath, `${slug}/successor-${index}.jsonl`, index + 2);
  });

  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  const originalClose = fs.closeSync;
  const tracked = new Set<number>();
  let bytesRead = 0;
  fs.openSync = ((filename: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const fd = originalOpen(filename, flags, mode);
    if (path.resolve(String(filename)) === candidatePath) tracked.add(fd);
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
    await linkEntries([candidate, ...successors], { persist: false });
  } finally {
    fs.openSync = originalOpen;
    fs.readSync = originalRead;
    fs.closeSync = originalClose;
  }

  /* The candidate also pays the independent 512 KiB compact-marker discovery
     read once. All 32 UUID lineage probes share the remaining 1 MiB tail read. */
  expect(bytesRead).toBeLessThanOrEqual(1536 * 1024);
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

test("background command recovery rescans replacement head after shrink above its offset", async () => {
  const projectRoot = path.join(SANDBOX, "shrunken-background-projects");
  const taskRoot = path.join(SANDBOX, "shrunken-background-tasks");
  const previousProjectRoot = ROOTS["claude-projects"];
  const previousTaskRoot = ROOTS["claude-tasks"];
  ROOTS["claude-projects"] = projectRoot;
  ROOTS["claude-tasks"] = taskRoot;
  const slug = "-repo-shrunken-background";
  const sid = "session-shrunken-background";
  const tid = "task-shrunken-background";
  const toolUseId = "toolu_shrunken_background";
  const mainPath = path.join(projectRoot, slug, `${sid}.jsonl`);
  const taskPath = path.join(taskRoot, slug, sid, "tasks", `${tid}.output`);
  fs.mkdirSync(path.dirname(mainPath), { recursive: true });
  fs.mkdirSync(path.dirname(taskPath), { recursive: true });
  fs.writeFileSync(mainPath, Buffer.alloc(512 * 1024, 0x78));
  fs.writeFileSync(taskPath, "complete\n");
  const main = entry(mainPath, `fixture/${slug}/${sid}.jsonl`, 1);
  const task: FileEntry = {
    ...entry(taskPath, `${slug}/${sid}/tasks/${tid}.output`, 2),
    root: "claude-tasks",
    engine: "shell",
    fmt: "plain",
    kind: "task",
  };

  try {
    await linkEntries([main, task], { persist: false });
    expect(task.cmd).toBe("");

    const proof = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{
          type: "tool_use",
          id: toolUseId,
          name: "Bash",
          input: { command: "bun run replacement-worker", description: "Run replacement worker" },
        }] },
      }),
      JSON.stringify({
        type: "user",
        tool_use_id: toolUseId,
        message: { content: [{
          type: "tool_result",
          tool_use_id: toolUseId,
          content: `background with ID: ${tid}`,
        }] },
      }),
      "",
    ].join("\n");
    const replacement = Buffer.alloc(384 * 1024, 0x20);
    replacement.write(proof, 0, "utf8");
    fs.writeFileSync(mainPath, replacement);
    main.size = replacement.length;
    main.mtime = fs.statSync(mainPath).mtimeMs / 1000;

    await linkEntries([main, task], { persist: false });
    expect(task).toMatchObject({
      parent: mainPath,
      cmd: "bun run replacement-worker",
      cmdDesc: "Run replacement worker",
      title: "Run replacement worker",
    });
  } finally {
    ROOTS["claude-projects"] = previousProjectRoot;
    ROOTS["claude-tasks"] = previousTaskRoot;
  }
});

test("background command recovery reserves a bounded fair share for later candidates", async () => {
  const projectRoot = path.join(SANDBOX, "fair-background-projects");
  const taskRoot = path.join(SANDBOX, "fair-background-tasks");
  const previousProjectRoot = ROOTS["claude-projects"];
  const previousTaskRoot = ROOTS["claude-tasks"];
  ROOTS["claude-projects"] = projectRoot;
  ROOTS["claude-tasks"] = taskRoot;
  const slug = "-repo-fair-background";
  const blockedSid = "session-blocked-background";
  const resolvedSid = "session-resolved-background";
  const blockedTid = "task-blocked-background";
  const resolvedTid = "task-resolved-background";
  const toolUseId = "toolu_resolved_background";
  const blockedMainPath = path.join(projectRoot, slug, `${blockedSid}.jsonl`);
  const resolvedMainPath = path.join(projectRoot, slug, `${resolvedSid}.jsonl`);
  const blockedTaskPath = path.join(taskRoot, slug, blockedSid, "tasks", `${blockedTid}.output`);
  const resolvedTaskPath = path.join(taskRoot, slug, resolvedSid, "tasks", `${resolvedTid}.output`);
  fs.mkdirSync(path.dirname(blockedMainPath), { recursive: true });
  fs.mkdirSync(path.dirname(resolvedMainPath), { recursive: true });
  fs.mkdirSync(path.dirname(blockedTaskPath), { recursive: true });
  fs.mkdirSync(path.dirname(resolvedTaskPath), { recursive: true });
  fs.writeFileSync(blockedMainPath, Buffer.alloc(512 * 1024, 0x78));
  fs.writeFileSync(resolvedMainPath, [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: toolUseId,
          name: "Bash",
          input: { command: "bun run fair-worker", description: "Run fair worker" },
        }],
      },
    }),
    JSON.stringify({
      type: "user",
      tool_use_id: toolUseId,
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: toolUseId,
          content: `background with ID: ${resolvedTid}`,
        }],
      },
    }),
    "",
  ].join("\n"));
  fs.writeFileSync(blockedTaskPath, "complete\n");
  fs.writeFileSync(resolvedTaskPath, "complete\n");
  /* Fixture names avoid compact-chain probes; this
     regression measures only the background-command generation allowance. */
  const blockedMain = entry(blockedMainPath, `fixture/${slug}/${blockedSid}.jsonl`, 1);
  const resolvedMain = entry(resolvedMainPath, `fixture/${slug}/${resolvedSid}.jsonl`, 2);
  const blockedTask: FileEntry = {
    ...entry(blockedTaskPath, `${slug}/${blockedSid}/tasks/${blockedTid}.output`, 3),
    root: "claude-tasks",
    engine: "shell",
    fmt: "plain",
    kind: "task",
  };
  const resolvedTask: FileEntry = {
    ...entry(resolvedTaskPath, `${slug}/${resolvedSid}/tasks/${resolvedTid}.output`, 4),
    root: "claude-tasks",
    engine: "shell",
    fmt: "plain",
    kind: "task",
  };
  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  const originalClose = fs.closeSync;
  const tracked = new Map<number, string>();
  let blockedBytesRead = 0;
  let totalBytesRead = 0;

  try {
    fs.openSync = ((filename: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = originalOpen(filename, flags, mode);
      const resolved = path.resolve(String(filename));
      if (resolved === blockedMainPath || resolved === resolvedMainPath) tracked.set(fd, resolved);
      return fd;
    }) as typeof fs.openSync;
    fs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition) => {
      const read = originalRead(fd, buffer, offset, length, position);
      const source = tracked.get(fd);
      if (source) {
        totalBytesRead += read;
        if (source === blockedMainPath) blockedBytesRead += read;
      }
      return read;
    }) as typeof fs.readSync;
    fs.closeSync = ((fd: number) => {
      tracked.delete(fd);
      return originalClose(fd);
    }) as typeof fs.closeSync;
    await linkEntries([blockedMain, blockedTask, resolvedMain, resolvedTask], { persist: false });

    expect(blockedBytesRead).toBeLessThanOrEqual(128 * 1024);
    expect(totalBytesRead).toBeLessThanOrEqual(256 * 1024);
    expect(resolvedTask).toMatchObject({
      parent: resolvedMainPath,
      cmd: "bun run fair-worker",
      cmdDesc: "Run fair worker",
      title: "Run fair worker",
    });
  } finally {
    fs.openSync = originalOpen;
    fs.readSync = originalRead;
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

test("a snapshot heuristic edge cannot outrank a provable compaction predecessor", async () => {
  const slug = "-repo-heuristic-compaction";
  const successorPath = path.join(SANDBOX, "heuristic-successor.jsonl");
  const provenPath = path.join(SANDBOX, "heuristic-proven.jsonl");
  const strayPath = path.join(SANDBOX, "heuristic-stray.jsonl");
  const logicalParentUuid = "bbbbbbbb-cccc-0ddd-0eee-ffffffffffff";
  fs.writeFileSync(successorPath, `${JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    logicalParentUuid,
  })}\n`);
  fs.writeFileSync(provenPath, `${JSON.stringify({ type: "assistant", uuid: logicalParentUuid })}\n`);
  fs.writeFileSync(strayPath, `${JSON.stringify({ type: "user", uuid: "unrelated" })}\n`);
  const successor = entry(successorPath, `${slug}/heuristic-successor.jsonl`, 3);
  successor.activity = "live";
  const proven = entry(provenPath, `${slug}/heuristic-proven.jsonl`, 2);
  const stray = entry(strayPath, `${slug}/heuristic-stray.jsonl`, 1);

  /* The persisted snapshot carried the nearest-older fallback taken while the
     live successor had no provable predecessor on disk. That edge is a guess,
     not an immutable fact, so a later generation with the true predecessor
     visible must re-prove instead of trusting the primed guess. */
  const snapshotSuccessor = { ...successor };
  const snapshotStray = { ...stray, parent: successor.path };
  primePersistedLineageFacts([snapshotSuccessor, snapshotStray]);

  await linkEntries([successor, proven, stray], { persist: false });

  expect(proven.parent).toBe(successor.path);
  expect(stray.parent).toBeNull();
});

test("proven compaction chains survive restart after predecessor growth", async () => {
  const slug = "-repo-restart-compaction";
  const predecessorPath = path.join(SANDBOX, "restart-predecessor.jsonl");
  const successorPath = path.join(SANDBOX, "restart-successor.jsonl");
  const logicalParentUuid = "66666666-7777-0888-0999-aaaaaaaaaaaa";
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

  expect(predecessor.parent as string | null).toBe(successor.path);
  expect(bytesRead).toBeLessThanOrEqual(512 * 1024);
});
