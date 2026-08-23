import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";
import { spawnResponseForReceipt } from "@/lib/agent/spawnResponse";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";

import type { RuntimeHostClient } from "./client";
import {
  STALE_STRUCTURED_SPAWN_TIMEOUT_MS,
  reconcileStructuredSpawnReplay,
  terminalizeStaleStructuredSpawns,
} from "./structuredSpawn";

const DEAD_RUNTIME_CLIENT = {
  operationStatus: async () => null,
  snapshot: async () => ({ revision: 0, sessions: [] }),
  effectBatch: async () => [],
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

function stagedStructuredReceipt(store: AgentRegistry, attempt: string) {
  const receipt = staleStructuredReceipt(store, attempt);
  const key = { engine: "codex" as const, sessionId: `session-${attempt}` };
  const artifactPath = path.join(path.dirname(store.filename), `${key.sessionId}.jsonl`);
  store.stageStructuredSpawn(receipt.launchId, {
    key,
    artifactPath,
    cwd: "/repo",
    accountId: "work",
    launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:live",
      process: { pid: process.pid, startIdentity: `host-${attempt}` },
      eventCursor: 1,
      protocolVersion: "v2",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: `structured-host:${attempt}`,
    pendingAction: "spawn",
  });
  return { receipt, key };
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
  });
  expect(second).toEqual({ examined: 0, terminalized: [], recovered: [] });

  /* No-loss: no receipt or conversation row is ever deleted by convergence. */
  const after = store.snapshot();
  expect(Object.keys(after.receipts)).toHaveLength(receiptCount);
  expect(Object.keys(after.conversations)).toHaveLength(conversationCount);
});

test.each(["codex", "claude"] as const)("an overdue %s placeholder still fails when runtime effect history is unavailable", async (engine) => {
  const store = registry();
  const begun = store.beginSpawnRequest({
    engine,
    cwd: "/repo",
    transport: "structured",
    accountId: "work",
    clientAttemptId: `effect_history_outage_${engine}`,
    requestDigest: engine === "codex" ? "c".repeat(64) : "a".repeat(64),
    launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
  });
  if (begun.kind !== "created") throw new Error("expected structured launch creation");
  const receipt = begun.receipt;
  const artifactPath = path.join(path.dirname(store.filename), `${engine}-effect-outage.jsonl`);
  store.stageStructuredSpawn(receipt.launchId, {
    key: { engine, sessionId: `${engine}-effect-outage` },
    artifactPath,
    cwd: "/repo",
    accountId: "work",
    launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
    status: "dead",
    host: null,
    structuredHost: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: "spawn",
  });
  const client = {
    operationStatus: async () => null,
    snapshot: async () => ({ revision: 0, sessions: [] }),
    effectBatch: async () => { throw new Error("runtime effect history is unavailable"); },
  } as unknown as RuntimeHostClient;

  const beforeDeadline = await reconcileStructuredSpawnReplay(receipt.launchId, store, client, {
    now: () => Date.parse(receipt.createdAt) + STALE_STRUCTURED_SPAWN_TIMEOUT_MS - 1,
  });
  expect(beforeDeadline).toMatchObject({ state: "path-pending", initialMessage: "pending", error: null });

  const result = await terminalizeStaleStructuredSpawns(store, client, { now: AGED });

  expect(result).toEqual({ examined: 1, terminalized: [receipt.launchId], recovered: [] });
  const failed = store.snapshot().receipts[receipt.launchId]!;
  expect(failed).toMatchObject({
    state: "failed",
    error: expect.stringContaining("runtime effect history remained unavailable"),
  });
  expect(spawnResponseForReceipt(failed, failed.artifactPath, { structured: true })).toMatchObject({
    state: "failed",
    retrySafe: true,
    initialMessage: "failed",
  });
});

test("a live admission owner loses an overdue deferred launch at the bounded timeout", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "live_owner_20260719_a1");

  const result = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
  });
  expect(result).toEqual({ examined: 1, terminalized: [receipt.launchId], recovered: [] });
  expect(store.snapshot().receipts[receipt.launchId]!.state).toBe("failed");
});

