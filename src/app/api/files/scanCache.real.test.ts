import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-files-real-scan-"));
const previousStateDir = process.env.LLV_STATE_DIR;
const previousCodexHome = process.env.LLV_CODEX_HOME;
const previousClaudeHome = process.env.LLV_CLAUDE_HOME;
const previousTmpdir = process.env.TMPDIR;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_CODEX_HOME = path.join(sandbox, "codex");
process.env.LLV_CLAUDE_HOME = path.join(sandbox, "claude");
process.env.TMPDIR = path.join(sandbox, "tmp");

const sessions = path.join(process.env.LLV_CODEX_HOME, "sessions");
fs.mkdirSync(sessions, { recursive: true });

const { listFilesWithProjectCatalog } = await import("@/lib/scanner");
const { ROOTS } = await import("@/lib/scanner/roots");
const { cachedFileScan, currentFileScan, resetFilesRouteCacheForTests } = await import("@/lib/scanner/scanCache");
const { linkEntries } = await import("@/lib/scanner/links");
const { activityVerdict, transcriptTurnResult } = await import("@/lib/scanner/activity");
const { entryEffort } = await import("@/lib/scanner/effort");
const { entryModels } = await import("@/lib/scanner/model");
const { planFor, goalFor } = await import("@/lib/scanner/plan");
const { ctxFor } = await import("@/lib/scanner/context");
const { lastTurnFor } = await import("@/lib/scanner/turnDuration");
const { pendingQuestionFor } = await import("@/lib/scanner/questions");
const { AgentRegistry } = await import("@/lib/agent/registry");
const { reconcileMigrationInventory } = await import("@/lib/accounts/migration/coordinator");

function writeSession(filename: string, cwd: string): string {
  const pathname = path.join(sessions, filename);
  fs.writeFileSync(pathname, `${JSON.stringify({ type: "session_meta", payload: { cwd } })}\n`, "utf8");
  return pathname;
}

async function waitForGeneration(targetGeneration: number, expectedPath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const scan = await cachedFileScan(undefined, undefined, Date.now(), undefined, targetGeneration);
    if (scan.generation >= targetGeneration && scan.snapshot.files.some((entry) => entry.path === expectedPath)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`files scan did not converge to ${expectedPath}`);
}

