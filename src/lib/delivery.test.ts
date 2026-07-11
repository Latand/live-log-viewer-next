import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, setAgentRegistryForTests, type ConversationObservation } from "./agent/registry";
import { emptyLaunchProfile } from "./accounts/migration/contracts";
import { drainHeldDeliveries } from "./accounts/migration/coordinator";
import { cleanupFailedImageDelivery, deliverConversationMessage, migrationDeliveryOutcome, type DeliveryFailure } from "./delivery";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-delivery-test-"));
const failure: DeliveryFailure = { ok: false, outcome: "failed", error: "resume unavailable", status: 503 };

function inboxImage(name: string): string {
  const pathname = path.join(SANDBOX, name);
  fs.writeFileSync(pathname, "image");
  return pathname;
}

beforeEach(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
});

afterEach(() => setAgentRegistryForTests(null));

afterAll(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

test("removes a direct-delivery inbox image before returning its host failure", () => {
  const imagePath = inboxImage("direct.png");

  expect(cleanupFailedImageDelivery(failure, [imagePath])).toEqual(failure);
  expect(fs.existsSync(imagePath)).toBe(false);
});

test("removes a relayed-delivery inbox image before returning its host failure", () => {
  const imagePath = inboxImage("relay.png");

  expect(cleanupFailedImageDelivery(failure, [imagePath])).toEqual(failure);
  expect(fs.existsSync(imagePath)).toBe(false);
});

test("migration delivery keeps an internally held result recoverable", () => {
  expect(migrationDeliveryOutcome({ ok: true, target: "conversation_held", outcome: "held" })).toBe("held");
  expect(migrationDeliveryOutcome({ ok: true, target: "pane" })).toBe("delivered");
  expect(migrationDeliveryOutcome(failure)).toBe("failed");
});

test("image-only reservations stay request-local and never drain without the client payload", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "image-reservation-registry.json"));
  const observation: ConversationObservation = {
    engine: "codex",
    path: "/image-only.jsonl",
    accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-11T10:00:00.000Z",
  };
  registry.reconcileConversations([observation]);
  const conversation = registry.conversationForPath(observation.path)!;
  const queued = registry.holdDelivery(conversation.id, "", "image-only", "ephemeral-images");
  expect(queued).toMatchObject({ state: "assigned", text: "", payloadKind: "ephemeral-images" });
  let delivered = 0;

  await drainHeldDeliveries(conversation.id, { async deliver() { delivered += 1; return "delivered"; } }, registry);

  expect(delivered).toBe(0);
  expect(registry.pendingDeliveries(conversation.id)).toMatchObject([
    { state: "failed", text: "", payloadKind: "ephemeral-images", error: "image delivery requires client retry" },
  ]);
});

test("delivered reservations retain only a bounded idempotency window", () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "delivery-tombstones-registry.json"));
  const observation: ConversationObservation = {
    engine: "codex",
    path: "/bounded-delivery.jsonl",
    accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-11T10:00:00.000Z",
  };
  registry.reconcileConversations([observation]);
  const conversation = registry.conversationForPath(observation.path)!;
  const generationId = conversation.generations.at(-1)!.id;
  for (let index = 0; index < 105; index += 1) {
    const queued = registry.holdDelivery(conversation.id, `message body ${index}`, `message-${index}`);
    registry.beginDeliveryAttempt(queued.id, generationId);
    registry.recordDeliveryOutcome(queued.id, "delivered");
  }

  const tombstones = Object.values(registry.snapshot().heldDeliveries);
  expect(tombstones).toHaveLength(100);
  expect(tombstones.every((delivery) => delivery.state === "delivered" && delivery.text === "")).toBe(true);
  expect(registry.holdDelivery(conversation.id, "replayed body", "message-104")).toMatchObject({ state: "delivered", text: "" });
});

