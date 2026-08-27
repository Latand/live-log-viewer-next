/**
 * Issue #1213 — giving `delivery-uncertain` an owner the operator can be.
 *
 * A send parked at a turn boundary keeps a PENDING journal effect and a
 * `delivery-uncertain` registry reservation, and nothing terminalizes either
 * while the conversation is live. These tests pin the exit: abandoning the
 * operation retires the durable effect in the same journal transaction that
 * fails the receipt, so the message can never be handed over afterwards — which
 * is what makes the operator's Retry structurally unable to duplicate it.
 *
 * Runs against a journal + registry inside a throwaway directory. Nothing here
 * touches the operator's state directory or any live host.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { NextRequest } from "next/server";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { RuntimeJournal } from "@/runtime-host/journal";

import type { RuntimeHostClient } from "./client";
import { DELIVERY_UNCONFIRMED_REASON, handleRuntimeAbandon, handleRuntimeRetry } from "./http";

const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
});

const SESSION_ID = "dddddddd-dddd-0ddd-0ddd-dddddddddddd";

function scenario(label: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `llv-1213-${label}-`));
  directories.push(directory);
  const transcript = path.join(directory, `${SESSION_ID}.jsonl`);
  const registry = new AgentRegistry(path.join(directory, "registry.json"));
  const profile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: "codex",
    path: transcript,
    accountId: "account-a",
    launchProfile: profile,
    turn: { state: "busy", source: "empty", terminalAt: null },
    observedAt: "2026-08-27T10:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(transcript)!;
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = {
    operationStatus: async (operationId: string, options?: { currentRetryLeaf?: boolean }) =>
      (options?.currentRetryLeaf ? journal.currentRetryResult(operationId) : journal.operationResult(operationId)),
    transitionOperation: async (...args: Parameters<RuntimeHostClient["transitionOperation"]>) =>
      journal.transitionOperation(...args),
    retryOperation: async (...args: Parameters<RuntimeHostClient["retryOperation"]>) => journal.retryOperation(...args),
    effectBatch: async (kinds?: readonly string[], afterEventSeq?: number) =>
      journal.effectBatch(100, kinds, afterEventSeq),
  } as RuntimeHostClient;

  /* The busy structured host the operator was talking to: hosted, mid-turn. */
  journal.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    producer: { kind: "codex-app-server", eventKey: `structured-host:${SESSION_ID}:1` },
    payload: {
      conversationId: conversation.id,
      sessionKey: { engine: "codex", sessionId: SESSION_ID },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "running",
      provenance: "structured",
      accountId: "account-a",
      parentConversationId: null,
      cwd: directory,
      artifactPath: transcript,
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: "turn-live",
    },
  });

  /* The operator's message, exactly as the composer admits one: a held
     reservation claimed into `delivery-uncertain` and a durable send effect the
     delivery queue will drain at the next turn boundary. */
  const admit = (text: string, clientMessageId: string) => {
    const operationId = `op_${clientMessageId}`;
    const reservation = registry.holdDelivery(
      conversation.id,
      text,
      clientMessageId,
      "text",
      [],
      null,
      { operationId, kind: "send" },
    );
    const claimed = registry.beginDeliveryAttempt(reservation.id, reservation.generationId!)!;
    const result = journal.executeOperation({
      kind: "send",
      conversationId: conversation.id,
      operationId,
      idempotencyKey: clientMessageId,
      text,
      policy: "queue",
    });
    return { operationId, reservationId: claimed.id, receipt: result.receipt };
  };

  const pendingSendOperationIds = () =>
    journal.effectBatch(100, ["runtime.send"], 0).map((effect) => String(effect.payload.operationId));

  return { conversation, registry, journal, client, admit, pendingSendOperationIds };
}

const post = (operationId: string, body?: unknown) => new NextRequest(
  `http://127.0.0.1/api/runtime/operations/${operationId}`,
  {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  },
);

const del = (operationId: string) => new NextRequest(
  `http://127.0.0.1/api/runtime/operations/${operationId}`,
  { method: "DELETE", headers: { host: "127.0.0.1" } },
);