afterAll(() => {
  resetFilesRouteCacheForTests();
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  if (previousCodexHome === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = previousCodexHome;
  if (previousClaudeHome === undefined) delete process.env.LLV_CLAUDE_HOME;
  else process.env.LLV_CLAUDE_HOME = previousClaudeHome;
  if (previousTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmpdir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("real cached scans repair private state modes under umask 000", async () => {
  const previousTestStateDir = process.env.LLV_STATE_DIR;
  const privateStateDir = path.join(sandbox, "private-real-state");
  const projectCatalogPath = path.join(privateStateDir, "project-catalog.json");
  const scanSnapshotPath = path.join(privateStateDir, "files-scan-snapshot.json");
  const originalRename = fs.renameSync;
  const previousUmask = process.umask(0);
  const projectTemporaryModes: number[] = [];
  const snapshotTemporaryModes: number[] = [];
  try {
    process.env.LLV_STATE_DIR = privateStateDir;
    fs.mkdirSync(privateStateDir, { recursive: true, mode: 0o777 });
    fs.chmodSync(privateStateDir, 0o777);
    fs.writeFileSync(projectCatalogPath, "permissive legacy index\n", { mode: 0o666 });
    fs.writeFileSync(scanSnapshotPath, "permissive legacy snapshot\n", { mode: 0o666 });
    fs.chmodSync(projectCatalogPath, 0o666);
    fs.chmodSync(scanSnapshotPath, 0o666);
    fs.renameSync = ((source: fs.PathLike, target: fs.PathLike) => {
      if (target === projectCatalogPath) projectTemporaryModes.push(fs.statSync(source).mode & 0o777);
      if (target === scanSnapshotPath) snapshotTemporaryModes.push(fs.statSync(source).mode & 0o777);
      return originalRename(source, target);
    }) as typeof fs.renameSync;
    resetFilesRouteCacheForTests();
    writeSession("private-real.jsonl", "/repo/private-real");

    const scan = await cachedFileScan();

    expect(scan.snapshot.complete).toBe(true);
    expect(fs.statSync(privateStateDir).mode & 0o777).toBe(0o700);
    expect(projectTemporaryModes).toEqual([0o600]);
    expect(snapshotTemporaryModes).toEqual([0o600]);
    expect(fs.statSync(projectCatalogPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(scanSnapshotPath).mode & 0o777).toBe(0o600);
  } finally {
    fs.renameSync = originalRename;
    process.umask(previousUmask);
    process.env.LLV_STATE_DIR = previousTestStateDir;
    resetFilesRouteCacheForTests();
    fs.rmSync(privateStateDir, { recursive: true, force: true });
  }
});

test("a persisted completed generation avoids cold tail rereads for unchanged transcripts", async () => {
  const previousTestStateDir = process.env.LLV_STATE_DIR;
  const testStateDir = path.join(sandbox, "durable-tail-reuse-state");
  const transcript = path.join(sessions, "durable-tail-reuse.jsonl");
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalRead = fs.readSync;
  const tracked = new Set<number>();
  let transcriptReads = 0;
  try {
    process.env.LLV_STATE_DIR = testStateDir;
    resetFilesRouteCacheForTests();
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/durable-tail", model: "gpt-5" } }),
      "x".repeat(600_000),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
      "",
    ].join("\n"));
    const initial = await currentFileScan({ fresh: true });
    expect(initial.snapshot.files.find((entry) => entry.path === transcript)).toBeDefined();

    const cacheStore = globalThis as typeof globalThis & { __llvCaches?: Record<string, Map<string, unknown>> };
    for (const cache of Object.values(cacheStore.__llvCaches ?? {})) cache.clear();
    resetFilesRouteCacheForTests();
    fs.openSync = ((filename: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = originalOpen(filename, flags, mode);
      if (filename === transcript) tracked.add(fd);
      return fd;
    }) as typeof fs.openSync;
    fs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition) => {
      if (tracked.has(fd)) transcriptReads += 1;
      return originalRead(fd, buffer, offset, length, position);
    }) as typeof fs.readSync;
    fs.closeSync = ((fd: number) => {
      tracked.delete(fd);
      return originalClose(fd);
    }) as typeof fs.closeSync;

    const restarted = await cachedFileScan(undefined, undefined, 0);
    const persisted = restarted.snapshot.files.find((entry) => entry.path === transcript);
    expect(persisted).toBeDefined();
    const mtimeMs = persisted!.mtime * 1000;
    const caches = cacheStore.__llvCaches ?? {};
    expect(caches["turn-evidence-v1"]?.get(`authoritative:${transcript}`)).toMatchObject({
      size: persisted!.size,
      mtimeMs,
      codex: true,
      authoritative: true,
      turn: { state: "terminal", source: "lifecycle" },
      composerReleased: false,
    });
    expect(caches.model?.get(transcript)).toEqual([
      persisted!.size,
      mtimeMs,
      { display: persisted!.model, launch: persisted!.launchModel ?? null },
    ]);
    if (Object.hasOwn(persisted!, "effort")) {
      expect(caches.effort?.get(transcript)).toEqual([persisted!.size, mtimeMs, persisted!.effort ?? null]);
    }
    if (Object.hasOwn(persisted!, "plan")) expect(caches["plan-v2"]?.get(transcript)).toEqual([persisted!.size, mtimeMs, persisted!.plan]);
    if (Object.hasOwn(persisted!, "goal")) expect(caches["goal-v2"]?.get(transcript)).toEqual([persisted!.size, mtimeMs, persisted!.goal]);
    if (Object.hasOwn(persisted!, "ctx")) expect(caches["ctx-v2"]?.get(transcript)).toEqual([persisted!.size, mtimeMs, persisted!.ctx]);
    if (Object.hasOwn(persisted!, "lastTurn")) {
      expect(caches["last-turn-v2"]?.get(transcript)).toEqual([persisted!.size, mtimeMs, persisted!.lastTurn]);
    }

    activityVerdict(persisted!.root, transcript, persisted!.mtime, persisted!.size);
    entryModels(persisted!);
    entryEffort(persisted!);
    planFor(persisted!);
    goalFor(persisted!);
    ctxFor(persisted!);
    lastTurnFor(persisted!);
    expect(transcriptReads).toBe(0);
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
    fs.readSync = originalRead;
    fs.rmSync(transcript, { force: true });
    process.env.LLV_STATE_DIR = previousTestStateDir;
    resetFilesRouteCacheForTests();
    fs.rmSync(testStateDir, { recursive: true, force: true });
  }
}, 20_000);

test("a restart warm-start never rereads a complete multi-megabyte transcript body", async () => {
  const previousTestStateDir = process.env.LLV_STATE_DIR;
  const testStateDir = path.join(sandbox, "durable-multimegabyte-state");
  const transcript = path.join(sessions, "durable-multimegabyte.jsonl");
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalRead = fs.readSync;
  const originalReadFile = fs.readFileSync;
  const tracked = new Set<number>();
  let bytesRead = 0;
  try {
    process.env.LLV_STATE_DIR = testStateDir;
    resetFilesRouteCacheForTests();
    const filler = `${JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message_delta", delta: "x".repeat(64 * 1024) },
    })}\n`.repeat(192);
    fs.writeFileSync(transcript, [
      `${JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/durable-multimegabyte", model: "gpt-5" } })}\n`,
      filler,
      `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })}\n`,
    ].join(""));
    const bodyBytes = fs.statSync(transcript).size;
    expect(bodyBytes).toBeGreaterThan(12 * 1024 * 1024);
    fs.openSync = ((filename: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = originalOpen(filename, flags, mode);
      if (path.resolve(String(filename)) === transcript) tracked.add(fd);
      return fd;
    }) as typeof fs.openSync;
    fs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition) => {
      const read = originalRead(fd, buffer, offset, length, position);
      if (tracked.has(fd)) bytesRead += read;
      return read;
    }) as typeof fs.readSync;
    fs.readFileSync = ((filename: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const value = Reflect.apply(originalReadFile, fs, [filename, ...args]) as Buffer | string;
      if (typeof filename !== "number" && path.resolve(String(filename)) === transcript) {
        bytesRead += typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
      }
      return value;
    }) as typeof fs.readFileSync;
    fs.closeSync = ((fd: number) => {
      tracked.delete(fd);
      return originalClose(fd);
    }) as typeof fs.closeSync;

    const initial = await currentFileScan({ fresh: true });
    expect(initial.snapshot.files.find((entry) => entry.path === transcript)).toMatchObject({
      derivationComplete: true,
      activityReason: "jsonl_turn_completed",
    });
    const coldBytes = bytesRead;
    expect(coldBytes).toBeGreaterThan(0);
    expect(coldBytes).toBeLessThanOrEqual(3 * 1024 * 1024);
    expect(coldBytes).toBeLessThan(bodyBytes);
    expect(fs.existsSync(path.join(testStateDir, "files-scan-snapshot.json"))).toBe(true);

    const cacheStore = globalThis as typeof globalThis & { __llvCaches?: Record<string, Map<string, unknown>> };
    for (const cache of Object.values(cacheStore.__llvCaches ?? {})) cache.clear();
    resetFilesRouteCacheForTests();
    bytesRead = 0;

    const restarted = await cachedFileScan(undefined, undefined, 0);
    const persisted = restarted.snapshot.files.find((entry) => entry.path === transcript);
    expect(persisted).toMatchObject({ derivationComplete: true, activityReason: "jsonl_turn_completed" });
    activityVerdict(persisted!.root, transcript, persisted!.mtime, persisted!.size);
    entryModels(persisted!);
    entryEffort(persisted!);
    planFor(persisted!);
    goalFor(persisted!);
    ctxFor(persisted!);
    lastTurnFor(persisted!);
    expect(bytesRead).toBe(0);
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
    fs.readSync = originalRead;
    fs.readFileSync = originalReadFile;
    fs.rmSync(transcript, { force: true });
    process.env.LLV_STATE_DIR = previousTestStateDir;
    resetFilesRouteCacheForTests();
    fs.rmSync(testStateDir, { recursive: true, force: true });
    const cacheStore = globalThis as typeof globalThis & { __llvCaches?: Record<string, Map<string, unknown>> };
    for (const cache of Object.values(cacheStore.__llvCaches ?? {})) cache.delete(transcript);
  }
}, 30_000);

