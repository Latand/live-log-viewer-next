import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { RuntimeJournal } from "@/runtime-host/journal";

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
  expect(ledger.writes).toEqual([{ id: "operation-one", text: "hello" }]);
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
  expect(ledger.writes).toEqual([{ id: "operation-one", text: "hello" }]);
  reopenedJournal.close();
});
