import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import type { Flow } from "@/lib/flows/types";
import { UnixRuntimeHostClient } from "@/lib/runtime/client";
import { runtimeScope } from "@/lib/runtime/contracts";

import { RuntimeHost, RuntimeHostFence } from "./host";
import { RuntimeJournal, RuntimeJournalFault } from "./journal";
import { serveRuntimeHost } from "./socket";

function sandbox(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `llv-runtime-${name}-`));
}

test("journal assigns global sequences, consecutive scoped revisions, and idempotent producer keys", () => {
  const dir = sandbox("sequence");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  const first = journal.append({ scope: runtimeScope("session", "one"), kind: "turn.started", payload: { turnId: "a" }, producerKey: "native:a" });
  const duplicate = journal.append({ scope: runtimeScope("session", "one"), kind: "turn.started", payload: { turnId: "a" }, producerKey: "native:a" });
  const second = journal.append({ scope: runtimeScope("session", "one"), kind: "turn.completed", payload: { turnId: "a" } });
  const third = journal.append({ scope: runtimeScope("flow", "one"), kind: "flow.ready", payload: {} });
  expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
  expect([first.revision, second.revision, third.revision]).toEqual([1, 2, 1]);
  expect(duplicate).toEqual(first);
  const snapshot = journal.snapshot();
  expect(snapshot.snapshotSeq).toBe(3);
  expect(snapshot.sessions).toHaveLength(1);
  expect(snapshot.sessions[0]).toMatchObject({ conversationId: "one", turn: "idle", revision: 2 });
  expect(snapshot.flows).toHaveLength(1);
  expect(snapshot.flows[0]).toMatchObject({ revision: 1, value: { id: "one" } });
  journal.close();
});

test("producer dedupe keys are isolated by producer identity", () => {
  const dir = sandbox("producer-dedupe");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  const first = journal.append({
    scope: runtimeScope("session", "one"),
    kind: "turn.started",
    payload: { turnId: "a" },
    producer: { kind: "codex-app-server", eventKey: "native:a" },
  });
  const second = journal.append({
    scope: runtimeScope("session", "one"),
    kind: "turn.completed",
    payload: { turnId: "a" },
    producer: { kind: "claude-broker", eventKey: "native:a" },
  });
  expect([first.seq, second.seq]).toEqual([1, 2]);
  expect([first.revision, second.revision]).toEqual([1, 2]);
  journal.close();
});

test("producer cursor reports the highest durably acknowledged engine event", () => {
  const dir = sandbox("producer-cursor");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 1, now: () => 100 });
  for (const sequence of [1, 2, 3]) {
    journal.append({
      scope: runtimeScope("session", "one"),
      kind: "delta",
      payload: { conversationId: "one", turnId: "turn-one", text: `delta ${sequence}` },
      producer: { kind: "codex-app-server", eventKey: `engine-host:codex:thread-one:${sequence}` },
    });
  }
  journal.compact(1);

  expect(journal.producerCursor("codex-app-server", "engine-host:codex:thread-one:")).toBe(3);
  expect(journal.producerCursor("claude-broker", "engine-host:claude:thread-one:")).toBe(0);
  journal.close();
});