test("a persisted completed generation primes permanent lineage facts", async () => {
  const previousTestStateDir = process.env.LLV_STATE_DIR;
  const testStateDir = path.join(sandbox, "durable-lineage-reuse-state");
  const slug = "-repo-durable-lineage";
  const sid = "session-durable-lineage";
  const tid = "task-durable-lineage";
  const source = path.join(sandbox, "durable-lineage-source.jsonl");
  const task = path.join(ROOTS["claude-tasks"], slug, sid, "tasks", `${tid}.output`);
  const predecessor = path.join(sandbox, "durable-lineage-predecessor.jsonl");
  const successor = path.join(sandbox, "durable-lineage-successor.jsonl");
  const cacheStore = globalThis as typeof globalThis & { __llvCaches?: Record<string, Map<string, unknown>> };
  const makeEntry = (
    pathname: string,
    root: FileEntry["root"],
    name: string,
    overrides: Partial<FileEntry> = {},
  ): FileEntry => {
    const stat = fs.statSync(pathname);
    return {
      path: pathname,
      root,
      name,
      project: "repo",
      title: "Durable lineage",
      engine: root === "claude-tasks" ? "shell" : "claude",
      kind: root === "claude-tasks" ? "task" : "session",
      fmt: root === "claude-tasks" ? "plain" : "claude",
      parent: null,
      mtime: stat.mtimeMs / 1000,
      size: stat.size,
      activity: "idle",
      activityReason: "mtime_old",
      derivationComplete: true,
      proc: null,
      pid: null,
      model: root === "claude-tasks" ? null : "sonnet-4",
      pendingQuestion: null,
      waitingInput: null,
      ...overrides,
    };
  };
  try {
    process.env.LLV_STATE_DIR = testStateDir;
    fs.mkdirSync(path.dirname(task), { recursive: true });
    fs.writeFileSync(source, "source\n");
    fs.writeFileSync(task, "complete\n");
    fs.writeFileSync(predecessor, "predecessor\n");
    fs.writeFileSync(successor, "successor\n");
    const sourceEntry = makeEntry(source, "claude-projects", `${slug}/${sid}.jsonl`);
    const taskEntry = makeEntry(task, "claude-tasks", `${slug}/${sid}/tasks/${tid}.output`, {
      parent: source,
      cmd: "bun run durable-worker",
      cmdDesc: "Run durable worker",
      title: "Run durable worker",
    });
    const predecessorEntry = makeEntry(predecessor, "claude-projects", `${slug}/predecessor.jsonl`, {
      parent: successor,
    });
    const successorEntry = makeEntry(successor, "claude-projects", `${slug}/successor.jsonl`);
    fs.mkdirSync(testStateDir, { recursive: true });
    fs.writeFileSync(path.join(testStateDir, "files-scan-snapshot.json"), JSON.stringify({
      version: 1,
      snapshot: {
        complete: true,
        files: [sourceEntry, taskEntry, predecessorEntry, successorEntry],
        projectCatalog: [],
      },
    }));
    for (const cache of Object.values(cacheStore.__llvCaches ?? {})) cache.clear();
    resetFilesRouteCacheForTests();

    await cachedFileScan(undefined, undefined, 0);

    expect(cacheStore.__llvCaches?.bgcmd?.get(tid)).toEqual({
      command: "bun run durable-worker",
      description: "Run durable worker",
      source,
    });
    /* A snapshot parent between two mains may be the unproven nearest-older
       fallback, so it must not prime the proven compact-chain store. */
    expect(cacheStore.__llvCaches?.["compact-links-v1"]?.get(successor)).toBeUndefined();
    taskEntry.parent = null;
    taskEntry.cmd = "";
    taskEntry.cmdDesc = "";
    await linkEntries([sourceEntry, taskEntry, predecessorEntry, successorEntry], { persist: false });
    expect(taskEntry).toMatchObject({
      parent: source,
      cmd: "bun run durable-worker",
      cmdDesc: "Run durable worker",
      title: "Run durable worker",
    });
  } finally {
    for (const pathname of [source, task, predecessor, successor]) fs.rmSync(pathname, { force: true });
    process.env.LLV_STATE_DIR = previousTestStateDir;
    resetFilesRouteCacheForTests();
    fs.rmSync(testStateDir, { recursive: true, force: true });
    for (const cache of Object.values(cacheStore.__llvCaches ?? {})) cache.clear();
  }
});

test("persisted Claude question state hydrates without transcript reads and stays retryable", async () => {
  const previousTestStateDir = process.env.LLV_STATE_DIR;
  const testStateDir = path.join(sandbox, "durable-claude-questions-state");
  const projectDir = path.join(process.env.LLV_CLAUDE_HOME!, "projects", "-repo-claude-question-hydration");
  const pendingPath = path.join(projectDir, "pending-question.jsonl");
  const quietPath = path.join(projectDir, "quiet-question.jsonl");
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalRead = fs.readSync;
  const tracked = new Map<number, string>();
  let transcriptReads = 0;
  let failPath: string | null = null;
  try {
    process.env.LLV_STATE_DIR = testStateDir;
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(pendingPath, [
      JSON.stringify({ type: "user", timestamp: "2026-07-16T12:00:00.000Z", cwd: "/repo", message: { role: "user", content: "Choose" } }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-16T12:00:01.000Z",
        message: {
          model: "claude-sonnet-4-20250514",
          content: [{
            type: "tool_use",
            id: "toolu_persisted_question",
            name: "AskUserQuestion",
            input: {
              questions: [{
                header: "Choice",
                question: "Which path?",
                options: [
                  { label: "Safe (Recommended)", description: "Keep the durable state." },
                  { label: "Fast", description: "Prefer speed." },
                ],
              }],
            },
          }],
        },
      }),
      "",
    ].join("\n"));
    fs.writeFileSync(quietPath, [
      JSON.stringify({ type: "user", timestamp: "2026-07-16T12:00:00.000Z", cwd: "/repo", message: { role: "user", content: "Done" } }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-16T12:00:01.000Z",
        message: { model: "claude-sonnet-4-20250514", stop_reason: "end_turn", content: [{ type: "text", text: "Complete" }] },
      }),
      "",
    ].join("\n"));
    resetFilesRouteCacheForTests();
    const initial = await currentFileScan({ fresh: true });
    const pendingEntry = initial.snapshot.files.find((entry) => entry.path === pendingPath);
    const quietEntry = initial.snapshot.files.find((entry) => entry.path === quietPath);
    expect(pendingEntry).toBeDefined();
    expect(quietEntry).toBeDefined();
    const snapshotPath = path.join(testStateDir, "files-scan-snapshot.json");
    const persisted = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as {
      version: number;
      snapshot: { files: typeof initial.snapshot.files };
    };
    const persistedPending = persisted.snapshot.files.find((entry) => entry.path === pendingPath)!;
    Object.assign(persistedPending, {
      proc: "running",
      pid: process.pid,
      pendingQuestion: {
        kind: "question",
        toolUseId: "toolu_persisted_question",
        transcriptPath: pendingPath,
        askedAt: "2026-07-16T12:00:01.000Z",
        pid: process.pid,
        paneTarget: "%7",
        questions: [{
          header: "Choice",
          question: "Which path?",
          multiSelect: false,
          options: [
            { label: "Safe", description: "Keep the durable state.", recommended: true },
            { label: "Fast", description: "Prefer speed.", recommended: false },
          ],
        }],
      },
    });
    fs.writeFileSync(snapshotPath, JSON.stringify(persisted) + "\n");

    const cacheStore = globalThis as typeof globalThis & { __llvCaches?: Record<string, Map<string, unknown>> };
    for (const cache of Object.values(cacheStore.__llvCaches ?? {})) cache.clear();
    resetFilesRouteCacheForTests();
    fs.openSync = ((filename: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = originalOpen(filename, flags, mode);
      const resolved = path.resolve(String(filename));
      if (resolved === pendingPath || resolved === quietPath) tracked.set(fd, resolved);
      return fd;
    }) as typeof fs.openSync;
    fs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition) => {
      const pathname = tracked.get(fd);
      if (pathname) {
        transcriptReads += 1;
        if (pathname === failPath) {
          const error = new Error("persisted Claude question EIO") as NodeJS.ErrnoException;
          error.code = "EIO";
          throw error;
        }
      }
      return originalRead(fd, buffer, offset, length, position);
    }) as typeof fs.readSync;
    fs.closeSync = ((fd: number) => {
      tracked.delete(fd);
      return originalClose(fd);
    }) as typeof fs.closeSync;

    const restarted = await cachedFileScan(undefined, undefined, 0);
    const restartedPending = restarted.snapshot.files.find((entry) => entry.path === pendingPath)!;
    const restartedQuiet = restarted.snapshot.files.find((entry) => entry.path === quietPath)!;
    expect(pendingQuestionFor(restartedPending)).toMatchObject({
      kind: "question",
      toolUseId: "toolu_persisted_question",
      pid: process.pid,
      paneTarget: null,
      questions: [{ question: "Which path?", options: [{ label: "Safe", recommended: true }, { label: "Fast", recommended: false }] }],
    });
    expect(pendingQuestionFor(restartedQuiet)).toBeNull();
    const warm = transcriptReads;

    fs.appendFileSync(pendingPath, "\n");
    const changedStat = fs.statSync(pendingPath);
    const changedPending = { ...restartedPending, size: changedStat.size, mtime: changedStat.mtimeMs / 1000 };
    failPath = pendingPath;
    expect(pendingQuestionFor(changedPending)).toBeNull();
    const failed = transcriptReads;
    failPath = null;
    expect(pendingQuestionFor(changedPending)).toMatchObject({ toolUseId: "toolu_persisted_question" });

    expect({ warm, failed, recovered: transcriptReads }).toEqual({ warm: 0, failed: 1, recovered: 2 });
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
    fs.readSync = originalRead;
    fs.rmSync(projectDir, { recursive: true, force: true });
    process.env.LLV_STATE_DIR = previousTestStateDir;
    resetFilesRouteCacheForTests();
    fs.rmSync(testStateDir, { recursive: true, force: true });
  }
}, 30_000);