test("#1213 a delivery parked at a turn boundary is un-owned until the operator discards it", () => {
  const world = scenario("unowned");
  const admitted = world.admit("status please", "msg-unowned");

  /* The defect, stated as a fact: the reservation is `delivery-uncertain` with
     an attempt spent, the receipt never left `queued`, and the durable effect
     is still pending — which is why the composer spins forever. */
  expect(world.registry.pendingDeliveries(world.conversation.id)).toMatchObject([
    { state: "delivery-uncertain", attempts: 1, deliveredAt: null },
  ]);
  expect(admitted.receipt.status).toBe("queued");
  expect(world.pendingSendOperationIds()).toEqual([admitted.operationId]);
});

test("#1213 discarding an unconfirmed delivery terminalizes it and retires its durable effect", async () => {
  const world = scenario("discard");
  const admitted = world.admit("status please", "msg-discard");

  const response = await handleRuntimeAbandon(del(admitted.operationId), admitted.operationId, {
    enabled: () => true,
    client: () => world.client,
    kick: () => {},
    registry: () => world.registry,
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    receipt: { status: "failed", reason: DELIVERY_UNCONFIRMED_REASON },
  });
  /* The message can no longer be handed over: the same transaction that failed
     the receipt marked the outbox row completed. */
  expect(world.pendingSendOperationIds()).toEqual([]);
  expect(world.registry.pendingDeliveries(world.conversation.id)).toMatchObject([
    { state: "failed", deliveredAt: null },
  ]);
});

test("#1213 discarding an already-delivered message changes nothing and reports the delivery", async () => {
  const world = scenario("delivered");
  const admitted = world.admit("status please", "msg-delivered");
  /* The 21-minute case: the queue reached a turn boundary and handed it over. */
  world.journal.transitionOperation(admitted.operationId, "delivering", { turnId: "turn-1" });
  world.journal.transitionOperation(admitted.operationId, "delivered", { turnId: "turn-1" });
  world.registry.recordDeliveryOutcome(admitted.reservationId, "delivered");

  const response = await handleRuntimeAbandon(del(admitted.operationId), admitted.operationId, {
    enabled: () => true,
    client: () => world.client,
    kick: () => {},
    registry: () => world.registry,
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ receipt: { status: "delivered" } });
  expect(world.registry.pendingDeliveries(world.conversation.id)).toEqual([]);
});

test("#1213 retrying an unconfirmed delivery abandons it first, so exactly one send stays deliverable", async () => {
  const world = scenario("retry");
  const admitted = world.admit("status please", "msg-retry");

  const response = await handleRuntimeRetry(post(admitted.operationId, { abandonUnconfirmed: true }), admitted.operationId, {
    enabled: () => true,
    client: () => world.client,
    kick: () => {},
    registry: () => world.registry,
    recover: async () => ({
      target: null,
      path: "/retry-1213.jsonl",
      conversationId: world.conversation.id,
      spawned: false,
    }),
    republish: async () => true,
  });

  expect(response.status).toBe(202);
  const body = await response.json() as { operationId: string; receipt: { status: string } };
  expect(body.operationId).not.toBe(admitted.operationId);
  /* The original attempt is retired and only the replacement is deliverable:
     a retry cannot put the same message into the agent's turn twice. */
  expect(world.pendingSendOperationIds()).toEqual([body.operationId]);
  expect(world.journal.operationResult(admitted.operationId)?.receipt.status).toBe("failed");
});

test("#1213 a retry loses the race to a delivery that landed first, and never sends again", async () => {
  const world = scenario("race");
  const admitted = world.admit("status please", "msg-race");
  world.journal.transitionOperation(admitted.operationId, "delivering", { turnId: "turn-1" });
  world.journal.transitionOperation(admitted.operationId, "delivered", { turnId: "turn-1" });

  let retries = 0;
  const response = await handleRuntimeRetry(post(admitted.operationId, { abandonUnconfirmed: true }), admitted.operationId, {
    enabled: () => true,
    client: () => ({
      ...world.client,
      retryOperation: async () => {
        retries += 1;
        throw new Error("a delivered message reached retry admission");
      },
    }) as RuntimeHostClient,
    kick: () => {},
    registry: () => world.registry,
    recover: async () => { throw new Error("a delivered message reached host recovery"); },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ receipt: { status: "delivered" } });
  expect(retries).toBe(0);
});