test("snapshot exposes the canonical projected runtime model", () => {
  const dir = sandbox("canonical-snapshot");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  journal.append({
    scope: runtimeScope("session", "conv-one"),
    kind: "session.status",
    payload: {
      conversationId: "conv-one",
      sessionKey: { engine: "codex", sessionId: "thread-one" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      accountId: "account-one",
      parentConversationId: null,
      flowId: null,
      workflowId: null,
      cwd: "/repo",
      artifactPath: "/sessions/one.jsonl",
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: null,
    },
  });
  journal.append({
    scope: runtimeScope("session", "conv-one"),
    kind: "turn.started",
    payload: { conversationId: "conv-one", turnId: "turn-one" },
  });
  journal.append({
    scope: runtimeScope("session", "conv-one"),
    kind: "attention.requested",
    payload: {
      id: "attention-one",
      conversationId: "conv-one",
      kind: "approval",
      state: "open",
      unowned: false,
      createdAt: "2026-07-10T00:00:00.000Z",
      request: { command: "bun test" },
      turnId: "turn-one",
    },
  });

  expect(journal.snapshot()).toEqual({
    schemaVersion: 1,
    snapshotSeq: 3,
    retentionFloorSeq: 0,
    serverTime: "1970-01-01T00:00:00.100Z",
    runtime: { hostEpoch: 1, health: "ready" },
    filesRevision: 0,
    sessions: [{
      conversationId: "conv-one",
      sessionKey: { engine: "codex", sessionId: "thread-one" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "running",
      provenance: "structured",
      revision: 3,
      attentionIds: ["attention-one"],
      recentReceipts: [],
      accountId: "account-one",
      parentConversationId: null,
      flowId: null,
      workflowId: null,
      cwd: "/repo",
      artifactPath: "/sessions/one.jsonl",
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: "turn-one",
      drift: null,
    }],
    attentions: [{
      id: "attention-one",
      conversationId: "conv-one",
      kind: "approval",
      state: "open",
      unowned: false,
      createdAt: "2026-07-10T00:00:00.000Z",
      request: { command: "bun test" },
      turnId: "turn-one",
    }],
    recentOperations: [],
    edges: [],
    flows: [],
    workflows: [],
    tasks: [],
    deployments: [],
  });
  journal.close();
});

test("issue 51 keeps tool work running until authoritative turn completion", () => {
  const dir = sandbox("terminal-axes");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  journal.append({
    scope: runtimeScope("session", "conv-one"),
    kind: "session-status",
    payload: { hostKind: "codex-app-server", host: "hosted", turn: "running", activeTurnId: "turn-one" },
  });
  journal.append({ scope: runtimeScope("session", "conv-one"), kind: "item.completed", payload: { itemType: "agentMessage" } });
  journal.append({ scope: runtimeScope("session", "conv-one"), kind: "item.completed", payload: { itemType: "commandExecution" } });
  expect(journal.snapshot().sessions[0]?.turn).toBe("running");
  journal.append({ scope: runtimeScope("session", "conv-one"), kind: "host.disconnected", payload: {} });
  expect(journal.snapshot().sessions[0]).toMatchObject({ host: "recovering", turn: "unknown", provenance: "replayed" });
  journal.append({ scope: runtimeScope("session", "conv-one"), kind: "turn.completed", payload: { turnId: "turn-one" } });
  expect(journal.snapshot().sessions[0]?.turn).toBe("idle");
  journal.close();
});

test("send operations converge by idempotency key and persist one receipt and effect", () => {
  const dir = sandbox("operation-dedupe");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  journal.append({
    scope: runtimeScope("session", "conv-one"),
    kind: "session-status",
    payload: {
      conversationId: "conv-one",
      sessionKey: { engine: "codex", sessionId: "thread-one" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "running",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: "turn-one",
    },
  });
  const command = {
    kind: "send" as const,
    operationId: "op-send-one",
    idempotencyKey: "send-key-one",
    conversationId: "conv-one",
    text: "keep going",
    policy: "steer-if-active" as const,
  };

  const first = journal.executeOperation(command);
  const duplicate = journal.executeOperation(command);

  expect(first.replayed).toBe(false);
  expect(duplicate).toEqual({ ...first, replayed: true });
  expect(first.receipt).toMatchObject({
    operationId: "op-send-one",
    idempotencyKey: "send-key-one",
    conversationId: "conv-one",
    kind: "send",
    status: "pending",
    turnId: "turn-one",
    revision: 1,
  });
  expect(journal.effectBatch()).toHaveLength(1);
  expect(journal.snapshot().recentOperations).toHaveLength(1);
  expect(journal.snapshot().sessions[0]?.recentReceipts).toHaveLength(1);
  expect(() => journal.executeOperation({ ...command, text: "different" })).toThrow("idempotency key already belongs to another request");
  expect(() => journal.executeOperation({ ...command, idempotencyKey: "send-key-two" })).toThrow("operationId already belongs to another request");
  journal.close();
});

test("structured send receipts advance through the durable delivery lifecycle", () => {
  const dir = sandbox("structured-delivery-lifecycle");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), {
    maxEvents: 100,
    now: () => 100,
    structuredHosts: true,
  });
  journal.append({
    scope: runtimeScope("session", "conv-one"),
    kind: "session-status",
    payload: {
      conversationId: "conv-one",
      sessionKey: { engine: "codex", sessionId: "thread-one" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      artifactPath: "/sessions/one.jsonl",
      capabilities: { steer: true, structuredAttention: true },
    },
  });

  const queued = journal.executeOperation({
    kind: "send",
    operationId: "op-lifecycle",
    idempotencyKey: "key-lifecycle",
    conversationId: "conv-one",
    text: "hello",
    policy: "queue",
  });
  expect(queued.receipt.status).toBe("queued");
  expect(journal.effectBatch()).toHaveLength(1);

  const delivering = journal.transitionOperation("op-lifecycle", "delivering");
  expect(delivering.receipt.status).toBe("delivering");
  expect(journal.effectBatch()).toHaveLength(1);

  const retryQueued = journal.transitionOperation("op-lifecycle", "queued", { reason: "dead-host" });
  expect(retryQueued.receipt).toMatchObject({ status: "queued", reason: "dead-host", revision: 3 });
  const retryDelivering = journal.transitionOperation("op-lifecycle", "delivering");
  expect(retryDelivering.receipt).toMatchObject({ status: "delivering", reason: null, revision: 4 });

  const delivered = journal.transitionOperation("op-lifecycle", "delivered", { turnId: "turn-one" });
  expect(delivered.receipt).toMatchObject({ status: "delivered", turnId: "turn-one", revision: 5 });
  expect(journal.effectBatch()).toEqual([]);
  expect(journal.snapshot().sessions[0]?.recentReceipts[0]).toMatchObject({ status: "delivered" });
  journal.close();
});

test("a terminal structured send retries from its full journaled request", () => {
  const dir = sandbox("structured-delivery-retry");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: true });
  journal.append({
    scope: runtimeScope("session", "conv-retry"),
    kind: "session-status",
    payload: {
      conversationId: "conv-retry",
      sessionKey: { engine: "codex", sessionId: "thread-retry" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  const text = "retry the complete payload ".repeat(20);
  journal.executeOperation({
    kind: "send",
    operationId: "op-retry-failed",
    idempotencyKey: "key-retry-failed",
    conversationId: "conv-retry",
    text,
    policy: "queue",
  });
  journal.transitionOperation("op-retry-failed", "delivering");
  journal.transitionOperation("op-retry-failed", "failed", { reason: "engine write failed" });
  expect(journal.effectBatch()).toEqual([]);

  const retried = journal.retryOperation("op-retry-failed");

  expect(retried.receipt).toMatchObject({ status: "queued", reason: null, revision: 4 });
  expect(journal.effectBatch()).toEqual([
    expect.objectContaining({
      id: "effect:op-retry-failed",
      kind: "runtime.send",
      payload: expect.objectContaining({ operationId: "op-retry-failed", text }),
    }),
  ]);
  journal.close();
});

test("filtered effect batches skip a full page of unrelated pending work", () => {
  const dir = sandbox("filtered-effect-batch");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: true });
  for (let index = 0; index < 100; index += 1) {
    journal.append({
      scope: runtimeScope("operation", `spawn-${index}`),
      kind: "receipt",
      payload: { operationId: `spawn-${index}` },
      effect: { id: `effect:spawn-${index}`, kind: "runtime.spawn", payload: { operationId: `spawn-${index}` } },
    });
  }
  journal.append({
    scope: runtimeScope("operation", "send-after-spawns"),
    kind: "receipt",
    payload: { operationId: "send-after-spawns" },
    effect: {
      id: "effect:send-after-spawns",
      kind: "runtime.send",
      payload: { operationId: "send-after-spawns", conversationId: "conv-one", text: "deliver me" },
    },
  });

  expect(journal.effectBatch()).toHaveLength(100);
  expect(journal.effectBatch(100, ["runtime.send", "runtime.steer"])).toEqual([
    expect.objectContaining({ id: "effect:send-after-spawns", kind: "runtime.send" }),
  ]);
  journal.close();
});

test("a delivering transition persists its derived turn fence in the outbox", () => {
  const dir = sandbox("structured-delivery-fence");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: true });
  journal.append({
    scope: runtimeScope("session", "conv-fence"),
    kind: "session-status",
    payload: {
      conversationId: "conv-fence",
      sessionKey: { engine: "codex", sessionId: "thread-fence" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "running",
      activeTurnId: "turn-old",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.executeOperation({
    kind: "send",
    operationId: "op-fenced-send",
    idempotencyKey: "key-fenced-send",
    conversationId: "conv-fence",
    text: "amend",
    policy: "steer-if-active",
  });

  journal.transitionOperation("op-fenced-send", "delivering", { turnId: "turn-old" });

  expect(journal.effectBatch()).toEqual([
    expect.objectContaining({
      id: "effect:op-fenced-send",
      payload: expect.objectContaining({ turnId: "turn-old" }),
    }),
  ]);

  journal.transitionOperation("op-fenced-send", "failed", { reason: "engine write failed" });
  journal.retryOperation("op-fenced-send");

  expect(journal.effectBatch()).toEqual([
    expect.objectContaining({
      id: "effect:op-fenced-send",
      payload: expect.objectContaining({ turnId: "turn-old" }),
    }),
  ]);
  journal.close();
});

test("answer and interrupt operations update projected attention and turn axes", () => {
  const dir = sandbox("answer-interrupt");
  const filename = path.join(dir, "events.sqlite");
  const journal = new RuntimeJournal(filename, { maxEvents: 100, now: () => 100 });
  journal.append({
    scope: runtimeScope("session", "conv-one"),
    kind: "session-status",
    payload: {
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "running",
      activeTurnId: "turn-one",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.append({
    scope: runtimeScope("session", "conv-one"),
    kind: "attention",
    payload: {
      id: "attention-one",
      conversationId: "conv-one",
      kind: "question",
      state: "open",
      unowned: false,
      createdAt: "2026-07-10T00:00:00.000Z",
      request: { question: { prompt: "Proceed?" } },
      turnId: "turn-one",
    },
  });
  journal.executeOperation({
    kind: "answer",
    conversationId: "conv-one",
    operationId: "op-answer-one",
    idempotencyKey: "answer-one",
    attentionId: "attention-one",
    resolution: { option: "yes" },
  });
  journal.executeOperation({
    kind: "interrupt",
    conversationId: "conv-one",
    operationId: "op-interrupt-one",
    idempotencyKey: "interrupt-one",
    turnId: "turn-one",
  });
  const snapshot = journal.snapshot();
  expect(snapshot.attentions[0]?.state).toBe("resolving");
  expect(snapshot.sessions[0]?.attentionIds).toEqual(["attention-one"]);
  expect(snapshot.sessions[0]?.turn).toBe("interrupt_requested");
  const database = new Database(filename);
  const persisted = database.query<{ request_json: string; payload_json: string }, []>("SELECT request_json, payload_json FROM operations JOIN outbox ON outbox.id = 'effect:' || operations.operation_id WHERE operations.operation_id = 'op-answer-one'").get();
  database.close();
  expect(persisted?.request_json).not.toContain('"option":"yes"');
  expect(persisted?.payload_json).not.toContain('"option":"yes"');
  expect(journal.effectBatch().find((effect) => effect.id === "effect:op-answer-one")?.payload.resolution).toEqual({ option: "yes" });
  const answered = journal.completeOperation("op-answer-one", "answered", { turnId: "turn-one" });
  const completedAgain = journal.completeOperation("op-answer-one", "answered", { turnId: "turn-one" });
  expect(completedAgain).toEqual({ ...answered, replayed: true });
  expect(journal.snapshot().attentions[0]?.state).toBe("resolved");
  expect(journal.snapshot().sessions[0]?.attentionIds).toEqual([]);
  const terminalAnswer = journal.executeOperation({
    kind: "answer",
    conversationId: "conv-one",
    operationId: "op-answer-two",
    idempotencyKey: "answer-two",
    attentionId: "attention-one",
    resolution: { option: "yes" },
  });
  expect(terminalAnswer.receipt.status).toBe("answered");
  expect(journal.effectBatch().some((effect) => effect.id === "effect:op-answer-two")).toBe(false);
  const completedDatabase = new Database(filename);
  const completedPayload = completedDatabase.query<{ payload_json: string }, [string]>("SELECT payload_json FROM outbox WHERE id = ?").get("effect:op-answer-one");
  completedDatabase.close();
  expect(completedPayload?.payload_json).toBe("{}");
  journal.close();
});

test("recovering sessions reject new actuation", () => {
  const dir = sandbox("recovering-actuation");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  journal.append({
    scope: runtimeScope("session", "conv-one"),
    kind: "session-status",
    payload: {
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "running",
      activeTurnId: "turn-one",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.append({ scope: runtimeScope("session", "conv-one"), kind: "host.disconnected", payload: {} });
  const send = journal.executeOperation({
    kind: "send",
    conversationId: "conv-one",
    operationId: "op-send-recovering",
    idempotencyKey: "send-recovering",
    text: "continue",
  });
  const interrupt = journal.executeOperation({
    kind: "interrupt",
    conversationId: "conv-one",
    operationId: "op-interrupt-recovering",
    idempotencyKey: "interrupt-recovering",
    turnId: "turn-one",
  });
  expect(send.receipt).toMatchObject({ status: "rejected", reason: "no-claim" });
  expect(interrupt.receipt).toMatchObject({ status: "rejected", reason: "no-claim" });
  expect(journal.effectBatch()).toEqual([]);
  journal.close();
});

test("spawn acceptance creates the placeholder session and lineage edge atomically", () => {
  const dir = sandbox("spawn-lineage");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  const command = {
    kind: "spawn" as const,
    conversationId: "child-one",
    operationId: "op-spawn-one",
    idempotencyKey: "spawn-one",
    engine: "codex" as const,
    cwd: "/repo",
    prompt: "Implement the task",
    accountId: "account-one",
    parentConversationId: "parent-one",
    sessionId: "thread-child-one",
  };
  journal.executeOperation(command);
  journal.executeOperation(command);
  const snapshot = journal.snapshot();
  expect(snapshot.sessions).toHaveLength(1);
  expect(snapshot.sessions[0]).toMatchObject({
    conversationId: "child-one",
    sessionKey: { engine: "codex", sessionId: "thread-child-one" },
    hostKind: "codex-app-server",
    host: "registering",
    parentConversationId: "parent-one",
    accountId: "account-one",
  });
  expect(snapshot.edges).toEqual([{
    id: "edge-op-spawn-one",
    kind: "viewer_spawn",
    parentConversationId: "parent-one",
    childConversationId: "child-one",
    createdByOperationId: "op-spawn-one",
    revision: 1,
    createdAt: "1970-01-01T00:00:00.100Z",
  }]);
  expect(journal.effectBatch()).toHaveLength(1);
  journal.close();
});

test("runtime host advances and publishes a flow from a terminal event without file polling", async () => {
  const dir = sandbox("flow-consumer");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  const calls: string[] = [];
  const host = new RuntimeHost(journal, {
    flowReady: (flowId, note) => {
      calls.push(`${flowId}:${note}`);
      return { id: flowId, state: "spawn_pending" } as unknown as Flow;
    },
    workflowStageCompleted: () => undefined,
    taskDeliveryAcknowledged: () => undefined,
  });
  await host.handle({
    id: "session-claim",
    method: "append",
    params: {
      event: {
        scope: runtimeScope("session", "implementer"),
        kind: "session-status",
        payload: {
          hostKind: "codex-app-server",
          host: "hosted",
          turn: "running",
          flowId: "flow-one",
          capabilities: { steer: true, structuredAttention: true },
        },
      },
    },
  });
  const response = await host.handle({
    id: "request-one",
    method: "append",
    params: {
      event: {
        scope: runtimeScope("session", "implementer"),
        kind: "turn.completed",
        producerKey: "terminal-flow-one",
        payload: { finalAssistantOutput: "REVIEW_READY: finished" },
      },
    },
  });
  await host.handle({
    id: "request-two",
    method: "append",
    params: {
      event: {
        scope: runtimeScope("session", "implementer"),
        kind: "turn.completed",
        producerKey: "terminal-flow-one",
        payload: { finalAssistantOutput: "REVIEW_READY: finished" },
      },
    },
  });
  expect(response.ok).toBe(true);
  expect(calls).toEqual(["flow-one:REVIEW_READY: finished"]);
  expect(journal.snapshot().flows[0]).toMatchObject({ revision: 1, value: { id: "flow-one", state: "spawn_pending" } });
  journal.close();
});

test("runtime host retries an uncheckpointed consumer after a committed event", async () => {
  const dir = sandbox("consumer-retry");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  let attempts = 0;
  const host = new RuntimeHost(journal, {
    flowReady: (flowId) => {
      attempts += 1;
      if (attempts === 1) throw new Error("consumer interrupted");
      return { id: flowId, state: "spawn_pending" } as unknown as Flow;
    },
    workflowStageCompleted: () => undefined,
    taskDeliveryAcknowledged: () => undefined,
  });
  const request = {
    method: "append" as const,
    params: {
      event: {
        scope: runtimeScope("session", "implementer"),
        kind: "turn.completed",
        producerKey: "terminal-consumer-retry",
        payload: { flowId: "flow-one", readyNote: "REVIEW_READY: finished" },
      },
    },
  };
  // The event commit remains successful even when its asynchronous consumer
  // needs another pass; callers must never retry an already-committed append.
  expect((await host.handle({ id: "request-one", ...request })).ok).toBe(true);
  expect((await host.handle({ id: "request-two", ...request })).ok).toBe(true);
  expect((await host.handle({ id: "request-three", ...request })).ok).toBe(true);
  expect(attempts).toBe(2);
  expect(journal.snapshot().flows[0]).toMatchObject({ value: { id: "flow-one", state: "spawn_pending" } });
  journal.close();
});

test("runtime host quarantines a deterministic consumer failure without poisoning commands", async () => {
  const journal = new RuntimeJournal(path.join(sandbox("consumer-poison"), "events.sqlite"), { maxEvents: 100, now: () => 100 });
  let attempts = 0;
  const host = new RuntimeHost(journal, {
    flowReady: () => { attempts += 1; throw new Error("poison event"); },
    workflowStageCompleted: () => undefined,
    taskDeliveryAcknowledged: () => undefined,
  });
  const event = {
    scope: runtimeScope("session", "implementer"),
    kind: "turn.completed",
    producerKey: "terminal-consumer-poison",
    payload: { flowId: "flow-one", readyNote: "REVIEW_READY: poison" },
  };
  for (let index = 0; index < 4; index += 1) {
    expect((await host.handle({ id: `request-${index}`, method: "append", params: { event } })).ok).toBe(true);
  }
  expect(attempts).toBe(3);
  journal.close();
});

test("runtime host serializes concurrent duplicate consumer delivery", async () => {
  const dir = sandbox("consumer-concurrency");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  let calls = 0;
  let releaseConsumer!: () => void;
  let markStarted!: () => void;
  const consumerStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const consumerGate = new Promise<void>((resolve) => { releaseConsumer = resolve; });
  const host = new RuntimeHost(journal, {
    flowReady: async (flowId) => {
      calls += 1;
      markStarted();
      await consumerGate;
      return { id: flowId, state: "spawn_pending" } as unknown as Flow;
    },
    workflowStageCompleted: () => undefined,
    taskDeliveryAcknowledged: () => undefined,
  });
  const event = {
    scope: runtimeScope("session", "implementer"),
    kind: "turn.completed",
    producerKey: "terminal-concurrent",
    payload: { flowId: "flow-one", readyNote: "REVIEW_READY: finished" },
  };
  const first = host.handle({ id: "request-one", method: "append", params: { event } });
  await consumerStarted;
  const second = host.handle({ id: "request-two", method: "append", params: { event } });
  releaseConsumer();
  const responses = await Promise.all([first, second]);
  expect(responses.every((response) => response.ok)).toBe(true);
  expect(calls).toBe(1);
  expect(journal.snapshot().flows).toHaveLength(1);
  journal.close();
});

test("runtime host recovers committed consumer work after restart", async () => {
  const dir = sandbox("consumer-restart");
  const filename = path.join(dir, "events.sqlite");
  const journal = new RuntimeJournal(filename, { maxEvents: 100, now: () => 100 });
  journal.append({
    scope: runtimeScope("session", "implementer"),
    kind: "session-status",
    payload: {
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "running",
      flowId: "flow-one",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  journal.append({
    scope: runtimeScope("session", "implementer"),
    kind: "turn.completed",
    producerKey: "terminal-before-restart",
    payload: { finalAssistantOutput: "REVIEW_READY: recovered" },
  });
  journal.close();

  const reopened = new RuntimeJournal(filename, { maxEvents: 100, now: () => 200 });
  const calls: string[] = [];
  const host = new RuntimeHost(reopened, {
    flowReady: (flowId, note) => {
      calls.push(`${flowId}:${note}`);
      return { id: flowId, state: "spawn_pending" } as unknown as Flow;
    },
    workflowStageCompleted: () => undefined,
    taskDeliveryAcknowledged: () => undefined,
  });
  expect(await host.recoverConsumers()).toBe(2);
  expect(await host.recoverConsumers()).toBe(0);
  expect(calls).toEqual(["flow-one:REVIEW_READY: recovered"]);
  expect(reopened.snapshot().flows[0]).toMatchObject({ value: { id: "flow-one", state: "spawn_pending" } });
  reopened.close();
});

test("journal waiters wake on the next committed event", async () => {
  const dir = sandbox("waiter");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  const waiting = journal.waitForEvents(0, 1_000);
  journal.append({ scope: runtimeScope("system", "runtime"), kind: "files.revision", payload: { filesRevision: 1 } });
  const replay = await waiting;
  expect(replay.reset).toBe(false);
  expect(replay.events.map((event) => event.seq)).toEqual([1]);
  journal.close();
});

test("runtime host epochs advance durably across host claims", () => {
  const dir = sandbox("host-epoch");
  const filename = path.join(dir, "events.sqlite");
  const journal = new RuntimeJournal(filename, { maxEvents: 100, now: () => 100 });
  expect(journal.claimHostEpoch()).toBe(2);
  expect(journal.snapshot().runtime).toEqual({ hostEpoch: 2, health: "ready" });
  journal.close();
  const reopened = new RuntimeJournal(filename, { maxEvents: 100, now: () => 100 });
  expect(reopened.claimHostEpoch()).toBe(3);
  reopened.close();
});

test("replay batches stay within the SSE backpressure byte ceiling", () => {
  const dir = sandbox("backpressure");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  for (let index = 0; index < 50; index += 1) {
    journal.append({
      scope: runtimeScope("system", "load"),
      kind: "limits",
      payload: { index, data: "x".repeat(8_000) },
      producerKey: `load:${index}`,
    });
  }
  const first = journal.replay(0, 128);
  expect(Buffer.byteLength(JSON.stringify(first.events))).toBeLessThanOrEqual(256 * 1024);
  expect(first.events.length).toBeLessThan(50);
  const second = journal.replay(first.events.at(-1)!.seq, 128);
  expect(second.events[0]?.seq).toBe(first.events.at(-1)!.seq + 1);
  journal.close();
});

test("journal compaction emits a deterministic retention reset and leaves an anchor-verified tail", () => {
  const dir = sandbox("compact");
  const filename = path.join(dir, "events.sqlite");
  const journal = new RuntimeJournal(filename, { maxEvents: 2, now: () => 100 });
  const first = journal.append({ scope: runtimeScope("session", "one"), kind: "item.completed", payload: { i: 0 }, producerKey: "compact-dedupe" });
  for (let i = 1; i < 4; i += 1) journal.append({ scope: runtimeScope("session", "one"), kind: "item.completed", payload: { i } });
  expect(journal.replay(0)).toEqual({ reset: true, floorSeq: 2, events: [] });
  expect(journal.replay(999)).toEqual({ reset: true, floorSeq: 2, events: [] });
  expect(journal.replay(2).events.map((event) => event.seq)).toEqual([3, 4]);
  expect(journal.append({ scope: runtimeScope("session", "one"), kind: "item.completed", payload: { i: 0 }, producerKey: "compact-dedupe" }).eventId).toBe(first.eventId);
  journal.close();
  const reopened = new RuntimeJournal(filename, { maxEvents: 2 });
  expect(reopened.replay(2).events).toHaveLength(2);
  reopened.close();
});

test("restart reconstructs identical sessions, receipts, flow state, and graph", () => {
  const dir = sandbox("restart-equivalence");
  const filename = path.join(dir, "events.sqlite");
  const command = {
    kind: "spawn" as const,
    conversationId: "child-one",
    operationId: "op-spawn-one",
    idempotencyKey: "spawn-one",
    engine: "codex" as const,
    cwd: "/repo",
    prompt: "Implement",
    parentConversationId: "parent-one",
  };
  const journal = new RuntimeJournal(filename, { maxEvents: 100, now: () => 100 });
  journal.executeOperation(command);
  journal.append({
    scope: runtimeScope("flow", "flow-one"),
    kind: "flow.state",
    payload: { id: "flow-one", state: "approved" },
    producerKey: "flow-one-approved",
  });
  const before = journal.snapshot();
  journal.close();

  const reopened = new RuntimeJournal(filename, { maxEvents: 100, now: () => 100 });
  expect(reopened.snapshot()).toEqual(before);
  expect(reopened.executeOperation(command).receipt).toEqual(before.recentOperations[0]);
  reopened.close();
});

test("rejected appends leave sequence, scope revisions, and projections unchanged", () => {
  const dir = sandbox("partial-write");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { maxEvents: 100, now: () => 100 });
  journal.append({ scope: runtimeScope("system", "runtime"), kind: "files.revision", payload: { filesRevision: 1 } });
  const before = journal.snapshot();
  expect(() => journal.append({
    scope: runtimeScope("system", "runtime"),
    kind: "limits",
    payload: { oversized: "x".repeat(17 * 1024) },
  })).toThrow("runtime event payload exceeds 16 KiB");
  expect(() => journal.append({
    scope: runtimeScope("system", "runtime"),
    kind: "limits",
    payload: "invalid" as unknown as Record<string, unknown>,
  })).toThrow("runtime event payload is invalid");
  expect(() => journal.append({
    scope: { type: "invalid", id: "runtime" } as never,
    kind: "limits",
    payload: {},
  })).toThrow("runtime scope type is invalid");
  expect(journal.snapshot()).toEqual(before);
  journal.close();
});

test("journal detects a modified hash chain and fails closed", () => {
  const dir = sandbox("fault");
  const filename = path.join(dir, "events.sqlite");
  const journal = new RuntimeJournal(filename);
  journal.append({ scope: runtimeScope("session", "one"), kind: "turn.started", payload: {} });
  journal.close();
  const database = new Database(filename);
  database.exec("UPDATE events SET producer_kind = 'tampered' WHERE seq = 1");
  database.close();
  const corrupted = new RuntimeJournal(filename);
  expect(corrupted.snapshot().runtime.health).toBe("read_only_fault");
  expect(() => corrupted.append({ scope: runtimeScope("session", "one"), kind: "turn.completed", payload: {} })).toThrow(RuntimeJournalFault);
  corrupted.close();
});

test("Unix socket host isolates a singleton writer and serves a fake Viewer client", async () => {
  const dir = sandbox("socket");
  const socketPath = path.join(dir, "runtime.sock");
  const fence = new RuntimeHostFence(`${socketPath}.lock`);
  fence.acquire();
  expect(() => new RuntimeHostFence(`${socketPath}.lock`).acquire()).toThrow("singleton fence");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"));
  const server = serveRuntimeHost(socketPath, new RuntimeHost(journal));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const client = new UnixRuntimeHostClient(socketPath);
  await client.append({
    scope: runtimeScope("session", "one"),
    kind: "session-status",
    payload: {
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "running",
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: "turn-one",
    },
  });
  expect((await client.snapshot()).snapshotSeq).toBe(1);
  const operation = await client.command({
    kind: "send",
    conversationId: "one",
    operationId: "op-socket-one",
    idempotencyKey: "socket-send-one",
    text: "continue",
    policy: "steer-if-active",
  });
  expect(operation.receipt.status).toBe("pending");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  journal.close();
  fence.release();
});

test("structured queue controls cross the local runtime socket", async () => {
  const dir = sandbox("structured-socket");
  const socketPath = path.join(dir, "runtime.sock");
  const journal = new RuntimeJournal(path.join(dir, "events.sqlite"), { structuredHosts: true });
  journal.append({
    scope: runtimeScope("session", "one"),
    kind: "session-status",
    payload: {
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  const server = serveRuntimeHost(socketPath, new RuntimeHost(journal, undefined, undefined, true));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const client = new UnixRuntimeHostClient(socketPath);
  await client.append({
    scope: runtimeScope("session", "one"),
    kind: "limits",
    payload: { conversationId: "one", snapshot: {} },
    producer: { kind: "codex-app-server", eventKey: "engine-host:codex:thread-one:7" },
  });
  expect(await client.producerCursor("codex-app-server", "engine-host:codex:thread-one:")).toBe(7);
  const operation = await client.command({
    kind: "send",
    conversationId: "one",
    operationId: "op-socket-queue",
    idempotencyKey: "socket-queue-key",
    text: "continue",
    policy: "queue",
  });

  expect(operation.receipt.status).toBe("queued");
  const initialEffects = await client.effectBatch();
  expect(initialEffects).toHaveLength(1);
  expect(await client.effectBatch(undefined, initialEffects[0]!.eventSeq)).toEqual([]);
  await expect(client.effectBatch(undefined, -1)).rejects.toThrow("runtime effect cursor is invalid");
  expect((await client.transitionOperation("op-socket-queue", "delivering")).receipt.status).toBe("delivering");
  expect((await client.transitionOperation("op-socket-queue", "failed", { reason: "write failed" })).receipt.status).toBe("failed");
  expect(await client.effectBatch()).toEqual([]);
  expect((await client.retryOperation("op-socket-queue")).receipt.status).toBe("queued");
  expect(await client.effectBatch(["runtime.send", "runtime.steer"])).toHaveLength(1);
  expect((await client.transitionOperation("op-socket-queue", "delivering")).receipt.status).toBe("delivering");
  expect((await client.transitionOperation("op-socket-queue", "delivered", { turnId: "turn-one" })).receipt.status).toBe("delivered");
  expect(await client.effectBatch()).toEqual([]);

  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  journal.close();
});

test("runtime host fencing reclaims a stale process identity", () => {
  const dir = sandbox("stale-fence");
  const filename = path.join(dir, "runtime.lock");
  fs.writeFileSync(filename, JSON.stringify({ pid: 42, startIdentity: "42:old" }), { mode: 0o600 });
  const fence = new RuntimeHostFence(filename, () => false);
  fence.acquire();
  expect(JSON.parse(fs.readFileSync(filename, "utf8"))).toMatchObject({ pid: process.pid });
  fence.release();
  expect(fs.existsSync(filename)).toBe(false);
});