test("a persisted Claude result hydrates authoritative turn evidence without transcript reads", async () => {
  const previousTestStateDir = process.env.LLV_STATE_DIR;
  const testStateDir = path.join(sandbox, "durable-claude-result-state");
  const projectDir = path.join(process.env.LLV_CLAUDE_HOME!, "projects", "-repo-claude-result-hydration");
  const resultPath = path.join(projectDir, "authoritative-result.jsonl");
  const assistantPath = path.join(projectDir, "assistant-only.jsonl");
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalRead = fs.readSync;
  const tracked = new Map<number, string>();
  let transcriptReads = 0;
  let failPath: string | null = null;
  const assistant = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-16T12:00:01.000Z",
    message: { model: "claude-sonnet-4-20250514", stop_reason: "end_turn", content: [{ type: "text", text: "Complete" }] },
  });
  try {
    process.env.LLV_STATE_DIR = testStateDir;
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(resultPath, [
      JSON.stringify({ type: "user", timestamp: "2026-07-16T12:00:00.000Z", cwd: "/repo", message: { role: "user", content: "Done" } }),
      assistant,
      JSON.stringify({ type: "result", timestamp: "2026-07-16T12:00:02.000Z", subtype: "success", result: "Complete" }),
      "",
    ].join("\n"));
    fs.writeFileSync(assistantPath, [
      JSON.stringify({ type: "user", timestamp: "2026-07-16T12:00:00.000Z", cwd: "/repo", message: { role: "user", content: "Done" } }),
      assistant,
      "",
    ].join("\n"));
    resetFilesRouteCacheForTests();
    const initial = await currentFileScan({ fresh: true });
    expect(initial.snapshot.files.find((entry) => entry.path === resultPath)?.activityReason).toBe("jsonl_turn_completed");
    expect(initial.snapshot.files.find((entry) => entry.path === assistantPath)?.activityReason).toBe("jsonl_turn_completed");

    const cacheStore = globalThis as typeof globalThis & { __llvCaches?: Record<string, Map<string, unknown>> };
    for (const cache of Object.values(cacheStore.__llvCaches ?? {})) cache.clear();
    resetFilesRouteCacheForTests();
    fs.openSync = ((filename: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = originalOpen(filename, flags, mode);
      const resolved = path.resolve(String(filename));
      if (resolved === resultPath || resolved === assistantPath) tracked.set(fd, resolved);
      return fd;
    }) as typeof fs.openSync;
    fs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition) => {
      const pathname = tracked.get(fd);
      if (pathname) {
        transcriptReads += 1;
        if (pathname === failPath) {
          const error = new Error("persisted Claude result EIO") as NodeJS.ErrnoException;
          error.code = "EIO";
          throw error;
        }
      }
      return originalRead(fd, buffer, offset, length, position);
    }) as typeof fs.readSync;
    fs.closeSync = ((fd: number) => {
      tracked.delete(fd);
      return originalClose(fd);
    }) as typeof fs.closeSync;

    const restarted = await cachedFileScan(undefined, undefined, 0);
    const restartedResult = restarted.snapshot.files.find((entry) => entry.path === resultPath)!;
    const restartedAssistant = restarted.snapshot.files.find((entry) => entry.path === assistantPath)!;
    expect(transcriptTurnResult(resultPath, restartedResult.size, restartedResult.mtime * 1000, false)).toMatchObject({
      complete: true,
      turn: { state: "terminal", source: "lifecycle" },
    });
    expect(transcriptTurnResult(assistantPath, restartedAssistant.size, restartedAssistant.mtime * 1000, false)).toMatchObject({
      complete: true,
      turn: { state: "busy", source: "assistant" },
    });
    expect(transcriptReads).toBe(0);

    fs.appendFileSync(resultPath, "\n");
    const changed = fs.statSync(resultPath);
    failPath = resultPath;
    expect(transcriptTurnResult(resultPath, changed.size, changed.mtimeMs, false).complete).toBe(false);
    failPath = null;
    expect(transcriptTurnResult(resultPath, changed.size, changed.mtimeMs, false)).toMatchObject({
      complete: true,
      turn: { state: "terminal", source: "lifecycle" },
    });
    expect(transcriptReads).toBe(2);
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
    fs.readSync = originalRead;
    fs.rmSync(projectDir, { recursive: true, force: true });
    process.env.LLV_STATE_DIR = previousTestStateDir;
    resetFilesRouteCacheForTests();
    fs.rmSync(testStateDir, { recursive: true, force: true });
  }
}, 30_000);

