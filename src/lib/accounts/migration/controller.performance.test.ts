import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { AgentRegistry } from "@/lib/agent/registry";
import type { FileEntry } from "@/lib/types";

import { reconcileMigrationInventory } from "./coordinator";

const LARGE_INVENTORY_SIZE = 800;
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

test("durable inventory reconciliation stays responsive with a production-shaped catalog", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-large-inventory-lag-"));
  try {
    const transcriptRoot = path.join(base, "sessions");
    await mkdir(transcriptRoot, { recursive: true });
    const files = await Promise.all(Array.from({ length: LARGE_INVENTORY_SIZE }, async (_, index): Promise<FileEntry> => {
      const pathname = path.join(transcriptRoot, `session-${String(index).padStart(4, "0")}.jsonl`);
      const content = `${JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/large-inventory" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "ready" } })}\n`;
      await writeFile(pathname, content);
      return {
        path: pathname,
        root: "codex-sessions",
        name: path.basename(pathname),
        project: "large-inventory",
        title: `Session ${index}`,
        engine: "codex",
        kind: "session",
        fmt: "codex",
        parent: null,
        mtime: Date.now() / 1_000,
        size: Buffer.byteLength(content),
        activity: "idle",
        proc: null,
        pid: null,
        model: null,
        pendingQuestion: null,
        waitingInput: null,
      };
    }));
    const registry = new AgentRegistry(path.join(base, "agent-registry.json"));
    await reconcileMigrationInventory(registry, files);

    const lags = await eventLoopLagsWhile(async () => {
      await reconcileMigrationInventory(registry, files);
    });

    expect(Object.keys(registry.snapshot().conversations)).toHaveLength(LARGE_INVENTORY_SIZE);
    expect(percentile(lags, 0.95)).toBeLessThan(EVENT_LOOP_BUDGET_MS);
    expect(Math.max(...lags)).toBeLessThan(EVENT_LOOP_BUDGET_MS);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 30_000);
