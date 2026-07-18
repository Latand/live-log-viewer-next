import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { AccountContext } from "@/lib/accounts/contracts";
import type { ResumeSpec } from "@/lib/agent/cli";
import { AgentRegistry } from "@/lib/agent/registry";
import { spawnResponseForReceipt } from "@/lib/agent/spawnResponse";
import { RuntimeJournal } from "@/runtime-host/journal";

import type { RuntimeHostClient } from "./client";
import { CodexAppServerHost, type CodexAppServerHostOptions } from "./codexAppServerHost";
import { StructuredHostAdoptionCleanupError, type DeliveryReceipt, type HostState, type QueueEntry, type RuntimeEvent } from "./engineHost";
import { bindStructuredDeliveryQueue, hasStructuredDeliveryHost } from "./structuredDeliveryController";
import { dispatchStructuredControl } from "./structuredControls";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";
import { INITIAL_MESSAGE_TIMEOUT_MS, reconcileStructuredSpawnReplay, recoverPendingStructuredSpawns, spawnStructuredConversation, structuredClaudePermissionMode, structuredClaudeSpawnPolicyBaseSettingsPath, waitForStructuredInitialMessage, type SpawnedStructuredHost } from "./structuredSpawn";
import { materializeStructuredTerminal } from "./structuredTerminal";

type UnsequencedEvent = RuntimeEvent extends infer Event
  ? Event extends RuntimeEvent ? Omit<Event, "seq"> : never
  : never;

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-spawn-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));
afterEach(async () => { await bindStructuredDeliveryQueue([]); });

test("structured Claude permission mapping distinguishes trusted autonomous spawn paths", () => {
  expect(structuredClaudePermissionMode("bypassPermissions", {
    agentInitiated: true,
    operatorAuthenticated: true,
    roleSpawn: true,
  })).toBe("bypassPermissions");
  expect(structuredClaudePermissionMode("bypassPermissions", {
    agentInitiated: false,
    operatorAuthenticated: false,
    roleSpawn: true,
  })).toBe("bypassPermissions");
  expect(structuredClaudePermissionMode("bypassPermissions", {
    agentInitiated: true,
    operatorAuthenticated: false,
    roleSpawn: true,
  })).toBe("bypassPermissions");
  expect(structuredClaudePermissionMode("bypassPermissions", {
    agentInitiated: true,
    operatorAuthenticated: false,
    roleSpawn: false,
  })).toBe("default");
  expect(structuredClaudePermissionMode("bypassPermissions", {
    agentInitiated: false,
    operatorAuthenticated: false,
    roleSpawn: false,
  })).toBe("bypassPermissions");
  expect(structuredClaudePermissionMode("plan", {
    agentInitiated: true,
    operatorAuthenticated: false,
    roleSpawn: true,
  })).toBe("plan");
});

test("structured Claude receipts expose the effective permission mode", () => {
  const store = new AgentRegistry(path.join(sandbox, `permission-receipt-${crypto.randomUUID()}.json`), undefined, undefined, { sqliteMode: "off" });
  const trusted = store.beginSpawnRequest({
    engine: "claude",
    cwd: "/repo",
    transport: "structured",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", permissionMode: "bypassPermissions" }),
  });
  const downgraded = store.beginSpawnRequest({
    engine: "claude",
    cwd: "/repo",
    transport: "structured",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", permissionMode: "default" }),
  });
  if (trusted.kind !== "created" || downgraded.kind !== "created") throw new Error("spawn receipt was unavailable");

  expect(spawnResponseForReceipt(trusted.receipt, null)).toMatchObject({
    state: "starting",
    effectivePermissionMode: "bypassPermissions",
  });
  expect(spawnResponseForReceipt(downgraded.receipt, null)).toMatchObject({
    state: "starting",
    effectivePermissionMode: "default",
  });
});

test("fresh managed Claude structured spawns select the shared settings snapshot", () => {
  const managed = { kind: "managed" } as AccountContext;
  const legacy = { kind: "legacy" } as AccountContext;

  expect(structuredClaudeSpawnPolicyBaseSettingsPath(managed, () => "/shared/claude/settings.json"))
    .toBe("/shared/claude/settings.json");
  expect(structuredClaudeSpawnPolicyBaseSettingsPath(legacy, () => "/shared/claude/settings.json"))
    .toBeNull();
});

test("attempt e9e8a4b4 terminalizes a queued initial message after the bounded host timeout", async () => {
  let now = 0;
  let polls = 0;
  const client = {
    operationStatus: async () => {
      polls += 1;
      return {
        receipt: {
          operationId: "spawn_message_e9e8a4b4",
          idempotencyKey: "spawn_e9e8a4b4",
          conversationId: "conversation_e9e8a4b4",
          kind: "send" as const,
          status: "queued" as const,
          at: new Date(0).toISOString(),
          revision: polls,
        },
        replayed: polls > 1,
      };
    },
  } as unknown as RuntimeHostClient;

  await expect(waitForStructuredInitialMessage(client, "spawn_message_e9e8a4b4", {
    now: () => now,
    sleep: async (ms) => { now += ms; },
  })).rejects.toThrow(`initial message remained queued for ${INITIAL_MESSAGE_TIMEOUT_MS}ms`);
  expect(now).toBe(INITIAL_MESSAGE_TIMEOUT_MS);
  expect(polls).toBeGreaterThan(1);
});

test("initial-message confirmation survives a transient runtime status read", async () => {
  let now = 0;
  let polls = 0;
  const client = {
    operationStatus: async () => {
      polls += 1;
      if (polls === 1) throw new Error("runtime socket is resynchronizing");
      return {
        receipt: {
          operationId: "spawn_message_transient",
          idempotencyKey: "spawn_transient",
          conversationId: "conversation_transient",
          kind: "send" as const,
          status: "delivered" as const,
          at: new Date(0).toISOString(),
          revision: polls,
        },
        replayed: true,
      };
    },
  } as unknown as RuntimeHostClient;

  await waitForStructuredInitialMessage(client, "spawn_message_transient", {
    now: () => now,
    sleep: async (ms) => { now += ms; },
  });

  expect(polls).toBe(2);
  expect(now).toBe(250);
});

test("attempt 93c42855 recovers a failed registry receipt from transcript evidence", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `transcript-replay-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "stikon",
    clientAttemptId: "attempt_93c42855_stikon",
  });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  registry.stageStructuredSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: id },
    artifactPath,
    cwd,
    accountId: "stikon",
    status: "unhosted",
    host: null,
    structuredHost: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: "spawn",
  });
  registry.failStructuredSpawn(begun.receipt.launchId, "structured host ownership is unavailable");
  fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Own issue #282" } })}\n`);

  const reconciled = await reconcileStructuredSpawnReplay(begun.receipt.launchId, registry, runtimeClient(journal));

  expect(reconciled).toMatchObject({ state: "completed", initialMessage: "delivered" });
  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    state: "completed",
    completionMode: "route-recovered",
    error: null,
  });
});

test("clientAttemptId replay materializes its reserved conversation from runtime evidence", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `runtime-replay-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "terra",
    clientAttemptId: "p0_282_runtime_replay_20260716_a1",
  });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const client = {
    snapshot: async () => ({
      schemaVersion: 1,
      snapshotSeq: 4,
      retentionFloorSeq: 0,
      serverTime: new Date().toISOString(),
      runtime: { hostEpoch: 1, health: "ready" },
      filesRevision: 0,
      sessions: [{
        conversationId: begun.receipt.conversationId,
        sessionKey: { engine: "codex" as const, sessionId: id },
        hostKind: "codex-app-server" as const,
        host: "hosted" as const,
        turn: "running" as const,
        provenance: "structured" as const,
        revision: 4,
        attentionIds: [],
        recentReceipts: [],
        accountId: "terra",
        parentConversationId: null,
        flowId: null,
        workflowId: null,
        cwd,
        artifactPath,
        capabilities: { steer: true, structuredAttention: true },
        activeTurnId: "turn-initial",
      }],
      attentions: [],
      recentOperations: [],
      edges: [],
      flows: [],
      workflows: [],
      tasks: [],
      deployments: [],
    }),
    operationStatus: async (operationId: string) => operationId === `spawn_message_${begun.receipt.launchId}` ? {
      receipt: {
        operationId,
        idempotencyKey: `spawn_${begun.receipt.launchId}`,
        conversationId: begun.receipt.conversationId,
        kind: "send" as const,
        status: "delivered" as const,
        at: new Date().toISOString(),
        revision: 2,
      },
      replayed: true,
    } : null,
  } as unknown as RuntimeHostClient;

  const reconciled = await reconcileStructuredSpawnReplay(begun.receipt.launchId, registry, client);

  expect(reconciled).toMatchObject({
    state: "completed",
    conversationId: begun.receipt.conversationId,
    artifactPath,
    key: { engine: "codex", sessionId: id },
    initialMessage: "delivered",
  });
  expect(registry.snapshot().conversations[begun.receipt.conversationId]?.generations).toHaveLength(1);
});

test("completed replay preserves its live structured host ownership", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `completed-live-replay-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "review current diff" } })}\n`);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
    clientAttemptId: `completed-live-${id}`,
  });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const key = { engine: "codex" as const, sessionId: id };
  const staged = registry.stageStructuredSpawn(begun.receipt.launchId, {
    key,
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    status: "live",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:4312",
      process: { pid: 4312, startIdentity: "4312:live" },
      eventCursor: 8,
      protocolVersion: "0.144.5",
      writerClaimEpoch: 3,
      activeTurnRef: "turn-live",
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 3,
    claimOwner: "structured-host:live-owner",
    pendingAction: "spawn",
  });
  if (staged.kind !== "settled") throw new Error("spawn staging failed");
  expect(registry.finalizeStructuredSpawn(begun.receipt.launchId)).toMatchObject({ kind: "settled" });
  const entryBeforeReplay = registry.snapshot().entries[`codex:${id}`];
  const client = {
    snapshot: async () => ({
      sessions: [{
        conversationId: begun.receipt.conversationId,
        sessionKey: key,
        cwd,
        artifactPath,
        hostKind: "codex-app-server" as const,
        host: "unhosted" as const,
        turn: "idle" as const,
        revision: 9,
        attentionIds: [],
        activeTurnId: null,
      }],
    }),
    operationStatus: async (operationId: string) => operationId === `spawn_message_${begun.receipt.launchId}` ? {
      receipt: {
        operationId,
        idempotencyKey: `spawn_${begun.receipt.launchId}`,
        conversationId: begun.receipt.conversationId,
        kind: "send" as const,
        status: "delivered" as const,
        at: new Date().toISOString(),
        revision: 3,
      },
      replayed: true,
    } : null,
  } as unknown as RuntimeHostClient;
  let released = 0;

  const reconciled = await reconcileStructuredSpawnReplay(begun.receipt.launchId, registry, client, {
    releaseHost: async () => { released += 1; return true; },
  });

  expect(reconciled).toMatchObject({ state: "completed", initialMessage: "delivered" });
  expect(registry.snapshot().entries[`codex:${id}`]).toEqual(entryBeforeReplay);
  expect(released).toBe(0);
});

test.each(["codex", "claude"] as const)("%s replay keeps a live registering spawn pending beyond the receipt timeout", async (engine) => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `registering-replay-${engine}-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const key = { engine, sessionId: id };
  const begun = registry.beginSpawnRequest({
    engine,
    cwd,
    transport: "structured",
    accountId: `${engine}-subscription`,
    clientAttemptId: `registering-${engine}-${id}`,
  });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  registry.stageStructuredSpawn(begun.receipt.launchId, {
    key,
    artifactPath,
    cwd,
    accountId: `${engine}-subscription`,
    status: "unhosted",
    host: null,
    structuredHost: {
      kind: engine === "codex" ? "codex-app-server" : "claude-broker",
      endpoint: "stdio:registering",
      process: null,
      eventCursor: 0,
      protocolVersion: null,
      writerClaimEpoch: 0,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: "spawn",
  });
  const claimed = registry.claimStructuredHost(key, { pid: process.pid, startIdentity: `${engine}-registering` }, { allowUnhosted: true });
  if (!claimed?.claimOwner || !claimed.structuredHost) throw new Error("registering host claim was unavailable");
  registry.setStructuredHostClaimed(key, {
    ...claimed.structuredHost,
    endpoint: "stdio:registering",
    process: { pid: process.pid, startIdentity: `${engine}-registering` },
    writerClaimEpoch: claimed.claimEpoch,
  }, "starting", claimed.claimOwner, claimed.claimEpoch);
  await client.append({
    scope: { type: "session", id: begun.receipt.conversationId },
    kind: "session-status",
    payload: {
      conversationId: begun.receipt.conversationId,
      sessionKey: key,
      hostKind: engine === "codex" ? "codex-app-server" : "claude-broker",
      host: "registering",
      turn: "idle",
      provenance: "structured",
      accountId: `${engine}-subscription`,
      cwd,
      artifactPath,
      capabilities: { steer: engine === "codex", structuredAttention: true },
      activeTurnId: null,
    },
  });
  let released = 0;

  const reconciled = await reconcileStructuredSpawnReplay(begun.receipt.launchId, registry, client, {
    now: () => Date.parse(begun.receipt.createdAt) + INITIAL_MESSAGE_TIMEOUT_MS,
    releaseHost: async () => { released += 1; return true; },
  });

  expect(reconciled).toMatchObject({
    state: "path-pending",
    initialMessage: "pending",
    key,
    artifactPath,
    error: null,
  });
  expect(registry.snapshot().entries[`${engine}:${id}`]).toMatchObject({
    status: "starting",
    pendingAction: "spawn",
    claimOwner: claimed.claimOwner,
    structuredHost: {
      process: { pid: process.pid, startIdentity: `${engine}-registering` },
      writerClaimEpoch: claimed.claimEpoch,
    },
  });
  expect(released).toBe(0);

  registry.releaseStructuredHostClaim(key, claimed.claimOwner, claimed.claimEpoch);
  const abandoned = await reconcileStructuredSpawnReplay(begun.receipt.launchId, registry, client, {
    now: () => Date.parse(begun.receipt.createdAt) + INITIAL_MESSAGE_TIMEOUT_MS,
    releaseHost: async () => { released += 1; return true; },
  });

  expect(abandoned).toMatchObject({ state: "failed", initialMessage: "failed" });
  expect(released).toBe(1);
});