test("a same-size rewrite after restart invalidates persisted tail derivations", async () => {
  const previousTestStateDir = process.env.LLV_STATE_DIR;
  const testStateDir = path.join(sandbox, "durable-tail-rewrite-state");
  const transcript = path.join(sessions, "durable-tail-rewrite.jsonl");
  try {
    process.env.LLV_STATE_DIR = testStateDir;
    resetFilesRouteCacheForTests();
    const completed = JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } });
    const started = `${JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })} `;
    expect(started).toHaveLength(completed.length);
    fs.writeFileSync(transcript, `${JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/durable-tail-rewrite" } })}\n${completed}\n`);
    const initial = await currentFileScan({ fresh: true });
    expect(initial.snapshot.files.find((entry) => entry.path === transcript)?.activityReason).toBe("jsonl_turn_completed");

    const cacheStore = globalThis as typeof globalThis & { __llvCaches?: Record<string, Map<string, unknown>> };
    for (const cache of Object.values(cacheStore.__llvCaches ?? {})) cache.clear();
    resetFilesRouteCacheForTests();
    const before = fs.statSync(transcript);
    fs.writeFileSync(transcript, `${JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/durable-tail-rewrite" } })}\n${started}\n`);
    fs.utimesSync(transcript, before.atime, new Date(before.mtimeMs + 1_000));

    const restarted = await currentFileScan({ fresh: true });

    expect(restarted.snapshot.files.find((entry) => entry.path === transcript)?.activityReason).toBe("jsonl_turn_open");
  } finally {
    fs.rmSync(transcript, { force: true });
    process.env.LLV_STATE_DIR = previousTestStateDir;
    resetFilesRouteCacheForTests();
    fs.rmSync(testStateDir, { recursive: true, force: true });
  }
}, 20_000);

test("an incomplete tail generation stays unpersisted and rereads the same identity after restart", async () => {
  const previousTestStateDir = process.env.LLV_STATE_DIR;
  const testStateDir = path.join(sandbox, "incomplete-tail-restart-state");
  const transcript = path.join(sessions, "incomplete-tail-restart.jsonl");
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalRead = fs.readSync;
  const tracked = new Set<number>();
  let failTail = true;
  let tailReads = 0;
  try {
    process.env.LLV_STATE_DIR = testStateDir;
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/incomplete-tail", model: "gpt-5.6-sol" } }),
      "x".repeat(150_000),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
      "",
    ].join("\n"));
    fs.utimesSync(transcript, 1_700_000_000, 1_700_000_000);
    const stat = fs.statSync(transcript);
    const tailPosition = Math.max(0, stat.size - 131_072);
    const cacheStore = globalThis as typeof globalThis & { __llvCaches?: Record<string, Map<string, unknown>> };
    for (const cache of Object.values(cacheStore.__llvCaches ?? {})) cache.delete(transcript);
    resetFilesRouteCacheForTests();
    fs.openSync = ((filename: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = originalOpen(filename, flags, mode);
      if (filename === transcript) tracked.add(fd);
      return fd;
    }) as typeof fs.openSync;
    fs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition) => {
      if (tracked.has(fd) && position === tailPosition) {
        tailReads += 1;
        if (failTail) {
          const error = new Error("injected scanner tail EIO") as NodeJS.ErrnoException;
          error.code = "EIO";
          throw error;
        }
      }
      return originalRead(fd, buffer, offset, length, position);
    }) as typeof fs.readSync;
    fs.closeSync = ((fd: number) => {
      tracked.delete(fd);
      return originalClose(fd);
    }) as typeof fs.closeSync;

    await expect(currentFileScan({ fresh: true })).rejects.toThrow("filesystem scan incomplete");
    expect(fs.existsSync(path.join(testStateDir, "files-scan-snapshot.json"))).toBe(false);

    failTail = false;
    for (const cache of Object.values(cacheStore.__llvCaches ?? {})) cache.delete(transcript);
    resetFilesRouteCacheForTests();
    const restarted = await currentFileScan({ fresh: true });
    const recovered = restarted.snapshot.files.find((entry) => entry.path === transcript);

    expect(tailReads).toBeGreaterThanOrEqual(2);
    expect(recovered).toMatchObject({
      activity: "stalled",
      activityReason: "jsonl_turn_stalled",
      derivationComplete: true,
    });
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
    fs.readSync = originalRead;
    fs.rmSync(transcript, { force: true });
    process.env.LLV_STATE_DIR = previousTestStateDir;
    resetFilesRouteCacheForTests();
    fs.rmSync(testStateDir, { recursive: true, force: true });
    const cacheStore = globalThis as typeof globalThis & { __llvCaches?: Record<string, Map<string, unknown>> };
    for (const cache of Object.values(cacheStore.__llvCaches ?? {})) cache.delete(transcript);
  }
}, 20_000);

test("a head-model EIO preserves the last complete snapshot until same-identity recovery", async () => {
  const previousTestStateDir = process.env.LLV_STATE_DIR;
  const testStateDir = path.join(sandbox, "incomplete-head-model-state");
  const transcript = path.join(sessions, "incomplete-head-model.jsonl");
  const nullTranscript = path.join(sessions, "complete-null-model.jsonl");
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalRead = fs.readSync;
  const tracked = new Set<number>();
  let failExtension = false;
  let extensionReads = 0;
  const contents = (model: string) => [
    JSON.stringify({ type: "response_item", payload: { type: "message", text: "x".repeat(140_000) } }),
    JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/head-model", model } }),
    "x".repeat(150_000),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
    "",
  ].join("\n");
  try {
    process.env.LLV_STATE_DIR = testStateDir;
    resetFilesRouteCacheForTests();
    fs.writeFileSync(transcript, contents("gpt-alpha"));
    fs.utimesSync(transcript, 1_700_000_000, 1_700_000_000);
    const initial = await currentFileScan({ fresh: true });
    expect(initial.snapshot.files.find((entry) => entry.path === transcript)).toMatchObject({
      launchModel: "gpt-alpha",
      derivationComplete: true,
    });
    const snapshotPath = path.join(testStateDir, "files-scan-snapshot.json");
    const completeSnapshot = fs.readFileSync(snapshotPath);

    fs.writeFileSync(transcript, contents("gpt-bravo"));
    fs.utimesSync(transcript, 1_700_000_001, 1_700_000_001);
    const cacheStore = globalThis as typeof globalThis & { __llvCaches?: Record<string, Map<string, unknown>> };
    for (const cache of Object.values(cacheStore.__llvCaches ?? {})) cache.delete(transcript);
    resetFilesRouteCacheForTests();
    fs.openSync = ((filename: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = originalOpen(filename, flags, mode);
      if (filename === transcript) tracked.add(fd);
      return fd;
    }) as typeof fs.openSync;
    fs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition) => {
      if (tracked.has(fd) && position === 128 * 1024) {
        extensionReads += 1;
        if (failExtension) {
          const error = new Error("injected scanner head extension EIO") as NodeJS.ErrnoException;
          error.code = "EIO";
          throw error;
        }
      }
      return originalRead(fd, buffer, offset, length, position);
    }) as typeof fs.readSync;
    fs.closeSync = ((fd: number) => {
      tracked.delete(fd);
      return originalClose(fd);
    }) as typeof fs.closeSync;

    failExtension = true;
    await expect(currentFileScan({ fresh: true })).rejects.toThrow("filesystem scan incomplete");
    expect(fs.readFileSync(snapshotPath)).toEqual(completeSnapshot);

    failExtension = false;
    const recovered = await currentFileScan({ fresh: true });
    expect(extensionReads).toBeGreaterThanOrEqual(2);
    expect(recovered.snapshot.files.find((entry) => entry.path === transcript)).toMatchObject({
      launchModel: "gpt-bravo",
      derivationComplete: true,
    });

    fs.writeFileSync(nullTranscript, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/no-model" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
      "",
    ].join("\n"));
    const completeNull = await currentFileScan({ fresh: true });
    expect(completeNull.snapshot.files.find((entry) => entry.path === nullTranscript)).toMatchObject({
      launchModel: null,
      derivationComplete: true,
    });
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
    fs.readSync = originalRead;
    fs.rmSync(transcript, { force: true });
    fs.rmSync(nullTranscript, { force: true });
    process.env.LLV_STATE_DIR = previousTestStateDir;
    resetFilesRouteCacheForTests();
    fs.rmSync(testStateDir, { recursive: true, force: true });
    const cacheStore = globalThis as typeof globalThis & { __llvCaches?: Record<string, Map<string, unknown>> };
    for (const cache of Object.values(cacheStore.__llvCaches ?? {})) {
      cache.delete(transcript);
      cache.delete(nullTranscript);
    }
  }
}, 20_000);