test("a terminal runtime operation preserves its reason through generic stale reconciliation", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "terminal_operation_reason");
  const client = {
    effectBatch: async () => [],
    operationStatus: async (operationId: string) => operationId === receipt.launchId ? {
      receipt: {
        operationId,
        idempotencyKey: operationId,
        conversationId: receipt.conversationId,
        kind: "spawn" as const,
        status: "failed" as const,
        reason: "synthetic terminal spawn failure",
        at: receipt.createdAt,
        revision: 2,
      },
      replayed: false,
    } : null,
    snapshot: async () => ({ revision: 0, sessions: [] }),
  } as unknown as RuntimeHostClient;

  const result = await terminalizeStaleStructuredSpawns(store, client, { now: AGED });

  expect(result).toEqual({ examined: 1, terminalized: [receipt.launchId], recovered: [] });
  expect(store.snapshot().receipts[receipt.launchId]).toMatchObject({
    state: "failed",
    error: "synthetic terminal spawn failure",
  });
});

test("a receipt younger than the pass timeout is never touched", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "fresh_20260719_a1");

  const result = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT);
  expect(result).toEqual({ examined: 0, terminalized: [], recovered: [] });
  expect(store.snapshot().receipts[receipt.launchId]!.state).toBe("starting");
});

test("a staged launch whose host entry stays claimed still fails at the bounded timeout", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "claimed_20260719_a1");
  const staged = store.stageStructuredSpawn(receipt.launchId, {
    key: { engine: "codex", sessionId: "019f7b8a-" + "9f75-7dc0-b231-17f7eadd7fe1" },
    artifactPath: "/sessions/019f7b8a_9f75_7dc0_b231_17f7eadd7fe1.jsonl",
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
  });
  expect(result).toEqual({ examined: 1, terminalized: [receipt.launchId], recovered: [] });
  expect(store.snapshot().receipts[receipt.launchId]!.state).toBe("failed");
});

test("reconciliation never releases a host after concurrent spawn completion", async () => {
  const store = registry();
  const { receipt } = stagedStructuredReceipt(store, "concurrent_completion");
  let released = 0;
  let operationStatus = "queued";
  const client = {
    effectBatch: async () => [],
    operationStatus: async (operationId: string) => operationId === receipt.launchId ? {
      operationId,
      replayed: false,
      receipt: {
        operationId,
        idempotencyKey: receipt.launchId,
        conversationId: receipt.conversationId,
        kind: "spawn" as const,
        status: operationStatus,
        reason: null,
        at: receipt.createdAt,
        revision: 1,
      },
    } : null,
    snapshot: async () => {
      expect(store.finalizeStructuredSpawn(receipt.launchId).kind).toBe("settled");
      return { revision: 1, sessions: [] };
    },
    transitionOperation: async () => {
      operationStatus = "failed";
      throw new Error("a completed launch must not be failed");
    },
  } as unknown as RuntimeHostClient;

  const reconciled = await reconcileStructuredSpawnReplay(receipt.launchId, store, client, {
    now: AGED,
    releaseHost: async () => { released += 1; return true; },
  });

  expect(reconciled).toMatchObject({ state: "completed", initialMessage: "delivered", error: null });
  expect(store.snapshot().receipts[receipt.launchId]!.state).toBe("completed");
  expect(operationStatus).toBe("queued");
  expect(released).toBe(0);
});