test("replay measures the delivery timeout from initial-message admission", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `admission-timing-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd, transport: "structured", accountId: "codex-subscription" });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const key = { engine: "codex" as const, sessionId: id };
  registry.stageStructuredSpawn(begun.receipt.launchId, {
    key,
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    status: "starting",
    host: null,
    structuredHost: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: "spawn",
  });
  const receiptCreatedAt = Date.parse(begun.receipt.createdAt);
  const messageAdmittedAt = receiptCreatedAt + INITIAL_MESSAGE_TIMEOUT_MS - 1;
  const client = {
    snapshot: async () => ({
      sessions: [{
        conversationId: begun.receipt.conversationId,
        sessionKey: key,
        cwd,
        artifactPath,
        host: "hosted" as const,
      }],
    }),
    operationStatus: async (operationId: string) => operationId === `spawn_message_${begun.receipt.launchId}` ? {
      receipt: {
        operationId,
        idempotencyKey: `spawn_${begun.receipt.launchId}`,
        conversationId: begun.receipt.conversationId,
        kind: "send" as const,
        status: "queued" as const,
        at: new Date(messageAdmittedAt).toISOString(),
        revision: 1,
      },
      replayed: true,
    } : null,
  } as unknown as RuntimeHostClient;
  let released = 0;

  const reconciled = await reconcileStructuredSpawnReplay(begun.receipt.launchId, registry, client, {
    now: () => receiptCreatedAt + INITIAL_MESSAGE_TIMEOUT_MS,
    releaseHost: async () => { released += 1; return true; },
  });

  expect(reconciled).toMatchObject({ state: "path-pending", initialMessage: "queued", error: null });
  expect(released).toBe(0);
});

test("replay terminalizes an explicit initial-message failure before the stage timeout", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `explicit-failure-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd, transport: "structured", accountId: "codex-subscription" });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const key = { engine: "codex" as const, sessionId: id };
  registry.stageStructuredSpawn(begun.receipt.launchId, {
    key,
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    status: "starting",
    host: null,
    structuredHost: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: "spawn",
  });
  const client = {
    snapshot: async () => ({ sessions: [] }),
    operationStatus: async (operationId: string) => operationId === `spawn_message_${begun.receipt.launchId}` ? {
      receipt: {
        operationId,
        idempotencyKey: `spawn_${begun.receipt.launchId}`,
        conversationId: begun.receipt.conversationId,
        kind: "send" as const,
        status: "failed" as const,
        reason: "provider rejected the initial prompt",
        at: begun.receipt.createdAt,
        revision: 1,
      },
      replayed: true,
    } : null,
  } as unknown as RuntimeHostClient;
  let released = 0;

  const reconciled = await reconcileStructuredSpawnReplay(begun.receipt.launchId, registry, client, {
    now: () => Date.parse(begun.receipt.createdAt) + 1,
    releaseHost: async () => { released += 1; return true; },
  });

  expect(reconciled).toMatchObject({
    state: "failed",
    initialMessage: "failed",
    error: "provider rejected the initial prompt",
  });
  expect(released).toBe(1);
});

test("p0_282 empty-host replay terminalizes the receipt and releases its stale guard", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `empty-host-replay-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "terra",
    clientAttemptId: "p0_282_spawn_visibility_20260716_a1",
  });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  registry.stageStructuredSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: id },
    artifactPath,
    cwd,
    accountId: "terra",
    status: "unhosted",
    host: null,
    structuredHost: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: "spawn",
  });
  const client = {
    snapshot: async () => ({ sessions: [] }),
    operationStatus: async (operationId: string) => ({
      receipt: {
        operationId,
        idempotencyKey: operationId,
        conversationId: begun.receipt.conversationId,
        kind: operationId === begun.receipt.launchId ? "spawn" as const : "send" as const,
        status: operationId === begun.receipt.launchId ? "delivered" as const : "queued" as const,
        at: begun.receipt.createdAt,
        revision: 1,
      },
      replayed: true,
    }),
  } as unknown as RuntimeHostClient;
  let released = 0;

  const reconciled = await reconcileStructuredSpawnReplay(begun.receipt.launchId, registry, client, {
    now: () => Date.parse(begun.receipt.createdAt) + INITIAL_MESSAGE_TIMEOUT_MS,
    releaseHost: async () => { released += 1; return true; },
  });

  expect(reconciled).toMatchObject({ state: "failed", initialMessage: "failed" });
  expect(registry.snapshot().entries[`codex:${id}`]).toMatchObject({
    status: "dead",
    claimOwner: null,
    pendingAction: null,
  });
  expect(released).toBe(1);
});

function runtimeClient(journal: RuntimeJournal): RuntimeHostClient {
  return {
    snapshot: async () => journal.snapshot(),
    events: async (after) => journal.replay(after),
    waitEvents: async (after) => journal.replay(after),
    append: async (event) => journal.append(event),
    operation: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (operationId) => journal.operationResult(operationId),
    retryOperation: async (operationId) => journal.retryOperation(operationId),
    producerCursor: async (producerKind, eventKeyPrefix) => journal.producerCursor(producerKind, eventKeyPrefix),
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) => journal.transitionOperation(operationId, status, details),
  } as RuntimeHostClient;
}

class RoundTripHost implements SpawnedStructuredHost {
  readonly sent: QueueEntry[] = [];
  readonly answers: Array<{ id: string; value: unknown }> = [];
  readonly interrupts: string[] = [];
  readonly identity: { threadId: string; path: string } | { sessionId: string };
  private readonly listeners = new Set<(state: HostState) => void>();
  private readonly events: RuntimeEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private cursor = 0;
  private status: HostState["status"] = "idle";
  private activeTurnRef: string | null = null;
  private pendingAttention: string[] = [];
  private released = false;
  releaseCount = 0;

  constructor(readonly engine: "codex" | "claude", readonly artifactPath: string, sessionId: string) {
    this.identity = engine === "codex" ? { threadId: sessionId, path: artifactPath } : { sessionId };
  }

  setWriterFence(fence: () => boolean): void {
    void fence;
  }

  onStateChange(listener: (state: HostState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  attach(afterSeq: number): AsyncIterable<RuntimeEvent> {
    const isReleased = () => this.released;
    const eventAfter = (cursor: number) => this.events.find((candidate) => candidate.seq > cursor);
    const waitForEvent = () => new Promise<void>((resolve) => this.waiters.add(resolve));
    return {
      async *[Symbol.asyncIterator]() {
        let cursor = afterSeq;
        while (!isReleased()) {
          const event = eventAfter(cursor);
          if (event) {
            cursor = event.seq;
            yield event;
            continue;
          }
          await waitForEvent();
        }
      },
    };
  }

  async send(entry: QueueEntry): Promise<DeliveryReceipt> {
    this.sent.push({ ...entry });
    const turnId = `turn-${this.sent.length}`;
    this.status = "active";
    this.activeTurnRef = turnId;
    this.emit({ kind: "turn-started", turnId });
    this.notify();
    return { outcome: "turn-started", turnId };
  }

  finishTurn(): void {
    const turnId = this.activeTurnRef;
    if (!turnId) return;
    this.status = "idle";
    this.activeTurnRef = null;
    this.emit({ kind: "turn-ended", turnId, status: "completed" });
    this.notify();
  }

  ask(attentionId: string): void {
    this.status = "attention";
    this.pendingAttention = [attentionId];
    this.emit({
      kind: "attention",
      id: attentionId,
      method: this.engine === "codex" ? "item/tool/requestUserInput" : "control_request",
      attention: this.engine === "codex"
        ? { turnId: this.activeTurnRef, questions: [{ id: "scope", header: "Scope", question: "Continue?", options: [{ label: "Yes" }] }] }
        : { tool_name: "AskUserQuestion", input: { questions: [{ header: "Scope", question: "Continue?", options: [{ label: "Yes" }] }] } },
    });
    this.notify();
  }

  async answer(attentionRef: string, value: unknown): Promise<void> {
    this.answers.push({ id: attentionRef, value });
    this.pendingAttention = [];
    this.status = this.activeTurnRef ? "active" : "idle";
    this.emit({ kind: "attention-resolved", id: attentionRef, resolution: "answered" });
    this.notify();
  }

  async interrupt(turnRef: string): Promise<void> {
    this.interrupts.push(turnRef);
    this.activeTurnRef = null;
    this.status = "idle";
    this.emit({ kind: "turn-ended", turnId: turnRef, status: "interrupted" });
    this.notify();
  }

  async health(): Promise<HostState> {
    return {
      status: this.status,
      sessionKey: this.engine === "codex" ? (this.identity as { threadId: string }).threadId : (this.identity as { sessionId: string }).sessionId,
      endpoint: "fake:stdio",
      pid: process.pid,
      processStartIdentity: "test-process",
      eventCursor: this.cursor,
      protocolVersion: "fake-v1",
      activeTurnRef: this.activeTurnRef,
      pendingAttention: [...this.pendingAttention],
      activeFlags: [],
      account: { type: this.engine === "codex" ? "chatgpt" : "claude.ai", planType: "subscription" },
    };
  }

  async release(): Promise<void> {
    this.releaseCount += 1;
    this.released = true;
    this.status = "unhosted";
    this.activeTurnRef = null;
    this.pendingAttention = [];
    this.emit({ kind: "session-status", status: "unhosted" });
    const state = await this.health();
    for (const listener of this.listeners) listener(state);
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  private emit(event: UnsequencedEvent): void {
    this.cursor += 1;
    this.events.push({ ...event, seq: this.cursor } as RuntimeEvent);
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  private notify(): void {
    void this.health().then((state) => {
      for (const listener of this.listeners) listener(state);
    });
  }
}

class UnreapableRoundTripHost extends RoundTripHost {
  override async release(): Promise<void> {
    this.releaseCount += 1;
    throw new Error("Codex app-server child could not be reaped");
  }
}

class LateReapingRoundTripHost extends RoundTripHost {
  private readonly lateReapListeners = new Set<(state: HostState) => void>();
  private reaped = false;

  override onStateChange(listener: (state: HostState) => void): () => void {
    this.lateReapListeners.add(listener);
    return () => this.lateReapListeners.delete(listener);
  }

  override async health(): Promise<HostState> {
    const state = await super.health();
    return {
      ...state,
      status: this.reaped ? "unhosted" : "idle",
      endpoint: this.reaped ? "stdio:released" : state.endpoint,
      pid: this.reaped ? null : state.pid,
      processStartIdentity: this.reaped ? null : state.processStartIdentity,
      eventCursor: 942,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    };
  }

  override async release(): Promise<void> {
    this.releaseCount += 1;
    throw new Error("Codex app-server child could not be reaped");
  }

  async completeLateReap(): Promise<void> {
    this.reaped = true;
    const state = await this.health();
    for (const listener of this.lateReapListeners) listener(state);
  }
}

async function waitFor(assertion: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (assertion()) return;
    await Bun.sleep(5);
  }
  throw new Error("round-trip condition did not settle");
}

async function completesWithin<T>(operation: T | PromiseLike<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("a fresh structured spawn permits an intentionally empty first message", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `empty-spawn-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const launchProfile = emptyLaunchProfile({ cwd, model: "gpt-5.6-luna" });
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    accountId: "codex-subscription",
    launchProfile,
  });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const host = new RoundTripHost("codex", artifactPath, id);

  await expect(spawnStructuredConversation({
    engine: "codex",
    receipt: begun.receipt,
    spec: { command: "codex", cwd, windowName: "empty", engine: "codex", transcript: artifactPath, launchProfile },
    account: { engine: "codex", accountId: "codex-subscription", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } },
    prompt: "",
    registry,
    client,
  }, {
    startHost: async () => host,
    bindHost: async (targetRegistry, key, runningHost, claimOwner, claimEpoch) => {
      const state = await runningHost.health();
      targetRegistry.setStructuredHostClaimed(key, {
        kind: "codex-app-server",
        endpoint: state.endpoint,
        process: { pid: process.pid, startIdentity: "test-process" },
        eventCursor: state.eventCursor,
        protocolVersion: state.protocolVersion,
        writerClaimEpoch: claimEpoch,
        activeTurnRef: state.activeTurnRef,
        pendingAttention: state.pendingAttention,
        activeFlags: state.activeFlags,
      }, "idle", claimOwner, claimEpoch);
      return () => {};
    },
    publishHost: async () => async () => {},
    processIdentity: () => ({ pid: process.pid, startIdentity: "test-process" }),
  })).resolves.toMatchObject({ launched: true, state: "settled" });

  expect(host.sent).toEqual([]);
  expect(await client.effectBatch(["runtime.send", "runtime.steer"], 0)).toEqual([]);
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