test("an image-only migration race stays recoverable without an orphan reservation", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "image-race-registry.json"));
  setAgentRegistryForTests(registry);
  const observation: ConversationObservation = {
    engine: "codex",
    path: "/image-race.jsonl",
    accountId: "managed",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-11T10:00:00.000Z",
  };
  registry.reconcileConversations([observation]);
  registry.commitMigrationIntent({
    engine: "codex", targetId: "default", origin: "manual", requestId: "image-race",
    expectedRevision: registry.engineRouting("codex").revision, scope: "all",
  });
  const outcome = await deliverConversationMessage({
    pid: null,
    path: observation.path,
    text: "",
    images: [{ base64: "aW1hZ2U=", mime: "image/png" }],
    clientMessageId: "image-race-message",
  });

  expect(outcome).toMatchObject({ ok: false, status: 409 });
  expect(Object.values(registry.snapshot().heldDeliveries)).toHaveLength(0);
  expect(fs.readdirSync(SANDBOX).some((name) => name.endsWith(".png"))).toBe(false);
});

test("sending to deferred history starts lazy migration and holds the message", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "registry.json"));
  setAgentRegistryForTests(registry);
  const observation: ConversationObservation = {
    engine: "codex",
    path: "/deferred-history.jsonl",
    accountId: "managed",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-11T10:00:00.000Z",
  };
  registry.reconcileConversations([observation]);
  const conversation = registry.conversationForPath(observation.path)!;
  registry.commitMigrationIntent({
    engine: "codex",
    targetId: "default",
    origin: "manual",
    requestId: "route-only-switch",
    expectedRevision: registry.engineRouting("codex").revision,
  });

  const outcome = await deliverConversationMessage({
    pid: null,
    path: observation.path,
    text: "Continue this conversation",
    images: [],
    clientMessageId: "lazy-message",
  });

  expect(outcome).toEqual({ ok: true, target: conversation.id, outcome: "held" });
  expect(registry.conversationForPath(observation.path)?.migration).toMatchObject({ targetId: "default", phase: "requested" });
  expect(registry.pendingDeliveries(registry.conversationForPath(observation.path)!.id)).toMatchObject([
    { text: "Continue this conversation", clientMessageId: "lazy-message", state: "held" },
  ]);
});

test("sending during a busy or unknown turn waits to migrate and keeps the message on the current generation", async () => {
  for (const turnState of ["busy", "unknown"] as const) {
    const registry = new AgentRegistry(path.join(SANDBOX, `${turnState}-registry.json`));
    setAgentRegistryForTests(registry);
    const observation: ConversationObservation = {
      engine: "codex",
      path: `/${turnState}-history.jsonl`,
      accountId: "managed",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
      turn: { state: turnState, source: "lifecycle", terminalAt: null },
      observedAt: "2026-07-11T10:00:00.000Z",
    };
    registry.reconcileConversations([observation]);
    registry.setEngineRouting("codex", "default");

    const outcome = await deliverConversationMessage({
      pid: null,
      path: observation.path,
      text: "Continue the active turn",
      images: [],
      clientMessageId: `during-${turnState}-turn`,
    });

    expect(outcome).not.toMatchObject({ ok: true, outcome: "held" });
    expect(registry.conversationForPath(observation.path)?.migration).toMatchObject({
      targetId: "default",
      phase: "waiting-turn",
    });
    expect(registry.pendingDeliveries(registry.conversationForPath(observation.path)!.id)).toHaveLength(0);
  }
});

