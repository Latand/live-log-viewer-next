import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
const { cachedFileScan, resetFilesRouteCacheForTests } = await import("./scanCache");

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