test("a concurrent structured spawn replay stays pending until durable host setup finishes", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `pending-replay-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  await bindStructuredDeliveryQueue([], { registry, client });
  const parent = registry.ensureConversation("codex", path.join(cwd, "parent.jsonl"), "codex-subscription");
  const child = registry.ensureConversation("codex", artifactPath, "codex-subscription");
  const request = {
    engine: "codex" as const,
    cwd,
    accountId: "codex-subscription",
    parentConversationId: parent.id,
    conversationId: child.id,
    purpose: "resume-successor" as const,
    launchProfile: emptyLaunchProfile({ cwd, model: "gpt-5.6-luna", parentConversationId: parent.id }),
    clientAttemptId: `attempt_${id}`,
    requestDigest: id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
  };
  const begun = registry.beginSpawnRequest(request);
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const host = new RoundTripHost("codex", artifactPath, id);
  const bindReached = deferred();
  const allowBind = deferred();
  const spawning = spawnStructuredConversation({
    engine: "codex",
    receipt: begun.receipt,
    spec: { command: "codex", cwd, windowName: "pending", engine: "codex", transcript: artifactPath, launchProfile: request.launchProfile },
    account: { engine: "codex", accountId: request.accountId, kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } },
    prompt: "initial prompt",
    registry,
    client,
  }, {
    startHost: async () => host,
    bindHost: async (targetRegistry, key, runningHost, claimOwner, claimEpoch) => {
      bindReached.resolve();
      await allowBind.promise;
      const state = await runningHost.health();
      targetRegistry.setStructuredHostClaimed(key, {
        kind: "codex-app-server",
        endpoint: state.endpoint,
        process: { pid: process.pid, startIdentity: "test-process" },
        eventCursor: state.eventCursor,
        protocolVersion: state.protocolVersion,
        writerClaimEpoch: claimEpoch,
        activeTurnRef: state.activeTurnRef,
        pendingAttention: state.pendingAttention,
        activeFlags: state.activeFlags,
      }, "idle", claimOwner, claimEpoch);
      return () => {};
    },
    processIdentity: () => ({ pid: process.pid, startIdentity: "test-process" }),
  });

  await bindReached.promise;
  const replay = registry.beginSpawnRequest(request);
  if (replay.kind !== "replay") throw new Error("concurrent request did not replay");
  const response = spawnResponseForReceipt(replay.receipt, replay.receipt.artifactPath, { structured: true });
  expect(response).toMatchObject({ launched: false, state: "path-pending", path: artifactPath });

  allowBind.resolve();
  await expect(spawning).resolves.toMatchObject({ launched: true, state: "settled", path: artifactPath });
  expect(journal.snapshot().sessions.find((session) => session.conversationId === begun.receipt.conversationId))
    .toMatchObject({ parentConversationId: parent.id });
  expect(journal.snapshot().edges.filter((edge) => edge.childConversationId === begun.receipt.conversationId))
    .toEqual([expect.objectContaining({ parentConversationId: parent.id })]);
});

test("a runtime synchronization hold preserves the staged spawn until recovery drains its first message once", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `held-first-message-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const host = new RoundTripHost("codex", artifactPath, id);
  await bindStructuredDeliveryQueue([{ key: { engine: "codex", sessionId: id }, host }], { registry, client });
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
    clientAttemptId: `held-${id}`,
  });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");

  const response = await spawnStructuredConversation({
    engine: "codex",
    receipt: begun.receipt,
    spec: { command: "codex", cwd, windowName: "held", engine: "codex", transcript: artifactPath },
    account: { engine: "codex", accountId: "codex-subscription", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } },
    prompt: "deliver after runtime recovery",
    registry,
    client,
  }, {
    startHost: async () => host,
    bindHost: async (targetRegistry, key, runningHost, claimOwner, claimEpoch) => {
      const state = await runningHost.health();
      targetRegistry.setStructuredHostClaimed(key, {
        kind: "codex-app-server",
        endpoint: state.endpoint,
        process: { pid: process.pid, startIdentity: "held-test-process" },
        eventCursor: state.eventCursor,
        protocolVersion: state.protocolVersion,
        writerClaimEpoch: claimEpoch,
        activeTurnRef: state.activeTurnRef,
        pendingAttention: state.pendingAttention,
        activeFlags: state.activeFlags,
      }, "idle", claimOwner, claimEpoch);
      return () => {};
    },
    deliverFirst: async () => "held" as never,
    processIdentity: () => ({ pid: process.pid, startIdentity: "held-test-process" }),
  });

  expect(response).toMatchObject({
    launchId: begun.receipt.launchId,
    conversationId: begun.receipt.conversationId,
    path: artifactPath,
    launched: true,
    retrySafe: false,
    initialMessage: "queued",
    state: "path-pending",
  });
  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    state: "path-pending",
    key: { engine: "codex", sessionId: id },
    artifactPath,
    error: null,
  });
  expect(registry.snapshot().entries[`codex:${id}`]).toMatchObject({
    pendingAction: "spawn",
    claimOwner: expect.any(String),
    structuredHostOperationId: begun.receipt.launchId,
    structuredHost: {
      process: { pid: process.pid, startIdentity: "held-test-process" },
    },
  });
  expect(host.releaseCount).toBe(0);

  await client.append({
    scope: { type: "session", id: begun.receipt.conversationId },
    kind: "session-status",
    payload: {
      conversationId: begun.receipt.conversationId,
      sessionKey: { engine: "codex", sessionId: id },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      accountId: "codex-subscription",
      cwd,
      artifactPath,
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: null,
    },
  });

  await recoverPendingStructuredSpawns(registry, client);
  await recoverPendingStructuredSpawns(registry, client);
  await waitFor(() => host.sent.length === 1);

  expect(host.sent.map((entry) => ({ id: entry.id, text: entry.text }))).toEqual([{
    id: `spawn_message_${begun.receipt.launchId}`,
    text: "deliver after runtime recovery",
  }]);
  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    state: "completed",
    key: { engine: "codex", sessionId: id },
    artifactPath,
    error: null,
  });
  expect((await client.operationStatus(begun.receipt.launchId))?.receipt.status).toBe("delivered");
  expect(Object.values(registry.snapshot().heldDeliveries)
    .filter((delivery) => delivery.clientMessageId === `spawn_${begun.receipt.launchId}`))
    .toMatchObject([{ state: "delivered", text: "" }]);
  expect(host.releaseCount).toBe(0);
});

test("a failed resume before identity staging projects dead ownership so the following send recovers", async () => {
  const sessionId = crypto.randomUUID();
  const cwd = path.join(sandbox, `resume-before-identity-${sessionId}`);
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const launchProfile = emptyLaunchProfile({ cwd, model: "gpt-5.6-luna" });
  const conversation = registry.ensureConversation("codex", artifactPath, "codex-subscription");
  const key = { engine: "codex" as const, sessionId };
  registry.upsert({
    key,
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    launchProfile,
    status: "dead",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:released",
      process: null,
      eventCursor: 2_907,
      protocolVersion: "0.144.1",
      writerClaimEpoch: 4,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 4,
    claimOwner: null,
    pendingAction: null,
  });
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
    conversationId: conversation.id,
    purpose: "resume-successor",
    expectedArtifactPath: artifactPath,
    launchProfile,
  });
  if (begun.kind !== "created") throw new Error("resume receipt was unavailable");

  await expect(spawnStructuredConversation({
    engine: "codex",
    receipt: begun.receipt,
    spec: { command: "codex", cwd, windowName: "resume", engine: "codex", transcript: artifactPath, launchProfile },
    account: { engine: "codex", accountId: "codex-subscription", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } },
    prompt: "",
    registry,
    client,
  }, {
    startHost: async () => { throw new Error("runtime event ledger sequence gap after 2907"); },
  })).rejects.toThrow("runtime event ledger sequence gap after 2907");

  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    state: "failed",
    error: "runtime event ledger sequence gap after 2907",
  });
  expect(registry.snapshot().entries[`codex:${sessionId}`]).toMatchObject({
    status: "dead",
    claimOwner: null,
    pendingAction: null,
    structuredHost: { eventCursor: 2_907, process: null },
  });
  expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)).toMatchObject({
    host: "dead",
    sessionKey: key,
    artifactPath,
  });

  let recoveryCalls = 0;
  const delivery = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "send-after-failed-adoption",
    text: "continue after failed adoption",
    hasImages: false,
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    recover: async () => {
      recoveryCalls += 1;
      await client.append({
        scope: { type: "session", id: conversation.id },
        kind: "session-status",
        payload: {
          conversationId: conversation.id,
          sessionKey: key,
          hostKind: "codex-app-server",
          host: "hosted",
          turn: "idle",
          provenance: "structured",
          accountId: "codex-subscription",
          cwd,
          artifactPath,
          capabilities: { steer: true, structuredAttention: true },
        },
      });
      return { target: null, path: artifactPath, conversationId: conversation.id, spawned: true };
    },
    kick: () => {},
  });

  expect(recoveryCalls).toBe(1);
  expect(delivery).toMatchObject({
    ok: true,
    structured: true,
    spawned: true,
    outcome: "queued",
    receipt: { status: "queued", reason: null },
  });
  journal.close();
});

test("structured successor resume forwards the 942-record registry cursor into host adoption", async () => {
  const sessionId = "019f66b5-8694-7410-8671-fbec75484a86";
  const cwd = path.join(sandbox, `resume-cursor-${crypto.randomUUID()}`);
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const launchProfile = emptyLaunchProfile({ cwd, model: "gpt-5.6-luna" });
  const conversation = registry.ensureConversation("codex", artifactPath, "codex-subscription");
  registry.upsert({
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    launchProfile,
    status: "dead",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:released",
      process: null,
      eventCursor: 942,
      protocolVersion: "0.144.1",
      writerClaimEpoch: 3,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 3,
    claimOwner: null,
    pendingAction: null,
  });
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
    conversationId: conversation.id,
    purpose: "resume-successor",
    expectedArtifactPath: artifactPath,
    launchProfile,
  });
  if (begun.kind !== "created") throw new Error("resume receipt was unavailable");
  const seen: Array<{ sessionId: string; cursor: number | undefined }> = [];
  const adopt = spyOn(CodexAppServerHost, "adopt").mockImplementation(async (
    adoptedSessionId: string,
    options: CodexAppServerHostOptions,
  ) => {
    seen.push({ sessionId: adoptedSessionId, cursor: options.initialEventCursor });
    throw new Error("stop after adoption options capture");
  });

  try {
    await expect(spawnStructuredConversation({
      engine: "codex",
      receipt: begun.receipt,
      spec: { command: "codex", cwd, windowName: "resume", engine: "codex", transcript: artifactPath, launchProfile },
      account: { engine: "codex", accountId: "codex-subscription", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } },
      prompt: "",
      registry,
      client,
    })).rejects.toThrow("stop after adoption options capture");
  } finally {
    adopt.mockRestore();
    journal.close();
  }

  expect(seen).toEqual([{ sessionId, cursor: 942 }]);
});

