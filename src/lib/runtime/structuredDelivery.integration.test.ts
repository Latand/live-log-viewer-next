import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";
import { reconcileMigrations } from "@/lib/accounts/migration/coordinator";
import { emptyLaunchProfile, type ProviderReceipt, type SuccessorProviderPort } from "@/lib/accounts/migration/contracts";
import { RegisteredSuccessorProvider } from "@/lib/accounts/migration/provider";
import { RuntimeJournal } from "@/runtime-host/journal";

import type { RuntimeHostClient } from "./client";
import type { EngineHost, HostState, QueueEntry, RuntimeEvent } from "./engineHost";
import { FakeEngineHost, createFakeDeliveryLedger } from "./fixtures/fakeEngineHost";
import { bindStructuredDeliveryQueue, publishStructuredDeliveryHost } from "./structuredDeliveryController";
import { StructuredDeliveryQueue, type StructuredDeliveryQueuePort } from "./structuredDeliveryQueue";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { deliverHeldStructuredMessage, enqueueStructuredMessage } from "./structuredMessageDelivery";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-delivery-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function journalPort(journal: RuntimeJournal, failDelivered = false): StructuredDeliveryQueuePort {
  return {
    effects: async () => journal.effectBatch(),
    transition: async (operationId, status, details) => {
      if (failDelivered && status === "delivered") throw new Error("runtime stopped before confirmation commit");
      journal.transitionOperation(operationId, status, details);
    },
  };
}

function observableFakeHost(host: FakeEngineHost): FakeEngineHost & { onStateChange(): () => void } {
  return Object.assign(host, { onStateChange: () => () => {} });
}

function burstyObservableHost(): {
  host: EngineHost & { onStateChange(listener: (state: HostState) => void): () => void };
  emit(event: RuntimeEvent): void;
  attachedAfter(): number | null;
} {
  let state: HostState = {
    status: "active",
    sessionKey: "burst-session",
    endpoint: "fake:burst-host",
    pid: 1,
    processStartIdentity: "fake:1",
    eventCursor: 0,
    protocolVersion: "fake-v1",
    activeTurnRef: "turn:burst",
    pendingAttention: [],
    activeFlags: [],
    account: null,
  };
  const listeners = new Set<(state: HostState) => void>();
  const queued: RuntimeEvent[] = [];
  const waiters: Array<(result: IteratorResult<RuntimeEvent>) => void> = [];
  let attachedAfter: number | null = null;
  let closed = false;
  const iterator: AsyncIterator<RuntimeEvent> = {
    next: async () => {
      const event = queued.shift();
      if (event) return { value: event, done: false };
      if (closed) return { value: undefined, done: true };
      return await new Promise<IteratorResult<RuntimeEvent>>((resolve) => waiters.push(resolve));
    },
    return: async () => {
      closed = true;
      for (const resolve of waiters.splice(0)) resolve({ value: undefined, done: true });
      return { value: undefined, done: true };
    },
  };
  const host = {
    attach: (afterSeq: number) => {
      attachedAfter = afterSeq;
      return { [Symbol.asyncIterator]: () => iterator };
    },
    send: async (entry: QueueEntry) => ({ outcome: "turn-started" as const, turnId: `turn:${entry.id}` }),
    interrupt: async () => {},
    answer: async () => {},
    health: async () => ({ ...state }),
    release: async () => {},
    onStateChange(listener: (next: HostState) => void) {
      listeners.add(listener);
      listener({ ...state });
      return () => listeners.delete(listener);
    },
  } satisfies EngineHost & { onStateChange(listener: (state: HostState) => void): () => void };
  return {
    host,
    emit(event) {
      state = { ...state, eventCursor: event.seq };
      for (const listener of listeners) listener({ ...state });
      const resolve = waiters.shift();
      if (resolve) resolve({ value: event, done: false });
      else queued.push(event);
    },
    attachedAfter: () => attachedAfter,
  };
}

async function waitForCondition(assertion: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (assertion()) return;
    await Bun.sleep(5);
  }
  throw new Error("structured delivery condition did not settle");
}

function runtimeJournalClient(journal: RuntimeJournal): RuntimeHostClient {
  return {
    snapshot: async () => journal.snapshot(),
    append: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (operationId) => journal.operationResult(operationId),
    producerCursor: async (producerKind, eventKeyPrefix) => journal.producerCursor(producerKind, eventKeyPrefix),
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) => journal.transitionOperation(operationId, status, details),
  } as RuntimeHostClient;
}

function cleanupOnlyProvider(): RegisteredSuccessorProvider {
  return new RegisteredSuccessorProvider({
    accounts: {
      resolveSpawn: () => { throw new Error("unexpected account resolution"); },
      resolveTranscriptOwner: () => { throw new Error("unexpected account resolution"); },
    },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => { throw new Error("unexpected Claude status"); },
    spawnClaude: async () => { throw new Error("unexpected Claude spawn"); },
    now: () => "2026-07-13T12:01:00.000Z",
  });
}

test("an engine event burst preserves every projection without polling the delivery queue per event", async () => {
  const directory = path.join(sandbox, "controller-event-burst");
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const artifactPath = path.join(directory, "burst-session.jsonl");
  const profile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "burst-account",
    launchProfile: profile,
    turn: { state: "busy", source: "assistant", terminalAt: null },
    observedAt: "2026-07-14T12:00:00.000Z",
  }]);
  registry.upsert({
    key: { engine: "codex", sessionId: "burst-session" },
    artifactPath,
    cwd: directory,
    accountId: "burst-account",
    launchProfile: profile,
    status: "live",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:burst-host",
      process: null,
      eventCursor: 0,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 0,
      activeTurnRef: "turn:burst",
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  let effectBatchCalls = 0;
  let deltaProjections = 0;
  let sessionStatusProjections = 0;
  const client = {
    append: async (event: { kind: string }) => {
      if (event.kind === "delta") deltaProjections += 1;
      if (event.kind === "session-status") sessionStatusProjections += 1;
    },
    producerCursor: async () => 17,
    effectBatch: async () => { effectBatchCalls += 1; return []; },
    transitionOperation: async () => { throw new Error("unexpected operation transition"); },
  } as unknown as RuntimeHostClient;
  const burst = burstyObservableHost();

  try {
    await bindStructuredDeliveryQueue([{
      key: { engine: "codex", sessionId: "burst-session" },
      host: burst.host,
    }], { registry, client });
    await Bun.sleep(50);
    expect(burst.attachedAfter()).toBe(17);
    const baselineEffects = effectBatchCalls;
    const baselineStatuses = sessionStatusProjections;

    for (let index = 18; index <= 57; index += 1) {
      burst.emit({ kind: "delta", turnId: "turn:burst", text: `delta ${index}`, seq: index });
    }

    await waitForCondition(() => deltaProjections === 40);
    await Bun.sleep(50);
    expect(deltaProjections).toBe(40);
    expect(sessionStatusProjections - baselineStatuses).toBeLessThanOrEqual(1);
    expect(effectBatchCalls - baselineEffects).toBeLessThanOrEqual(1);
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null });
  }
});