test("reconciliation preserves a newer same-key host owner", async () => {
  const store = registry();
  const { receipt, key } = stagedStructuredReceipt(store, "newer_same_key_owner");
  const previous = store.snapshot().entries[`codex:${key.sessionId}`]!;
  const { updatedAt: _updatedAt, ...newerEntry } = previous;
  let released = 0;
  const client = {
    effectBatch: async () => [],
    operationStatus: async (operationId: string) => operationId === receipt.launchId ? {
      operationId,
      replayed: false,
      receipt: {
        operationId,
        idempotencyKey: receipt.launchId,
        conversationId: receipt.conversationId,
        kind: "spawn" as const,
        status: "queued" as const,
        reason: null,
        at: receipt.createdAt,
        revision: 1,
      },
    } : null,
    snapshot: async () => ({ revision: 1, sessions: [] }),
    transitionOperation: async (operationId: string) => {
      store.upsert({
        ...newerEntry,
        structuredHostOperationId: "newer-launch-operation",
        structuredHost: {
          ...newerEntry.structuredHost!,
          process: { pid: process.pid, startIdentity: "newer-host" },
        },
        claimOwner: "structured-host:newer",
      });
      return {
        operationId,
        replayed: false,
        receipt: {
          operationId,
          idempotencyKey: receipt.launchId,
          conversationId: receipt.conversationId,
          kind: "spawn" as const,
          status: "failed" as const,
          reason: "stale launch superseded",
          at: receipt.createdAt,
          revision: 2,
        },
      };
    },
  } as unknown as RuntimeHostClient;

  const reconciled = await reconcileStructuredSpawnReplay(receipt.launchId, store, client, {
    now: AGED,
    releaseHost: async () => { released += 1; return true; },
  });

  expect(reconciled).toMatchObject({ state: "failed", initialMessage: "failed" });
  expect(store.snapshot().entries[`codex:${key.sessionId}`]).toMatchObject({
    status: "idle",
    structuredHostOperationId: "newer-launch-operation",
    claimOwner: "structured-host:newer",
    structuredHost: { process: { startIdentity: "newer-host" } },
  });
  expect(released).toBe(0);
});

test("issue 533: host loss after recoverable timeout reaches retry-safe failure despite the same process staying live", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "recoverable_timeout_host_loss");
  const key = { engine: "codex" as const, sessionId: "session-timeout-host-loss" };
  store.stageStructuredSpawn(receipt.launchId, {
    key,
    artifactPath: "/sessions/timeout-host-loss.jsonl",
    cwd: "/repo",
    accountId: "work",
    launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
    status: "dead",
    host: null,
    structuredHost: {
      kind: "codex-app-server", endpoint: "stdio:released", process: null,
      eventCursor: 1, protocolVersion: null, writerClaimEpoch: 0,
      activeTurnRef: null, pendingAttention: [], activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: "spawn",
  });
  store.releaseStructuredSpawnAdmissionOwner(receipt.launchId, receipt.admissionOwner!);

  const result = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
  });

  expect(result).toEqual({ examined: 1, terminalized: [receipt.launchId], recovered: [] });
  expect(store.snapshot().receipts[receipt.launchId]).toMatchObject({
    state: "failed",
    admissionOwner: null,
    error: expect.stringContaining("no session"),
  });
  expect(spawnResponseForReceipt(store.snapshot().receipts[receipt.launchId]!)).toMatchObject({
    state: "failed",
    retrySafe: true,
  });
});

test("issue 1074: a stale materialized launch is recovered from its late transcript on the reaper tick", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "materialized_incident_placeholder");
  const sessionId = "materialized-incident-session";
  const artifactPath = path.join(path.dirname(store.filename), `${sessionId}.jsonl`);
  fs.writeFileSync(artifactPath, JSON.stringify({
    type: "event_msg",
    payload: { type: "user_message", message: "delayed initial message" },
  }) + "\n");
  store.stageStructuredSpawn(receipt.launchId, {
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd: "/repo",
    accountId: "work",
    launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:incident",
      process: { pid: process.pid, startIdentity: "incident-host" },
      eventCursor: 3,
      protocolVersion: "v2",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "structured-host:incident",
    pendingAction: "spawn",
  });
  store.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "work",
    launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
    turn: { state: "busy", source: "assistant", terminalAt: null },
    observedAt: new Date().toISOString(),
  }]);
  expect(store.snapshot().receipts[receipt.launchId]).toMatchObject({
    state: "path-pending",
    artifactLifecycle: "materialized",
  });

  const result = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
  });

  expect(result).toEqual({ examined: 1, terminalized: [], recovered: [receipt.launchId] });
  expect(store.snapshot().receipts[receipt.launchId]).toMatchObject({
    state: "completed",
    artifactLifecycle: "materialized",
    completionMode: "route-recovered",
    error: null,
  });
});

