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
      launch_pending: {
        conversationId: "conversation_receipt_pending",
        state: "starting",
        artifactLifecycle: "pending",
      },
      launch_failed: {
        conversationId: "conversation_receipt_failed",
        state: "failed",
        artifactLifecycle: "pending",
      },
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

test("registry retention canonicalizes multi-hop aliases and fails closed on cycles", () => {
  const states = registryConversationRetentionStates({
    conversations: {
      conversation_canonical: {
        id: "conversation_canonical",
        engine: "codex",
        generations: [{ id: "thread-dead" }],
        supersededBy: null,
      },
    },
    entries: {
      "codex:thread-dead": { status: "dead" },
    },
    receipts: {},
    conversationAliases: {
      conversation_outer_alias: "conversation_inner_alias",
      conversation_inner_alias: "conversation_canonical",
      conversation_cycle_a: "conversation_cycle_b",
      conversation_cycle_b: "conversation_cycle_a",
    },
  });

  expect(states.get("conversation_outer_alias")).toBe("dead");
  expect(states.get("conversation_inner_alias")).toBe("dead");
  expect(states.get("conversation_cycle_a")).toBe("current");
  expect(states.get("conversation_cycle_b")).toBe("current");
});

test("an unhosted registry conversation keeps its old effect pending", () => {
  const states = registryConversationRetentionStates({
    conversations: {
      conversation_unhosted: {
        id: "conversation_unhosted",
        engine: "codex",
        generations: [{ id: "thread-unhosted" }],
        supersededBy: null,
      },
    },
    entries: {
      "codex:thread-unhosted": { status: "unhosted" },
    },
    receipts: {},
    conversationAliases: {},
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-journal-retention-"));
  let now = 1_000;
  const journal = new RuntimeJournal(path.join(directory, "events.sqlite"), {
    structuredHosts: true,
    now: () => now,
  });

  journal.executeOperation({
    kind: "spawn",
    conversationId: "conversation_unhosted",
    operationId: "operation_unhosted",
    idempotencyKey: "unhosted",
    engine: "codex",
    cwd: "/repo",
    "prompt": "start",
  });

  now += RUNTIME_PENDING_EFFECT_STALE_MS + 1;
  journal.settleStalePendingEffects(states);
  now += RUNTIME_PENDING_EFFECT_STALE_MS;
  journal.settleStalePendingEffects(states);

  expect(states.get("conversation_unhosted")).toBe("current");
  expect(journal.operationResult("operation_unhosted")?.receipt.status).toBe("queued");
  expect(journal.effectBatch().map((effect) => effect.payload.operationId)).toEqual([
    "operation_unhosted",
  ]);

  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("a completed spawn receipt cannot shadow dead conversation state", () => {
  const states = registryConversationRetentionStates({
    conversations: {
      conversation_completed_receipt: {
        id: "conversation_completed_receipt",
        engine: "codex",
        generations: [{ id: "thread-completed-receipt" }],
        supersededBy: null,
      },
    },
    entries: {
      "codex:thread-completed-receipt": { status: "dead" },
    },
    receipts: {
      launch_completed: {
        conversationId: "conversation_completed_receipt",
        state: "completed",
        artifactLifecycle: "materialized",
      },
      launch_active: {
        conversationId: "conversation_active_receipt",
        state: "starting",
        artifactLifecycle: "pending",
      },
    },
    conversationAliases: {},
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-journal-retention-"));
  let now = 1_000;
  const journal = new RuntimeJournal(path.join(directory, "events.sqlite"), {
    structuredHosts: true,
    now: () => now,
  });

  journal.executeOperation({
    kind: "spawn",
    conversationId: "conversation_completed_receipt",
    operationId: "operation_completed_receipt",
    idempotencyKey: "completed-receipt",
    engine: "codex",
    cwd: "/repo",
    "prompt": "start",
  });

  now += RUNTIME_PENDING_EFFECT_STALE_MS + 1;
  journal.settleStalePendingEffects(states);
  now += RUNTIME_PENDING_EFFECT_STALE_MS;
  journal.settleStalePendingEffects(states);

  expect(states.get("conversation_completed_receipt")).toBe("dead");
  expect(states.get("conversation_active_receipt")).toBe("current");
  expect(journal.operationResult("operation_completed_receipt")?.receipt.status).toBe("failed");
  expect(journal.effectBatch()).toEqual([]);

  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("stale effects require one continuous absence horizon and reset when liveness returns", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-journal-retention-"));
  let now = 1_000;
  let journal = new RuntimeJournal(path.join(directory, "events.sqlite"), {
    structuredHosts: true,
    now: () => now,
  });

  journal.executeOperation({
    kind: "spawn",
    conversationId: "conversation_continuous_absence",
    operationId: "operation_continuous_absence",
    idempotencyKey: "continuous-absence",
    engine: "codex",
    cwd: "/repo",
    "prompt": "start",
  });

  now += RUNTIME_PENDING_EFFECT_STALE_MS + 1;
  expect(journal.settleStalePendingEffects(new Map([
    ["conversation_continuous_absence", "current"],
  ]))).toEqual({ scanned: 1, settled: 0 });
  expect(journal.settleStalePendingEffects(new Map())).toEqual({ scanned: 1, settled: 0 });

  journal.close();
  now += RUNTIME_PENDING_EFFECT_STALE_MS - 1;
  journal = new RuntimeJournal(path.join(directory, "events.sqlite"), {
    structuredHosts: true,
    now: () => now,
  });
  expect(journal.settleStalePendingEffects(new Map())).toEqual({ scanned: 1, settled: 0 });

  expect(journal.settleStalePendingEffects(new Map([
    ["conversation_continuous_absence", "current"],
  ]))).toEqual({ scanned: 1, settled: 0 });
  expect(journal.settleStalePendingEffects(new Map())).toEqual({ scanned: 1, settled: 0 });

  now += RUNTIME_PENDING_EFFECT_STALE_MS - 1;
  expect(journal.settleStalePendingEffects(new Map())).toEqual({ scanned: 1, settled: 0 });
  now += 1;
  expect(journal.settleStalePendingEffects(new Map())).toEqual({ scanned: 1, settled: 1 });
  expect(journal.operationResult("operation_continuous_absence")?.receipt).toMatchObject({
    status: "failed",
    reason: expect.stringMatching(/^stale: /),
  });

  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
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
  const states = new Map<string, "current" | "dead">([
    ["conversation_stale_kill", "dead"],
    ["conversation_live_kill", "dead"],
    ["conversation_registered_spawn", "current"],
  ]);
  expect(journal.settleStalePendingEffects(states)).toEqual({ scanned: 4, settled: 0 });
  now += RUNTIME_PENDING_EFFECT_STALE_MS;
  const result = journal.settleStalePendingEffects(states);

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
