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

test("a transient real scanner failure preserves the completed route snapshot until recovery", async () => {
  resetFilesRouteCacheForTests();
  const canonicalPath = writeSession("canonical.jsonl", "/repo/canonical");
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

test("a confirmed ENOENT deletion remains a complete inventory change", async () => {
  const deletedPath = writeSession("confirmed-deletion.jsonl", "/repo/deleted");
  const before = await listFilesWithProjectCatalog();
  expect(before.complete).toBe(true);
  expect(before.files.map((entry) => entry.path)).toContain(deletedPath);

  fs.rmSync(deletedPath);
  const after = await listFilesWithProjectCatalog();
  expect(after.complete).toBe(true);
  expect(after.files.map((entry) => entry.path)).not.toContain(deletedPath);
});