test.each(["codex", "claude"] as const)("issue 1074: a stale %s registering host fails at the generic setup bound", async (engine) => {
  const store = registry();
  const begun = store.beginSpawnRequest({
    engine,
    cwd: "/repo",
    transport: "structured",
    accountId: "work",
    clientAttemptId: `registering_${engine}_incident`,
    requestDigest: engine === "codex" ? "c".repeat(64) : "a".repeat(64),
    launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
  });
  if (begun.kind !== "created") throw new Error("expected structured launch creation");
  const receipt = begun.receipt;
  const key = { engine, sessionId: `${engine}-registering-session` };
  const artifactPath = path.join(path.dirname(store.filename), `${key.sessionId}.jsonl`);
  store.stageStructuredSpawn(receipt.launchId, {
    key,
    artifactPath,
    cwd: "/repo",
    accountId: "work",
    launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
    status: "idle",
    host: null,
    structuredHost: {
      kind: engine === "codex" ? "codex-app-server" : "claude-broker",
      endpoint: "stdio:registering",
      process: { pid: process.pid, startIdentity: `${engine}-incident-host` },
      eventCursor: 1,
      protocolVersion: "v2",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: `structured-host:${engine}-incident`,
    pendingAction: "spawn",
  });
  let operationStatus = "queued";
  let operationReason: string | null = null;
  let released = 0;
  const terminated: Array<{ pid: number; startIdentity: string | null }> = [];
  const operationResult = () => ({
    operationId: receipt.launchId,
    replayed: false,
    receipt: {
      operationId: receipt.launchId,
      idempotencyKey: receipt.launchId,
      conversationId: receipt.conversationId,
      kind: "spawn" as const,
      status: operationStatus,
      reason: operationReason,
      at: receipt.createdAt,
      revision: operationStatus === "queued" ? 1 : 2,
    },
  });
  const client = {
    effectBatch: async () => [],
    operationStatus: async (operationId: string) => operationId === receipt.launchId ? operationResult() : null,
    transitionOperation: async (_operationId: string, status: string, details?: { reason?: string | null }) => {
      operationStatus = status;
      operationReason = details?.reason ?? null;
      return operationResult();
    },
    snapshot: async () => ({
      sessions: [{
        conversationId: receipt.conversationId,
        sessionKey: key,
        hostKind: engine === "codex" ? "codex-app-server" : "claude-broker",
        host: "registering",
        turn: "idle",
        provenance: "structured",
        revision: 1,
        attentionIds: [],
        recentReceipts: [],
        accountId: "work",
        parentConversationId: null,
        cwd: "/repo",
        artifactPath,
        capabilities: { steer: engine === "codex", structuredAttention: true },
        activeTurnId: null,
      }],
    }),
  } as unknown as RuntimeHostClient;

  const result = await terminalizeStaleStructuredSpawns(store, client, {
    now: AGED,
    reconcile: (launchId, registry, runtimeClient, options) => reconcileStructuredSpawnReplay(
      launchId,
      registry,
      runtimeClient,
      {
        ...options,
        releaseHost: async () => {
          released += 1;
          return false;
        },
        terminateHostProcess: async (expected) => {
          terminated.push(expected);
          return true;
        },
      },
    ),
  });

  expect(result).toEqual({ examined: 1, terminalized: [receipt.launchId], recovered: [] });
  expect(released).toBe(1);
  expect(terminated).toEqual([{ pid: process.pid, startIdentity: `${engine}-incident-host` }]);
  expect(operationStatus).toBe("failed");
  expect(operationReason ?? "").toContain("durable setup remained incomplete");
  const failed = store.snapshot().receipts[receipt.launchId]!;
  expect(failed).toMatchObject({ state: "failed", error: operationReason });
  expect(spawnResponseForReceipt(failed, failed.artifactPath, { structured: true })).toMatchObject({
    state: "failed",
    retrySafe: true,
    initialMessage: "failed",
  });
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
    actuationCap: 2,
  });
  expect(first.examined).toBe(2);
  expect(first.terminalized).toHaveLength(2);

  const second = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
    actuationCap: 2,
  });
  expect(second.examined).toBe(1);
  expect(second.terminalized).toHaveLength(1);
  for (const receipt of receipts) {
    expect(store.snapshot().receipts[receipt.launchId]!.state).toBe("failed");
  }
});
