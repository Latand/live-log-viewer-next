import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { forEachCooperatively } from "@/lib/cooperative";
import { runReaperCycle } from "@/lib/reaperRuntime";
import type { FileEntry } from "@/lib/types";

import { reconcileMigrationInventory } from "./coordinator";
import { AccountMigrationController } from "./controller";

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

    let reconciliationFinished = false;
    let mutationRanDuringReconciliation = false;
    const lags = await eventLoopLagsWhile(async () => {
      const reconciliation = reconcileMigrationInventory(registry, files);
      const mutation = new Promise<void>((resolve) => {
        setImmediate(() => {
          mutationRanDuringReconciliation = !reconciliationFinished;
          registry.reconcileConversations([{
            engine: "codex",
            path: files[0]!.path,
            accountId: null,
            launchProfile: emptyLaunchProfile({ cwd: "/repo/large-inventory" }),
            turn: { state: "busy", source: "assistant", terminalAt: null },
            observedAt: new Date().toISOString(),
          }]);
          resolve();
        });
      });
      await reconciliation;
      reconciliationFinished = true;
      await mutation;
    });

    expect(Object.keys(registry.snapshot().conversations)).toHaveLength(LARGE_INVENTORY_SIZE);
    expect(mutationRanDuringReconciliation).toBe(true);
    expect(registry.conversationForPath(files[0]!.path)?.turn.state).toBe("busy");
    expect(percentile(lags, 0.95)).toBeLessThan(EVENT_LOOP_BUDGET_MS);
    expect(Math.max(...lags)).toBeLessThan(EVENT_LOOP_BUDGET_MS);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 30_000);

test("a complete initial controller cycle stays inside the event-loop budget", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-full-controller-lag-"));
  const previousStateDir = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(base, "state");
  try {
    const transcriptRoot = path.join(base, "sessions");
    await mkdir(transcriptRoot, { recursive: true });
    const files = await Promise.all(Array.from({ length: LARGE_INVENTORY_SIZE }, async (_, index): Promise<FileEntry> => {
      const pathname = path.join(transcriptRoot, `controller-${String(index).padStart(4, "0")}.jsonl`);
      const content = [
        JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/full-controller" } }),
        ...Array.from({ length: 63 }, () => JSON.stringify({
          type: "event_msg",
          payload: { type: "agent_message", message: "r".repeat(1_900) },
        })),
      ].join("\n") + "\n";
      await writeFile(pathname, content);
      return {
        path: pathname,
        root: "codex-sessions",
        name: path.basename(pathname),
        project: "full-controller",
        title: `Controller session ${index}`,
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
    const visited: string[] = [];
    const cooperativePhase = async (name: string): Promise<void> => {
      visited.push(name);
      await forEachCooperatively(files, (file) => {
        JSON.parse(JSON.stringify({ path: file.path, title: file.title, size: file.size }));
      });
    };
    const controller = new AccountMigrationController(
      registry,
      { tick: async () => undefined },
      null,
      {
        scan: async () => {
          await cooperativePhase("scan");
          return { files, projectCatalog: [] };
        },
        reconcileFlowOwnership: async () => cooperativePhase("flows"),
        reconcileWorkflowOwnership: async () => cooperativePhase("workflows"),
        reconcileHandoffOwnership: async () => cooperativePhase("handoffs"),
        reconcileFiles: async () => cooperativePhase("file-controllers"),
        reconcileRuntime: async (currentRegistry, currentFiles) => {
          visited.push("runtime");
          await runReaperCycle({
            registry: currentRegistry,
            hosts: [],
            files: currentFiles,
            actuation: { loadFlows: () => [] },
          });
        },
        reconcileTaskStore: async () => cooperativePhase("tasks"),
        syncRouting: async () => cooperativePhase("routing"),
        reconcileMigrationCycle: async () => cooperativePhase("migrations"),
      },
    );

    const lags = await eventLoopLagsWhile(() => controller.tick());

    expect(visited).toEqual([
      "scan",
      "flows",
      "workflows",
      "handoffs",
      "file-controllers",
      "runtime",
      "tasks",
      "routing",
      "migrations",
    ]);
    expect(Object.keys(registry.snapshot().conversations)).toHaveLength(LARGE_INVENTORY_SIZE);
    expect(percentile(lags, 0.95)).toBeLessThan(EVENT_LOOP_BUDGET_MS);
    expect(Math.max(...lags)).toBeLessThan(EVENT_LOOP_BUDGET_MS);
  } finally {
    if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDir;
    await rm(base, { recursive: true, force: true });
  }
}, 30_000);

test("authorship scanning yields while reading one large transcript", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-large-authorship-lag-"));
  const previousStateDir = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(base, "state");
  try {
    const pathname = path.join(base, "large.jsonl");
    const sessionRecord = JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/large-authorship" } }) + "\n";
    const assistantRecord = JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", message: "a".repeat(1_900) },
    }) + "\n";
    const targetBytes = 65 * 1024 * 1024;
    const content = sessionRecord + assistantRecord.repeat(Math.ceil((targetBytes - sessionRecord.length) / assistantRecord.length));
    await writeFile(pathname, content);
    const file: FileEntry = {
      path: pathname,
      root: "codex-sessions",
      name: path.basename(pathname),
      project: "large-authorship",
      title: "Large authorship transcript",
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
    const registry = new AgentRegistry(path.join(base, "agent-registry.json"));

    const lags = await eventLoopLagsWhile(async () => {
      await runReaperCycle({
        registry,
        hosts: [],
        files: [file],
        actuation: { loadFlows: () => [] },
      });
    });

    expect(percentile(lags, 0.95)).toBeLessThan(EVENT_LOOP_BUDGET_MS);
    expect(Math.max(...lags)).toBeLessThan(EVENT_LOOP_BUDGET_MS);
  } finally {
    if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDir;
    await rm(base, { recursive: true, force: true });
  }
}, 30_000);