test("a failed route kick retries queued controls and messages without a host-state notification", async () => {
  const directory = path.join(sandbox, "controller-route-kick-retry");
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "c012d11e-1854-4157-aede-75eae7bde18c";
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  const profile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "route-kick-account",
    launchProfile: profile,
    turn: { state: "busy", source: "assistant", terminalAt: null },
    observedAt: "2026-07-14T12:00:00.000Z",
  }]);
  const conversationId = Object.keys(registry.snapshot().conversations)[0]!;
  registry.upsert({
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd: directory,
    accountId: "route-kick-account",
    launchProfile: profile,
    status: "live",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:route-kick-host",
      process: null,
      eventCursor: 0,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 0,
      activeTurnRef: "turn:route-kick",
      pendingAttention: ["attention-route-kick"],
      activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const journal = new RuntimeJournal(path.join(directory, "events.sqlite"), { structuredHosts: true });
  const baseClient = runtimeJournalClient(journal);
  const transitions: Array<[string, string]> = [];
  let effectBatchCalls = 0;
  let failNextEffectBatch = false;
  const client = {
    ...baseClient,
    effectBatch: async (...args: Parameters<RuntimeHostClient["effectBatch"]>) => {
      effectBatchCalls += 1;
      if (failNextEffectBatch) {
        failNextEffectBatch = false;
        throw new Error("transient route-kick effect-batch failure");
      }
      return await baseClient.effectBatch(...args);
    },
    transitionOperation: async (...args: Parameters<RuntimeHostClient["transitionOperation"]>) => {
      transitions.push([args[0], args[1]]);
      return await baseClient.transitionOperation(...args);
    },
  } satisfies RuntimeHostClient;
  const hostCalls: string[] = [];
  let hostState: HostState = {
    status: "active",
    sessionKey: "route-kick-session",
    endpoint: "fake:route-kick-host",
    pid: 1,
    processStartIdentity: "fake:1",
    eventCursor: 0,
    protocolVersion: "fake-v1",
    activeTurnRef: "turn:route-kick",
    pendingAttention: ["attention-route-kick"],
    activeFlags: [],
    account: null,
  };
  const host = {
    async *attach(): AsyncIterableIterator<RuntimeEvent> {},
    send: async (entry: QueueEntry) => {
      hostCalls.push(`send:${entry.id}`);
      return { outcome: "turn-started" as const, turnId: `turn:${entry.id}` };
    },
    answer: async (attentionId: string) => { hostCalls.push(`answer:${attentionId}`); },
    interrupt: async (turnId: string) => {
      hostCalls.push(`interrupt:${turnId}`);
      hostState = { ...hostState, status: "idle", activeTurnRef: null };
    },
    health: async () => ({ ...hostState }),
    release: async () => {},
    onStateChange(listener: (state: HostState) => void) {
      listener({ ...hostState });
      return () => {};
    },
  } satisfies EngineHost & { onStateChange(listener: (state: HostState) => void): () => void };

  try {
    await bindStructuredDeliveryQueue([{
      key: { engine: "codex", sessionId },
      host,
    }], { registry, client });
    journal.append({
      scope: { type: "session", id: conversationId },
      kind: "attention",
      payload: {
        id: "attention-route-kick",
        conversationId,
        kind: "question",
        state: "open",
        unowned: false,
        createdAt: "2026-07-14T12:00:00.000Z",
        request: { question: { prompt: "Proceed?" } },
        turnId: "turn:route-kick",
      },
    });
    journal.executeOperation({
      kind: "send",
      operationId: "operation-route-send",
      idempotencyKey: "route-send",
      conversationId,
      text: "continue after controls",
      policy: "queue",
    });
    journal.executeOperation({
      kind: "answer",
      operationId: "operation-route-answer",
      idempotencyKey: "route-answer",
      conversationId,
      attentionId: "attention-route-kick",
      resolution: { answer: "yes" },
    });
    journal.executeOperation({
      kind: "interrupt",
      operationId: "operation-route-interrupt",
      idempotencyKey: "route-interrupt",
      conversationId,
      turnId: "turn:route-kick",
    });
    const baselineEffectBatchCalls = effectBatchCalls;
    failNextEffectBatch = true;

    await kickStructuredDeliveryQueue();
    expect(effectBatchCalls - baselineEffectBatchCalls).toBe(1);
    await waitForCondition(() => journal.operationResult("operation-route-send")?.receipt.status === "delivered");

    expect(journal.operationResult("operation-route-answer")?.receipt.status).toBe("answered");
    expect(journal.operationResult("operation-route-interrupt")?.receipt.status).toBe("interrupted");
    expect(journal.operationResult("operation-route-send")?.receipt.status).toBe("delivered");
    expect(effectBatchCalls - baselineEffectBatchCalls).toBe(2);
    expect(hostCalls).toEqual([
      "answer:attention-route-kick",
      "interrupt:turn:route-kick",
      "send:operation-route-send",
    ]);
    expect(transitions).toEqual([
      ["operation-route-answer", "delivering"],
      ["operation-route-answer", "answered"],
      ["operation-route-interrupt", "delivering"],
      ["operation-route-interrupt", "interrupted"],
      ["operation-route-send", "delivering"],
      ["operation-route-send", "delivered"],
    ]);
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null });
    journal.close();
  }
});

