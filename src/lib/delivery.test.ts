import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, setAgentRegistryForTests, type ConversationObservation } from "./agent/registry";
import { emptyLaunchProfile } from "./accounts/migration/contracts";
import { cleanupFailedImageDelivery, deliverConversationMessage, type DeliveryFailure } from "./delivery";

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

test("a stopped migration survives restart and blocks lazy re-enrollment for its routing revision", async () => {
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
    migrationOptOut: { targetId: "default", routeRevision: restarted.engineRouting("codex").revision },
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

test("card-level Keep blocks lazy re-enrollment for the current routing revision", async () => {
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
