import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RuntimeJournal, RUNTIME_PENDING_EFFECT_STALE_MS } from "./journal";
import { registryConversationRetentionStates } from "./journalRetention";

function sessionStatus(
  journal: RuntimeJournal,
  conversationId: string,
  sessionId: string,
  host: "hosted" | "dead",
): void {
  journal.append({
    scope: { type: "session", id: conversationId },
    kind: "session-status",
    payload: {
      conversationId,
      sessionKey: { engine: "codex", sessionId },
      hostKind: "codex-app-server",
      host,
      turn: host === "hosted" ? "idle" : "unknown",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: null,
    },
  });
}

test("registry retention evidence distinguishes current, dead, superseded, and aliased conversations", () => {
  const states = registryConversationRetentionStates({
    conversations: {
      conversation_current: {
        id: "conversation_current",
        engine: "codex",
        generations: [{ id: "thread-current" }],
        supersededBy: null,
      },
      conversation_dead: {
        id: "conversation_dead",
        engine: "claude",
        generations: [{ id: "session-dead" }],
        supersededBy: null,
      },
      conversation_superseded: {
        id: "conversation_superseded",
        engine: "codex",
        generations: [{ id: "thread-old" }],
        supersededBy: { conversationId: "conversation_current" },
      },
    },
    entries: {
      "codex:thread-current": { status: "idle" },
      "claude:session-dead": { status: "dead" },
      "codex:thread-old": { status: "idle" },
    },
    receipts: {
      launch_pending: { conversationId: "conversation_receipt_pending", state: "starting" },
      launch_failed: { conversationId: "conversation_receipt_failed", state: "failed" },
    },
    conversationAliases: { conversation_alias: "conversation_dead" },
  });

  expect(Object.fromEntries(states)).toEqual({
    conversation_current: "current",
    conversation_dead: "dead",
    conversation_superseded: "superseded",
    conversation_receipt_pending: "current",
    conversation_receipt_failed: "dead",
    conversation_alias: "dead",
  });
});

test("stale orphaned spawn and kill effects settle while live work remains pending", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-journal-retention-"));
  let now = 1_000;
  const journal = new RuntimeJournal(path.join(directory, "events.sqlite"), {
    structuredHosts: true,
    now: () => now,
  });

  journal.executeOperation({
    kind: "spawn",
    conversationId: "conversation_stale_spawn",
    operationId: "operation_stale_spawn",
    idempotencyKey: "stale-spawn",
    engine: "codex",
    cwd: "/repo",
    "prompt": "start",
  });

  sessionStatus(journal, "conversation_stale_send", "thread-send", "hosted");
  journal.executeOperation({
    kind: "send",
    conversationId: "conversation_stale_send",
    operationId: "operation_stale_send",
    idempotencyKey: "stale-send",
    text: "keep this unknown-fate delivery",
    policy: "queue",
  });
  sessionStatus(journal, "conversation_stale_send", "thread-send", "dead");

  sessionStatus(journal, "conversation_stale_kill", "thread-stale", "hosted");
  journal.executeOperation({
    kind: "kill",
    conversationId: "conversation_stale_kill",
    operationId: "operation_stale_kill",
    idempotencyKey: "stale-kill",
    sessionKey: { engine: "codex", sessionId: "thread-stale" },
  });
  sessionStatus(journal, "conversation_stale_kill", "thread-stale", "dead");

  sessionStatus(journal, "conversation_live_kill", "thread-live", "hosted");
  journal.executeOperation({
    kind: "kill",
    conversationId: "conversation_live_kill",
    operationId: "operation_live_kill",
    idempotencyKey: "live-kill",
    sessionKey: { engine: "codex", sessionId: "thread-live" },
  });

  journal.executeOperation({
    kind: "spawn",
    conversationId: "conversation_registered_spawn",
    operationId: "operation_registered_spawn",
    idempotencyKey: "registered-spawn",
    engine: "claude",
    cwd: "/repo",
    "prompt": "start",
  });

  now += RUNTIME_PENDING_EFFECT_STALE_MS + 1;
  const result = journal.settleStalePendingEffects(new Map([
    ["conversation_stale_kill", "dead"],
    ["conversation_live_kill", "dead"],
    ["conversation_registered_spawn", "current"],
  ]));

  expect(result).toEqual({ scanned: 4, settled: 2 });
  for (const operationId of ["operation_stale_spawn", "operation_stale_kill"]) {
    expect(journal.operationResult(operationId)?.receipt).toMatchObject({
      status: "failed",
      reason: expect.stringMatching(/^stale: /),
    });
  }
  expect(journal.effectBatch().map((effect) => effect.payload.operationId)).toEqual([
    "operation_stale_send",
    "operation_live_kill",
    "operation_registered_spawn",
  ]);
  expect(journal.operationResult("operation_live_kill")?.receipt.status).toBe("queued");
  expect(journal.operationResult("operation_registered_spawn")?.receipt.status).toBe("queued");
  expect(journal.operationResult("operation_stale_send")?.receipt.status).toBe("queued");

  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