test("an uncertain adoption cleanup retains the child process and writer claim", async () => {
  const sessionId = crypto.randomUUID();
  const cwd = path.join(sandbox, `uncertain-adoption-cleanup-${sessionId}`);
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const launchProfile = emptyLaunchProfile({ cwd, model: "gpt-5.6-luna" });
  const conversation = registry.ensureConversation("codex", artifactPath, "codex-subscription");
  registry.upsert({
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    launchProfile,
    status: "dead",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:released",
      process: null,
      eventCursor: 942,
      protocolVersion: "0.144.1",
      writerClaimEpoch: 3,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 3,
    claimOwner: null,
    pendingAction: null,
  });
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
    conversationId: conversation.id,
    purpose: "resume-successor",
    expectedArtifactPath: artifactPath,
    launchProfile,
  });
  if (begun.kind !== "created") throw new Error("resume receipt was unavailable");
  const host = new UnreapableRoundTripHost("codex", artifactPath, sessionId);

  await expect(spawnStructuredConversation({
    engine: "codex",
    receipt: begun.receipt,
    spec: { command: "codex", cwd, windowName: "resume", engine: "codex", transcript: artifactPath, launchProfile },
    account: { engine: "codex", accountId: "codex-subscription", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } },
    prompt: "",
    registry,
    client,
  }, {
    startHost: async () => {
      throw new StructuredHostAdoptionCleanupError("runtime event ledger sequence gap after 942", host);
    },
    bindHost: async (targetRegistry, key, runningHost, claimOwner, claimEpoch) => {
      const state = await runningHost.health();
      const persisted = targetRegistry.setStructuredHostClaimed(key, {
        kind: "codex-app-server",
        endpoint: state.endpoint,
        process: { pid: state.pid!, startIdentity: state.processStartIdentity },
        eventCursor: state.eventCursor,
        protocolVersion: state.protocolVersion,
        writerClaimEpoch: claimEpoch,
        activeTurnRef: state.activeTurnRef,
        pendingAttention: state.pendingAttention,
        activeFlags: state.activeFlags,
      }, "idle", claimOwner, claimEpoch);
      if (!persisted) throw new Error("uncertain adoption persistence failed");
      return () => { targetRegistry.releaseStructuredHostClaim(key, claimOwner, claimEpoch); };
    },
    processIdentity: () => ({ pid: process.pid, startIdentity: "uncertain-adoption-owner" }),
  })).rejects.toThrow("runtime event ledger sequence gap after 942");

  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({ state: "starting" });
  expect(registry.snapshot().entries[`codex:${sessionId}`]).toMatchObject({
    status: "idle",
    claimEpoch: 4,
    claimOwner: expect.any(String),
    structuredHost: {
      endpoint: "fake:stdio",
      process: { pid: process.pid, startIdentity: "test-process" },
      eventCursor: 0,
      writerClaimEpoch: 4,
    },
  });
  expect(host.releaseCount).toBe(1);
  journal.close();
});

test("late adoption cleanup preserves the open failure and terminalizes the released source", async () => {
  const sessionId = crypto.randomUUID();
  const cwd = path.join(sandbox, `late-adoption-cleanup-${sessionId}`);
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const launchProfile = emptyLaunchProfile({ cwd, model: "gpt-5.6-luna" });
  const conversation = registry.ensureConversation("codex", artifactPath, "codex-subscription");
  registry.upsert({
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    launchProfile,
    status: "dead",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:released",
      process: null,
      eventCursor: 942,
      protocolVersion: "0.144.1",
      writerClaimEpoch: 3,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 3,
    claimOwner: null,
    pendingAction: null,
  });
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
    conversationId: conversation.id,
    purpose: "resume-successor",
    expectedArtifactPath: artifactPath,
    launchProfile,
  });
  if (begun.kind !== "created") throw new Error("resume receipt was unavailable");
  const host = new LateReapingRoundTripHost("codex", artifactPath, sessionId);
  const openFailure = new StructuredHostAdoptionCleanupError(
    "runtime event ledger sequence gap after 942",
    host,
  );
  let surfaced: unknown;

  try {
    await spawnStructuredConversation({
      engine: "codex",
      receipt: begun.receipt,
      spec: { command: "codex", cwd, windowName: "resume", engine: "codex", transcript: artifactPath, launchProfile },
      account: { engine: "codex", accountId: "codex-subscription", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } },
      prompt: "",
      registry,
      client,
    }, {
      startHost: async () => { throw openFailure; },
      processIdentity: () => ({ pid: process.pid, startIdentity: "late-adoption-owner" }),
    });
  } catch (error) {
    surfaced = error;
  }

  await host.completeLateReap();

  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({ state: "starting" });
  expect(registry.snapshot().entries[`codex:${sessionId}`]).toMatchObject({
    status: "dead",
    claimEpoch: 4,
    claimOwner: null,
    structuredHost: {
      endpoint: "stdio:released",
      process: null,
      eventCursor: 942,
      writerClaimEpoch: 4,
    },
  });
  expect(surfaced).toBe(openFailure);
  expect(host.releaseCount).toBe(1);
  journal.close();
});

test("failed adoption keeps dead projection retryable across an append failure and releases its claim", async () => {
  const sessionId = crypto.randomUUID();
  const cwd = path.join(sandbox, `resume-projection-retry-${sessionId}`);
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const launchProfile = emptyLaunchProfile({ cwd, model: "gpt-5.6-luna" });
  const conversation = registry.ensureConversation("codex", artifactPath, "codex-subscription");
  const key = { engine: "codex" as const, sessionId };
  registry.upsert({
    key,
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    launchProfile,
    status: "dead",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:released",
      process: null,
      eventCursor: 942,
      protocolVersion: "0.144.1",
      writerClaimEpoch: 4,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 4,
    claimOwner: null,
    pendingAction: null,
  });
  await client.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: key,
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "running",
      provenance: "structured",
      accountId: "codex-subscription",
      cwd,
      artifactPath,
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: "stale-turn",
    },
  });
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
    conversationId: conversation.id,
    purpose: "resume-successor",
    expectedArtifactPath: artifactPath,
    launchProfile,
  });
  if (begun.kind !== "created") throw new Error("resume receipt was unavailable");
  let failProjectionAppend = true;
  const flakyClient = {
    ...client,
    append: async (...args: Parameters<RuntimeHostClient["append"]>) => {
      const event = args[0];
      if (failProjectionAppend && event.kind === "session-status"
        && (event.payload as { host?: unknown }).host === "dead") {
        failProjectionAppend = false;
        throw new Error("simulated runtime projection append failure");
      }
      return client.append(...args);
    },
  } as RuntimeHostClient;

  await expect(spawnStructuredConversation({
    engine: "codex",
    receipt: begun.receipt,
    spec: { command: "codex", cwd, windowName: "resume", engine: "codex", transcript: artifactPath, launchProfile },
    account: { engine: "codex", accountId: "codex-subscription", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } },
    prompt: "",
    registry,
    client: flakyClient,
  }, {
    startHost: async () => { throw new Error("runtime event ledger sequence gap after 942"); },
    processIdentity: () => ({ pid: 987_654, startIdentity: "failed-adoption" }),
  })).rejects.toThrow("runtime event ledger sequence gap after 942");

  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({ state: "starting" });
  expect(registry.snapshot().entries[`codex:${sessionId}`]).toMatchObject({
    status: "dead",
    claimEpoch: 5,
    claimOwner: null,
    structuredHost: { eventCursor: 942, process: null, writerClaimEpoch: 5 },
  });
  expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)?.host).not.toBe("dead");

  await recoverPendingStructuredSpawns(registry, client);

  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({ state: "failed" });
  expect(registry.snapshot().entries[`codex:${sessionId}`]).toMatchObject({
    status: "dead",
    claimOwner: null,
    pendingAction: null,
    structuredHost: { eventCursor: 942, process: null },
  });
  expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)).toMatchObject({
    host: "dead",
    turn: "idle",
    activeTurnId: null,
  });
  journal.close();
});

test("a staged resume releases its transferred claim when failure projection is unavailable", async () => {
  const sessionId = crypto.randomUUID();
  const cwd = path.join(sandbox, `staged-projection-failure-${sessionId}`);
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const launchProfile = emptyLaunchProfile({ cwd, model: "gpt-5.6-luna" });
  const conversation = registry.ensureConversation("codex", artifactPath, "codex-subscription");
  const key = { engine: "codex" as const, sessionId };
  registry.upsert({
    key,
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    launchProfile,
    status: "dead",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:released",
      process: null,
      eventCursor: 942,
      protocolVersion: "0.144.1",
      writerClaimEpoch: 5,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 5,
    claimOwner: null,
    pendingAction: null,
  });
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
    conversationId: conversation.id,
    purpose: "resume-successor",
    expectedArtifactPath: artifactPath,
    launchProfile,
  });
  if (begun.kind !== "created") throw new Error("resume receipt was unavailable");
  const host = new RoundTripHost("codex", artifactPath, sessionId);
  const flakyClient = {
    ...client,
    append: async (...args: Parameters<RuntimeHostClient["append"]>) => {
      const event = args[0];
      if (event.kind === "session-status" && (event.payload as { host?: unknown }).host === "dead") {
        throw new Error("simulated runtime projection append failure");
      }
      return client.append(...args);
    },
  } as RuntimeHostClient;

  await expect(spawnStructuredConversation({
    engine: "codex",
    receipt: begun.receipt,
    spec: { command: "codex", cwd, windowName: "resume", engine: "codex", transcript: artifactPath, launchProfile },
    account: { engine: "codex", accountId: "codex-subscription", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } },
    prompt: "",
    registry,
    client: flakyClient,
  }, {
    startHost: async () => host,
    bindHost: async () => { throw new Error("resume binding failed after identity staging"); },
    processIdentity: () => ({ pid: 765_432, startIdentity: "staged-adoption" }),
  })).rejects.toThrow("resume binding failed after identity staging");

  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({ state: "path-pending" });
  expect(registry.snapshot().entries[`codex:${sessionId}`]).toMatchObject({
    claimEpoch: 6,
    claimOwner: null,
    structuredHost: { eventCursor: 942, process: null, writerClaimEpoch: 6 },
  });
  expect(host.releaseCount).toBe(1);
  journal.close();
});

test("a projected same-session resume failure retains its terminal event cursor", async () => {
  const sessionId = crypto.randomUUID();
  const cwd = path.join(sandbox, `staged-projected-failure-${sessionId}`);
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const launchProfile = emptyLaunchProfile({ cwd, model: "gpt-5.6-luna" });
  const conversation = registry.ensureConversation("codex", artifactPath, "codex-subscription");
  registry.upsert({
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    launchProfile,
    status: "dead",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:released",
      process: null,
      eventCursor: 942,
      protocolVersion: "0.144.1",
      writerClaimEpoch: 5,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 5,
    claimOwner: null,
    pendingAction: null,
  });
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
    conversationId: conversation.id,
    purpose: "resume-successor",
    expectedArtifactPath: artifactPath,
    launchProfile,
  });
  if (begun.kind !== "created") throw new Error("resume receipt was unavailable");
  const host = new RoundTripHost("codex", artifactPath, sessionId);

  await expect(spawnStructuredConversation({
    engine: "codex",
    receipt: begun.receipt,
    spec: { command: "codex", cwd, windowName: "resume", engine: "codex", transcript: artifactPath, launchProfile },
    account: { engine: "codex", accountId: "codex-subscription", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } },
    prompt: "",
    registry,
    client,
  }, {
    startHost: async () => host,
    bindHost: async () => { throw new Error("resume binding failed after identity staging"); },
    processIdentity: () => ({ pid: 765_432, startIdentity: "staged-adoption" }),
  })).rejects.toThrow("resume binding failed after identity staging");

  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({ state: "failed" });
  expect(registry.snapshot().entries[`codex:${sessionId}`]).toMatchObject({
    status: "dead",
    claimEpoch: 6,
    claimOwner: null,
    pendingAction: null,
    structuredHost: {
      endpoint: "stdio:released",
      process: null,
      eventCursor: 942,
      writerClaimEpoch: 6,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
  });
  expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)).toMatchObject({
    host: "dead",
    turn: "idle",
  });
  expect(host.releaseCount).toBe(1);
  journal.close();
});