test("65- and 505-file scans share bounded prefixes with migration reconciliation", async () => {
  const previousTestStateDir = process.env.LLV_STATE_DIR;
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalRead = fs.readSync;
  const tracked = new Map<number, string>();
  let fixtureDir = "";
  let failPath: string | null = null;
  let failuresRemaining = 0;
  let prefixReads = 0;
  let tailReads = 0;
  let maxReadLength = 0;
  try {
    fs.openSync = ((filename: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = originalOpen(filename, flags, mode);
      if (typeof filename === "string" && filename.startsWith(fixtureDir + path.sep)) tracked.set(fd, filename);
      return fd;
    }) as typeof fs.openSync;
    fs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition) => {
      const pathname = tracked.get(fd);
      if (pathname && typeof position === "number") {
        maxReadLength = Math.max(maxReadLength, length);
        if (position === 0) {
          prefixReads += 1;
        }
        else if (position === Math.max(0, fs.fstatSync(fd).size - 131_072)) tailReads += 1;
        if (pathname === failPath && position === 0 && failuresRemaining > 0) {
          failuresRemaining -= 1;
          const error = new Error("injected prefix EIO") as NodeJS.ErrnoException;
          error.code = "EIO";
          throw error;
        }
      }
      return originalRead(fd, buffer, offset, length, position);
    }) as typeof fs.readSync;
    fs.closeSync = ((fd: number) => {
      tracked.delete(fd);
      return originalClose(fd);
    }) as typeof fs.closeSync;

    const cacheStore = globalThis as typeof globalThis & { __llvCaches?: Record<string, Map<string, unknown>> };
    for (const count of [65, 505]) {
      const testStateDir = path.join(sandbox, `bounded-prefix-${count}-state`);
      fixtureDir = path.join(sessions, `bounded-prefix-${count}`);
      process.env.LLV_STATE_DIR = testStateDir;
      fs.mkdirSync(fixtureDir, { recursive: true });
      const sessionBody = (index: number, timestamp = "2026-07-16T12:00:00.000Z") => [
        JSON.stringify({
          type: "session_meta",
          payload: { cwd: `/repo/bounded-prefix-${index % 7}`, timestamp, model: "gpt-5" },
        }),
        "x".repeat(140_000),
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-5", effort: "high" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
        "",
      ].join("\n");
      const paths = Array.from({ length: count }, (_, index) => path.join(
        fixtureDir,
        `rollout-${String(index).padStart(3, "0")}.jsonl`,
      ));
      for (let index = 0; index < count; index += 1) fs.writeFileSync(paths[index]!, sessionBody(index));
      for (const cache of Object.values(cacheStore.__llvCaches ?? {})) cache.clear();
      resetFilesRouteCacheForTests();
      prefixReads = 0;
      tailReads = 0;
      maxReadLength = 0;

      const scan = await currentFileScan({ fresh: true });
      const migrationFiles = scan.snapshot.files.filter((entry) => entry.path.startsWith(fixtureDir + path.sep));
      const migrationRegistry = new AgentRegistry(path.join(testStateDir, "migration-registry.json"));
      const scannedPrefixes = prefixReads;
      await reconcileMigrationInventory(migrationRegistry, migrationFiles);
      const reconciledPrefixes = prefixReads;
      await reconcileMigrationInventory(migrationRegistry, migrationFiles);

      expect(migrationFiles).toHaveLength(count);
      expect({ scannedPrefixes, reconciledPrefixes, warmPrefixes: prefixReads }).toEqual({
        scannedPrefixes: count,
        reconciledPrefixes: count,
        warmPrefixes: count,
      });
      expect(tailReads).toBe(count);

      for (const cache of Object.values(cacheStore.__llvCaches ?? {})) cache.clear();
      resetFilesRouteCacheForTests();
      const restarted = await cachedFileScan(undefined, undefined, 0);
      const restartedFiles = restarted.snapshot.files.filter((entry) => entry.path.startsWith(fixtureDir + path.sep));
      const restartedRegistry = new AgentRegistry(path.join(testStateDir, "restarted-migration-registry.json"));
      await reconcileMigrationInventory(restartedRegistry, restartedFiles);
      expect({ prefixReads, tailReads }).toEqual({ prefixReads: count, tailReads: count });

      const changedPath = paths[0]!;
      const changedMtime = fs.statSync(changedPath).mtimeMs + 2_000;
      fs.writeFileSync(changedPath, sessionBody(0, "2026-07-16T13:00:00.000Z"));
      fs.utimesSync(changedPath, changedMtime / 1000, changedMtime / 1000);
      const changed = await currentFileScan({ fresh: true });
      const changedFiles = changed.snapshot.files.filter((entry) => entry.path.startsWith(fixtureDir + path.sep));
      await reconcileMigrationInventory(restartedRegistry, changedFiles);
      expect(prefixReads).toBe(count + 1);

      const retryPath = paths[1]!;
      const retryMtime = fs.statSync(retryPath).mtimeMs + 2_000;
      fs.writeFileSync(retryPath, sessionBody(1, "2026-07-16T14:00:00.000Z"));
      fs.utimesSync(retryPath, retryMtime / 1000, retryMtime / 1000);
      const expectedRetryMtime = fs.statSync(retryPath).mtimeMs / 1000;
      failPath = retryPath;
      failuresRemaining = 1;
      let recovered: Awaited<ReturnType<typeof currentFileScan>>;
      let observedFailure: unknown;
      try {
        recovered = await currentFileScan({ fresh: true });
      } catch (error) {
        observedFailure = error;
        recovered = await currentFileScan({ fresh: true });
      }
      expect(observedFailure).toMatchObject({ message: "filesystem scan incomplete" });
      if (recovered.snapshot.files.find((entry) => entry.path === retryPath)?.mtime !== expectedRetryMtime) {
        recovered = await currentFileScan({ fresh: true });
      }
      failPath = null;
      const recoveredFiles = recovered.snapshot.files.filter((entry) => entry.path.startsWith(fixtureDir + path.sep));
      await reconcileMigrationInventory(restartedRegistry, recoveredFiles);
      expect(recoveredFiles.find((entry) => entry.path === retryPath)?.mtime).toBe(expectedRetryMtime);
      expect(prefixReads).toBe(count + 3);
      expect(maxReadLength).toBeLessThanOrEqual(128 * 1024);

      const rawHeadCache = cacheStore.__llvCaches?.["scanner-head-v1"];
      let rawHeadBytes = 0;
      for (const value of rawHeadCache?.values() ?? []) {
        const bytes = (value as { bytes?: Buffer }).bytes;
        if (bytes) rawHeadBytes += bytes.length;
      }
      expect(rawHeadBytes).toBeLessThanOrEqual(32 * 1024 * 1024);

      fs.rmSync(fixtureDir, { recursive: true, force: true });
      fs.rmSync(testStateDir, { recursive: true, force: true });
      for (const cache of Object.values(cacheStore.__llvCaches ?? {})) cache.clear();
      resetFilesRouteCacheForTests();
    }
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
    fs.readSync = originalRead;
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
    process.env.LLV_STATE_DIR = previousTestStateDir;
    resetFilesRouteCacheForTests();
    const cacheStore = globalThis as typeof globalThis & { __llvCaches?: Record<string, Map<string, unknown>> };
    for (const cache of Object.values(cacheStore.__llvCaches ?? {})) cache.clear();
  }
}, 120_000);