test("a stopped migration survives restart and unrelated inventory revisions", async () => {
  const filename = path.join(SANDBOX, "registry.json");
  const registry = new AgentRegistry(filename);
  const observation: ConversationObservation = {
    engine: "codex",
    path: "/stopped-history.jsonl",
    accountId: "managed",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-11T10:00:00.000Z",
  };
  registry.reconcileConversations([
    observation,
    { ...observation, path: "/active-turn.jsonl", turn: { state: "busy", source: "lifecycle", terminalAt: null } },
  ]);
  const intent = registry.commitMigrationIntent({
    engine: "codex",
    targetId: "default",
    origin: "manual",
    requestId: "stopped-switch",
    expectedRevision: registry.engineRouting("codex").revision,
    scope: "active",
  });
  expect(registry.conversationForPath(observation.path)?.migration).toBeNull();
  registry.setMigrationIntentState(intent.id, "stopped", intent.revision);
  const stoppedRevision = registry.engineRouting("codex").revision;
  const unrelated = { ...observation, path: "/unrelated-turn.jsonl" };
  registry.reconcileConversations([unrelated]);
  registry.reconcileConversations([{
    ...unrelated,
    turn: { state: "busy", source: "lifecycle", terminalAt: null },
    observedAt: "2026-07-11T10:01:00.000Z",
  }]);
  const unrelatedKey = { engine: "codex" as const, sessionId: "019f4e76-66b4-7f87-94b2-cfa9bf711111" };
  registry.upsert({
    key: unrelatedKey,
    artifactPath: unrelated.path,
    cwd: "/repo",
    accountId: "managed",
    status: "live",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  registry.markUnhosted(unrelatedKey);
  expect(registry.engineRouting("codex").revision).toBeGreaterThan(stoppedRevision);

  const restarted = new AgentRegistry(filename);
  setAgentRegistryForTests(restarted);
  const outcome = await deliverConversationMessage({
    pid: null,
    path: observation.path,
    text: "Stay on the source account",
    images: [],
    clientMessageId: "after-stop",
  });

  expect(outcome).not.toMatchObject({ ok: true, outcome: "held" });
  expect(restarted.conversationForPath(observation.path)).toMatchObject({
    migration: null,
    migrationOptOut: { targetId: "default" },
  });
  expect(restarted.pendingDeliveries(restarted.conversationForPath(observation.path)!.id)).toHaveLength(0);
  expect(Object.values(restarted.snapshot().migrationIntents)).toHaveLength(1);

  restarted.commitMigrationIntent({
    engine: "codex",
    targetId: "default",
    origin: "manual",
    requestId: "later-explicit-switch",
    expectedRevision: restarted.engineRouting("codex").revision,
    scope: "active",
  });
  const reenrolled = await deliverConversationMessage({
    pid: null,
    path: observation.path,
    text: "Use the newly selected account",
    images: [],
    clientMessageId: "after-new-switch",
  });
  expect(reenrolled).toMatchObject({ ok: true, outcome: "held" });
});

test("card-level Keep survives unrelated inventory revisions", async () => {
  const filename = path.join(SANDBOX, "registry.json");
  const registry = new AgentRegistry(filename);
  const observation: ConversationObservation = {
    engine: "codex",
    path: "/kept-history.jsonl",
    accountId: "managed",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-11T10:00:00.000Z",
  };
  registry.reconcileConversations([observation]);
  registry.commitMigrationIntent({
    engine: "codex",
    targetId: "default",
    origin: "manual",
    requestId: "keep-switch",
    expectedRevision: registry.engineRouting("codex").revision,
    scope: "all",
  });
  const conversation = registry.conversationForPath(observation.path)!;
  registry.rollbackConversationMigration(conversation.id, conversation.migration!.revision);
  registry.reconcileConversations([{ ...observation, path: "/unrelated-after-keep.jsonl" }]);
  registry.reconcileConversations([{
    ...observation,
    path: "/unrelated-after-keep.jsonl",
    turn: { state: "busy", source: "lifecycle", terminalAt: null },
    observedAt: "2026-07-11T10:01:00.000Z",
  }]);

  const restarted = new AgentRegistry(filename);
  setAgentRegistryForTests(restarted);
  const outcome = await deliverConversationMessage({
    pid: null,
    path: observation.path,
    text: "Keep using the source account",
    images: [],
    clientMessageId: "after-keep",
  });

  expect(outcome).not.toMatchObject({ ok: true, outcome: "held" });
  expect(restarted.conversationForPath(observation.path)?.migration?.phase).toBe("rolled-back");
  expect(restarted.pendingDeliveries(conversation.id)).toHaveLength(0);
});