test("spawn failure preserves the staged writer when its child cannot be reaped", async () => {
  const sessionId = crypto.randomUUID();
  const cwd = path.join(sandbox, `unreaped-spawn-failure-${sessionId}`);
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const launchProfile = emptyLaunchProfile({ cwd, model: "gpt-5.6-luna" });
  const conversation = registry.ensureConversation("codex", artifactPath, "codex-subscription");
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
    conversationId: conversation.id,
    purpose: "resume-successor",
    expectedArtifactPath: artifactPath,
    launchProfile,
  });
  if (begun.kind !== "created") throw new Error("resume receipt was unavailable");
  const host = new UnreapableRoundTripHost("codex", artifactPath, sessionId);
  let published = false;

  await expect(spawnStructuredConversation({
    engine: "codex",
    receipt: begun.receipt,
    spec: { command: "codex", cwd, windowName: "resume", engine: "codex", transcript: artifactPath, launchProfile },
    account: { engine: "codex", accountId: "codex-subscription", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } },
    prompt: "",
    registry,
    client,
  }, {
    startHost: async () => host,
    bindHost: async (targetRegistry, key, runningHost, claimOwner, claimEpoch) => {
      const state = await runningHost.health();
      const persisted = targetRegistry.setStructuredHostClaimed(key, {
        kind: "codex-app-server",
        endpoint: state.endpoint,
        process: { pid: state.pid!, startIdentity: state.processStartIdentity },
        eventCursor: state.eventCursor,
        protocolVersion: state.protocolVersion,
        writerClaimEpoch: claimEpoch,
        activeTurnRef: state.activeTurnRef,
        pendingAttention: state.pendingAttention,
        activeFlags: state.activeFlags,
      }, "idle", claimOwner, claimEpoch);
      if (!persisted) throw new Error("staged writer persistence failed");
      return () => { targetRegistry.releaseStructuredHostClaim(key, claimOwner, claimEpoch); };
    },
    publishHost: async () => {
      published = true;
      return async () => { published = false; };
    },
    deliverFirst: async () => { throw new Error("first message delivery failed"); },
    processIdentity: () => ({ pid: process.pid, startIdentity: "test-process" }),
  })).rejects.toThrow("first message delivery failed");

  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({ state: "path-pending" });
  expect(registry.snapshot().entries[`codex:${sessionId}`]).toMatchObject({
    status: "idle",
    pendingAction: "spawn",
    structuredHostOperationId: begun.receipt.launchId,
    claimOwner: expect.any(String),
    structuredHost: {
      endpoint: "fake:stdio",
      process: { pid: process.pid, startIdentity: "test-process" },
    },
  });
  expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)?.host).not.toBe("dead");
  expect(host.releaseCount).toBe(1);
  expect(published).toBeTrue();
  journal.close();
});

test("startup recovery preserves a live adopted writer while settling its stale unstaged resume", async () => {
  const sessionId = crypto.randomUUID();
  const cwd = path.join(sandbox, `live-writer-recovery-${sessionId}`);
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(
    path.join(cwd, "registry.json"),
    () => true,
    undefined,
    { sqliteMode: "off" },
  );
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const launchProfile = emptyLaunchProfile({ cwd, model: "gpt-5.6-luna" });
  const conversation = registry.ensureConversation("codex", artifactPath, "codex-subscription");
  const key = { engine: "codex" as const, sessionId };
  registry.upsert({
    key,
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    launchProfile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:live",
      process: { pid: 4321, startIdentity: "live-adopter" },
      eventCursor: 942,
      protocolVersion: "0.144.1",
      writerClaimEpoch: 7,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 7,
    claimOwner: 'structured-host:{"pid":4321,"startIdentity":"live-adopter"}',
    pendingAction: null,
  });
  await client.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: key,
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      accountId: "codex-subscription",
      cwd,
      artifactPath,
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: null,
    },
  });
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
    conversationId: conversation.id,
    purpose: "resume-successor",
    expectedArtifactPath: artifactPath,
    launchProfile,
  });
  if (begun.kind !== "created") throw new Error("resume receipt was unavailable");
  await client.command({
    kind: "spawn",
    operationId: begun.receipt.launchId,
    idempotencyKey: begun.receipt.launchId,
    conversationId: conversation.id,
    engine: "codex",
    cwd,
    prompt: "",
    accountId: "codex-subscription",
  });
  await client.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: key,
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      accountId: "codex-subscription",
      cwd,
      artifactPath,
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: null,
    },
  });

  await recoverPendingStructuredSpawns(registry, client);

  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({ state: "failed" });
  expect(registry.snapshot().entries[`codex:${sessionId}`]).toMatchObject({
    status: "idle",
    claimEpoch: 7,
    claimOwner: 'structured-host:{"pid":4321,"startIdentity":"live-adopter"}',
    structuredHost: {
      endpoint: "stdio:live",
      eventCursor: 942,
      process: { pid: 4321, startIdentity: "live-adopter" },
      writerClaimEpoch: 7,
    },
  });
  expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)?.host).not.toBe("dead");
  journal.close();
});

test("startup recovery preserves a live adopted writer while settling its stale staged resume", async () => {
  const sessionId = crypto.randomUUID();
  const cwd = path.join(sandbox, `live-staged-writer-recovery-${sessionId}`);
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(
    path.join(cwd, "registry.json"),
    () => true,
    undefined,
    { sqliteMode: "off" },
  );
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const launchProfile = emptyLaunchProfile({ cwd, model: "gpt-5.6-luna" });
  const conversation = registry.ensureConversation("codex", artifactPath, "codex-subscription");
  const key = { engine: "codex" as const, sessionId };
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
    conversationId: conversation.id,
    purpose: "resume-successor",
    expectedArtifactPath: artifactPath,
    launchProfile,
  });
  if (begun.kind !== "created") throw new Error("resume receipt was unavailable");
  const staged = registry.stageStructuredSpawn(begun.receipt.launchId, {
    key,
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    launchProfile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:live-staged",
      process: { pid: 5432, startIdentity: "live-staged-adopter" },
      eventCursor: 942,
      protocolVersion: "0.144.1",
      writerClaimEpoch: 11,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 11,
    claimOwner: 'structured-host:{"pid":5432,"startIdentity":"live-staged-adopter"}',
    pendingAction: "spawn",
  });
  if (staged.kind !== "settled") throw new Error("resume identity was unavailable");
  registry.upsert({
    ...staged.entry,
    structuredHostOperationId: "winning-resume-operation",
  });
  await client.command({
    kind: "spawn",
    operationId: begun.receipt.launchId,
    idempotencyKey: begun.receipt.launchId,
    conversationId: conversation.id,
    engine: "codex",
    cwd,
    prompt: "",
    accountId: "codex-subscription",
  });
  await client.transitionOperation(begun.receipt.launchId, "failed", { reason: "stale staged resume failed" });
  await client.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: key,
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      accountId: "codex-subscription",
      cwd,
      artifactPath,
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: null,
    },
  });

  await recoverPendingStructuredSpawns(registry, client);

  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({ state: "failed" });
  expect(registry.snapshot().entries[`codex:${sessionId}`]).toMatchObject({
    status: "idle",
    claimEpoch: 11,
    claimOwner: 'structured-host:{"pid":5432,"startIdentity":"live-staged-adopter"}',
    structuredHost: {
      endpoint: "stdio:live-staged",
      eventCursor: 942,
      process: { pid: 5432, startIdentity: "live-staged-adopter" },
      writerClaimEpoch: 11,
    },
  });
  expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)).toMatchObject({
    host: "hosted",
    turn: "idle",
  });
  journal.close();
});

function stagedOwnershipRace(label: string) {
  const sessionId = crypto.randomUUID();
  const cwd = path.join(sandbox, `${label}-${sessionId}`);
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const launchProfile = emptyLaunchProfile({ cwd, model: "gpt-5.6-luna" });
  const conversation = registry.ensureConversation("codex", artifactPath, "codex-subscription");
  const key = { engine: "codex" as const, sessionId };
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
    conversationId: conversation.id,
    purpose: "resume-successor",
    expectedArtifactPath: artifactPath,
    launchProfile,
  });
  if (begun.kind !== "created") throw new Error("resume receipt was unavailable");
  const staged = registry.stageStructuredSpawn(begun.receipt.launchId, {
    key,
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    launchProfile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:older",
      process: { pid: 6543, startIdentity: "older-adopter" },
      eventCursor: 942,
      protocolVersion: "0.144.1",
      writerClaimEpoch: 13,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 13,
    claimOwner: 'structured-host:{"pid":6543,"startIdentity":"older-adopter"}',
    pendingAction: "spawn",
  });
  if (staged.kind !== "settled") throw new Error("resume identity was unavailable");
  registry.upsert({
    ...staged.entry,
    structuredHostOperationId: "newer-resume-operation",
    structuredHost: {
      ...staged.entry.structuredHost!,
      endpoint: "stdio:newer",
      process: { pid: 7654, startIdentity: "newer-adopter" },
      writerClaimEpoch: 14,
    },
    claimEpoch: 14,
    claimOwner: 'structured-host:{"pid":7654,"startIdentity":"newer-adopter"}',
  });
  return { registry, begun, sessionId };
}

test("an older failed spawn cannot erase a newer structured host owner", () => {
  const { registry, begun, sessionId } = stagedOwnershipRace("failed-operation-fence");

  registry.failStructuredSpawn(begun.receipt.launchId, "older operation failed");

  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    state: "failed",
    error: "older operation failed",
  });
  expect(registry.snapshot().entries[`codex:${sessionId}`]).toMatchObject({
    status: "idle",
    structuredHostOperationId: "newer-resume-operation",
    claimEpoch: 14,
    claimOwner: 'structured-host:{"pid":7654,"startIdentity":"newer-adopter"}',
    structuredHost: {
      endpoint: "stdio:newer",
      process: { pid: 7654, startIdentity: "newer-adopter" },
      writerClaimEpoch: 14,
    },
  });
});

test("an older finalize cannot settle across a newer structured host owner", () => {
  const { registry, begun, sessionId } = stagedOwnershipRace("finalize-operation-fence");

  expect(registry.finalizeStructuredSpawn(begun.receipt.launchId)).toMatchObject({
    kind: "conflict",
    code: "spawn_identity_conflict",
  });

  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    state: "conflicted",
    error: "spawn_identity_conflict",
  });
  expect(registry.snapshot().entries[`codex:${sessionId}`]).toMatchObject({
    status: "idle",
    pendingAction: "spawn",
    structuredHostOperationId: "newer-resume-operation",
    claimEpoch: 14,
    claimOwner: 'structured-host:{"pid":7654,"startIdentity":"newer-adopter"}',
  });
});

test("a stale finalize cannot project the newer structured owner dead", async () => {
  const sessionId = crypto.randomUUID();
  const cwd = path.join(sandbox, `stale-finalize-projection-${sessionId}`);
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const launchProfile = emptyLaunchProfile({ cwd, model: "gpt-5.6-luna" });
  const conversation = registry.ensureConversation("codex", artifactPath, "codex-subscription");
  const key = { engine: "codex" as const, sessionId };
  registry.upsert({
    key,
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    launchProfile,
    status: "dead",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:released",
      process: null,
      eventCursor: 942,
      protocolVersion: "0.144.1",
      writerClaimEpoch: 2,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 2,
    claimOwner: null,
    pendingAction: null,
  });
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
    conversationId: conversation.id,
    purpose: "resume-successor",
    expectedArtifactPath: artifactPath,
    launchProfile,
  });
  if (begun.kind !== "created") throw new Error("resume receipt was unavailable");
  const host = new RoundTripHost("codex", artifactPath, sessionId);

  await expect(spawnStructuredConversation({
    engine: "codex",
    receipt: begun.receipt,
    spec: { command: "codex", cwd, windowName: "resume", engine: "codex", transcript: artifactPath, launchProfile },
    account: { engine: "codex", accountId: "codex-subscription", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } },
    prompt: "",
    registry,
    client,
  }, {
    startHost: async () => host,
    bindHost: async (targetRegistry, hostKey, runningHost, claimOwner, claimEpoch) => {
      const state = await runningHost.health();
      const persisted = targetRegistry.setStructuredHostClaimed(hostKey, {
        kind: "codex-app-server",
        endpoint: state.endpoint,
        process: { pid: state.pid!, startIdentity: state.processStartIdentity },
        eventCursor: state.eventCursor,
        protocolVersion: state.protocolVersion,
        writerClaimEpoch: claimEpoch,
        activeTurnRef: state.activeTurnRef,
        pendingAttention: state.pendingAttention,
        activeFlags: state.activeFlags,
      }, "idle", claimOwner, claimEpoch);
      if (!persisted) throw new Error("older writer persistence failed");
      return () => { targetRegistry.releaseStructuredHostClaim(hostKey, claimOwner, claimEpoch); };
    },
    publishHost: async () => async () => {},
    deliverFirst: async () => {
      const current = registry.snapshot().entries[`codex:${sessionId}`];
      registry.upsert({
        ...current,
        status: "idle",
        structuredHostOperationId: "newer-resume-operation",
        structuredHost: {
          ...current.structuredHost!,
          endpoint: "stdio:newer",
          process: { pid: 86_420, startIdentity: "newer-writer" },
          writerClaimEpoch: current.claimEpoch + 1,
        },
        claimEpoch: current.claimEpoch + 1,
        claimOwner: 'structured-host:{"pid":86420,"startIdentity":"newer-writer"}',
      });
      await client.append({
        scope: { type: "session", id: conversation.id },
        kind: "session-status",
        payload: {
          conversationId: conversation.id,
          sessionKey: key,
          hostKind: "codex-app-server",
          host: "hosted",
          turn: "idle",
          provenance: "structured",
          accountId: "codex-subscription",
          cwd,
          artifactPath,
          capabilities: { steer: true, structuredAttention: true },
          activeTurnId: null,
        },
      });
    },
    processIdentity: () => ({ pid: 75_310, startIdentity: "older-writer" }),
  })).rejects.toThrow("structured spawn registry conflict: spawn_identity_conflict");

  expect(registry.snapshot().entries[`codex:${sessionId}`]).toMatchObject({
    status: "idle",
    structuredHostOperationId: "newer-resume-operation",
    claimOwner: 'structured-host:{"pid":86420,"startIdentity":"newer-writer"}',
    structuredHost: { endpoint: "stdio:newer", process: { pid: 86_420, startIdentity: "newer-writer" } },
  });
  expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)).toMatchObject({
    host: "hosted",
    turn: "idle",
  });
  journal.close();
});

