import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";

import type { RuntimeHostClient } from "./client";
import {
  STALE_STRUCTURED_SPAWN_TIMEOUT_MS,
  terminalizeStaleStructuredSpawns,
} from "./structuredSpawn";

const DEAD_RUNTIME_CLIENT = {
  operationStatus: async () => null,
  snapshot: async () => ({ revision: 0, sessions: [] }),
} as unknown as RuntimeHostClient;

function registry(): AgentRegistry {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-terminalize-"));
  return new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
}

function staleStructuredReceipt(store: AgentRegistry, attempt: string) {
  const begun = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    transport: "structured",
    accountId: "work",
    clientAttemptId: attempt,
    requestDigest: "d".repeat(64),
    launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
  });
  if (begun.kind !== "created") throw new Error("expected structured launch creation");
  return begun.receipt;
}

const AGED = () => Date.now() + STALE_STRUCTURED_SPAWN_TIMEOUT_MS + 60_000;

test("a stale dead-evidence structured launch converges to durable retry-safe failed exactly once", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "stale_20260719_a1");
  const before = store.snapshot();
  const receiptCount = Object.keys(before.receipts).length;
  const conversationCount = Object.keys(before.conversations).length;

  const first = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
    ownerAlive: () => false,
  });
  expect(first.examined).toBe(1);
  expect(first.terminalized).toEqual([receipt.launchId]);
  expect(first.recovered).toEqual([]);

  const failed = store.snapshot().receipts[receipt.launchId]!;
  expect(failed.state).toBe("failed");
  expect(failed.error).toContain("no session");
  expect(failed.conversationId).toBe(receipt.conversationId);

  /* Idempotence: a second pass is a no-op — terminal receipts are skipped. */
  const second = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
    ownerAlive: () => false,
  });
  expect(second).toEqual({ examined: 0, terminalized: [], recovered: [] });

  /* No-loss: no receipt or conversation row is ever deleted by convergence. */
  const after = store.snapshot();
  expect(Object.keys(after.receipts)).toHaveLength(receiptCount);
  expect(Object.keys(after.conversations)).toHaveLength(conversationCount);
});

test("a live admission owner keeps responsibility for its deferred launch", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "live_owner_20260719_a1");

  const result = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
    ownerAlive: () => true,
  });
  expect(result).toEqual({ examined: 0, terminalized: [], recovered: [] });
  expect(store.snapshot().receipts[receipt.launchId]!.state).toBe("starting");
});

test("a receipt younger than the pass timeout is never touched", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "fresh_20260719_a1");

  const result = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    ownerAlive: () => false,
  });
  expect(result).toEqual({ examined: 0, terminalized: [], recovered: [] });
  expect(store.snapshot().receipts[receipt.launchId]!.state).toBe("starting");
});

test("a staged launch whose host entry is claimed stays with its claimant", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "claimed_20260719_a1");
  const staged = store.stageStructuredSpawn(receipt.launchId, {
    key: { engine: "codex", sessionId: "019f7b8a-9f75-7dc0-b231-17f7eadd7fe1" },
    artifactPath: "/sessions/019f7b8a-9f75-7dc0-b231-17f7eadd7fe1.jsonl",
    cwd: "/repo",
    accountId: "work",
    launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
    status: "unhosted",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:pending",
      process: null,
      eventCursor: 0,
      protocolVersion: null,
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "worker:live",
    pendingAction: "spawn",
  });
  expect(staged.kind).toBe("settled");

  const result = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
    ownerAlive: () => false,
  });
  expect(result).toEqual({ examined: 0, terminalized: [], recovered: [] });
  expect(store.snapshot().receipts[receipt.launchId]!.state).not.toBe("failed");
});

test("the actuation cap bounds one cycle and the remainder converges on the next", async () => {
  const store = registry();
  const receipts = [
    staleStructuredReceipt(store, "capped_20260719_a1"),
    staleStructuredReceipt(store, "capped_20260719_a2"),
    staleStructuredReceipt(store, "capped_20260719_a3"),
  ];

  const first = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
    ownerAlive: () => false,
    actuationCap: 2,
  });
  expect(first.examined).toBe(2);
  expect(first.terminalized).toHaveLength(2);

  const second = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
    ownerAlive: () => false,
    actuationCap: 2,
  });
  expect(second.examined).toBe(1);
  expect(second.terminalized).toHaveLength(1);
  for (const receipt of receipts) {
    expect(store.snapshot().receipts[receipt.launchId]!.state).toBe("failed");
  }
});