test("a transient real scanner failure preserves the completed route snapshot until recovery", async () => {
  resetFilesRouteCacheForTests();
  const canonicalPath = writeSession("canonical.jsonl", "/repo/canonical");
  const initial = await cachedFileScan();
  await waitForGeneration(initial.targetGeneration, canonicalPath);
  const completed = await cachedFileScan();
  expect(completed.snapshot.complete).toBe(true);
  expect(completed.snapshot.files.map((entry) => entry.path)).toContain(canonicalPath);

  const snapshotPath = path.join(process.env.LLV_STATE_DIR!, "files-scan-snapshot.json");
  const persistedBeforeFailure = fs.readFileSync(snapshotPath);
  const savedSessions = `${sessions}.saved`;
  fs.renameSync(sessions, savedSessions);
  fs.writeFileSync(sessions, "temporary non-directory root", "utf8");

  const stale = await cachedFileScan(undefined, undefined, Date.now(), Number.MAX_SAFE_INTEGER);
  expect(stale.snapshot.files.map((entry) => entry.path)).toContain(canonicalPath);
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  expect(fs.readFileSync(snapshotPath)).toEqual(persistedBeforeFailure);

  fs.rmSync(sessions);
  fs.renameSync(savedSessions, sessions);
  fs.rmSync(canonicalPath);
  const recoveredPath = writeSession("recovered.jsonl", "/repo/recovered");
  await waitForGeneration(stale.targetGeneration, recoveredPath);

  const recovered = await cachedFileScan();
  expect(recovered.snapshot.files.map((entry) => entry.path)).toContain(recoveredPath);
  expect(recovered.snapshot.files.map((entry) => entry.path)).not.toContain(canonicalPath);
  expect(fs.readFileSync(snapshotPath)).not.toEqual(persistedBeforeFailure);
});

test("task twin EIO preserves canonical files generation and durable snapshots until recovery", async () => {
  const previousTestStateDir = process.env.LLV_STATE_DIR;
  const testStateDir = path.join(sandbox, "task-twin-generation-state");
  const taskRoot = ROOTS["claude-tasks"];
  const taskSlug = `llv-scan-test-${path.basename(sandbox)}`;
  const taskFixtureRoot = path.join(taskRoot, taskSlug);
  const taskPath = path.join(taskFixtureRoot, "session-a", "tasks", "task-a.output");
  const twinPath = path.join(ROOTS["claude-projects"], taskSlug, "session-a", "subagents", "agent-task-a.jsonl");
  const originalAccess = fs.promises.access;
  try {
    process.env.LLV_STATE_DIR = testStateDir;
    resetFilesRouteCacheForTests();
    fs.mkdirSync(path.dirname(taskPath), { recursive: true });
    const canonicalPath = writeSession("task-twin-canonical.jsonl", "/repo/task-twin-canonical");
    const canonical = await cachedFileScan();
    expect(canonical.snapshot.files.map((entry) => entry.path)).toContain(canonicalPath);
    const snapshotPath = path.join(testStateDir, "files-scan-snapshot.json");
    const indexPath = path.join(testStateDir, "project-catalog.json");
    const canonicalSnapshot = fs.readFileSync(snapshotPath);
    const canonicalIndex = fs.readFileSync(indexPath);

    fs.writeFileSync(taskPath, "finished\n");
    fs.promises.access = (async (pathname, mode) => {
      if (pathname === twinPath) {
        const error = new Error("injected task twin EIO") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      return originalAccess(pathname, mode);
    }) as typeof fs.promises.access;
    const stale = await cachedFileScan(undefined, undefined, Date.now(), 261);
    expect(stale.generation).toBe(canonical.generation);
    expect(stale.targetGeneration).toBeGreaterThan(stale.generation);
    expect(stale.snapshot.files.map((entry) => entry.path)).not.toContain(taskPath);
    await Bun.sleep(50);
    expect(fs.readFileSync(snapshotPath)).toEqual(canonicalSnapshot);
    expect(fs.readFileSync(indexPath)).toEqual(canonicalIndex);

    fs.promises.access = originalAccess;
    let recovered = await cachedFileScan();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      recovered = await cachedFileScan(undefined, undefined, Date.now(), undefined, stale.targetGeneration);
      if (recovered.generation >= stale.targetGeneration
        && recovered.snapshot.files.some((entry) => entry.path === taskPath)) break;
      await Bun.sleep(10);
    }
    expect(recovered.generation).toBeGreaterThanOrEqual(stale.targetGeneration);
    expect(recovered.snapshot.files.map((entry) => entry.path)).toContain(taskPath);
  } finally {
    fs.promises.access = originalAccess;
    process.env.LLV_STATE_DIR = previousTestStateDir;
    resetFilesRouteCacheForTests();
    fs.rmSync(testStateDir, { recursive: true, force: true });
    fs.rmSync(taskFixtureRoot, { recursive: true, force: true });
  }
});

