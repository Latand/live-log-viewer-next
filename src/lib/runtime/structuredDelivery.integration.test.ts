import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";
import { reconcileMigrations } from "@/lib/accounts/migration/coordinator";
import { emptyLaunchProfile, type SuccessorProviderPort } from "@/lib/accounts/migration/contracts";
import { RuntimeJournal } from "@/runtime-host/journal";

import type { RuntimeHostClient } from "./client";
import type { EngineHost, QueueEntry } from "./engineHost";
import { FakeEngineHost, createFakeDeliveryLedger } from "./fixtures/fakeEngineHost";
import { bindStructuredDeliveryQueue, publishStructuredDeliveryHost } from "./structuredDeliveryController";
import { StructuredDeliveryQueue, type StructuredDeliveryQueuePort } from "./structuredDeliveryQueue";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { deliverHeldStructuredMessage } from "./structuredMessageDelivery";

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
  const client = {
    snapshot: async () => journal.snapshot(),
    append: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (operationId) => journal.operationResult(operationId),
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) => journal.transitionOperation(operationId, status, details),
  } as RuntimeHostClient;
  const observable = (host: FakeEngineHost) => Object.assign(host, { onStateChange: () => () => {} });
  const sourceLedger = createFakeDeliveryLedger();
  const successorLedger = createFakeDeliveryLedger();
  await bindStructuredDeliveryQueue([{
    key: { engine: "codex", sessionId: sourceId },
    host: observable(new FakeEngineHost(sourceLedger)),
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
        host: observable(new FakeEngineHost(successorLedger)),
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
