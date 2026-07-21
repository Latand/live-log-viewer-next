import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";
import { drainHeldDeliveries, reconcileMigrations } from "@/lib/accounts/migration/coordinator";
import { emptyLaunchProfile, type ProviderReceipt, type SuccessorProviderPort } from "@/lib/accounts/migration/contracts";
import { RegisteredSuccessorProvider } from "@/lib/accounts/migration/provider";
import { RuntimeJournal } from "@/runtime-host/journal";

import type { RuntimeHostClient } from "./client";
import type { EngineHost, HostState, QueueEntry, RuntimeEvent } from "./engineHost";
import { FakeEngineHost, createFakeDeliveryLedger } from "./fixtures/fakeEngineHost";
import { bindStructuredDeliveryQueue, hasStructuredDeliveryHost, publishStructuredDeliveryHost, republishStructuredDeliveryHost } from "./structuredDeliveryController";
import { StructuredDeliveryQueue, type StructuredDeliveryQueuePort } from "./structuredDeliveryQueue";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { deliverHeldStructuredMessage, enqueueStructuredMessage } from "./structuredMessageDelivery";
import { structuredContentDigest } from "./structuredContent";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-delivery-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function journalPort(journal: RuntimeJournal, failDelivered = false): StructuredDeliveryQueuePort {
  return {
    effects: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transition: async (operationId, status, details) => {
      if (failDelivered && status === "delivered") throw new Error("runtime stopped before confirmation commit");
      journal.transitionOperation(operationId, status, details);
    },
  };
}

function observableFakeHost(host: FakeEngineHost): FakeEngineHost & { onStateChange(): () => void } {
  return Object.assign(host, { onStateChange: () => () => {} });
}

function statefulObservableFakeHost(
  initialState: HostState,
  ledger = createFakeDeliveryLedger(),
): {
  host: FakeEngineHost & { onStateChange(listener: (state: HostState) => void): () => void };
  setState(next: HostState): void;
} {
  let state = structuredClone(initialState);
  const listeners = new Set<(state: HostState) => void>();
  const host = Object.assign(new FakeEngineHost(ledger), {
    health: async () => structuredClone(state),
    onStateChange(listener: (next: HostState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  return {
    host,
    setState(next) {
      state = structuredClone(next);
      for (const listener of listeners) listener(structuredClone(state));
    },
  };
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
    events: async (afterEventSeq) => journal.replay(afterEventSeq),
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
  let snapshotCalls = 0;
  let deltaProjections = 0;
  let sessionStatusProjections = 0;
  const client = {
    snapshot: async () => {
      snapshotCalls += 1;
      return { filesRevision: 0 };
    },
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
    const baselineSnapshots = snapshotCalls;
    const baselineStatuses = sessionStatusProjections;

    for (let index = 18; index <= 57; index += 1) {
      burst.emit({ kind: "delta", turnId: "turn:burst", text: `delta ${index}`, seq: index });
    }

    await waitForCondition(() => deltaProjections === 40);
    await Bun.sleep(50);
    expect(deltaProjections).toBe(40);
    expect(sessionStatusProjections - baselineStatuses).toBeLessThanOrEqual(1);
    expect(effectBatchCalls - baselineEffects).toBeLessThanOrEqual(1);
    expect(snapshotCalls - baselineSnapshots).toBeLessThanOrEqual(1);
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null });
  }
});

test("the controller republishes a live host into a restarted runtime journal", async () => {
  const directory = path.join(sandbox, "controller-runtime-restart");
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "8f25d04a-8f94-\x344bb-a6f2-bf987f2ded41";
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  const profile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: "claude",
    path: artifactPath,
    accountId: "runtime-restart-account",
    launchProfile: profile,
    turn: { state: "idle", source: "assistant", terminalAt: null },
    observedAt: "2026-07-17T20:40:00.000Z",
  }]);
  const conversation = registry.conversationForPath(artifactPath)!;
  const key = { engine: "claude" as const, sessionId };
  registry.upsert({
    key,
    artifactPath,
    cwd: directory,
    accountId: "runtime-restart-account",
    launchProfile: profile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "claude-broker",
      endpoint: "fake:runtime-restart-host",
      process: null,
      eventCursor: 7,
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
  let journal = new RuntimeJournal(path.join(directory, "runtime-before.sqlite"), { structuredHosts: true });
  const client = {
    snapshot: async () => journal.snapshot(),
    append: async (event: Parameters<RuntimeHostClient["append"]>[0]) => journal.append(event),
    command: async (command: Parameters<RuntimeHostClient["command"]>[0]) => journal.executeOperation(command),
    operationStatus: async (operationId: string) => journal.operationResult(operationId),
    producerCursor: async (producerKind: string, eventKeyPrefix: string) => journal.producerCursor(producerKind, eventKeyPrefix),
    effectBatch: async (kinds?: readonly string[], afterEventSeq?: number) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId: string, status: Parameters<RuntimeHostClient["transitionOperation"]>[1], details?: Parameters<RuntimeHostClient["transitionOperation"]>[2]) => journal.transitionOperation(operationId, status, details),
  } as RuntimeHostClient;
  const host = observableFakeHost(new FakeEngineHost(createFakeDeliveryLedger()));

  try {
    await bindStructuredDeliveryQueue([{ key, host }], { registry, client });
    expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)?.host).toBe("hosted");

    /* A route bundle can have a different realm global from instrumentation.
       Removing the realm-local legacy slot must leave the process controller
       available to the route-side publication API. */
    delete (globalThis as typeof globalThis & { __llvStructuredDeliveryController?: unknown })
      .__llvStructuredDeliveryController;
    expect(await republishStructuredDeliveryHost(key)).toBeTrue();

    journal.close();
    journal = new RuntimeJournal(path.join(directory, "runtime-after.sqlite"), { structuredHosts: true });
    expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)).toBeUndefined();

    expect(await republishStructuredDeliveryHost(key)).toBeTrue();
    expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)).toMatchObject({
      host: "hosted",
      hostKind: "claude-broker",
      sessionKey: key,
    });
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null });
    journal.close();
  }
});