test("transcript metadata EIO after rewrite retains canonical snapshots until convergence", async () => {
  resetFilesRouteCacheForTests();
  const transcript = path.join(sessions, "metadata-rewrite.jsonl");
  const alpha = `${JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/alpha" } })}\n`;
  const bravo = `${JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/bravo" } })}\n`;
  expect(Buffer.byteLength(alpha)).toBe(Buffer.byteLength(bravo));
  fs.writeFileSync(transcript, alpha);
  fs.utimesSync(transcript, 1_700_000_000, 1_700_000_000);
  const initial = await cachedFileScan();
  await waitForGeneration(initial.targetGeneration, transcript);
  const completed = await cachedFileScan();
  expect(completed.snapshot.files.find((entry) => entry.path === transcript)?.cwd).toBe("/repo/alpha");
  const snapshotPath = path.join(process.env.LLV_STATE_DIR!, "files-scan-snapshot.json");
  const indexPath = path.join(process.env.LLV_STATE_DIR!, "project-catalog.json");
  const canonicalSnapshot = fs.readFileSync(snapshotPath);
  const canonicalIndex = fs.readFileSync(indexPath);

  fs.writeFileSync(transcript, bravo);
  fs.utimesSync(transcript, 1_700_000_001, 1_700_000_001);
  const originalOpen = fs.openSync;
  let failures = 2;
  fs.openSync = ((filename: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (filename === transcript && failures > 0) {
      failures -= 1;
      const error = new Error("injected transcript metadata EIO") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    }
    return originalOpen(filename, flags, mode);
  }) as typeof fs.openSync;
  let targetGeneration = 0;
  try {
    const stale = await cachedFileScan(undefined, undefined, Date.now(), Number.MAX_SAFE_INTEGER);
    targetGeneration = stale.targetGeneration;
    expect(stale.snapshot.files.find((entry) => entry.path === transcript)?.cwd).toBe("/repo/alpha");
    await Bun.sleep(50);
  } finally {
    fs.openSync = originalOpen;
  }

  expect(fs.readFileSync(snapshotPath)).toEqual(canonicalSnapshot);
  expect(fs.readFileSync(indexPath)).toEqual(canonicalIndex);
  let recovered = await cachedFileScan();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    recovered = await cachedFileScan(undefined, undefined, Date.now(), undefined, targetGeneration);
    if (recovered.generation >= targetGeneration
      && recovered.snapshot.files.find((entry) => entry.path === transcript)?.cwd === "/repo/bravo") break;
    await Bun.sleep(10);
  }
  expect(recovered.snapshot.files.find((entry) => entry.path === transcript)?.cwd).toBe("/repo/bravo");
  expect(fs.readFileSync(snapshotPath)).not.toEqual(canonicalSnapshot);
  expect(fs.readFileSync(indexPath)).not.toEqual(canonicalIndex);
});

test("sidecar metadata EIO after rewrite retains canonical snapshots until convergence", async () => {
  resetFilesRouteCacheForTests();
  const transcript = path.join(process.env.LLV_CLAUDE_HOME!, "projects", "sidecar", "session", "subagents", "agent-x.jsonl");
  const sidecar = transcript.slice(0, -".jsonl".length) + ".meta.json";
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, "{}\n");
  fs.writeFileSync(sidecar, JSON.stringify({ description: "Agent alpha" }));
  fs.utimesSync(sidecar, 1_700_000_000, 1_700_000_000);
  const initial = await cachedFileScan();
  await waitForGeneration(initial.targetGeneration, transcript);
  const completed = await cachedFileScan();
  expect(completed.snapshot.files.find((entry) => entry.path === transcript)?.title).toBe("Agent alpha");
  const snapshotPath = path.join(process.env.LLV_STATE_DIR!, "files-scan-snapshot.json");
  const indexPath = path.join(process.env.LLV_STATE_DIR!, "project-catalog.json");
  const canonicalSnapshot = fs.readFileSync(snapshotPath);
  const canonicalIndex = fs.readFileSync(indexPath);

  fs.writeFileSync(sidecar, JSON.stringify({ description: "Agent bravo" }));
  fs.utimesSync(sidecar, 1_700_000_001, 1_700_000_001);
  const originalRead = fs.readFileSync;
  let failures = 1;
  fs.readFileSync = ((filename: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (filename === sidecar && failures > 0) {
      failures -= 1;
      const error = new Error("injected sidecar metadata EIO") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    }
    return (originalRead as (...inner: unknown[]) => unknown)(filename, ...args);
  }) as typeof fs.readFileSync;
  let targetGeneration = 0;
  try {
    const stale = await cachedFileScan(undefined, undefined, Date.now(), Number.MAX_SAFE_INTEGER);
    targetGeneration = stale.targetGeneration;
    expect(stale.snapshot.files.find((entry) => entry.path === transcript)?.title).toBe("Agent alpha");
    await Bun.sleep(50);
  } finally {
    fs.readFileSync = originalRead;
  }

  expect(fs.readFileSync(snapshotPath)).toEqual(canonicalSnapshot);
  expect(fs.readFileSync(indexPath)).toEqual(canonicalIndex);
  let recovered = await cachedFileScan();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    recovered = await cachedFileScan(undefined, undefined, Date.now(), undefined, targetGeneration);
    if (recovered.generation >= targetGeneration
      && recovered.snapshot.files.find((entry) => entry.path === transcript)?.title === "Agent bravo") break;
    await Bun.sleep(10);
  }
  expect(recovered.snapshot.files.find((entry) => entry.path === transcript)?.title).toBe("Agent bravo");
  expect(fs.readFileSync(snapshotPath)).not.toEqual(canonicalSnapshot);
  expect(fs.readFileSync(indexPath)).not.toEqual(canonicalIndex);
});

test("a confirmed ENOENT deletion remains a complete inventory change", async () => {
  const deletedPath = writeSession("confirmed-deletion.jsonl", "/repo/deleted");
  const before = await listFilesWithProjectCatalog(undefined, { persist: false, persistIndex: true });
  expect(before.complete).toBe(true);
  expect(before.files.map((entry) => entry.path)).toContain(deletedPath);

  fs.rmSync(deletedPath);
  const after = await listFilesWithProjectCatalog(undefined, { persist: false, persistIndex: true });
  expect(after.complete).toBe(true);
  expect(after.files.map((entry) => entry.path)).not.toContain(deletedPath);
  const index = JSON.parse(fs.readFileSync(path.join(process.env.LLV_STATE_DIR!, "project-catalog.json"), "utf8"));
  expect(index.files[deletedPath]).toBeUndefined();
});