test("#1213 a hand-over already under way is never abandoned, and never duplicated", async () => {
  /* The race the operator cannot see: the delivery queue writes `delivering`
     BEFORE `host.send`, so a message can be in front of the agent while its
     receipt still looks unsettled. Failing it here would retire the effect
     mid-flight — the agent keeps the message, the real delivery can no longer
     record itself, and a replacement delivers the same text a second time. */
  const world = scenario("handover");
  const admitted = world.admit("status please", "msg-handover");
  world.journal.transitionOperation(admitted.operationId, "delivering", { turnId: "turn-1" });

  const deps = {
    enabled: () => true,
    client: () => world.client,
    kick: () => {},
    registry: () => world.registry,
    recover: async () => { throw new Error("a hand-over in flight reached host recovery"); },
  };

  const discarded = await handleRuntimeAbandon(del(admitted.operationId), admitted.operationId, deps);
  expect(discarded.status).toBe(409);
  expect(await discarded.json()).toMatchObject({ handover: true, receipt: { status: "delivering" } });

  const retried = await handleRuntimeRetry(
    post(admitted.operationId, { abandonUnconfirmed: true }),
    admitted.operationId,
    deps,
  );
  expect(retried.status).toBe(409);
  expect(await retried.json()).toMatchObject({ handover: true });

  /* Exactly one deliverable send, still the original, and its receipt is
     untouched — so the hand-over the queue is running can still record its own
     outcome. */
  expect(world.pendingSendOperationIds()).toEqual([admitted.operationId]);
  expect(world.journal.operationResult(admitted.operationId)?.receipt.status).toBe("delivering");
  expect(world.journal.transitionOperation(admitted.operationId, "delivered", { turnId: "turn-1" }).receipt.status)
    .toBe("delivered");
});

test("#1213 a transition that faults is never reported as a delivery that landed", async () => {
  /* "The message arrived" is the one answer that stops the operator acting. It
     may only be given when a terminal receipt proves it — a journal fault over
     a receipt still sitting `queued` proves nothing, and answering 200 there
     would leave the message undelivered and the operator told otherwise. */
  const world = scenario("fault");
  const admitted = world.admit("status please", "msg-fault");

  const response = await handleRuntimeAbandon(del(admitted.operationId), admitted.operationId, {
    enabled: () => true,
    client: () => ({
      ...world.client,
      transitionOperation: async () => { throw new Error("database is locked"); },
    }) as RuntimeHostClient,
    kick: () => {},
    registry: () => world.registry,
  });

  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: "database is locked" });
  expect(world.pendingSendOperationIds()).toEqual([admitted.operationId]);
  expect(world.registry.pendingDeliveries(world.conversation.id)).toMatchObject([
    { state: "delivery-uncertain", deliveredAt: null },
  ]);
});

test("#1213 an in-flight operation still refuses a retry that did not ask to abandon it", async () => {
  const world = scenario("guard");
  const admitted = world.admit("status please", "msg-guard");

  const response = await handleRuntimeRetry(post(admitted.operationId), admitted.operationId, {
    enabled: () => true,
    client: () => world.client,
    kick: () => {},
    registry: () => world.registry,
    recover: async () => { throw new Error("an in-flight operation reached host recovery"); },
  });

  expect(response.status).toBe(409);
  expect(world.pendingSendOperationIds()).toEqual([admitted.operationId]);
});

test("#1213 abandon validates its target before touching the journal", async () => {
  const world = scenario("validation");
  const deps = {
    enabled: () => true,
    client: () => world.client,
    kick: () => {},
    registry: () => world.registry,
  };

  const unknown = await handleRuntimeAbandon(del("op_missing"), "op_missing", deps);
  expect(unknown.status).toBe(404);

  const crossOrigin = new NextRequest("http://127.0.0.1/api/runtime/operations/op_missing", {
    method: "DELETE",
    headers: { host: "evil.example", origin: "https://evil.example" },
  });
  expect((await handleRuntimeAbandon(crossOrigin, "op_missing", deps)).status).toBe(403);

  const invalid = await handleRuntimeAbandon(del("op bad"), "op bad", deps);
  expect(invalid.status).toBe(400);
});