test("a kill cancels an automatic delivery retry without falsifying either receipt", async () => {
  const directory = path.join(sandbox, "controller-kill-cancels-auto-retry");
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "e40306b9-a4df-47b3-bf6e-4570c44259c7";
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  const profile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "kill-auto-retry-account",
    launchProfile: profile,
    turn: { state: "busy", source: "assistant", terminalAt: null },
    observedAt: "2026-07-14T12:00:00.000Z",
  }]);
  const conversationId = Object.keys(registry.snapshot().conversations)[0]!;
  const key = { engine: "codex" as const, sessionId };
  registry.upsert({
    key,
    artifactPath,
    cwd: directory,
    accountId: "kill-auto-retry-account",
    launchProfile: profile,
    status: "live",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:kill-auto-retry-host",
      process: null,
      eventCursor: 0,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 0,
      activeTurnRef: "turn:kill-auto-retry",
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const journal = new RuntimeJournal(path.join(directory, "events.sqlite"), { structuredHosts: true });
  const baseClient = runtimeJournalClient(journal);
  let effectBatchCalls = 0;
  const client = {
    ...baseClient,
    effectBatch: async (...args: Parameters<RuntimeHostClient["effectBatch"]>) => {
      effectBatchCalls += 1;
      return await baseClient.effectBatch(...args);
    },
  } satisfies RuntimeHostClient;
  let released = false;
  let releaseCount = 0;
  let sendCount = 0;
  const host = {
    async *attach(): AsyncIterableIterator<RuntimeEvent> {},
    send: async () => {
      sendCount += 1;
      throw new Error("Codex app-server request timed out: thread/read");
    },
    answer: async () => {},
    interrupt: async () => {},
    health: async () => ({
      status: released ? "unhosted" as const : "active" as const,
      sessionKey: sessionId,
      endpoint: "fake:kill-auto-retry-host",
      pid: 1,
      processStartIdentity: "fake:1",
      eventCursor: 0,
      protocolVersion: "fake-v1",
      activeTurnRef: released ? null : "turn:kill-auto-retry",
      pendingAttention: [],
      activeFlags: [],
      account: null,
    }),
    release: async () => {
      releaseCount += 1;
      released = true;
    },
    onStateChange: () => () => {},
  } satisfies EngineHost & { onStateChange(listener: (state: HostState) => void): () => void };

  try {
    await bindStructuredDeliveryQueue([{ key, host }], { registry, client });
    const sendOperationId = "operation-send-before-kill";
    journal.executeOperation({
      kind: "send",
      operationId: sendOperationId,
      idempotencyKey: sendOperationId,
      conversationId,
      text: "keep this queued while the host is busy",
      policy: "steer-if-active",
    });

    await kickStructuredDeliveryQueue();

    expect(sendCount).toBe(2);
    expect(journal.operationResult(sendOperationId)?.receipt).toMatchObject({
      kind: "send",
      status: "queued",
      reason: "delivery-auto-retry",
    });

    const killOperationId = "operation-kill-during-auto-retry";
    journal.executeOperation({
      kind: "kill",
      operationId: killOperationId,
      idempotencyKey: killOperationId,
      conversationId,
      sessionKey: key,
    });

    await kickStructuredDeliveryQueue();
    const effectBatchCallsAfterKill = effectBatchCalls;
    await Bun.sleep(1_100);

    expect(releaseCount).toBe(1);
    expect(sendCount).toBe(2);
    expect(effectBatchCalls).toBe(effectBatchCallsAfterKill);
    expect(journal.operationResult(killOperationId)?.receipt).toMatchObject({
      kind: "kill",
      status: "delivered",
      reason: null,
    });
    expect(journal.operationResult(sendOperationId)?.receipt).toMatchObject({
      kind: "send",
      status: "queued",
      reason: "delivery-auto-retry",
    });
    expect(journal.effectBatch(100, ["runtime.kill"], 0)).toEqual([]);
    expect(journal.effectBatch(100, ["runtime.send"], 0)).toHaveLength(1);
    expect(journal.snapshot().sessions.find((session) => session.conversationId === conversationId)).toMatchObject({
      sessionKey: key,
      host: "dead",
    });
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null });
    journal.close();
  }
});

test("a failed kill projection retries through the coalesced drain and terminalizes", async () => {
  const directory = path.join(sandbox, "controller-kill-projection-retry");
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "b6b55ea7-4a5e-4fe5-894d-2f332a7247c7";
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  const profile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "kill-retry-account",
    launchProfile: profile,
    turn: { state: "idle", source: "assistant", terminalAt: null },
    observedAt: "2026-07-14T12:00:00.000Z",
  }]);
  const conversationId = Object.keys(registry.snapshot().conversations)[0]!;
  const key = { engine: "codex" as const, sessionId };
  registry.upsert({
    key,
    artifactPath,
    cwd: directory,
    accountId: "kill-retry-account",
    launchProfile: profile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:kill-retry-host",
      process: null,
      eventCursor: 0,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 0,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const journal = new RuntimeJournal(path.join(directory, "events.sqlite"), { structuredHosts: true });
  const baseClient = runtimeJournalClient(journal);
  let failNextDeadProjection = false;
  let deadProjectionAttempts = 0;
  const client = {
    ...baseClient,
    append: async (...args: Parameters<RuntimeHostClient["append"]>) => {
      const [event] = args;
      if (event.kind === "session-status" && event.payload.host === "dead") {
        deadProjectionAttempts += 1;
        if (failNextDeadProjection) {
          failNextDeadProjection = false;
          throw new Error("transient dead projection failure");
        }
      }
      return await baseClient.append(...args);
    },
  } satisfies RuntimeHostClient;
  const host = observableFakeHost(new FakeEngineHost());

  try {
    await bindStructuredDeliveryQueue([{ key, host }], { registry, client });
    const operationId = "operation-kill-projection-retry";
    journal.executeOperation({
      kind: "kill",
      operationId,
      idempotencyKey: operationId,
      conversationId,
      sessionKey: key,
    });
    failNextDeadProjection = true;

    await kickStructuredDeliveryQueue();
    expect(journal.operationResult(operationId)?.receipt.status).toBe("queued");
    await waitForCondition(() => journal.operationResult(operationId)?.receipt.status === "delivered");

    expect(deadProjectionAttempts).toBe(2);
    expect(journal.snapshot().sessions.find((session) => session.conversationId === conversationId)).toMatchObject({
      sessionKey: key,
      host: "dead",
    });
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null });
    journal.close();
  }
});

