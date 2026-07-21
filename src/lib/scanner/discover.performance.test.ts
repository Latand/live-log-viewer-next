import { expect, test } from "bun:test";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { RootKey } from "../types";
import { discoverFilesWithProjectCatalog } from "./discover";

const LARGE_CATALOG_SIZE = 800;
const EVENT_LOOP_BUDGET_MS = 100;

async function eventLoopLagsWhile(work: () => Promise<void>): Promise<number[]> {
  const lags: number[] = [];
  let running = true;
  let expectedAt = performance.now();
  const sample = () => {
    const now = performance.now();
    lags.push(now - expectedAt);
    expectedAt = now;
    if (running) setImmediate(sample);
  };
  setImmediate(sample);
  await work();
  running = false;
  await new Promise<void>((resolve) => setImmediate(resolve));
  return lags;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

test("large-catalog reconciliation keeps event-loop lag below the controller budget", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-large-catalog-lag-"));
  const previousStateDir = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(base, "state");
  try {
    const roots: Record<RootKey, string> = {
      "codex-sessions": path.join(base, "codex-sessions"),
      "claude-projects": path.join(base, "claude-projects"),
      "claude-tasks": path.join(base, "claude-tasks"),
    };
    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));
    const padding = "x".repeat(1_900);
    const transcript = Array.from({ length: 64 }, (_, index) => JSON.stringify({
      type: index === 0 ? "session_meta" : "event_msg",
      payload: index === 0 ? { cwd: "/repo/large-catalog" } : { type: "agent_message", message: padding },
    })).join("\n");
    await Promise.all(Array.from({ length: LARGE_CATALOG_SIZE }, (_, index) => writeFile(
      path.join(roots["codex-sessions"], `rollout-${String(index).padStart(4, "0")}.jsonl`),
      transcript,
    )));

    const lags = await eventLoopLagsWhile(async () => {
      const scan = await discoverFilesWithProjectCatalog(roots, undefined, { persist: false });
      expect(scan.projectCatalog.reduce((total, project) => total + project.conversations, 0)).toBe(LARGE_CATALOG_SIZE);
    });

    expect(percentile(lags, 0.95)).toBeLessThan(EVENT_LOOP_BUDGET_MS);
    expect(Math.max(...lags)).toBeLessThan(EVENT_LOOP_BUDGET_MS);
  } finally {
    if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDir;
    await rm(base, { recursive: true, force: true });
  }
}, 30_000);