test("a resume claim loser leaves the winning writer projection and ownership intact", async () => {
  const sessionId = crypto.randomUUID();
  const cwd = path.join(sandbox, `resume-claim-loser-${sessionId}`);
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(
    path.join(cwd, "registry.json"),
    () => true,
    undefined,
    { sqliteMode: "off" },
  );
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const launchProfile = emptyLaunchProfile({ cwd, model: "gpt-5.6-luna" });
  const conversation = registry.ensureConversation("codex", artifactPath, "codex-subscription");
  const key = { engine: "codex" as const, sessionId };
  registry.upsert({
    key,
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    launchProfile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:winner",
      process: { pid: 8765, startIdentity: "winning-adopter" },
      eventCursor: 942,
      protocolVersion: "0.144.1",
      writerClaimEpoch: 9,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 9,
    claimOwner: 'structured-host:{"pid":8765,"startIdentity":"winning-adopter"}',
    pendingAction: null,
  });
  await client.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: key,
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      accountId: "codex-subscription",
      cwd,
      artifactPath,
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: null,
    },
  });
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
    conversationId: conversation.id,
    purpose: "resume-successor",
    expectedArtifactPath: artifactPath,
    launchProfile,
  });
  if (begun.kind !== "created") throw new Error("resume receipt was unavailable");

  await expect(spawnStructuredConversation({
    engine: "codex",
    receipt: begun.receipt,
    spec: { command: "codex", cwd, windowName: "resume", engine: "codex", transcript: artifactPath, launchProfile },
    account: { engine: "codex", accountId: "codex-subscription", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } },
    prompt: "",
    registry,
    client,
  }, {
    startHost: async () => { throw new Error("claim loser reached host adoption"); },
  })).rejects.toThrow("structured resume host claim is unavailable");

  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({ state: "failed" });
  expect(registry.snapshot().entries[`codex:${sessionId}`]).toMatchObject({
    status: "idle",
    claimEpoch: 9,
    claimOwner: 'structured-host:{"pid":8765,"startIdentity":"winning-adopter"}',
    structuredHost: {
      endpoint: "stdio:winner",
      eventCursor: 942,
      process: { pid: 8765, startIdentity: "winning-adopter" },
      writerClaimEpoch: 9,
    },
  });
  expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)?.host).not.toBe("dead");
  journal.close();
});

describe.each(["bind", "publish", "first-message"] as const)("structured spawn %s failure", (barrier) => {
  test("a concurrent replay never observes success", async () => {
    const id = crypto.randomUUID();
    const cwd = path.join(sandbox, `${barrier}-failure-${id}`);
    fs.mkdirSync(cwd, { recursive: true });
    const artifactPath = path.join(cwd, `${id}.jsonl`);
    const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
    const client = runtimeClient(journal);
    await bindStructuredDeliveryQueue([], { registry, client });
    const parent = registry.ensureConversation("codex", path.join(cwd, "reviewed.jsonl"), "codex-subscription");
    const child = registry.ensureConversation("codex", artifactPath, "codex-subscription");
    const request = {
      engine: "codex" as const,
      cwd,
      accountId: "codex-subscription",
      parentConversationId: parent.id,
      conversationId: child.id,
      purpose: "resume-successor" as const,
      launchProfile: emptyLaunchProfile({ cwd, model: "gpt-5.6-luna", parentConversationId: parent.id }),
      clientAttemptId: `attempt_${id}`,
      requestDigest: id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    };
    const begun = registry.beginSpawnRequest(request);
    if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
    const host = new RoundTripHost("codex", artifactPath, id);
    const reached = deferred();
    const release = deferred();
    const failAtBarrier = async (candidate: typeof barrier): Promise<void> => {
      if (candidate !== barrier) return;
      reached.resolve();
      await release.promise;
      throw new Error(`${barrier} failed`);
    };
    const spawning = spawnStructuredConversation({
      engine: "codex",
      receipt: begun.receipt,
      spec: { command: "codex", cwd, windowName: "failure", engine: "codex", transcript: artifactPath, launchProfile: request.launchProfile },
      account: { engine: "codex", accountId: request.accountId, kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } },
      prompt: "initial prompt",
      registry,
      client,
    }, {
      startHost: async () => host,
      bindHost: async (targetRegistry, key, runningHost, claimOwner, claimEpoch) => {
        await failAtBarrier("bind");
        const state = await runningHost.health();
        targetRegistry.setStructuredHostClaimed(key, {
          kind: "codex-app-server",
          endpoint: state.endpoint,
          process: { pid: process.pid, startIdentity: "test-process" },
          eventCursor: state.eventCursor,
          protocolVersion: state.protocolVersion,
          writerClaimEpoch: claimEpoch,
          activeTurnRef: state.activeTurnRef,
          pendingAttention: state.pendingAttention,
          activeFlags: state.activeFlags,
        }, "idle", claimOwner, claimEpoch);
        return () => {};
      },
      publishHost: async () => {
        await failAtBarrier("publish");
        return async () => {};
      },
      deliverFirst: async () => { await failAtBarrier("first-message"); },
      processIdentity: () => ({ pid: process.pid, startIdentity: "test-process" }),
    });

    await reached.promise;
    const replay = registry.beginSpawnRequest(request);
    if (replay.kind !== "replay") throw new Error("concurrent request did not replay");
    expect(spawnResponseForReceipt(replay.receipt, replay.receipt.artifactPath, { structured: true })).toMatchObject({
      launched: false,
      state: "path-pending",
      path: artifactPath,
    });

    release.resolve();
    await expect(spawning).rejects.toThrow(`${barrier} failed`);
    expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({ state: "failed", error: `${barrier} failed` });
    expect(Object.values(registry.snapshot().entries).find((entry) => entry.artifactPath === artifactPath)).toMatchObject({
      status: "dead",
      structuredHost: null,
      pendingAction: null,
    });
    expect(journal.snapshot().sessions.find((session) => session.conversationId === begun.receipt.conversationId)).toMatchObject({
      host: "dead",
      artifactPath,
      parentConversationId: parent.id,
    });
    expect(journal.snapshot().edges.filter((edge) => edge.childConversationId === begun.receipt.conversationId))
      .toEqual([expect.objectContaining({ parentConversationId: parent.id })]);
  });
});

test("startup recovery finalizes a staged spawn without duplicating its admitted first message", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `recovery-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const launchProfile = emptyLaunchProfile({ cwd, model: "gpt-5.6-luna" });
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd, accountId: "codex-subscription", launchProfile });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  await client.command({
    kind: "spawn",
    operationId: begun.receipt.launchId,
    idempotencyKey: begun.receipt.launchId,
    conversationId: begun.receipt.conversationId,
    engine: "codex",
    cwd,
    prompt: "recover this first prompt",
    accountId: "codex-subscription",
    parentConversationId: null,
  });
  const key = { engine: "codex" as const, sessionId: id };
  const staged = registry.stageStructuredSpawn(begun.receipt.launchId, {
    key,
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    launchProfile,
    status: "unhosted",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:pending",
      process: null,
      eventCursor: 0,
      protocolVersion: null,
      writerClaimEpoch: 0,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: "spawn",
  });
  if (staged.kind !== "settled") throw new Error("spawn identity was unavailable");
  const claimed = registry.claimStructuredHost(key, { pid: process.pid, startIdentity: "test-process" }, { allowUnhosted: true });
  if (!claimed?.claimOwner) throw new Error("structured claim was unavailable");
  registry.setStructuredHostClaimed(key, {
    kind: "codex-app-server",
    endpoint: "fake:stdio",
    process: { pid: process.pid, startIdentity: "test-process" },
    eventCursor: 0,
    protocolVersion: "fake-v1",
    writerClaimEpoch: claimed.claimEpoch,
    activeTurnRef: null,
    pendingAttention: [],
    activeFlags: [],
  }, "idle", claimed.claimOwner, claimed.claimEpoch);
  const host = new RoundTripHost("codex", artifactPath, id);
  await bindStructuredDeliveryQueue([{ key, host }], { registry, client });
  await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: begun.receipt.conversationId,
    clientMessageId: `spawn_${begun.receipt.launchId}`,
    operationId: `spawn_message_${begun.receipt.launchId}`,
    text: "recover this first prompt",
    hasImages: false,
  }, { client: () => client, registry: () => registry, enabled: () => true });
  await waitFor(() => host.sent.length === 1);

  await recoverPendingStructuredSpawns(registry, client);

  expect(host.sent.map((entry) => entry.text)).toEqual(["recover this first prompt"]);
  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({ state: "completed", artifactPath });
  expect((await client.operationStatus(begun.receipt.launchId))?.receipt.status).toBe("delivered");
});

test("startup recovery terminalizes an admitted spawn interrupted before identity staging", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `unstaged-recovery-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd, transport: "structured", accountId: "codex-subscription" });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  await client.command({
    kind: "spawn", operationId: begun.receipt.launchId, idempotencyKey: begun.receipt.launchId,
    conversationId: begun.receipt.conversationId, engine: "codex", cwd, prompt: "durably admitted", accountId: "codex-subscription", parentConversationId: null,
  });

  await recoverPendingStructuredSpawns(registry, client);
  await recoverPendingStructuredSpawns(registry, client);

  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({ state: "failed", key: null });
  expect((await client.operationStatus(begun.receipt.launchId))?.receipt).toMatchObject({ status: "failed" });
  expect((await client.effectBatch(["runtime.spawn"], 0)).filter((effect) => effect.payload.operationId === begun.receipt.launchId)).toEqual([]);
  expect(registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
    clientAttemptId: `fresh-${id}`,
  }).kind).toBe("created");
});

test("startup recovery settles a structured receipt after a crash before runtime admission", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `pre-admission-recovery-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const structured = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
  });
  const tmux = registry.beginSpawnRequest({
    engine: "claude",
    cwd,
    transport: "tmux",
    accountId: "claude-subscription",
  });
  if (structured.kind !== "created" || tmux.kind !== "created") throw new Error("spawn receipt was unavailable");

  await recoverPendingStructuredSpawns(registry, client);
  await recoverPendingStructuredSpawns(registry, client);

  expect(registry.snapshot().receipts[structured.receipt.launchId]).toMatchObject({
    state: "failed",
    key: null,
    error: `structured spawn interrupted before runtime admission: ${structured.receipt.launchId}`,
  });
  expect(registry.snapshot().receipts[tmux.receipt.launchId]).toMatchObject({ state: "starting", key: null });
  expect(await client.effectBatch(["runtime.spawn"], 0)).toEqual([]);
  expect(registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
    clientAttemptId: `fresh-${id}`,
  }).kind).toBe("created");
});

test.each(["failed", "delivered"] as const)("startup recovery settles a keyless receipt after the runtime operation is %s", async (terminalStatus) => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `pre-identity-${terminalStatus}-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
  });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  await client.command({
    kind: "spawn",
    operationId: begun.receipt.launchId,
    idempotencyKey: begun.receipt.launchId,
    conversationId: begun.receipt.conversationId,
    engine: "codex",
    cwd,
    prompt: "durable pre-identity prompt",
    accountId: "codex-subscription",
    parentConversationId: null,
  });
  await client.transitionOperation(begun.receipt.launchId, terminalStatus, {
    ...(terminalStatus === "failed" ? { reason: "runtime spawn failed before identity" } : {}),
  });

  await recoverPendingStructuredSpawns(registry, client);
  await recoverPendingStructuredSpawns(registry, client);

  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    state: "failed",
    key: null,
  });
  expect((await client.operationStatus(begun.receipt.launchId))?.receipt.status).toBe(terminalStatus);
  expect((await client.effectBatch(["runtime.spawn"], 0)).filter((effect) => effect.payload.operationId === begun.receipt.launchId)).toEqual([]);
  expect(registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
    clientAttemptId: `fresh-${id}`,
  }).kind).toBe("created");
});