test("a queued hosted send survives restart without an adopted host through one successor turn", async () => {
  const directory = path.join(sandbox, "host-death-queued-send-recovery");
  let registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "45345345-3453-\x34453-8453-453453453453";
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  const profile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "host-death-account",
    launchProfile: profile,
    turn: { state: "busy", source: "assistant", terminalAt: null },
    observedAt: "2026-07-19T12:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(artifactPath)!;
  const key = { engine: "codex" as const, sessionId };
  const structuredHost = {
    kind: "codex-app-server" as const,
    endpoint: "fake:host-before-death",
    process: null,
    eventCursor: 0,
    protocolVersion: "fake-v1",
    writerClaimEpoch: 0,
    activeTurnRef: "turn:blocking",
    pendingAttention: [],
    activeFlags: [],
  };
  registry.upsert({
    key,
    artifactPath,
    cwd: directory,
    accountId: "host-death-account",
    launchProfile: profile,
    status: "live",
    host: null,
    structuredHost,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const runtimeFilename = path.join(directory, "runtime.sqlite");
  let journal = new RuntimeJournal(runtimeFilename, { structuredHosts: true });
  const projections: string[] = [];
  const clientFor = (target: RuntimeJournal): RuntimeHostClient => {
    const base = runtimeJournalClient(target);
    return {
      ...base,
      append: async (event) => {
        if (event.kind === "session-status" && typeof event.payload.host === "string") {
          projections.push(event.payload.host);
        }
        return await base.append(event);
      },
    };
  };
  let client = clientFor(journal);
  const predecessorLedger = createFakeDeliveryLedger();
  const predecessor = statefulObservableFakeHost({
    status: "active",
    sessionKey: sessionId,
    endpoint: structuredHost.endpoint,
    pid: 45_300,
    processStartIdentity: "fake:predecessor",
    eventCursor: 0,
    protocolVersion: "fake-v1",
    activeTurnRef: "turn:blocking",
    pendingAttention: [],
    activeFlags: [],
    account: null,
  }, predecessorLedger);
  const successorLedger = createFakeDeliveryLedger();
  const successor = statefulObservableFakeHost({
    status: "idle",
    sessionKey: sessionId,
    endpoint: "fake:host-after-death",
    pid: 45_301,
    processStartIdentity: "fake:successor",
    eventCursor: 0,
    protocolVersion: "fake-v1",
    activeTurnRef: null,
    pendingAttention: [],
    activeFlags: [],
    account: null,
  }, successorLedger);
  const request = {
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "host-death-idempotency-key",
    operationId: "operation-admitted-before-host-death",
    kind: "send" as const,
    policy: "queue" as const,
    turnId: null,
    text: "deliver this durable queue head once",
    hasImages: false,
  };
  let recoveryCalls = 0;
  const recover = async (recoveryRequest: { conversationId?: string | null }) => {
    recoveryCalls += 1;
    expect(recoveryRequest.conversationId).toBe(conversation.id);
    expect(projections.at(-1)).toBe("dead");
    expect(journal.operationResult(request.operationId)?.receipt).toMatchObject({
      operationId: request.operationId,
      idempotencyKey: request.clientMessageId,
      status: "queued",
    });
    registry.setStructuredHost(key, {
      ...structuredHost,
      endpoint: "fake:host-after-death",
      activeTurnRef: null,
    }, "idle");
    await publishStructuredDeliveryHost({ key, host: successor.host });
    return {
      target: null,
      path: artifactPath,
      conversationId: conversation.id,
      spawned: true,
    } as const;
  };

  try {
    await bindStructuredDeliveryQueue([{ key, host: predecessor.host }], { registry, client, recover });
    const admitted = await enqueueStructuredMessage(request, {
      enabled: () => true,
      client: () => client,
      registry: () => registry,
      kick: () => {},
    });
    expect(admitted).toMatchObject({
      ok: true,
      structured: true,
      outcome: "queued",
      operationId: request.operationId,
      receipt: {
        operationId: request.operationId,
        idempotencyKey: request.clientMessageId,
        status: "queued",
      },
    });
    expect(predecessorLedger.writes).toEqual([]);

    registry.setStructuredHost(key, {
      ...structuredHost,
      endpoint: "fake:released-predecessor",
      activeTurnRef: null,
    }, "dead");
    await client.append({
      scope: { type: "session", id: conversation.id },
      kind: "session-status",
      payload: {
        conversationId: conversation.id,
        sessionKey: key,
        hostKind: "codex-app-server",
        host: "dead",
        turn: "unknown",
        provenance: "structured",
        artifactPath,
        capabilities: { steer: true, structuredAttention: true },
      },
    });
    await bindStructuredDeliveryQueue([], { registry, client: null });
    journal.close();
    registry = new AgentRegistry(registry.filename);
    journal = new RuntimeJournal(runtimeFilename, { structuredHosts: true });
    client = clientFor(journal);

    await bindStructuredDeliveryQueue([], { registry, client, recover });

    await waitForCondition(() => journal.operationResult(request.operationId)?.receipt.status === "delivered");
    expect(recoveryCalls).toBe(1);
    expect(projections[0]).toBe("hosted");
    expect(projections).toContain("dead");
    expect(projections.at(-1)).toBe("hosted");
    expect(predecessorLedger.writes).toEqual([]);
    expect(successorLedger.writes).toEqual([expect.objectContaining({
      id: request.operationId,
      text: request.text,
      expectedTurnId: request.turnId,
    })]);
    expect(journal.operationResult(request.operationId)?.receipt).toMatchObject({
      operationId: request.operationId,
      idempotencyKey: request.clientMessageId,
      status: "delivered",
      turnId: `turn:${request.operationId}`,
    });
    expect(registry.snapshot().deliveryOperationOwners[request.operationId]).toMatchObject({
      conversationId: conversation.id,
      terminalState: "delivered",
    });

    await bindStructuredDeliveryQueue([], { registry, client: null });
    journal.close();
    const replayRegistry = new AgentRegistry(registry.filename);
    journal = new RuntimeJournal(runtimeFilename, { structuredHosts: true });
    client = clientFor(journal);
    await bindStructuredDeliveryQueue([{ key, host: successor.host }], {
      registry: replayRegistry,
      client,
      recover,
    });
    await kickStructuredDeliveryQueue();
    expect(await enqueueStructuredMessage(request, {
      enabled: () => true,
      client: () => client,
      registry: () => replayRegistry,
      kick: () => {},
    })).toMatchObject({
      ok: true,
      structured: true,
      outcome: "delivered",
      operationId: request.operationId,
      receipt: { status: "delivered" },
    });
    expect(recoveryCalls).toBe(1);
    expect(successorLedger.writes).toHaveLength(1);
    expect(journal.effectBatch()).toEqual([]);
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null });
    journal.close();
  }
});

test("a declined startup recovery fails the absent-host queue head for explicit retry", async () => {
  const directory = path.join(sandbox, "declined-startup-recovery");
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "45345345-3453-\x34453-8453-453453453454";
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  const profile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "declined-recovery-account",
    launchProfile: profile,
    turn: { state: "busy", source: "assistant", terminalAt: null },
    observedAt: "2026-07-19T12:01:00.000Z",
  }]);
  const conversation = registry.conversationForPath(artifactPath)!;
  const key = { engine: "codex" as const, sessionId };
  registry.upsert({
    key,
    artifactPath,
    cwd: directory,
    accountId: "declined-recovery-account",
    launchProfile: profile,
    status: "dead",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:declined-recovery",
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
  const operationId = "operation-declined-startup-recovery";
  const idempotencyKey = "declined-startup-recovery-key";
  const text = "keep the declined recovery retryable";
  const held = registry.holdDelivery(
    conversation.id,
    text,
    idempotencyKey,
    "text",
    [],
    structuredContentDigest({ text, images: [] }),
    { operationId, kind: "send", policy: "queue", turnId: null },
  );
  registry.beginDeliveryAttempt(held.id, held.generationId!);
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: key,
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "running",
      provenance: "structured",
      artifactPath,
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.executeOperation({
    kind: "send",
    operationId,
    idempotencyKey,
    conversationId: conversation.id,
    text,
    policy: "queue",
  });
  journal.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: key,
      hostKind: "codex-app-server",
      host: "dead",
      turn: "unknown",
      provenance: "structured",
      artifactPath,
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  let recoveryCalls = 0;

  try {
    await bindStructuredDeliveryQueue([], {
      registry,
      client: runtimeJournalClient(journal),
      recover: async (request) => {
        recoveryCalls += 1;
        expect(request).toMatchObject({ path: artifactPath, conversationId: conversation.id });
        return { target: null, path: artifactPath, conversationId: conversation.id, spawned: false };
      },
    });

    expect(recoveryCalls).toBe(1);
    expect(journal.operationResult(operationId)?.receipt).toMatchObject({
      operationId,
      idempotencyKey,
      status: "failed",
      reason: "structured host recovery did not start; retry the operation",
    });
    expect(registry.snapshot().heldDeliveries[held.id]).toMatchObject({
      state: "failed",
      error: "structured host recovery did not start; retry the operation",
    });
    journal.append({
      scope: { type: "session", id: conversation.id },
      kind: "session-status",
      payload: {
        conversationId: conversation.id,
        sessionKey: key,
        hostKind: "codex-app-server",
        host: "hosted",
        turn: "idle",
        provenance: "structured",
        artifactPath,
        capabilities: { steer: true, structuredAttention: true },
      },
    });
    const retry = journal.retryOperation(operationId, "declined-startup-recovery-retry-key");
    expect(retry.receipt).toMatchObject({
      status: "queued",
      retryOfOperationId: operationId,
    });
    expect(journal.effectBatch()).toHaveLength(1);
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null });
    journal.close();
  }
});

