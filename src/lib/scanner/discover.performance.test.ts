import { expect, test } from "bun:test";
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