test("a delivering entry resumes after restart through the host ledger without a second engine write", async () => {
  const filename = path.join(sandbox, "events.sqlite");
  const ledger = createFakeDeliveryLedger();
  const firstJournal = new RuntimeJournal(filename, { structuredHosts: true });
  firstJournal.append({
    scope: { type: "session", id: "conversation-one" },
    kind: "session-status",
    payload: {
      conversationId: "conversation-one",
      sessionKey: { engine: "codex", sessionId: "session-one" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      artifactPath: "/sessions/one.jsonl",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  firstJournal.executeOperation({
    kind: "send",
    operationId: "operation-one",
    idempotencyKey: "message-one",
    conversationId: "conversation-one",
    text: "hello",
    policy: "queue",
  });
  const firstHost = new FakeEngineHost(ledger);
  const firstQueue = new StructuredDeliveryQueue(journalPort(firstJournal, true), () => firstHost);

  await expect(firstQueue.drain()).rejects.toThrow("runtime stopped before confirmation commit");
  expect(firstJournal.operationResult("operation-one")?.receipt.status).toBe("delivering");
  expect(firstJournal.effectBatch()).toHaveLength(1);
  expect(ledger.writes).toEqual([{ id: "operation-one", text: "hello", expectedTurnId: null }]);
  firstJournal.close();

  const reopenedJournal = new RuntimeJournal(filename, { structuredHosts: true });
  const recoveredHost = new FakeEngineHost(ledger);
  const recoveredQueue = new StructuredDeliveryQueue(journalPort(reopenedJournal), () => recoveredHost);
  await recoveredQueue.drain();

  expect(reopenedJournal.operationResult("operation-one")?.receipt).toMatchObject({
    status: "delivered",
    turnId: "turn:operation-one",
  });
  expect(reopenedJournal.effectBatch()).toEqual([]);
  expect(ledger.writes).toEqual([{ id: "operation-one", text: "hello", expectedTurnId: null }]);
  reopenedJournal.close();
});

test("repeated terminal retry clicks produce one replacement engine write", async () => {
  const filename = path.join(sandbox, "terminal-retry-clicks.sqlite");
  const journal = new RuntimeJournal(filename, { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: "conversation-terminal-retry" },
    kind: "session-status",
    payload: {
      conversationId: "conversation-terminal-retry",
      sessionKey: { engine: "codex", sessionId: "session-terminal-retry" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      artifactPath: "/sessions/terminal-retry.jsonl",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.executeOperation({
    kind: "send",
    operationId: "operation-terminal-original",
    idempotencyKey: "message-terminal-original",
    conversationId: "conversation-terminal-retry",
    text: "deliver this once",
    policy: "queue",
  });
  journal.transitionOperation("operation-terminal-original", "delivering");
  journal.transitionOperation("operation-terminal-original", "failed", { reason: "dead-host" });

  const replacement = journal.retryOperation("operation-terminal-original", "message-terminal-replacement");
  const repeated = journal.retryOperation("operation-terminal-original", "message-terminal-second-click");
  const ledger = createFakeDeliveryLedger();

  expect(repeated).toMatchObject({ operationId: replacement.operationId, replayed: true });
  expect(journal.effectBatch()).toHaveLength(1);
  await new StructuredDeliveryQueue(journalPort(journal), () => new FakeEngineHost(ledger)).drain();

  expect(ledger.writes).toEqual([{
    id: replacement.operationId,
    text: "deliver this once",
    expectedTurnId: null,
  }]);
  expect(journal.operationResult(replacement.operationId)?.receipt).toMatchObject({
    status: "delivered",
    retryOfOperationId: "operation-terminal-original",
  });
  journal.close();
});

test("ledger recovery drains every entry beyond one effect batch", async () => {
  const filename = path.join(sandbox, "batch-continuation.sqlite");
  const journal = new RuntimeJournal(filename, { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: "conversation-batch" },
    kind: "session-status",
    payload: {
      conversationId: "conversation-batch",
      sessionKey: { engine: "codex", sessionId: "session-batch" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      artifactPath: "/sessions/batch.jsonl",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  for (let index = 0; index < 101; index += 1) {
    journal.executeOperation({
      kind: "send",
      operationId: `operation-${index}`,
      idempotencyKey: `message-${index}`,
      conversationId: "conversation-batch",
      text: `message ${index}`,
      policy: "queue",
    });
  }
  const ledger = createFakeDeliveryLedger();
  const queue = new StructuredDeliveryQueue(journalPort(journal), () => new FakeEngineHost(ledger));

  await queue.drain();

  expect(ledger.writes).toHaveLength(101);
  expect(ledger.writes.map((entry) => entry.id)).toEqual(
    Array.from({ length: 101 }, (_, index) => `operation-${index}`),
  );
  expect(journal.effectBatch()).toEqual([]);
  journal.close();
});

test("an explicit steer keeps its admission turn fence through unavailable-host recovery", async () => {
  const filename = path.join(sandbox, "explicit-steer-fence.sqlite");
  const journal = new RuntimeJournal(filename, { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: "conversation-steer" },
    kind: "session-status",
    payload: {
      conversationId: "conversation-steer",
      sessionKey: { engine: "codex", sessionId: "session-steer" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "running",
      activeTurnId: "turn-old",
      provenance: "structured",
      artifactPath: "/sessions/steer.jsonl",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  const admitted = journal.executeOperation({
    kind: "steer",
    operationId: "operation-steer",
    idempotencyKey: "message-steer",
    conversationId: "conversation-steer",
    text: "amend the active turn",
  });
  expect(admitted.receipt).toMatchObject({ status: "pending", turnId: "turn-old" });

  const expectedTurns: Array<string | null | undefined> = [];
  let recovered = false;
  const idleHost = {
    health: async () => ({
      status: recovered ? "idle" as const : "dead" as const,
      sessionKey: "session-steer",
      endpoint: "fake:steer",
      pid: 1,
      processStartIdentity: "fake:1",
      eventCursor: 0,
      protocolVersion: "fake-v1",
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
      account: null,
    }),
    send: async (entry: QueueEntry) => {
      expectedTurns.push(entry.expectedTurnId);
      return entry.expectedTurnId === "turn-old"
        ? { outcome: "rejected" as const, reason: "stale-turn" as const }
        : { outcome: "turn-started" as const, turnId: "fresh-turn" };
    },
    async *attach() {},
    interrupt: async () => {},
    answer: async () => {},
    release: async () => {},
  } satisfies EngineHost;
  const queue = new StructuredDeliveryQueue(journalPort(journal), () => idleHost);

  await queue.drain();
  expect(journal.operationResult("operation-steer")?.receipt).toMatchObject({
    status: "queued",
    turnId: "turn-old",
    reason: "dead-host",
  });

  recovered = true;
  await queue.drain();

  expect(expectedTurns).toEqual(["turn-old"]);
  expect(journal.operationResult("operation-steer")?.receipt).toMatchObject({
    status: "failed",
    turnId: "turn-old",
    reason: "stale-turn",
  });
  journal.close();
});

test("a failed idle send retry keeps its null turn fence when another turn starts", async () => {
  const filename = path.join(sandbox, "idle-retry-fence.sqlite");
  const journal = new RuntimeJournal(filename, { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: "conversation-idle-retry" },
    kind: "session-status",
    payload: {
      conversationId: "conversation-idle-retry",
      sessionKey: { engine: "codex", sessionId: "session-idle-retry" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      activeTurnId: null,
      provenance: "structured",
      artifactPath: "/sessions/idle-retry.jsonl",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.executeOperation({
    kind: "send",
    operationId: "operation-idle-retry",
    idempotencyKey: "message-idle-retry",
    conversationId: "conversation-idle-retry",
    text: "start from the idle turn",
    policy: "steer-if-active",
  });
  journal.transitionOperation("operation-idle-retry", "delivering", { turnId: null });
  journal.transitionOperation("operation-idle-retry", "failed", { reason: "engine write failed" });
  journal.retryOperation("operation-idle-retry");

  const expectedTurns: Array<string | null | undefined> = [];
  const activeHost = {
    health: async () => ({
      status: "active" as const,
      sessionKey: "session-idle-retry",
      endpoint: "fake:idle-retry",
      pid: 1,
      processStartIdentity: "fake:1",
      eventCursor: 0,
      protocolVersion: "fake-v1",
      activeTurnRef: "turn-unrelated",
      pendingAttention: [],
      activeFlags: [],
      account: null,
    }),
    send: async (entry: QueueEntry) => {
      expectedTurns.push(entry.expectedTurnId);
      return entry.expectedTurnId === null
        ? { outcome: "rejected" as const, reason: "stale-turn" as const }
        : { outcome: "steered" as const, turnId: "turn-unrelated" };
    },
    async *attach() {},
    interrupt: async () => {},
    answer: async () => {},
    release: async () => {},
  } satisfies EngineHost;

  await new StructuredDeliveryQueue(journalPort(journal), () => activeHost).drain();

  expect(expectedTurns).toEqual([null]);
  expect(journal.operationResult("operation-idle-retry")?.receipt).toMatchObject({
    status: "failed",
    turnId: null,
    reason: "stale-turn",
  });
  journal.close();
});

test("a migration-held delivery switches from the source host to the published Codex successor", async () => {
  const sourceId = "11111111-1111-4111-8111-111111111111";
  const successorId = "22222222-2222-4222-8222-222222222222";
  const sourcePath = path.join(sandbox, `${sourceId}.jsonl`);
  const successorPath = path.join(sandbox, `${successorId}.jsonl`);
  const registry = new AgentRegistry(path.join(sandbox, "migration-registry.json"));
  const profile = emptyLaunchProfile({ cwd: sandbox });
  registry.reconcileConversations([{
    engine: "codex",
    path: sourcePath,
    accountId: "source",
    launchProfile: profile,
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-13T12:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(sourcePath)!;
  registry.upsert({
    key: { engine: "codex", sessionId: sourceId },
    artifactPath: sourcePath,
    cwd: sandbox,
    accountId: "source",
    launchProfile: profile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:source",
      process: null,
      eventCursor: 0,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 0,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });

  const journal = new RuntimeJournal(path.join(sandbox, "migration-runtime.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);
  const sourceLedger = createFakeDeliveryLedger();
  const successorLedger = createFakeDeliveryLedger();
  await bindStructuredDeliveryQueue([{
    key: { engine: "codex", sessionId: sourceId },
    host: observableFakeHost(new FakeEngineHost(sourceLedger)),
  }], { registry, client });

  registry.commitMigrationIntent({
    engine: "codex",
    targetId: "target",
    origin: "manual",
    requestId: "publish-successor-before-drain",
    expectedRevision: registry.engineRouting("codex").revision,
  });
  const held = registry.holdDelivery(conversation.id, "continue on the successor", "migration-successor-message");
  expect(held.state).toBe("held");

  const order: string[] = [];
  const commitSuccessor = registry.commitSuccessor.bind(registry);
  registry.commitSuccessor = ((...args: Parameters<AgentRegistry["commitSuccessor"]>) => {
    order.push("commit");
    return commitSuccessor(...args);
  }) as AgentRegistry["commitSuccessor"];
  const provider: SuccessorProviderPort = {
    async create(input) {
      input.recordContinuityPath(successorPath);
      return {
        operationId: input.operationId,
        nativeId: successorId,
        path: successorPath,
        continuityPaths: [successorPath],
        historyHash: "successor-history",
        host: { kind: "codex-app-server", identity: successorId, epoch: 1, verifiedAt: "2026-07-13T12:01:00.000Z" },
      };
    },
    async verify() { order.push("verify"); },
    async publishHost() {
      order.push("publish");
      registry.upsert({
        key: { engine: "codex", sessionId: successorId },
        artifactPath: successorPath,
        cwd: sandbox,
        accountId: "target",
        launchProfile: profile,
        status: "idle",
        host: null,
        structuredHost: {
          kind: "codex-app-server",
          endpoint: "fake:successor",
          process: null,
          eventCursor: 0,
          protocolVersion: "fake-v1",
          writerClaimEpoch: 0,
          activeTurnRef: null,
          pendingAttention: [],
          activeFlags: [],
        },
        claimEpoch: 0,
        claimOwner: null,
        pendingAction: null,
      });
      await publishStructuredDeliveryHost({
        key: { engine: "codex", sessionId: successorId },
        host: observableFakeHost(new FakeEngineHost(successorLedger)),
      });
    },
  };

  await reconcileMigrations(provider, {
    async deliver({ delivery, path: deliveryPath, clientMessageId }) {
      return await deliverHeldStructuredMessage({
        conversationId: conversation.id,
        path: deliveryPath,
        deliveryId: delivery.id,
        clientMessageId,
        text: delivery.text,
      }, {
        enabled: () => true,
        client: () => client,
        kick: kickStructuredDeliveryQueue,
      }) ?? "delivery-uncertain";
    },
  }, registry);

  expect(order.slice(0, 3)).toEqual(["verify", "publish", "commit"]);
  expect(sourceLedger.writes).toEqual([]);
  expect(successorLedger.writes).toEqual([{
    id: held.id,
    text: "continue on the successor",
    expectedTurnId: null,
  }]);
  expect(registry.pendingDeliveries(conversation.id)).toEqual([]);
  expect(journal.operationResult(held.id)?.receipt.status).toBe("delivered");

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
});

test("a migration-held delivery switches from the source host to the published Claude successor", async () => {
  const sourceId = "33333333-3333-4333-8333-333333333333";
  const successorId = "44444444-4444-4444-8444-444444444444";
  const accountRoot = path.join(sandbox, "claude-migration-accounts");
  const sourceHome = path.join(accountRoot, "source");
  const targetHome = path.join(accountRoot, "target");
  const sourceRoot = path.join(sourceHome, "projects");
  const targetRoot = path.join(targetHome, "projects");
  fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(sourceHome, 0o700);
  fs.chmodSync(targetHome, 0o700);
  const sourcePath = path.join(sourceRoot, `${sourceId}.jsonl`);
  const successorPath = path.join(targetRoot, `${successorId}.jsonl`);
  fs.writeFileSync(sourcePath, JSON.stringify({ sessionId: sourceId }) + "\n", { mode: 0o600 });
  fs.writeFileSync(successorPath, JSON.stringify({ sessionId: successorId }) + "\n", { mode: 0o600 });

  const registry = new AgentRegistry(path.join(sandbox, "claude-migration-registry.json"));
  const profile = emptyLaunchProfile({ cwd: sandbox });
  registry.reconcileConversations([{
    engine: "claude",
    path: sourcePath,
    accountId: "source",
    launchProfile: profile,
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-13T12:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(sourcePath)!;
  registry.upsert({
    key: { engine: "claude", sessionId: sourceId },
    artifactPath: sourcePath,
    cwd: sandbox,
    accountId: "source",
    launchProfile: profile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "claude-broker",
      endpoint: "fake:claude-source",
      process: null,
      eventCursor: 0,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 0,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const journal = new RuntimeJournal(path.join(sandbox, "claude-migration-runtime.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);
  const sourceLedger = createFakeDeliveryLedger();
  const successorLedger = createFakeDeliveryLedger();
  await bindStructuredDeliveryQueue([{
    key: { engine: "claude", sessionId: sourceId },
    host: observableFakeHost(new FakeEngineHost(sourceLedger)),
  }], { registry, client });

  registry.commitMigrationIntent({
    engine: "claude",
    targetId: "target",
    origin: "manual",
    requestId: "publish-claude-successor-before-drain",
    expectedRevision: registry.engineRouting("claude").revision,
  });
  let migrating = registry.conversation(conversation.id)!;
  const revision = migrating.migration!.revision;
  migrating = registry.transitionConversationMigration(migrating.id, revision, ["requested"], { phase: "preparing" });
  migrating = registry.transitionConversationMigration(migrating.id, revision, ["preparing"], { phase: "successor-starting" });
  registry.recordConversationContinuityPath(migrating.id, successorPath);
  const receipt: ProviderReceipt = {
    operationId: migrating.migration!.operationId,
    nativeId: successorId,
    path: successorPath,
    continuityPaths: [successorPath],
    historyHash: "claude-successor-history",
    host: {
      kind: "claude-stream",
      identity: "%44:4444",
      epoch: 1,
      verifiedAt: "2026-07-13T12:01:00.000Z",
      tmuxHost: {
        kind: "tmux",
        endpoint: "/tmp/claude-migration-tmux.sock",
        server: { pid: 4400, startIdentity: "server-4400" },
        paneId: "%44",
        panePid: { pid: 4444, startIdentity: "pane-4444" },
        windowName: "claude-migration-successor",
        agent: { pid: 4445, startIdentity: "agent-4445" },
        argv: ["claude"],
      },
    },
  };
  registry.transitionConversationMigration(migrating.id, revision, ["successor-starting"], {
    phase: "verifying",
    providerReceipt: receipt,
  });
  const held = registry.holdDelivery(conversation.id, "continue on the Claude successor", "claude-migration-message");
  expect(held.state).toBe("held");

  const sourceAccount = {
    engine: "claude" as const,
    accountId: "source",
    kind: "managed" as const,
    home: sourceHome,
    transcriptRoot: sourceRoot,
    env: { ...process.env },
  };
  const targetAccount = {
    engine: "claude" as const,
    accountId: "target",
    kind: "managed" as const,
    home: targetHome,
    transcriptRoot: targetRoot,
    env: { ...process.env },
  };
  let publications = 0;
  const provider = new RegisteredSuccessorProvider({
    accounts: {
      resolveSpawn: () => targetAccount,
      resolveTranscriptOwner: () => sourceAccount,
    },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    spawnClaude: async () => { throw new Error("unexpected Claude spawn"); },
    verifyClaudeHost: async () => true,
    publishClaudeHost: async () => {
      publications += 1;
      registry.upsert({
        key: { engine: "claude", sessionId: successorId },
        artifactPath: successorPath,
        cwd: sandbox,
        accountId: "target",
        launchProfile: profile,
        status: "idle",
        host: null,
        structuredHost: {
          kind: "claude-broker",
          endpoint: "fake:claude-successor",
          process: null,
          eventCursor: 0,
          protocolVersion: "fake-v1",
          writerClaimEpoch: 0,
          activeTurnRef: null,
          pendingAttention: [],
          activeFlags: [],
        },
        claimEpoch: 0,
        claimOwner: null,
        pendingAction: null,
      });
      const unregister = await publishStructuredDeliveryHost({
        key: { engine: "claude", sessionId: successorId },
        host: observableFakeHost(new FakeEngineHost(successorLedger)),
      });
      return async () => { await unregister(); };
    },
    registry,
    now: () => "2026-07-13T12:01:00.000Z",
  });

  await reconcileMigrations(provider, {
    async deliver({ delivery, path: deliveryPath, clientMessageId }) {
      return await deliverHeldStructuredMessage({
        conversationId: conversation.id,
        path: deliveryPath,
        deliveryId: delivery.id,
        clientMessageId,
        text: delivery.text,
      }, {
        enabled: () => true,
        client: () => client,
        kick: kickStructuredDeliveryQueue,
      }) ?? "delivery-uncertain";
    },
  }, registry);

  expect(publications).toBe(1);
  expect(sourceLedger.writes).toEqual([]);
  expect(successorLedger.writes).toEqual([{
    id: held.id,
    text: "continue on the Claude successor",
    expectedTurnId: null,
  }]);
  expect(registry.pendingDeliveries(conversation.id)).toEqual([]);
  expect(journal.operationResult(held.id)?.receipt.status).toBe("delivered");

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
});

test("successor cleanup drains a delayed publication before restoring path-only rollback delivery", async () => {
  const sourceId = "55555555-5555-4555-8555-555555555555";
  const successorId = "66666666-6666-4666-8666-666666666666";
  const sourcePath = path.join(sandbox, `${sourceId}.jsonl`);
  const successorPath = path.join(sandbox, `${successorId}.jsonl`);
  const registry = new AgentRegistry(path.join(sandbox, "rollback-projection-registry.json"));
  const profile = emptyLaunchProfile({ cwd: sandbox });
  registry.reconcileConversations([{
    engine: "codex",
    path: sourcePath,
    accountId: "source",
    launchProfile: profile,
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-13T12:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(sourcePath)!;
  const structuredColumns = (endpoint: string) => ({
    kind: "codex-app-server" as const,
    endpoint,
    process: null,
    eventCursor: 0,
    protocolVersion: "fake-v1",
    writerClaimEpoch: 0,
    activeTurnRef: null,
    pendingAttention: [],
    activeFlags: [],
  });
  registry.upsert({
    key: { engine: "codex", sessionId: sourceId },
    artifactPath: sourcePath,
    cwd: sandbox,
    accountId: "source",
    launchProfile: profile,
    status: "idle",
    host: null,
    structuredHost: structuredColumns("fake:rollback-source"),
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const journal = new RuntimeJournal(path.join(sandbox, "rollback-projection-runtime.sqlite"), { structuredHosts: true });
  const journalClient = runtimeJournalClient(journal);
  let releaseDelayedPublication = () => {};
  const delayedPublicationGate = new Promise<void>((resolve) => { releaseDelayedPublication = resolve; });
  let markDelayedPublicationStarted = () => {};
  const delayedPublicationStarted = new Promise<void>((resolve) => { markDelayedPublicationStarted = resolve; });
  let markDelayedPublicationFinished = () => {};
  const delayedPublicationFinished = new Promise<void>((resolve) => { markDelayedPublicationFinished = resolve; });
  const client = {
    ...journalClient,
    append: async (event: Parameters<RuntimeHostClient["append"]>[0]) => {
      if (event.kind === "session-status" && event.payload.activeTurnId === "turn:late-successor") {
        markDelayedPublicationStarted();
        await delayedPublicationGate;
        const result = await journalClient.append(event);
        markDelayedPublicationFinished();
        return result;
      }
      return journalClient.append(event);
    },
  } as RuntimeHostClient;
  const sourceLedger = createFakeDeliveryLedger();
  await bindStructuredDeliveryQueue([{
    key: { engine: "codex", sessionId: sourceId },
    host: observableFakeHost(new FakeEngineHost(sourceLedger)),
  }], { registry, client });

  registry.commitMigrationIntent({
    engine: "codex",
    targetId: "target",
    origin: "manual",
    requestId: "rollback-successor-projection",
    expectedRevision: registry.engineRouting("codex").revision,
  });
  const revision = registry.conversation(conversation.id)!.migration!.revision;
  registry.recordConversationContinuityPath(conversation.id, successorPath);
  registry.upsert({
    key: { engine: "codex", sessionId: successorId },
    artifactPath: successorPath,
    cwd: sandbox,
    accountId: "target",
    launchProfile: profile,
    status: "idle",
    host: null,
    structuredHost: structuredColumns("fake:rollback-successor"),
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  let successorStateListener: ((state: HostState) => void) | null = null;
  const emitSuccessorState = (state: HostState) => successorStateListener?.(state);
  const successorHost = Object.assign(new FakeEngineHost(), {
    onStateChange(listener: (state: HostState) => void) {
      successorStateListener = listener;
      return () => {
        if (successorStateListener === listener) successorStateListener = null;
      };
    },
  });
  await publishStructuredDeliveryHost({
    key: { engine: "codex", sessionId: successorId },
    host: successorHost,
  });
  expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)?.artifactPath)
    .toBe(successorPath);

  emitSuccessorState({
    ...await successorHost.health(),
    status: "active",
    eventCursor: 1,
    activeTurnRef: "turn:late-successor",
  });
  await delayedPublicationStarted;

  registry.rollbackConversationMigration(conversation.id, revision);
  const cleanup = cleanupOnlyProvider().cleanup({
    operationId: "discarded-rollback-successor",
    nativeId: successorId,
    path: successorPath,
    continuityPaths: [successorPath],
    historyHash: "discarded-history",
    host: { kind: "codex-app-server", identity: successorId, epoch: 1, verifiedAt: "2026-07-13T12:01:00.000Z" },
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  releaseDelayedPublication();
  await cleanup;
  await delayedPublicationFinished;
  expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)?.artifactPath)
    .toBe(sourcePath);
  const result = await enqueueStructuredMessage({
    path: sourcePath,
    text: "continue after rollback",
    clientMessageId: "rollback-composer-message",
    hasImages: false,
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    kick: kickStructuredDeliveryQueue,
  });
  await kickStructuredDeliveryQueue();

  expect(result).toMatchObject({ ok: true, structured: true, target: conversation.id });
  expect(sourceLedger.writes).toEqual([{
    id: expect.any(String),
    text: "continue after rollback",
    expectedTurnId: null,
  }]);

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
});

test("structured successor cleanup restores a rolled-back tmux source projection", async () => {
  const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const successorId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const sourcePath = path.join(sandbox, `${sourceId}.jsonl`);
  const successorPath = path.join(sandbox, `${successorId}.jsonl`);
  const registry = new AgentRegistry(path.join(sandbox, "legacy-rollback-projection-registry.json"));
  const profile = emptyLaunchProfile({ cwd: sandbox });
  registry.reconcileConversations([{
    engine: "codex",
    path: sourcePath,
    accountId: "source",
    launchProfile: profile,
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-14T12:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(sourcePath)!;
  registry.upsert({
    key: { engine: "codex", sessionId: sourceId },
    artifactPath: sourcePath,
    cwd: sandbox,
    accountId: "source",
    launchProfile: profile,
    status: "idle",
    host: {
      kind: "tmux",
      endpoint: "tmux:legacy-source",
      server: { pid: 101, startIdentity: "server:101" },
      paneId: "%101",
      panePid: { pid: 102, startIdentity: "pane:102" },
      windowName: "legacy-source",
      agent: { pid: 103, startIdentity: "agent:103" },
      argv: ["codex", "resume", sourceId],
    },
    structuredHost: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const journal = new RuntimeJournal(path.join(sandbox, "legacy-rollback-projection-runtime.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);
  await bindStructuredDeliveryQueue([], { registry, client });

  registry.commitMigrationIntent({
    engine: "codex",
    targetId: "target",
    origin: "manual",
    requestId: "legacy-rollback-successor",
    expectedRevision: registry.engineRouting("codex").revision,
  });
  const revision = registry.conversation(conversation.id)!.migration!.revision;
  registry.recordConversationContinuityPath(conversation.id, successorPath);
  registry.upsert({
    key: { engine: "codex", sessionId: successorId },
    artifactPath: successorPath,
    cwd: sandbox,
    accountId: "target",
    launchProfile: profile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:legacy-rollback-successor",
      process: null,
      eventCursor: 0,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 0,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  await publishStructuredDeliveryHost({
    key: { engine: "codex", sessionId: successorId },
    host: observableFakeHost(new FakeEngineHost()),
  });
  expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)?.artifactPath)
    .toBe(successorPath);

  registry.rollbackConversationMigration(conversation.id, revision);
  await cleanupOnlyProvider().cleanup({
    operationId: "discarded-legacy-rollback-successor",
    nativeId: successorId,
    path: successorPath,
    continuityPaths: [successorPath],
    historyHash: "discarded-legacy-history",
    host: { kind: "codex-app-server", identity: successorId, epoch: 1, verifiedAt: "2026-07-14T12:01:00.000Z" },
  });

  expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)).toMatchObject({
    sessionKey: { engine: "codex", sessionId: sourceId },
    hostKind: "tmux-legacy",
    artifactPath: sourcePath,
  });
  const result = await enqueueStructuredMessage({
    path: sourcePath,
    text: "continue on legacy source",
    clientMessageId: "legacy-rollback-composer-message",
    hasImages: false,
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    kick: kickStructuredDeliveryQueue,
  });
  expect(result).toBeNull();

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
});

test("late discarded-successor cleanup republishes the committed retarget host", async () => {
  const sourceId = "77777777-7777-4777-8777-777777777777";
  const discardedId = "88888888-8888-4888-8888-888888888888";
  const committedId = "99999999-9999-4999-8999-999999999999";
  const sourcePath = path.join(sandbox, `${sourceId}.jsonl`);
  const discardedPath = path.join(sandbox, `${discardedId}.jsonl`);
  const committedPath = path.join(sandbox, `${committedId}.jsonl`);
  const registry = new AgentRegistry(path.join(sandbox, "retarget-projection-registry.json"));
  const profile = emptyLaunchProfile({ cwd: sandbox });
  registry.reconcileConversations([{
    engine: "codex",
    path: sourcePath,
    accountId: "source",
    launchProfile: profile,
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-13T12:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(sourcePath)!;
  const upsertHost = (sessionId: string, artifactPath: string, accountId: string, endpoint: string) => registry.upsert({
    key: { engine: "codex" as const, sessionId },
    artifactPath,
    cwd: sandbox,
    accountId,
    launchProfile: profile,
    status: "idle" as const,
    host: null,
    structuredHost: {
      kind: "codex-app-server" as const,
      endpoint,
      process: null,
      eventCursor: 0,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 0,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  upsertHost(sourceId, sourcePath, "source", "fake:retarget-source");
  const journal = new RuntimeJournal(path.join(sandbox, "retarget-projection-runtime.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);
  await bindStructuredDeliveryQueue([{
    key: { engine: "codex", sessionId: sourceId },
    host: observableFakeHost(new FakeEngineHost()),
  }], { registry, client });

  registry.commitMigrationIntent({
    engine: "codex",
    targetId: "committed",
    origin: "manual",
    requestId: "retarget-projection",
    expectedRevision: registry.engineRouting("codex").revision,
  });
  let migrating = registry.conversation(conversation.id)!;
  const revision = migrating.migration!.revision;
  migrating = registry.transitionConversationMigration(migrating.id, revision, ["requested"], { phase: "preparing" });
  migrating = registry.transitionConversationMigration(migrating.id, revision, ["preparing"], { phase: "successor-starting" });
  registry.recordConversationContinuityPath(conversation.id, discardedPath);
  registry.recordConversationContinuityPath(conversation.id, committedPath);
  upsertHost(discardedId, discardedPath, "discarded", "fake:retarget-discarded");
  upsertHost(committedId, committedPath, "committed", "fake:retarget-committed");
  const committedLedger = createFakeDeliveryLedger();
  const unregisterCommitted = await publishStructuredDeliveryHost({
    key: { engine: "codex", sessionId: committedId },
    host: observableFakeHost(new FakeEngineHost(committedLedger)),
  });
  await publishStructuredDeliveryHost({
    key: { engine: "codex", sessionId: discardedId },
    host: observableFakeHost(new FakeEngineHost()),
  });
  expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)?.artifactPath)
    .toBe(discardedPath);

  const receipt: ProviderReceipt = {
    operationId: migrating.migration!.operationId,
    nativeId: committedId,
    path: committedPath,
    continuityPaths: [committedPath],
    historyHash: "retarget-history",
    host: { kind: "codex-app-server", identity: committedId, epoch: 1, verifiedAt: "2026-07-13T12:02:00.000Z" },
  };
  registry.transitionConversationMigration(conversation.id, revision, ["successor-starting"], {
    phase: "verifying",
    providerReceipt: receipt,
  });
  registry.commitSuccessor(conversation.id, {
    id: committedId,
    path: committedPath,
    accountId: "committed",
    launchProfile: profile,
    historyHash: receipt.historyHash,
    host: receipt.host,
  }, revision);
  await cleanupOnlyProvider().cleanup({
    operationId: "discarded-retarget-successor",
    nativeId: discardedId,
    path: discardedPath,
    continuityPaths: [discardedPath],
    historyHash: "discarded-retarget-history",
    host: { kind: "codex-app-server", identity: discardedId, epoch: 1, verifiedAt: "2026-07-13T12:01:00.000Z" },
  });

  const result = await enqueueStructuredMessage({
    path: committedPath,
    text: "continue after retarget",
    clientMessageId: "retarget-composer-message",
    hasImages: false,
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    kick: kickStructuredDeliveryQueue,
  });
  await kickStructuredDeliveryQueue();

  expect(result).toMatchObject({ ok: true, structured: true, target: conversation.id });
  expect(committedLedger.writes).toEqual([{
    id: expect.any(String),
    text: "continue after retarget",
    expectedTurnId: null,
  }]);

  await unregisterCommitted();
  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
});