test("startup recovery cleans a staged host whose spawn operation already failed", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `failed-recovery-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const launchProfile = emptyLaunchProfile({ cwd, model: "gpt-5.6-luna" });
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd, accountId: "codex-subscription", launchProfile });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  await client.command({
    kind: "spawn",
    operationId: begun.receipt.launchId,
    idempotencyKey: begun.receipt.launchId,
    conversationId: begun.receipt.conversationId,
    engine: "codex",
    cwd,
    prompt: "crash-window prompt",
    accountId: "codex-subscription",
    parentConversationId: null,
  });
  const key = { engine: "codex" as const, sessionId: id };
  const staged = registry.stageStructuredSpawn(begun.receipt.launchId, {
    key,
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    launchProfile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:stdio",
      process: { pid: process.pid, startIdentity: "test-process" },
      eventCursor: 0,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "structured-host:test",
    pendingAction: "spawn",
  });
  if (staged.kind !== "settled") throw new Error("spawn identity was unavailable");
  const host = new RoundTripHost("codex", artifactPath, id);
  await bindStructuredDeliveryQueue([{ key, host }], { registry, client });
  await client.transitionOperation(begun.receipt.launchId, "failed", { reason: "engine child failed" });

  await recoverPendingStructuredSpawns(registry, client);
  await recoverPendingStructuredSpawns(registry, client);

  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    state: "failed",
    error: "engine child failed",
  });
  expect(registry.snapshot().entries[`codex:${id}`]).toMatchObject({
    status: "dead",
    structuredHost: null,
    claimOwner: null,
    pendingAction: null,
  });
  expect(hasStructuredDeliveryHost(key)).toBeFalse();
  expect(host.releaseCount).toBe(1);
  expect((await client.operationStatus(begun.receipt.launchId))?.receipt).toMatchObject({
    status: "failed",
    reason: "engine child failed",
  });
  expect(journal.snapshot().sessions.find((session) => session.conversationId === begun.receipt.conversationId)).toMatchObject({
    host: "dead",
  });
});

test("startup recovery retains a failed staged writer when its child cannot be reaped", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `unreaped-failed-recovery-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const launchProfile = emptyLaunchProfile({ cwd, model: "gpt-5.6-luna" });
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd, accountId: "codex-subscription", launchProfile });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  await client.command({
    kind: "spawn",
    operationId: begun.receipt.launchId,
    idempotencyKey: begun.receipt.launchId,
    conversationId: begun.receipt.conversationId,
    engine: "codex",
    cwd,
    prompt: "crash-window prompt",
    accountId: "codex-subscription",
    parentConversationId: null,
  });
  const key = { engine: "codex" as const, sessionId: id };
  const staged = registry.stageStructuredSpawn(begun.receipt.launchId, {
    key,
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    launchProfile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:stdio",
      process: { pid: process.pid, startIdentity: "test-process" },
      eventCursor: 0,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "structured-host:test",
    pendingAction: "spawn",
  });
  if (staged.kind !== "settled") throw new Error("spawn identity was unavailable");
  const host = new UnreapableRoundTripHost("codex", artifactPath, id);
  await bindStructuredDeliveryQueue([{ key, host }], { registry, client });
  await client.transitionOperation(begun.receipt.launchId, "failed", { reason: "engine child failed" });

  await expect(recoverPendingStructuredSpawns(registry, client))
    .rejects.toThrow("Codex app-server child could not be reaped");

  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({ state: "path-pending" });
  expect(registry.snapshot().entries[`codex:${id}`]).toMatchObject({
    status: "idle",
    pendingAction: "spawn",
    structuredHostOperationId: begun.receipt.launchId,
    claimOwner: "structured-host:test",
    structuredHost: {
      endpoint: "fake:stdio",
      process: { pid: process.pid, startIdentity: "test-process" },
    },
  });
  expect(hasStructuredDeliveryHost(key)).toBeFalse();
  expect(host.releaseCount).toBe(1);
  expect(journal.snapshot().sessions.find((session) => session.conversationId === begun.receipt.conversationId)?.host).not.toBe("dead");
  journal.close();
});

test("startup recovery completes an intentionally empty spawn prompt without a host send", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `empty-prompt-recovery-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const launchProfile = emptyLaunchProfile({ cwd, model: "gpt-5.6-luna" });
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd, accountId: "codex-subscription", launchProfile });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  await client.command({
    kind: "spawn",
    operationId: begun.receipt.launchId,
    idempotencyKey: begun.receipt.launchId,
    conversationId: begun.receipt.conversationId,
    engine: "codex",
    cwd,
    prompt: "",
    accountId: "codex-subscription",
    parentConversationId: null,
  });
  const key = { engine: "codex" as const, sessionId: id };
  const staged = registry.stageStructuredSpawn(begun.receipt.launchId, {
    key,
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    launchProfile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:stdio",
      process: { pid: process.pid, startIdentity: "test-process" },
      eventCursor: 0,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "structured-host:test",
    pendingAction: "spawn",
  });
  if (staged.kind !== "settled") throw new Error("spawn identity was unavailable");
  const host = new RoundTripHost("codex", artifactPath, id);
  await bindStructuredDeliveryQueue([{ key, host }], { registry, client });

  await recoverPendingStructuredSpawns(registry, client);

  expect(host.sent).toEqual([]);
  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({ state: "completed", artifactPath });
  expect((await client.operationStatus(begun.receipt.launchId))?.receipt.status).toBe("delivered");
});

test("a queued kill terminalizes after restart when its generation is confirmed dead", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `dead-kill-recovery-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const conversation = registry.ensureConversation("codex", artifactPath, "codex-subscription");
  const generation = conversation.generations.at(-1);
  if (!generation) throw new Error("structured generation was unavailable");
  const key = { engine: "codex" as const, sessionId: generation.id };
  registry.upsert({
    key,
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    status: "dead",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:released",
      process: null,
      eventCursor: 942,
      protocolVersion: "0.144.1",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: null,
    pendingAction: null,
  });
  await client.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: key,
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      accountId: "codex-subscription",
      parentConversationId: null,
      cwd,
      artifactPath,
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: null,
    },
  });
  expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)?.host).toBe("hosted");
  const operationId = `kill_${id}`;
  const deliveringOperationId = `kill_delivering_${id}`;
  await client.command({
    kind: "kill",
    operationId,
    idempotencyKey: operationId,
    conversationId: conversation.id,
    sessionKey: key,
  });
  await client.command({
    kind: "kill",
    operationId: deliveringOperationId,
    idempotencyKey: deliveringOperationId,
    conversationId: conversation.id,
    sessionKey: key,
  });
  await client.transitionOperation(deliveringOperationId, "delivering");

  await bindStructuredDeliveryQueue([], { registry, client });

  expect((await client.operationStatus(operationId))?.receipt).toMatchObject({
    kind: "kill",
    status: "delivered",
  });
  expect((await client.operationStatus(deliveringOperationId))?.receipt).toMatchObject({
    kind: "kill",
    status: "delivered",
  });
  expect(registry.snapshot().entries[`codex:${generation.id}`]).toMatchObject({
    status: "dead",
    host: null,
    structuredHost: null,
    claimOwner: null,
    pendingAction: null,
  });
  expect(await client.effectBatch(["runtime.kill"], 0)).toEqual([]);
  expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)).toMatchObject({
    host: "dead",
    activeTurnId: null,
  });
  const rejected = await Promise.all(Array.from({ length: 3 }, async (_, index) => {
    const sendOperationId = `send_after_${index}_${id}`;
    return client.command({
      kind: "send",
      operationId: sendOperationId,
      idempotencyKey: sendOperationId,
      conversationId: conversation.id,
      text: "same visible text after failed adoption",
      policy: "queue",
    });
  }));
  expect(rejected.map((result) => result.receipt)).toEqual([
    expect.objectContaining({ status: "rejected", reason: "dead-host" }),
    expect.objectContaining({ status: "rejected", reason: "dead-host" }),
    expect.objectContaining({ status: "rejected", reason: "dead-host" }),
  ]);
});

test("a delivering kill terminalizes a stale structured wrapper owned by the live Viewer", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `absent-wrapper-kill-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const conversation = registry.ensureConversation("claude", artifactPath, "default");
  const key = { engine: "claude" as const, sessionId: id };
  registry.upsert({
    key,
    artifactPath,
    cwd,
    accountId: "default",
    status: "live",
    host: null,
    structuredHost: {
      kind: "claude-broker",
      endpoint: "stdio:2000000000",
      process: { pid: 2_000_000_000, startIdentity: "missing-wrapper" },
      eventCursor: 17,
      protocolVersion: "2.1.209",
      writerClaimEpoch: 4,
      activeTurnRef: "completed-review-turn",
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 4,
    claimOwner: `structured-host:${JSON.stringify({
      pid: process.pid,
      startIdentity: null,
    })}`,
    pendingAction: null,
  });
  await client.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: key,
      hostKind: "claude-broker",
      host: "hosted",
      turn: "running",
      provenance: "structured",
      accountId: "default",
      parentConversationId: null,
      cwd,
      artifactPath,
      capabilities: { steer: false, structuredAttention: true },
      activeTurnId: "completed-review-turn",
    },
  });
  const operationId = `kill_absent_wrapper_${id}`;
  await client.command({
    kind: "kill",
    operationId,
    idempotencyKey: operationId,
    conversationId: conversation.id,
    sessionKey: key,
  });
  await client.transitionOperation(operationId, "delivering");

  await bindStructuredDeliveryQueue([], { registry, client });

  expect((await client.operationStatus(operationId))?.receipt).toMatchObject({
    kind: "kill",
    status: "delivered",
  });
  expect(registry.snapshot().entries[`claude:${id}`]).toMatchObject({
    status: "dead",
    structuredHost: null,
    claimOwner: null,
    pendingAction: null,
  });
  expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)).toMatchObject({
    host: "dead",
    turn: "unknown",
    activeTurnId: null,
  });
  expect(await client.effectBatch(["runtime.kill"], 0)).toEqual([]);
});

test("a dead predecessor kill terminalizes without touching its live successor", async () => {
  const predecessorId = crypto.randomUUID();
  const successorId = crypto.randomUUID();
  const cwd = path.join(sandbox, `successor-kill-${predecessorId}`);
  fs.mkdirSync(cwd, { recursive: true });
  const predecessorPath = path.join(cwd, `${predecessorId}.jsonl`);
  const successorPath = path.join(cwd, `${successorId}.jsonl`);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const conversation = registry.ensureConversation("codex", predecessorPath, "codex-subscription");
  const predecessorKey = { engine: "codex" as const, sessionId: predecessorId };
  registry.upsert({
    key: predecessorKey,
    artifactPath: predecessorPath,
    cwd,
    accountId: "codex-subscription",
    status: "dead",
    host: null,
    structuredHost: null,
    claimEpoch: 1,
    claimOwner: null,
    pendingAction: null,
  });
  const resumed = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    accountId: "codex-subscription",
    conversationId: conversation.id,
    purpose: "resume-successor",
  });
  if (resumed.kind !== "created") throw new Error("successor receipt was unavailable");
  const successorKey = { engine: "codex" as const, sessionId: successorId };
  const settled = registry.settleSpawn(resumed.receipt.launchId, {
    key: successorKey,
    artifactPath: successorPath,
    cwd,
    accountId: "codex-subscription",
    status: "live",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:successor",
      process: { pid: process.pid, startIdentity: "successor-process" },
      eventCursor: 1,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 2,
      activeTurnRef: "successor-turn",
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 2,
    claimOwner: "structured-host:successor",
    pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error("successor settlement failed");
  const successorBefore = registry.snapshot().entries[`codex:${successorId}`];
  const operationId = `kill_${predecessorId}`;
  await client.command({
    kind: "kill",
    operationId,
    idempotencyKey: operationId,
    conversationId: conversation.id,
    sessionKey: predecessorKey,
  });
  const successorHost = new RoundTripHost("codex", successorPath, successorId);

  await bindStructuredDeliveryQueue([{ key: successorKey, host: successorHost }], { registry, client });

  expect((await client.operationStatus(operationId))?.receipt.status).toBe("delivered");
  expect(registry.snapshot().entries[`codex:${successorId}`]).toEqual(successorBefore);
  expect(successorHost.releaseCount).toBe(0);
  expect(hasStructuredDeliveryHost(successorKey)).toBeTrue();
  expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)).toMatchObject({
    sessionKey: successorKey,
    host: "hosted",
    hostKind: "codex-app-server",
  });
  expect(await client.effectBatch(["runtime.kill"], 0)).toEqual([]);
});

test("a queued kill waits when an unadopted structured process may still be live", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `live-kill-recovery-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const conversation = registry.ensureConversation("codex", artifactPath, "codex-subscription");
  const key = { engine: "codex" as const, sessionId: id };
  registry.upsert({
    key,
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    status: "live",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:unadopted",
      process: { pid: process.pid, startIdentity: null },
      eventCursor: 1,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "structured-host:unadopted",
    pendingAction: null,
  });
  const entryBefore = registry.snapshot().entries[`codex:${id}`];
  const operationId = `kill_${id}`;
  await client.command({
    kind: "kill",
    operationId,
    idempotencyKey: operationId,
    conversationId: conversation.id,
    sessionKey: key,
  });

  await bindStructuredDeliveryQueue([], { registry, client });

  expect((await client.operationStatus(operationId))?.receipt.status).toBe("queued");
  expect(registry.snapshot().entries[`codex:${id}`]).toEqual(entryBefore);
  expect(await client.effectBatch(["runtime.kill"], 0)).toHaveLength(1);
});

