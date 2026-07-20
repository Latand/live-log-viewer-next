import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { HandoffQueue, type HandoffRowInput } from "./handoffQueue";
import { SqliteHandoffQueueStore } from "./handoffQueueStore";

function rowInput(overrides: Partial<HandoffRowInput> = {}): HandoffRowInput {
  return {
    operationId: overrides.operationId ?? "handoff_root_1",
    conversationId: overrides.conversationId ?? "conversation_root",
    engine: overrides.engine ?? "codex",
    engineSessionId: overrides.engineSessionId ?? "session_root",
    kind: overrides.kind ?? "root",
    parentConversationId: overrides.parentConversationId ?? null,
    hostGeneration: overrides.hostGeneration ?? "gen-blue",
    accountId: overrides.accountId ?? "acct-a",
    turnState: overrides.turnState ?? "idle",
    pendingDeliveries: overrides.pendingDeliveries ?? [],
  };
}

test("SQLite store survives a container replace and preserves an idempotent replay", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-handoff-queue-"));
  const filename = path.join(directory, "handoff-queue.sqlite");

  const outgoing = new HandoffQueue(new SqliteHandoffQueueStore(filename));
  outgoing.enqueue([rowInput({ pendingDeliveries: [{ deliveryId: "d1", clientMessageId: "c1", seq: 1 }] })]);
  outgoing.beginDrain("gen-blue");
  const claimed = outgoing.claim("handoff_root_1", { fromGeneration: "gen-blue", toGeneration: "gen-green" });
  expect(claimed.replay.map((d) => d.deliveryId)).toEqual(["d1"]);

  // A fresh process (the successor container) opens the same durable file.
  const successor = new HandoffQueue(new SqliteHandoffQueueStore(filename));
  const row = successor.row("handoff_root_1")!;
  expect(row.status).toBe("claimed");
  expect(row.hostGeneration).toBe("gen-green");
  expect(row.predecessorGeneration).toBe("gen-blue");
  // Replaying the same successor claim after restart never duplicates the delivery.
  const replay = successor.claim("handoff_root_1", { fromGeneration: "gen-blue", toGeneration: "gen-green" });
  expect(replay.ok).toBe(true);
  expect(replay.replay).toEqual([]);
  expect(successor.rows()).toHaveLength(1);

  fs.rmSync(directory, { recursive: true, force: true });
});