test("pipeline status churn keeps a 100 MB growing transcript scan incremental and responsive", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-growing-controller-scan-"));
  const previousStateDir = process.env.LLV_STATE_DIR;
  const stateDir = path.join(base, "state");
  process.env.LLV_STATE_DIR = stateDir;
  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  const originalReadFile = fs.readFileSync;
  const originalClose = fs.closeSync;
  const tracked = new Set<number>();
  let bytesRead = 0;
  try {
    const roots: Record<RootKey, string> = {
      "codex-sessions": path.join(base, "codex-sessions"),
      "claude-projects": path.join(base, "claude-projects"),
      "claude-tasks": path.join(base, "claude-tasks"),
    };
    await Promise.all([...Object.values(roots), stateDir].map((root) => mkdir(root, { recursive: true })));
    const flowPath = path.join(stateDir, "flows.json");
    const workflowPath = path.join(stateDir, "workflows.json");
    const writeControllerState = (state: string, heartbeatAt: number) => {
      fs.writeFileSync(flowPath, JSON.stringify({
        schemaVersion: 3,
        flows: [{
          id: "flow-growing",
          project: "large-catalog",
          cwd: "/repo/large-catalog",
          implementerPath: "/sessions/implementer.jsonl",
          state,
          stateDetail: `heartbeat-${heartbeatAt}`,
          rounds: [{ reviewerPath: "/sessions/reviewer.jsonl", state, heartbeatAt }],
        }],
      }) + "\n");
      fs.writeFileSync(workflowPath, JSON.stringify({
        workflows: [{
          id: "workflow-growing",
          project: "large-catalog",
          repoDir: "/repo/large-catalog",
          worktreeDir: "/repo/large-catalog-worktree",
          state,
          stageRuns: [{ agentPath: "/sessions/stage.jsonl", state, heartbeatAt }],
        }],
      }) + "\n");
    };
    writeControllerState("running", 100);
    fs.writeFileSync(path.join(stateDir, "worktree-map.json"), "{}\n");

    const active = path.join(roots["codex-sessions"], "rollout-active.jsonl");
    const activeFd = fs.openSync(active, "w");
    const sessionMeta = `${JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/large-catalog" } })}\n`;
    fs.writeSync(activeFd, sessionMeta, 0, "utf8");
    fs.ftruncateSync(activeFd, 100 * 1024 * 1024);
    fs.writeSync(activeFd, "\n", 100 * 1024 * 1024 - 1, "utf8");
    fs.closeSync(activeFd);
    const stableTranscript = `${sessionMeta}${JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })}\n`;
    await Promise.all(Array.from({ length: LARGE_CATALOG_SIZE - 1 }, (_, index) => writeFile(
      path.join(roots["codex-sessions"], `rollout-stable-${String(index).padStart(4, "0")}.jsonl`),
      stableTranscript,
    )));

    const initial = await discoverFilesWithProjectCatalog(roots, undefined, { persist: true });
    expect(initial.projectCatalog.reduce((total, project) => total + project.conversations, 0)).toBe(LARGE_CATALOG_SIZE);
    writeControllerState("needs_decision", 200);
    fs.appendFileSync(active, `${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "continued" } })}\n`);
    const scannerCaches = (globalThis as typeof globalThis & { __llvCaches?: Record<string, Map<string, unknown>> }).__llvCaches;
    for (const cache of Object.values(scannerCaches ?? {})) cache.clear();

    const transcriptPaths = new Set([active, ...Array.from({ length: LARGE_CATALOG_SIZE - 1 }, (_, index) =>
      path.join(roots["codex-sessions"], `rollout-stable-${String(index).padStart(4, "0")}.jsonl`))]);
    fs.openSync = ((filename: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = originalOpen(filename, flags, mode);
      if (transcriptPaths.has(path.resolve(String(filename)))) tracked.add(fd);
      return fd;
    }) as typeof fs.openSync;
    fs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition) => {
      const read = originalRead(fd, buffer, offset, length, position);
      if (tracked.has(fd)) bytesRead += read;
      return read;
    }) as typeof fs.readSync;
    fs.readFileSync = ((filename: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const value = Reflect.apply(originalReadFile, fs, [filename, ...args]) as Buffer | string;
      if (typeof filename !== "number" && transcriptPaths.has(path.resolve(String(filename)))) {
        bytesRead += typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
      }
      return value;
    }) as typeof fs.readFileSync;
    fs.closeSync = ((fd: number) => {
      tracked.delete(fd);
      return originalClose(fd);
    }) as typeof fs.closeSync;

    const startedAt = performance.now();
    const lags = await eventLoopLagsWhile(async () => {
      const scan = await discoverFilesWithProjectCatalog(roots, undefined, { persist: false });
      expect(scan.projectCatalog.reduce((total, project) => total + project.conversations, 0)).toBe(LARGE_CATALOG_SIZE);
    });
    const durationMs = performance.now() - startedAt;

    expect(bytesRead).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(durationMs).toBeLessThan(15_000);
    expect(percentile(lags, 0.95)).toBeLessThan(EVENT_LOOP_BUDGET_MS);
    expect(Math.max(...lags)).toBeLessThan(EVENT_LOOP_BUDGET_MS);
  } finally {
    fs.openSync = originalOpen;
    fs.readSync = originalRead;
    fs.readFileSync = originalReadFile;
    fs.closeSync = originalClose;
    if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDir;
    await rm(base, { recursive: true, force: true });
  }
}, 30_000);