test("a queued kill waits through a processless structured adoption claim", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `claimed-kill-recovery-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const conversation = registry.ensureConversation("codex", artifactPath, "codex-subscription");
  const key = { engine: "codex" as const, sessionId: id };
  registry.upsert({
    key,
    artifactPath,
    cwd,
    accountId: "codex-subscription",
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
    claimOwner: "structured-host:adopting",
    pendingAction: null,
  });
  const entryBefore = registry.snapshot().entries[`codex:${id}`];
  const operationId = `kill_${id}`;
  await client.command({
    kind: "kill",
    operationId,
    idempotencyKey: operationId,
    conversationId: conversation.id,
    sessionKey: key,
  });

  await bindStructuredDeliveryQueue([], { registry, client });

  expect((await client.operationStatus(operationId))?.receipt.status).toBe("queued");
  expect(registry.snapshot().entries[`codex:${id}`]).toEqual(entryBefore);
  expect(await client.effectBatch(["runtime.kill"], 0)).toHaveLength(1);
});

describe.each(["codex", "claude"] as const)("%s structured spawn round trip", (engine) => {
  test("spawn, send, question, answer, interrupt, resume, and kill use one pane-less host", async () => {
    const id = crypto.randomUUID();
    const cwd = path.join(sandbox, `${engine}-${id}`);
    fs.mkdirSync(cwd, { recursive: true });
    const artifactPath = path.join(cwd, `${id}.jsonl`);
    const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
    const client = runtimeClient(journal);
    await bindStructuredDeliveryQueue([], { registry, client });
    const model = engine === "codex" ? "gpt-5.6-luna" : "claude-sonnet-4-6";
    const launchProfile = emptyLaunchProfile({ cwd, model });
    const begun = registry.beginSpawnRequest({
      engine,
      cwd,
      accountId: `${engine}-subscription`,
      launchProfile,
      clientAttemptId: `attempt_${id}`,
      requestDigest: id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    });
    if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
    const spec: ResumeSpec = { command: engine, cwd, windowName: `test-${engine}`, engine, transcript: artifactPath, launchProfile };
    const account: AccountContext = {
      engine,
      accountId: `${engine}-subscription`,
      kind: "managed",
      home: path.join(cwd, "account"),
      transcriptRoot: cwd,
      env: { NODE_ENV: "test" },
    };
    const host = new RoundTripHost(engine, artifactPath, id);

    const response = await spawnStructuredConversation({
      engine,
      receipt: begun.receipt,
      spec,
      account,
      prompt: "initial prompt",
      registry,
      client,
    }, {
      startHost: async (input) => {
        expect(input.spec.launchProfile?.model).toBe(model);
        return host;
      },
      bindHost: async (targetRegistry, key, runningHost, claimOwner, claimEpoch) => {
        const state = await runningHost.health();
        targetRegistry.setStructuredHostClaimed(key, {
          kind: engine === "codex" ? "codex-app-server" : "claude-broker",
          endpoint: state.endpoint,
          process: state.pid ? { pid: state.pid, startIdentity: state.processStartIdentity } : null,
          eventCursor: state.eventCursor,
          protocolVersion: state.protocolVersion,
          writerClaimEpoch: claimEpoch,
          activeTurnRef: state.activeTurnRef,
          pendingAttention: state.pendingAttention,
          activeFlags: state.activeFlags,
        }, "idle", claimOwner, claimEpoch);
        return () => {};
      },
      processIdentity: () => ({ pid: process.pid, startIdentity: "test-process" }),
    });

    expect(response).toMatchObject({ launched: true, target: null, path: artifactPath, state: "settled" });
    if (engine === "claude") {
      expect(response).toMatchObject({ effectivePermissionMode: "default" });
      /* Bypass acceptance readiness lands in the managed home before runtime
         admission, so no launch can wait at an interactive acceptance gate. */
      const homeState = JSON.parse(fs.readFileSync(path.join(account.home, ".claude.json"), "utf8")) as {
        bypassPermissionsModeAccepted?: boolean;
        projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
      };
      expect(homeState.bypassPermissionsModeAccepted).toBeTrue();
      expect(homeState.projects?.[cwd]?.hasTrustDialogAccepted).toBeTrue();
    }
    expect(registry.snapshot().receipts[begun.receipt.launchId]?.pane).toBeNull();
    const registryBeforeAttach = registry.snapshot();
    let terminalCommand = "";
    const attached = await materializeStructuredTerminal(artifactPath, {
      registry,
      spawn: async (command) => {
        terminalCommand = command.command;
        return {
          paneId: "%77",
          panePid: 7700,
          display: "agents:view.0",
          host: undefined,
          ...command,
        };
      },
    });
    expect(attached).toEqual({ target: "%77", display: "agents:view.0" });
    expect(terminalCommand).toContain("tail -n 200 -F");
    expect(terminalCommand.includes("codex resume") || terminalCommand.includes("claude --resume")).toBeFalse();
    expect(registry.snapshot().entries).toEqual(registryBeforeAttach.entries);
    await waitFor(() => host.sent.length === 1);
    host.finishTurn();

    const sent = await enqueueStructuredMessage({
      path: artifactPath,
      conversationId: response.conversationId,
      clientMessageId: `message_${id}`,
      text: "viewer send",
      hasImages: false,
    }, { client: () => client, registry: () => registry, enabled: () => true });
    expect(sent?.ok).toBeTrue();
    await waitFor(() => host.sent.some((entry) => entry.text === "viewer send"));

    host.ask("question-one");
    await waitFor(() => journal.snapshot().attentions.some((attention) => attention.id === "question-one"));
    const resolution = engine === "codex"
      ? { answers: { scope: { answers: ["Yes"] } } }
      : { behavior: "allow", updatedInput: { questions: [{ header: "Scope", question: "Continue?", options: [{ label: "Yes" }] }], answers: { "Continue?": "Yes" } } };
    await client.command({
      kind: "answer",
      operationId: `answer_${id}`,
      idempotencyKey: `answer_${id}`,
      conversationId: response.conversationId,
      attentionId: "question-one",
      resolution,
    });
    await kickStructuredDeliveryQueue();
    await waitFor(() => host.answers.length === 1);
    expect(host.answers[0]).toEqual({ id: "question-one", value: resolution });

    host.finishTurn();
    await enqueueStructuredMessage({
      path: artifactPath,
      conversationId: response.conversationId,
      clientMessageId: `slow_${id}`,
      text: "deliberately slow fake-host turn",
      hasImages: false,
    }, { client: () => client, registry: () => registry, enabled: () => true });
    await waitFor(() => host.sent.some((entry) => entry.text === "deliberately slow fake-host turn"));
    const slowTurn = (await host.health()).activeTurnRef!;
    await client.command({
      kind: "interrupt",
      operationId: `interrupt_${id}`,
      idempotencyKey: `interrupt_${id}`,
      conversationId: response.conversationId,
      turnId: slowTurn,
    });
    await kickStructuredDeliveryQueue();
    await waitFor(() => host.interrupts.includes(slowTurn));

    await enqueueStructuredMessage({
      path: artifactPath,
      conversationId: response.conversationId,
      clientMessageId: `resume_${id}`,
      text: "resume after interrupt",
      hasImages: false,
    }, { client: () => client, registry: () => registry, enabled: () => true });
    await waitFor(() => host.sent.some((entry) => entry.text === "resume after interrupt"));
    expect(host.sent.map((entry) => entry.text)).toEqual([
      "initial prompt",
      "viewer send",
      "deliberately slow fake-host turn",
      "resume after interrupt",
    ]);

    const pendingAfterKillId = `pending_after_kill_${id}`;
    await enqueueStructuredMessage({
      path: artifactPath,
      conversationId: response.conversationId,
      clientMessageId: pendingAfterKillId,
      text: "must stay queued after kill",
      hasImages: false,
      policy: "queue",
    }, { client: () => client, registry: () => registry, enabled: () => true });
    expect(host.sent.some((entry) => entry.text === "must stay queued after kill")).toBeFalse();

    const killOperationId = `kill_${id}`;
    const secondKillOperationId = `kill_again_${id}`;
    const kill = await dispatchStructuredControl({ path: artifactPath, conversationId: response.conversationId, action: "kill" }, {
      registry,
      client,
      operationId: () => killOperationId,
      kick: () => {},
      enabled: () => true,
    });
    expect(kill).toMatchObject({ status: 202, body: { ok: true, structured: true, operationId: killOperationId } });
    const secondKill = await dispatchStructuredControl({ path: artifactPath, conversationId: response.conversationId, action: "kill" }, {
      registry,
      client,
      operationId: () => secondKillOperationId,
      kick: () => {},
      enabled: () => true,
    });
    expect(secondKill).toMatchObject({ status: 202, body: { ok: true, structured: true, operationId: secondKillOperationId } });
    await completesWithin(kickStructuredDeliveryQueue(), "structured kill did not complete");
    await waitFor(() => host.releaseCount === 1);

    expect(hasStructuredDeliveryHost({ engine, sessionId: id })).toBeFalse();
    expect(registry.snapshot().entries[`${engine}:${id}`]).toMatchObject({
      status: "dead",
      host: null,
      structuredHost: null,
      claimOwner: null,
      pendingAction: null,
    });
    expect((await client.operationStatus(killOperationId))?.receipt).toMatchObject({
      kind: "kill",
      status: "delivered",
    });
    expect((await client.operationStatus(secondKillOperationId))?.receipt).toMatchObject({
      kind: "kill",
      status: "delivered",
    });
    expect(await client.effectBatch(["runtime.kill"], 0)).toEqual([]);
    expect(journal.snapshot().sessions.find((session) => session.conversationId === response.conversationId)).toMatchObject({
      host: "dead",
    });
    await completesWithin(kickStructuredDeliveryQueue(), "structured delivery queue stayed wedged after kill");
    expect(host.sent.some((entry) => entry.text === "must stay queued after kill")).toBeFalse();
  });
});

test("structured spawn fails loudly when Codex omits the transcript-path capability", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `codex-gap-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const launchProfile = emptyLaunchProfile({ cwd, model: "gpt-5.6-luna" });
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd, accountId: "codex-subscription", launchProfile });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const host = new RoundTripHost("codex", path.join(cwd, `${id}.jsonl`), id);
  Object.defineProperty(host, "identity", { value: { threadId: id, path: null } });

  await expect(spawnStructuredConversation({
    engine: "codex",
    receipt: begun.receipt,
    spec: { command: "codex", cwd, windowName: "gap", engine: "codex", launchProfile },
    account: { engine: "codex", accountId: "codex-subscription", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } },
    prompt: "prompt",
    registry,
    client,
  }, { startHost: async () => host })).rejects.toThrow("app-server returned no transcript path");

  expect(registry.snapshot().receipts[begun.receipt.launchId]?.state).toBe("failed");
  expect(journal.operationResult(begun.receipt.launchId)?.receipt).toMatchObject({ status: "failed", reason: expect.stringContaining("transcript path") });
});