test("a failed dead-host recovery terminalizes the durable head for explicit retry", async () => {
  const filename = path.join(sandbox, "failed-dead-host-recovery.sqlite");
  const journal = new RuntimeJournal(filename, { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: "conversation-recovery-failure" },
    kind: "session-status",
    payload: {
      conversationId: "conversation-recovery-failure",
      sessionKey: { engine: "codex", sessionId: "recovery-failure-session" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      artifactPath: "/sessions/recovery-failure.jsonl",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.executeOperation({
    kind: "send",
    operationId: "operation-recovery-failure",
    idempotencyKey: "recovery-failure-key",
    conversationId: "conversation-recovery-failure",
    text: "keep this retryable",
    policy: "queue",
  });
  const deadHost = new FakeEngineHost();
  deadHost.health = async () => ({
    status: "dead",
    sessionKey: "recovery-failure-session",
    endpoint: "fake:dead-host",
    pid: null,
    processStartIdentity: null,
    eventCursor: 0,
    protocolVersion: "fake-v1",
    activeTurnRef: null,
    pendingAttention: [],
    activeFlags: [],
    account: null,
  });
  const queue = new StructuredDeliveryQueue(
    journalPort(journal),
    () => deadHost,
    undefined,
    undefined,
    async () => { throw new Error("successor admission unavailable"); },
  );

  try {
    await queue.drain();
    expect(journal.operationResult("operation-recovery-failure")?.receipt).toMatchObject({
      operationId: "operation-recovery-failure",
      idempotencyKey: "recovery-failure-key",
      status: "failed",
      reason: "structured host recovery failed: successor admission unavailable",
    });
    const retry = journal.retryOperation("operation-recovery-failure", "recovery-failure-retry-key");
    expect(retry.receipt).toMatchObject({
      status: "queued",
      retryOfOperationId: "operation-recovery-failure",
    });
    expect(journal.effectBatch()).toHaveLength(1);
  } finally {
    journal.close();
  }
});

test("a failed route kick retries queued controls and messages without a host-state notification", async () => {
  const directory = path.join(sandbox, "controller-route-kick-retry");
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "c012d11e-1854-\x34157-aede-75eae7bde18c";
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

test("a kill cancels an automatic delivery retry and fails the send retryably", async () => {
  const directory = path.join(sandbox, "controller-kill-cancels-auto-retry");
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "e40306b9-a4df-\x347b3-bf6e-4570c44259c7";
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
  const conversationId = Object.keys(registry.snapshot().conversations)[0]! as `conversation_${string}`;
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
  const successorLedger = createFakeDeliveryLedger();
  const successor = observableFakeHost(new FakeEngineHost(successorLedger));
  let recoveryCalls = 0;
  const recover = async (request: { conversationId?: string | null }) => {
    recoveryCalls += 1;
    expect(request.conversationId).toBe(conversationId);
    registry.setStructuredHost(key, {
      kind: "codex-app-server",
      endpoint: "fake:revived-after-kill",
      process: null,
      eventCursor: 0,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    }, "idle");
    await publishStructuredDeliveryHost({ key, host: successor });
    return { target: null, path: artifactPath, conversationId, spawned: true } as const;
  };

  try {
    await bindStructuredDeliveryQueue([{ key, host }], { registry, client, recover });
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
    expect(recoveryCalls).toBe(0);
    expect(successorLedger.writes).toEqual([]);
    expect(effectBatchCalls).toBe(effectBatchCallsAfterKill);
    expect(journal.operationResult(killOperationId)?.receipt).toMatchObject({
      kind: "kill",
      status: "delivered",
      reason: null,
    });
    expect(journal.operationResult(sendOperationId)?.receipt).toMatchObject({
      kind: "send",
      status: "failed",
      reason: "structured host was intentionally terminated; retry the operation",
    });
    expect(journal.effectBatch(100, ["runtime.kill"], 0)).toEqual([]);
    expect(journal.effectBatch(100, ["runtime.send"], 0)).toEqual([]);
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
  const sessionId = "b6b55ea7-4a5e-\x34fe5-894d-2f332a7247c7";
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
  expect(ledger.writes).toMatchObject([{ id: "operation-one", text: "hello", expectedTurnId: null }]);
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
  expect(ledger.writes).toMatchObject([{ id: "operation-one", text: "hello", expectedTurnId: null }]);
  reopenedJournal.close();
});

test("an applying reconfigure recovers before its queued message after journal restart", async () => {
  const filename = path.join(sandbox, "reconfigure-restart.sqlite");
  const firstJournal = new RuntimeJournal(filename, { structuredHosts: true });
  firstJournal.append({
    scope: { type: "session", id: "conversation-reconfigure-restart" },
    kind: "session-status",
    payload: {
      conversationId: "conversation-reconfigure-restart",
      sessionKey: { engine: "codex", sessionId: "session-reconfigure-restart" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      artifactPath: "/sessions/reconfigure-restart.jsonl",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  firstJournal.executeOperation({
    kind: "reconfigure",
    operationId: "reconfigure-before-crash",
    idempotencyKey: "reconfigure-before-crash",
    conversationId: "conversation-reconfigure-restart",
    model: "gpt-5.6-sol",
    effort: "high",
    fast: true,
    previousProfile: { model: null, effort: null, fast: null },
  });
  firstJournal.executeOperation({
    kind: "send",
    operationId: "message-after-reconfigure-crash",
    idempotencyKey: "message-after-reconfigure-crash",
    conversationId: "conversation-reconfigure-restart",
    text: "continue after recovery",
    policy: "queue",
  });
  firstJournal.transitionOperation("reconfigure-before-crash", "applying");
  firstJournal.close();

  const reopenedJournal = new RuntimeJournal(filename, { structuredHosts: true });
  const ledger = createFakeDeliveryLedger();
  const recoveredHost = new FakeEngineHost(ledger);
  let recovered = false;
  const actions: string[] = [];
  const queue = new StructuredDeliveryQueue(
    journalPort(reopenedJournal),
    () => recovered ? recoveredHost : null,
    undefined,
    undefined,
    undefined,
    async (effect, ownership) => {
      expect(await ownership.isCurrent()).toBeTrue();
      actions.push(`reconfigure:${effect.operationId}`);
      recovered = true;
    },
  );
  await queue.drain();

  expect(actions).toEqual(["reconfigure:reconfigure-before-crash"]);
  expect(ledger.writes.map((entry) => entry.id)).toEqual(["message-after-reconfigure-crash"]);
  expect(reopenedJournal.operationResult("reconfigure-before-crash")?.receipt.status).toBe("applied");
  expect(reopenedJournal.operationResult("message-after-reconfigure-crash")?.receipt.status).toBe("delivered");
  expect(reopenedJournal.snapshot().sessions[0]?.pendingReconfigure).toBeNull();
  reopenedJournal.close();
});

test("repeated terminal retry clicks produce one replacement engine write", async () => {
  const filename = path.join(sandbox, "terminal-retry-clicks.sqlite");
  const sessionId = "12121212-1212-\x34212-8212-121212121212";
  const artifactPath = path.join(sandbox, `${sessionId}.jsonl`);
  const registry = new AgentRegistry(path.join(sandbox, "terminal-retry-registry.json"));
  const profile = emptyLaunchProfile({ cwd: sandbox });
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "default",
    launchProfile: profile,
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-17T19:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(artifactPath)!;
  registry.upsert({
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd: sandbox,
    accountId: "default",
    launchProfile: profile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:terminal-retry",
      process: null,
      eventCursor: 0,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: null,
    pendingAction: null,
  });
  const held = registry.holdDelivery(
    conversation.id,
    "deliver this once",
    "message-terminal-original",
    "text",
    [],
    structuredContentDigest({ text: "deliver this once", images: [] }),
    { operationId: "operation-terminal-original", kind: "send", policy: "queue" },
  );
  registry.beginDeliveryAttempt(held.id, held.generationId!);
  registry.recordDeliveryOutcome(held.id, "failed", "dead-host");
  const journal = new RuntimeJournal(filename, { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: { engine: "codex", sessionId },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      artifactPath,
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.executeOperation({
    kind: "send",
    operationId: "operation-terminal-original",
    idempotencyKey: "message-terminal-original",
    conversationId: conversation.id,
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
  await bindStructuredDeliveryQueue([{
    key: { engine: "codex", sessionId },
    host: observableFakeHost(new FakeEngineHost(ledger)),
  }], { registry, client: runtimeJournalClient(journal) });
  await kickStructuredDeliveryQueue();

  expect(ledger.writes).toMatchObject([{
    id: replacement.operationId,
    text: "deliver this once",
    expectedTurnId: null,
  }]);
  expect(journal.operationResult(replacement.operationId)?.receipt).toMatchObject({
    status: "delivered",
    retryOfOperationId: "operation-terminal-original",
  });
  expect(registry.snapshot().heldDeliveries[held.id]).toMatchObject({ state: "delivered", text: "" });
  await bindStructuredDeliveryQueue([], { registry, client: null });
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

test("a successful kill beyond one effect page fences older sends through compaction and repeated restart", async () => {
  const filename = path.join(sandbox, "durable-kill-boundary.sqlite");
  const conversationId = "conversation-durable-kill";
  const sessionKey = { engine: "codex" as const, sessionId: "session-durable-kill" };
  let journal = new RuntimeJournal(filename, { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: conversationId },
    kind: "session-status",
    payload: {
      conversationId,
      sessionKey,
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      artifactPath: "/sessions/durable-kill.jsonl",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  const sendOperationIds = Array.from({ length: 101 }, (_, index) => `operation-stale-${index}`);
  for (const [index, operationId] of sendOperationIds.entries()) {
    journal.executeOperation({
      kind: "send",
      operationId,
      idempotencyKey: `message-stale-${index}`,
      conversationId,
      text: `stale message ${index}`,
      policy: "queue",
    });
  }
  for (let index = 0; index < 40; index += 1) {
    journal.append({
      scope: { type: "system", id: "durable-kill-history-padding" },
      kind: "test.padding",
      producer: { kind: "integration-test", eventKey: `durable-kill-padding:${index}` },
      payload: { index },
    });
  }
  const killOperationId = "operation-durable-kill";
  journal.executeOperation({
    kind: "kill",
    operationId: killOperationId,
    idempotencyKey: killOperationId,
    conversationId,
    sessionKey,
  });

  const ledger = createFakeDeliveryLedger();
  const host = new FakeEngineHost(ledger);
  let terminated = false;
  let recoveryCalls = 0;
  let crashesRemaining = 2;
  const queue = () => new StructuredDeliveryQueue({
    effects: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transition: async (operationId, status, details) => {
      journal.transitionOperation(operationId, status, details);
      if (status === "failed" && operationId.startsWith("operation-stale-") && crashesRemaining > 0) {
        crashesRemaining -= 1;
        throw new Error("runtime crashed after kill settlement");
      }
    },
  } as StructuredDeliveryQueuePort, () => terminated ? null : host, async () => {
    terminated = true;
    return true;
  }, () => {}, async () => {
    recoveryCalls += 1;
    return false;
  });

  await expect(queue().drain()).rejects.toThrow("runtime crashed after kill settlement");
  expect(journal.operationResult(killOperationId)?.receipt.status).toBe("delivered");
  journal.compact(2);
  journal.close();

  journal = new RuntimeJournal(filename, { structuredHosts: true });
  await expect(queue().drain()).rejects.toThrow("runtime crashed after kill settlement");
  journal.close();

  journal = new RuntimeJournal(filename, { structuredHosts: true });
  await queue().drain();

  expect(recoveryCalls).toBe(0);
  expect(ledger.writes).toEqual([]);
  for (const operationId of sendOperationIds) {
    expect(journal.operationResult(operationId)?.receipt).toMatchObject({
      status: "failed",
      reason: "structured host was intentionally terminated; retry the operation",
    });
  }
  expect(journal.effectBatch()).toEqual([]);
  journal.close();
});

test("a retry admitted during kill drain starts one successor turn after compaction and restart", async () => {
  const filename = path.join(sandbox, "post-kill-retry.sqlite");
  const conversationId = "conversation-post-kill-retry";
  const sessionKey = { engine: "codex" as const, sessionId: "session-post-kill-retry" };
  let journal = new RuntimeJournal(filename, { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: conversationId },
    kind: "session-status",
    payload: {
      conversationId,
      sessionKey,
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      artifactPath: "/sessions/post-kill-retry.jsonl",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  const originalOperationId = "operation-before-kill";
  journal.executeOperation({
    kind: "send",
    operationId: originalOperationId,
    idempotencyKey: "message-before-kill",
    conversationId,
    text: "deliver on the successor",
    policy: "queue",
  });
  const killOperationId = "operation-kill-before-retry";
  journal.executeOperation({
    kind: "kill",
    operationId: killOperationId,
    idempotencyKey: killOperationId,
    conversationId,
    sessionKey,
  });

  const staleLedger = createFakeDeliveryLedger();
  const successorLedger = createFakeDeliveryLedger();
  const successorHost = new FakeEngineHost(successorLedger);
  let currentHost: EngineHost | null = new FakeEngineHost(staleLedger);
  let recoveryCalls = 0;
  let crashAfterStaleFence = true;
  let staleFenceCommitted!: () => void;
  let releaseCrash!: () => void;
  const staleFence = new Promise<void>((resolve) => { staleFenceCommitted = resolve; });
  const crashGate = new Promise<void>((resolve) => { releaseCrash = resolve; });
  const queue = () => new StructuredDeliveryQueue({
    effects: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transition: async (operationId, status, details) => {
      journal.transitionOperation(operationId, status, details);
      if (crashAfterStaleFence && operationId === originalOperationId && status === "failed") {
        staleFenceCommitted();
        await crashGate;
        throw new Error("runtime crashed with a retry kick pending");
      }
    },
  }, () => currentHost, async () => {
    currentHost = null;
    return true;
  }, () => {}, async () => {
    recoveryCalls += 1;
    return false;
  });

  const activeQueue = queue();
  const drain = activeQueue.drain();
  await staleFence;
  currentHost = successorHost;
  journal.append({
    scope: { type: "session", id: conversationId },
    kind: "session-status",
    payload: {
      conversationId,
      sessionKey,
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      artifactPath: "/sessions/post-kill-retry.jsonl",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  const replacement = journal.retryOperation(originalOperationId, "message-after-kill");
  const replayed = journal.retryOperation(originalOperationId, "message-after-kill-replay");
  const kicked = activeQueue.drain();
  expect(replayed).toMatchObject({ operationId: replacement.operationId, replayed: true });
  releaseCrash();
  await expect(drain).rejects.toThrow("runtime crashed with a retry kick pending");
  await expect(kicked).rejects.toThrow("runtime crashed with a retry kick pending");
  journal.compact(2);
  journal.close();

  crashAfterStaleFence = false;
  journal = new RuntimeJournal(filename, { structuredHosts: true });
  const restartedQueue = queue();
  await restartedQueue.drain();
  await restartedQueue.drain();

  expect(recoveryCalls).toBe(0);
  expect(staleLedger.writes).toEqual([]);
  expect(successorLedger.writes).toEqual([
    expect.objectContaining({ id: replacement.operationId, text: "deliver on the successor" }),
  ]);
  expect(journal.operationResult(replacement.operationId)?.receipt).toMatchObject({
    status: "delivered",
    turnId: `turn:${replacement.operationId}`,
    retryOfOperationId: originalOperationId,
  });
  expect(journal.effectBatch()).toEqual([]);
  journal.close();
});

test("a failed kill creates no durable boundary across compaction and restart", async () => {
  const filename = path.join(sandbox, "failed-kill-boundary.sqlite");
  const conversationId = "conversation-failed-kill-boundary";
  const sessionKey = { engine: "codex" as const, sessionId: "session-failed-kill-boundary" };
  let journal = new RuntimeJournal(filename, { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: conversationId },
    kind: "session-status",
    payload: {
      conversationId,
      sessionKey,
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      artifactPath: "/sessions/failed-kill-boundary.jsonl",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  const sendOperationId = "operation-survives-failed-kill";
  journal.executeOperation({
    kind: "send",
    operationId: sendOperationId,
    idempotencyKey: sendOperationId,
    conversationId,
    text: "deliver after failed kill",
    policy: "queue",
  });
  const killOperationId = "operation-failed-kill-boundary";
  journal.executeOperation({
    kind: "kill",
    operationId: killOperationId,
    idempotencyKey: killOperationId,
    conversationId,
    sessionKey,
  });

  const ledger = createFakeDeliveryLedger();
  const host = new FakeEngineHost(ledger);
  let crashAfterFailedKill = true;
  let recoveryCalls = 0;
  const queue = () => new StructuredDeliveryQueue({
    effects: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transition: async (operationId, status, details) => {
      journal.transitionOperation(operationId, status, details);
      if (crashAfterFailedKill && operationId === killOperationId && status === "failed") {
        throw new Error("runtime crashed after failed kill");
      }
    },
  }, () => host, async () => false, () => {}, async () => {
    recoveryCalls += 1;
    return false;
  });

  await expect(queue().drain()).rejects.toThrow();
  expect(journal.operationResult(killOperationId)?.receipt.status).toBe("failed");
  expect(journal.operationResult(sendOperationId)?.receipt.status).toBe("queued");
  journal.compact(2);
  journal.close();

  crashAfterFailedKill = false;
  journal = new RuntimeJournal(filename, { structuredHosts: true });
  await queue().drain();

  expect(recoveryCalls).toBe(0);
  expect(ledger.writes).toEqual([
    expect.objectContaining({ id: sendOperationId, text: "deliver after failed kill" }),
  ]);
  expect(journal.operationResult(sendOperationId)?.receipt).toMatchObject({
    status: "delivered",
    turnId: `turn:${sendOperationId}`,
  });
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

test("runtime recovery drains one durable synchronization hold into one engine command", async () => {
  const sessionId = "aaaaaaaa-aaaa-\x34aaa-8aaa-aaaaaaaaaaaa";
  const directory = path.join(sandbox, "runtime-synchronization-hold");
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "default",
    launchProfile: profile,
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-16T20:07:01.000Z",
  }]);
  const conversation = registry.conversationForPath(artifactPath)!;
  registry.upsert({
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd: directory,
    accountId: "default",
    launchProfile: profile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:runtime-before-restart",
      process: null,
      eventCursor: 42,
      protocolVersion: "v2",
      writerClaimEpoch: 5,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 5,
    claimOwner: null,
    pendingAction: null,
  });
  const request = {
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "runtime-sync-held-message",
    operationId: "operation-runtime-sync-held-message",
    kind: "send" as const,
    policy: "queue" as const,
    turnId: null,
    text: "deliver exactly once after runtime recovery",
    hasImages: false,
  };
  let requestedDrains = 0;

  const first = await enqueueStructuredMessage(request, {
    enabled: () => true,
    client: () => null,
    registry: () => registry,
    requestMigrationTick: () => { requestedDrains += 1; },
  });
  const refreshedRegistry = new AgentRegistry(registry.filename);
  const duplicate = await enqueueStructuredMessage(request, {
    enabled: () => true,
    client: () => null,
    registry: () => refreshedRegistry,
    requestMigrationTick: () => { requestedDrains += 1; },
  });
  const held = Object.values(registry.snapshot().heldDeliveries)
    .filter((delivery) => delivery.clientMessageId === request.clientMessageId);

  expect(first).toMatchObject({ ok: true, structured: true, outcome: "held" });
  expect(duplicate).toMatchObject({ ok: true, structured: true, outcome: "held" });
  expect(requestedDrains).toBe(2);
  expect(held).toMatchObject([{
    text: request.text,
    command: {
      operationId: request.operationId,
      kind: request.kind,
      policy: request.policy,
      turnId: request.turnId,
    },
    requestDigest: expect.any(String),
    state: "assigned",
    generationId: sessionId,
  }]);

  await drainHeldDeliveries(conversation.id, {
    async deliver({ delivery, path: deliveryPath, clientMessageId }) {
      return await deliverHeldStructuredMessage({
        conversationId: conversation.id,
        path: deliveryPath,
        deliveryId: delivery.id,
        clientMessageId,
        text: delivery.text,
        command: delivery.command,
      }, {
        enabled: () => true,
        client: () => null,
        registry: () => registry,
        startupFailed: () => true,
      }) ?? "delivery-uncertain";
    },
  }, registry);
  expect(registry.snapshot().heldDeliveries[held[0]!.id]).toMatchObject({
    state: "delivery-uncertain",
    clientMessageId: request.clientMessageId,
    text: request.text,
  });

  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);
  const ledger = createFakeDeliveryLedger();
  await bindStructuredDeliveryQueue([{
    key: { engine: "codex", sessionId },
    host: observableFakeHost(new FakeEngineHost(ledger)),
  }], { registry, client });

  await client.command({
    kind: held[0]!.command.kind,
    operationId: held[0]!.command.operationId,
    conversationId: conversation.id,
    idempotencyKey: request.clientMessageId,
    text: request.text,
    contentDigest: structuredContentDigest({ text: request.text, images: [] }),
    policy: held[0]!.command.policy,
    turnId: held[0]!.command.turnId,
  });
  await kickStructuredDeliveryQueue();

  expect(ledger.writes).toMatchObject([{
    id: request.operationId,
    text: request.text,
    expectedTurnId: null,
  }]);
  expect(registry.snapshot().heldDeliveries[held[0]!.id]).toMatchObject({
    state: "delivered",
    clientMessageId: request.clientMessageId,
    text: "",
  });
  expect(journal.operationResult(request.operationId)?.receipt.status).toBe("delivered");

  const recoveredDuplicate = await enqueueStructuredMessage(request, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    kick: kickStructuredDeliveryQueue,
  });
  expect(recoveredDuplicate).toMatchObject({ ok: true, structured: true, outcome: "delivered" });
  expect(ledger.writes).toHaveLength(1);

  const migrationTicksBeforeTerminalReplay = requestedDrains;
  const afterDeliveryDuplicate = await enqueueStructuredMessage(request, {
    enabled: () => true,
    client: () => null,
    registry: () => registry,
    requestMigrationTick: () => { requestedDrains += 1; },
  });
  expect(afterDeliveryDuplicate).toMatchObject({ ok: true, structured: true, outcome: "delivered" });
  expect(requestedDrains).toBe(migrationTicksBeforeTerminalReplay);
  expect(ledger.writes).toHaveLength(1);
  expect(Object.values(registry.snapshot().heldDeliveries)
    .filter((delivery) => delivery.clientMessageId === request.clientMessageId)).toHaveLength(1);

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
});

test("queue binding settles an uncertain reservation from a terminal journal receipt", async () => {
  const sessionId = "abababab-abab-\x34bab-8bab-abababababab";
  const directory = path.join(sandbox, "terminal-journal-registry-reconciliation");
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "default",
    launchProfile: profile,
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-17T19:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(artifactPath)!;
  const operationId = "operation-terminal-before-registry-settlement";
  const held = registry.holdDelivery(
    conversation.id,
    "already delivered",
    "terminal-before-registry-settlement",
    "text",
    [],
    structuredContentDigest({ text: "already delivered", images: [] }),
    { operationId, kind: "send", policy: "queue", turnId: null },
  );
  expect(held.state).toBe("assigned");
  expect(registry.beginDeliveryAttempt(held.id, held.generationId!)?.state).toBe("delivery-uncertain");
  let statusReads = 0;
  const client = {
    operationStatus: async (requestedId: string) => {
      statusReads += 1;
      expect(requestedId).toBe(operationId);
      return {
        operationId,
        replayed: true,
        receipt: {
          operationId,
          idempotencyKey: "terminal-before-registry-settlement",
          conversationId: conversation.id,
          kind: "send" as const,
          status: "delivered" as const,
        },
      };
    },
    effectBatch: async () => [],
  } as unknown as RuntimeHostClient;

  await bindStructuredDeliveryQueue([], { registry, client });

  expect(statusReads).toBe(1);
  expect(registry.snapshot().heldDeliveries[held.id]).toMatchObject({
    state: "delivered",
    text: "",
    error: null,
  });
  await bindStructuredDeliveryQueue([], { registry, client: null });
});

test("production backlog reconciliation publishes the controller before a historical status read settles", async () => {
  const sessionId = "bcbcbcbc-bcbc-\x34bcb-8bcb-bcbcbcbcbcbc";
  const directory = path.join(sandbox, "controller-ready-before-backlog-reconciliation");
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: directory }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-21T20:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(artifactPath)!;
  const operationId = "operation-blocked-historical-status";
  const held = registry.holdDelivery(
    conversation.id,
    "historical status remains in flight",
    "blocked-historical-status",
    "text",
    [],
    null,
    { operationId, kind: "send", policy: "queue", turnId: null },
  );
  registry.beginDeliveryAttempt(held.id, held.generationId!);
  let statusStarted!: () => void;
  const statusStartedPromise = new Promise<void>((resolve) => { statusStarted = resolve; });
  let releaseStatus!: () => void;
  const statusRelease = new Promise<void>((resolve) => { releaseStatus = resolve; });
  const client = {
    operationStatus: async () => {
      statusStarted();
      await statusRelease;
      return {
        operationId,
        replayed: true,
        receipt: {
          operationId,
          idempotencyKey: "blocked-historical-status",
          conversationId: conversation.id,
          kind: "send" as const,
          status: "delivered" as const,
        },
      };
    },
    append: async () => ({}),
    producerCursor: async () => 0,
    effectBatch: async () => [],
    transitionOperation: async () => { throw new Error("unexpected transition"); },
  } as unknown as RuntimeHostClient;
  const binding = bindStructuredDeliveryQueue([], { registry, client });
  await statusStartedPromise;
  const key = { engine: "codex" as const, sessionId: "controller-ready-during-reconciliation" };
  const host = observableFakeHost(new FakeEngineHost(createFakeDeliveryLedger()));
  let publicationError: unknown = null;
  let unregister: (() => Promise<void>) | null = null;
  try {
    unregister = await publishStructuredDeliveryHost({ key, host });
  } catch (error) {
    publicationError = error;
  } finally {
    releaseStatus();
    await binding;
  }

  expect(publicationError).toBeNull();
  expect(hasStructuredDeliveryHost(key)).toBe(true);
  await unregister?.();
  await bindStructuredDeliveryQueue([], { registry, client: null });
});

test("production backlog reconciliation bounds status concurrency and skips terminal no-op writes", async () => {
  const sessionId = "cdcdcdcd-cdcd-\x34dcd-8dcd-cdcdcdcdcdcd";
  const directory = path.join(sandbox, "bounded-terminal-reconciliation-pages");
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: directory }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-21T20:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(artifactPath)!;
  const deliveries = Array.from({ length: 35 }, (_, index) => {
    const operationId = `bounded-terminal-operation-${index}`;
    const held = registry.holdDelivery(
      conversation.id,
      `historical delivery ${index}`,
      `bounded-terminal-client-${index}`,
      "text",
      [],
      null,
      { operationId, kind: "send", policy: "queue", turnId: null },
    );
    registry.beginDeliveryAttempt(held.id, held.generationId!);
    if (index < 33) registry.recordDeliveryOutcome(held.id, "failed", "old terminal failure");
    return held;
  });
  const before = registry.storageDiagnostics().transactionCount;
  let active = 0;
  let maxActive = 0;
  let statusReads = 0;
  const client = {
    operationStatus: async (operationId: string) => {
      statusReads += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(1);
      active -= 1;
      return {
        operationId,
        replayed: true,
        receipt: {
          operationId,
          idempotencyKey: operationId,
          conversationId: conversation.id,
          kind: "send" as const,
          status: "failed" as const,
          reason: "old terminal failure",
        },
      };
    },
    effectBatch: async () => [],
  } as unknown as RuntimeHostClient;

  await bindStructuredDeliveryQueue([], { registry, client });

  expect(statusReads).toBe(deliveries.length);
  expect(maxActive).toBe(16);
  expect(registry.storageDiagnostics().transactionCount).toBe(before + 1);
  expect(deliveries.slice(33).every((delivery) =>
    registry.snapshot().heldDeliveries[delivery.id]?.state === "failed")).toBe(true);
  await bindStructuredDeliveryQueue([], { registry, client: null });
});

test("startup fallback projection reads one runtime snapshot and publishes only drift across a production conversation set", async () => {
  const directory = path.join(sandbox, "startup-fallback-snapshot-reuse");
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const conversations = Array.from({ length: 24 }, (_, index) => {
    const sessionId = `dededede-dede-\x34ded-8ded-${String(index).padStart(12, "0")}`;
    const artifactPath = path.join(directory, `${sessionId}.jsonl`);
    const profile = emptyLaunchProfile({ cwd: directory });
    registry.reconcileConversations([{
      engine: "codex",
      path: artifactPath,
      accountId: "default",
      launchProfile: profile,
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-21T20:00:00.000Z",
    }]);
    const conversation = registry.conversationForPath(artifactPath)!;
    registry.upsert({
      key: { engine: "codex", sessionId },
      artifactPath,
      cwd: directory,
      accountId: "default",
      launchProfile: profile,
      status: "dead",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: `fake:startup-${index}`,
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
    return { sessionId, conversationId: conversation.id, artifactPath };
  });
  const readSnapshot = registry.snapshot.bind(registry);
  let snapshotReads = 0;
  registry.snapshot = () => {
    snapshotReads += 1;
    return readSnapshot();
  };
  let projections = 0;
  let runtimeSnapshots = 0;
  const client = {
    append: async () => { projections += 1; return {}; },
    snapshot: async () => {
      runtimeSnapshots += 1;
      return {
        sessions: conversations.map((conversation, index) => ({
          conversationId: conversation.conversationId,
          sessionKey: { engine: "codex" as const, sessionId: conversation.sessionId },
          hostKind: "codex-app-server" as const,
          host: index === 0 ? "hosted" as const : "dead" as const,
          turn: "unknown" as const,
          provenance: "structured" as const,
          accountId: "default",
          parentConversationId: null,
          cwd: directory,
          artifactPath: conversation.artifactPath,
          activeTurnId: null,
        })),
      };
    },
    effectBatch: async () => [],
  } as unknown as RuntimeHostClient;

  await bindStructuredDeliveryQueue([], { registry, client });

  expect(projections).toBe(1);
  expect(runtimeSnapshots).toBe(1);
  expect(snapshotReads).toBe(2);
  await bindStructuredDeliveryQueue([], { registry, client: null });
});

test("queue binding settles a rejected journal receipt as a recoverable failure", async () => {
  const sessionId = "acacacac-acac-\x34cac-8cac-acacacacacac";
  const directory = path.join(sandbox, "rejected-journal-registry-reconciliation");
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: directory }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-17T19:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(artifactPath)!;
  const operationId = "operation-rejected-before-registry-settlement";
  const held = registry.holdDelivery(
    conversation.id,
    "rejected before settlement",
    "rejected-before-registry-settlement",
    "text",
    [],
    structuredContentDigest({ text: "rejected before settlement", images: [] }),
    { operationId, kind: "send", policy: "queue", turnId: null },
  );
  registry.beginDeliveryAttempt(held.id, held.generationId!);
  const client = {
    operationStatus: async () => ({
      operationId,
      replayed: true,
      receipt: {
        operationId,
        idempotencyKey: "rejected-before-registry-settlement",
        conversationId: conversation.id,
        kind: "send" as const,
        status: "rejected" as const,
        reason: "no-claim",
      },
    }),
    effectBatch: async () => [],
  } as unknown as RuntimeHostClient;

  await bindStructuredDeliveryQueue([], { registry, client });

  expect(registry.snapshot().heldDeliveries[held.id]).toMatchObject({
    state: "failed",
    error: "no-claim",
  });
  await bindStructuredDeliveryQueue([], { registry, client: null });
});

test("terminal operation replay survives registry and runtime journal compaction", async () => {
  const sessionId = "dddddddd-dddd-\x34ddd-8ddd-dddddddddddd";
  const directory = path.join(sandbox, "durable-operation-ownership");
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "default",
    launchProfile: profile,
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-17T00:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(artifactPath)!;
  registry.upsert({
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd: directory,
    accountId: "default",
    launchProfile: profile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:operation-owner",
      process: null,
      eventCursor: 0,
      protocolVersion: "v2",
      writerClaimEpoch: 4,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 4,
    claimOwner: null,
    pendingAction: null,
  });
  const runtimeFilename = path.join(directory, "runtime.sqlite");
  let journal = new RuntimeJournal(runtimeFilename, { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: { engine: "codex", sessionId },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      artifactPath,
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  const client = runtimeJournalClient(journal);
  const ledger = createFakeDeliveryLedger();
  await bindStructuredDeliveryQueue([{
    key: { engine: "codex", sessionId },
    host: observableFakeHost(new FakeEngineHost(ledger)),
  }], { registry, client });
  const original = {
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "operation-owner-client-one",
    operationId: "operation-owned-by-client-one",
    kind: "send" as const,
    policy: "queue" as const,
    turnId: null,
    text: "actuate this command once",
    hasImages: false,
  };

  try {
    expect(await enqueueStructuredMessage(original, {
      enabled: () => true,
      client: () => client,
      registry: () => registry,
      kick: () => {},
    })).toMatchObject({ ok: true, structured: true, outcome: "queued" });
    await kickStructuredDeliveryQueue();
    expect(ledger.writes).toEqual([expect.objectContaining({
      id: original.operationId,
      text: original.text,
      expectedTurnId: original.turnId,
    })]);

    expect(await enqueueStructuredMessage({
      ...original,
      clientMessageId: "operation-owner-client-two",
    }, {
      enabled: () => true,
      client: () => client,
      registry: () => registry,
      kick: () => {},
    })).toMatchObject({
      ok: false,
      structured: true,
      outcome: "failed",
      status: 409,
    });

    expect(await enqueueStructuredMessage(original, {
      enabled: () => true,
      client: () => client,
      registry: () => registry,
      kick: () => {},
    })).toMatchObject({ ok: true, structured: true, outcome: "delivered" });
    expect(ledger.writes).toHaveLength(1);

    for (let index = 0; index < 101; index += 1) {
      const later = registry.holdDelivery(
        conversation.id,
        `later terminal delivery ${index}`,
        `later-terminal-delivery-${index}`,
      );
      registry.recordDeliveryOutcome(later.id, "delivered");
    }
    expect(Object.values(registry.snapshot().heldDeliveries)
      .some((delivery) => delivery.command.operationId === original.operationId)).toBeFalse();
    journal.append({ scope: { type: "system", id: "runtime" }, kind: "files.revision", payload: { filesRevision: 1 } });
    journal.append({ scope: { type: "system", id: "runtime" }, kind: "files.revision", payload: { filesRevision: 2 } });
    journal.compact(1);
    expect(journal.operationResult(original.operationId)).toBeNull();
    expect(journal.effectBatch()).toEqual([]);
    journal.close();

    const reopened = new AgentRegistry(registry.filename);
    journal = new RuntimeJournal(runtimeFilename, { structuredHosts: true });
    const restartedClient = runtimeJournalClient(journal);
    expect(await enqueueStructuredMessage(original, {
      enabled: () => true,
      client: () => restartedClient,
      registry: () => reopened,
      kick: () => {},
    })).toMatchObject({
      ok: true,
      structured: true,
      outcome: "delivered",
      operationId: original.operationId,
      receipt: { status: "delivered" },
    });
    expect(await enqueueStructuredMessage({ ...original, text: "changed after compaction" }, {
      enabled: () => true,
      client: () => restartedClient,
      registry: () => reopened,
      kick: () => {},
    })).toMatchObject({ ok: false, structured: true, outcome: "failed", status: 409 });
    expect(reopened.pendingDeliveries(conversation.id)).toEqual([]);
    expect(journal.effectBatch()).toEqual([]);
    expect(ledger.writes).toHaveLength(1);
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null });
    journal.close();
  }
});

test("provisional adoption preserves runtime idempotency across Codex and Claude", async () => {
  const scenarios = [
    {
      engine: "codex" as const,
      hostKind: "codex-app-server" as const,
      sessionId: "eeeeeeee-eeee-\x34eee-8eee-eeeeeeeeeeee",
    },
    {
      engine: "claude" as const,
      hostKind: "claude-broker" as const,
      sessionId: "ffffffff-ffff-\x34fff-8fff-ffffffffffff",
    },
  ];

  for (const scenario of scenarios) {
    const directory = path.join(sandbox, `provisional-operation-owner-${scenario.engine}`);
    fs.mkdirSync(directory, { recursive: true });
    const sourcePath = path.join(directory, `source-${scenario.engine}.jsonl`);
    const targetPath = path.join(directory, `${scenario.sessionId}.jsonl`);
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const profile = emptyLaunchProfile({ cwd: directory });
    const canonical = registry.ensureConversation(scenario.engine, sourcePath, "source");
    registry.reconcileConversations([{
      engine: scenario.engine,
      path: targetPath,
      accountId: "target",
      launchProfile: profile,
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-17T01:00:00.000Z",
    }]);
    const provisional = registry.conversationForPath(targetPath)!;
    const structuredHost = {
      kind: scenario.hostKind,
      endpoint: `fake:provisional-${scenario.engine}`,
      process: null,
      eventCursor: 0,
      protocolVersion: "v2",
      writerClaimEpoch: 5,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    };
    registry.upsert({
      key: { engine: scenario.engine, sessionId: scenario.sessionId },
      artifactPath: targetPath,
      cwd: directory,
      accountId: "target",
      launchProfile: profile,
      status: "idle",
      host: null,
      structuredHost,
      claimEpoch: 5,
      claimOwner: null,
      pendingAction: null,
    });
    const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
    journal.append({
      scope: { type: "session", id: provisional.id },
      kind: "session-status",
      payload: {
        conversationId: provisional.id,
        sessionKey: { engine: scenario.engine, sessionId: scenario.sessionId },
        hostKind: scenario.hostKind,
        host: "hosted",
        turn: "idle",
        provenance: "structured",
        artifactPath: targetPath,
        capabilities: { steer: scenario.engine === "codex", structuredAttention: true },
      },
    });
    const client = runtimeJournalClient(journal);
    const ledger = createFakeDeliveryLedger();
    await bindStructuredDeliveryQueue([{
      key: { engine: scenario.engine, sessionId: scenario.sessionId },
      host: observableFakeHost(new FakeEngineHost(ledger)),
    }], { registry, client });
    const request = {
      path: targetPath,
      conversationId: provisional.id,
      clientMessageId: `provisional-client-${scenario.engine}`,
      operationId: `provisional-operation-${scenario.engine}`,
      kind: "send" as const,
      policy: "queue" as const,
      turnId: null,
      text: `deliver once through ${scenario.engine} adoption`,
      hasImages: false,
    };

    try {
      expect(await enqueueStructuredMessage(request, {
        enabled: () => true,
        client: () => client,
        registry: () => registry,
        kick: () => {},
      })).toMatchObject({ ok: true, structured: true, outcome: "queued" });
      expect(journal.effectBatch()).toHaveLength(1);

      const migration = registry.beginSpawnRequest({
        engine: scenario.engine,
        cwd: directory,
        accountId: "target",
        conversationId: canonical.id,
        purpose: "launch",
        expectedArtifactPath: targetPath,
      });
      if (migration.kind !== "created") throw new Error("expected migration successor receipt");
      expect(registry.settleSpawn(migration.receipt.launchId, {
        key: { engine: scenario.engine, sessionId: scenario.sessionId },
        artifactPath: targetPath,
        cwd: directory,
        accountId: "target",
        launchProfile: profile,
        status: "idle",
        host: null,
        structuredHost,
        claimEpoch: 5,
        claimOwner: null,
        pendingAction: null,
      })).toMatchObject({ kind: "settled", conversation: { id: canonical.id } });
      expect(registry.canonicalConversationId(provisional.id)).toBe(canonical.id);

      const unrelated = registry.ensureConversation(
        scenario.engine,
        path.join(directory, `unrelated-${scenario.engine}.jsonl`),
        "target",
      );
      expect(() => registry.holdDelivery(
        unrelated.id,
        request.text,
        request.clientMessageId,
        "text",
        [],
        null,
        {
          operationId: request.operationId,
          kind: request.kind,
          policy: request.policy,
          turnId: request.turnId,
        },
      )).toThrow("operation id is already reserved for another client message");

      expect(await enqueueStructuredMessage(request, {
        enabled: () => true,
        client: () => client,
        registry: () => registry,
        kick: () => {},
      })).toMatchObject({
        ok: true,
        structured: true,
        outcome: "queued",
        operationId: request.operationId,
      });
      expect(await enqueueStructuredMessage({ ...request, text: `${request.text} changed` }, {
        enabled: () => true,
        client: () => client,
        registry: () => registry,
        kick: () => {},
      })).toMatchObject({ ok: false, structured: true, outcome: "failed", status: 409 });

      await kickStructuredDeliveryQueue();
      expect(ledger.writes).toEqual([expect.objectContaining({
        id: request.operationId,
        text: request.text,
        expectedTurnId: request.turnId,
      })]);
      expect(journal.effectBatch()).toEqual([]);
    } finally {
      await bindStructuredDeliveryQueue([], { registry, client: null });
      journal.close();
    }
  }
});

test("a stale synchronization-held steer fails safely across Codex and Claude recovery", async () => {
  const cases = [
    {
      engine: "codex" as const,
      hostKind: "codex-app-server" as const,
      sessionId: "bbbbbbbb-bbbb-\x34bbb-8bbb-bbbbbbbbbbbb",
    },
    {
      engine: "claude" as const,
      hostKind: "claude-broker" as const,
      sessionId: "cccccccc-cccc-\x34ccc-8ccc-cccccccccccc",
    },
  ];

  for (const scenario of cases) {
    const directory = path.join(sandbox, `stale-synchronization-hold-${scenario.engine}`);
    const artifactPath = path.join(directory, `${scenario.sessionId}.jsonl`);
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const profile = emptyLaunchProfile({ cwd: directory });
    registry.reconcileConversations([{
      engine: scenario.engine,
      path: artifactPath,
      accountId: "default",
      launchProfile: profile,
      turn: { state: "busy", source: "assistant", terminalAt: null },
      observedAt: "2026-07-16T20:07:01.000Z",
    }]);
    const conversation = registry.conversationForPath(artifactPath)!;
    registry.upsert({
      key: { engine: scenario.engine, sessionId: scenario.sessionId },
      artifactPath,
      cwd: directory,
      accountId: "default",
      launchProfile: profile,
      status: "live",
      host: null,
      structuredHost: {
        kind: scenario.hostKind,
        endpoint: `stdio:${scenario.engine}-before-restart`,
        process: null,
        eventCursor: 23,
        protocolVersion: "v2",
        writerClaimEpoch: 3,
        activeTurnRef: "turn-before-restart",
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 3,
      claimOwner: null,
      pendingAction: null,
    });
    const request = {
      path: artifactPath,
      conversationId: conversation.id,
      clientMessageId: `stale-held-steer-${scenario.engine}`,
      operationId: `operation-stale-held-steer-${scenario.engine}`,
      kind: "steer" as const,
      policy: "steer-if-active" as const,
      turnId: "turn-before-restart",
      text: `retain the ${scenario.engine} turn fence`,
      hasImages: false,
    };

    expect(await enqueueStructuredMessage(request, {
      enabled: () => true,
      client: () => null,
      registry: () => registry,
      requestMigrationTick: () => {},
    })).toMatchObject({ ok: true, structured: true, outcome: "held" });

    const reopened = new AgentRegistry(registry.filename);
    const held = reopened.pendingDeliveries(conversation.id)[0]!;
    const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
    journal.append({
      scope: { type: "session", id: conversation.id },
      kind: "session-status",
      payload: {
        conversationId: conversation.id,
        sessionKey: { engine: scenario.engine, sessionId: scenario.sessionId },
        hostKind: scenario.hostKind,
        host: "hosted",
        turn: "running",
        activeTurnId: "turn-after-restart",
        provenance: "structured",
        artifactPath,
        capabilities: { steer: true, structuredAttention: true },
      },
    });
    const client = runtimeJournalClient(journal);

    await drainHeldDeliveries(conversation.id, {
      async deliver({ delivery, path: deliveryPath, clientMessageId }) {
        return await deliverHeldStructuredMessage({
          conversationId: conversation.id,
          path: deliveryPath,
          deliveryId: delivery.id,
          clientMessageId,
          text: delivery.text,
          command: delivery.command,
        }, {
          enabled: () => true,
          client: () => client,
          kick: () => {},
        }) ?? "delivery-uncertain";
      },
    }, reopened);

    expect(journal.operationResult(request.operationId)?.receipt).toMatchObject({
      kind: request.kind,
      status: "rejected",
      reason: "stale-turn",
      turnId: request.turnId,
    });
    expect(journal.effectBatch()).toEqual([]);
    expect(reopened.snapshot().heldDeliveries[held.id]).toMatchObject({
      state: "failed",
      command: held.command,
      requestDigest: held.requestDigest,
    });
    journal.close();
  }
});

test("a migration-held delivery switches from the source host to the published Codex successor", async () => {
  const sourceId = "11111111-1111-\x34111-8111-111111111111";
  const successorId = "22222222-2222-\x34222-8222-222222222222";
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
  const held = registry.holdDelivery(
    conversation.id,
    "continue on the successor",
    "migration-successor-message",
    "text",
    [],
    null,
    {
      operationId: "operation-migration-successor-message",
      kind: "send",
      policy: "queue",
      turnId: null,
    },
  );
  expect(held.state).toBe("held");

  const order: string[] = [];
  const commitSuccessor = registry.commitSuccessor.bind(registry);
  registry.commitSuccessor = ((...args: Parameters<AgentRegistry["commitSuccessor"]>) => {
    order.push("commit");
    return commitSuccessor(...args);
  }) as AgentRegistry["commitSuccessor"];
  const provider: SuccessorProviderPort = {
    virtualSource: true,
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
        command: delivery.command,
      }, {
        enabled: () => true,
        client: () => client,
        kick: kickStructuredDeliveryQueue,
      }) ?? "delivery-uncertain";
    },
  }, registry);

  expect(order.slice(0, 3)).toEqual(["verify", "publish", "commit"]);
  expect(sourceLedger.writes).toEqual([]);
  expect(successorLedger.writes).toMatchObject([{
    id: held.command.operationId,
    text: "continue on the successor",
    expectedTurnId: null,
  }]);
  expect(registry.pendingDeliveries(conversation.id)).toEqual([]);
  expect(journal.operationResult(held.command.operationId)?.receipt.status).toBe("delivered");

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
});

test("a migration-held delivery switches from the source host to the published Claude successor", async () => {
  const sourceId = "33333333-3333-\x34333-8333-333333333333";
  const successorId = "44444444-4444-\x34444-8444-444444444444";
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
  const held = registry.holdDelivery(
    conversation.id,
    "continue on the Claude successor",
    "claude-migration-message",
    "text",
    [],
    null,
    {
      operationId: "operation-claude-migration-message",
      kind: "send",
      policy: "queue",
      turnId: null,
    },
  );
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
        command: delivery.command,
      }, {
        enabled: () => true,
        client: () => client,
        kick: kickStructuredDeliveryQueue,
      }) ?? "delivery-uncertain";
    },
  }, registry);

  expect(publications).toBe(1);
  expect(sourceLedger.writes).toEqual([]);
  expect(successorLedger.writes).toMatchObject([{
    id: held.command.operationId,
    text: "continue on the Claude successor",
    expectedTurnId: null,
  }]);
  expect(registry.pendingDeliveries(conversation.id)).toEqual([]);
  expect(journal.operationResult(held.command.operationId)?.receipt.status).toBe("delivered");

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
});

test("successor cleanup drains a delayed publication before restoring path-only rollback delivery", async () => {
  const sourceId = "55555555-5555-\x34555-8555-555555555555";
  const successorId = "66666666-6666-\x34666-8666-666666666666";
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
  expect(sourceLedger.writes).toMatchObject([{
    id: expect.any(String),
    text: "continue after rollback",
    expectedTurnId: null,
  }]);

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
});

test("ownership loss inside successor projection republishes the current source host", async () => {
  const sourceId = "12121212-1212-\x34212-8212-121212121212";
  const successorId = "34343434-3434-\x34434-8434-343434343434";
  const sourcePath = path.join(sandbox, `${sourceId}.jsonl`);
  const successorPath = path.join(sandbox, `${successorId}.jsonl`);
  const registry = new AgentRegistry(path.join(sandbox, "publication-ownership-projection-registry.json"));
  const profile = emptyLaunchProfile({ cwd: sandbox });
  registry.reconcileConversations([{
    engine: "codex",
    path: sourcePath,
    accountId: "source",
    launchProfile: profile,
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-19T12:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(sourcePath)!;
  const structuredHost = (endpoint: string) => ({
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
  const upsertHost = (sessionId: string, artifactPath: string, accountId: string, endpoint: string) => registry.upsert({
    key: { engine: "codex" as const, sessionId },
    artifactPath,
    cwd: sandbox,
    accountId,
    launchProfile: profile,
    status: "idle" as const,
    host: null,
    structuredHost: structuredHost(endpoint),
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  upsertHost(sourceId, sourcePath, "source", "fake:publication-source");
  registry.commitMigrationIntent({
    engine: "codex",
    targetId: "target",
    origin: "manual",
    requestId: "publication-ownership-loss",
    expectedRevision: registry.engineRouting("codex").revision,
  });
  registry.recordConversationContinuityPath(conversation.id, successorPath);
  upsertHost(successorId, successorPath, "target", "fake:publication-successor");

  const journal = new RuntimeJournal(path.join(sandbox, "publication-ownership-projection-runtime.sqlite"), { structuredHosts: true });
  const journalClient = runtimeJournalClient(journal);
  let ownsPublication = true;
  let successorProjections = 0;
  let releaseSuccessorAppend = () => {};
  const successorAppendGate = new Promise<void>((resolve) => { releaseSuccessorAppend = resolve; });
  let markSuccessorProjected = () => {};
  const successorProjected = new Promise<void>((resolve) => { markSuccessorProjected = resolve; });
  const client = {
    ...journalClient,
    append: async (event: Parameters<RuntimeHostClient["append"]>[0]) => {
      const result = await journalClient.append(event);
      if (event.kind === "session-status" && event.payload.artifactPath === successorPath) {
        successorProjections += 1;
        ownsPublication = false;
        markSuccessorProjected();
        await successorAppendGate;
      }
      return result;
    },
  } as RuntimeHostClient;

  await bindStructuredDeliveryQueue([{
    key: { engine: "codex", sessionId: sourceId },
    host: observableFakeHost(new FakeEngineHost()),
  }], { registry, client });
  try {
    const publication = publishStructuredDeliveryHost({
      key: { engine: "codex", sessionId: successorId },
      host: observableFakeHost(new FakeEngineHost()),
    }, async () => ownsPublication);
    await successorProjected;
    expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)?.artifactPath)
      .toBe(successorPath);
    releaseSuccessorAppend();
    const cleanup = await publication;
    await cleanup();

    expect(successorProjections).toBe(1);
    expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)).toMatchObject({
      sessionKey: { engine: "codex", sessionId: sourceId },
      accountId: "source",
      artifactPath: sourcePath,
    });
  } finally {
    releaseSuccessorAppend();
    await bindStructuredDeliveryQueue([], { registry, client: null });
    journal.close();
  }
});

test("structured successor cleanup restores a rolled-back tmux source projection", async () => {
  const sourceId = "aaaaaaaa-aaaa-\x34aaa-8aaa-aaaaaaaaaaaa";
  const successorId = "bbbbbbbb-bbbb-\x34bbb-8bbb-bbbbbbbbbbbb";
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
  const sourceId = "77777777-7777-\x34777-8777-777777777777";
  const discardedId = "88888888-8888-\x34888-8888-888888888888";
  const committedId = "99999999-9999-\x34999-8999-999999999999";
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
  }, revision, receipt.operationId, receipt);
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
  expect(committedLedger.writes).toMatchObject([{
    id: expect.any(String),
    text: "continue after retarget",
    expectedTurnId: null,
  }]);

  await unregisterCommitted();
  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
});
