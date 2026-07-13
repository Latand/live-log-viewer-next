import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { RuntimeJournal } from "@/runtime-host/journal";

import type { EngineHost, QueueEntry } from "./engineHost";
import { FakeEngineHost, createFakeDeliveryLedger } from "./fixtures/fakeEngineHost";
import { StructuredDeliveryQueue, type StructuredDeliveryQueuePort } from "./structuredDeliveryQueue";

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
