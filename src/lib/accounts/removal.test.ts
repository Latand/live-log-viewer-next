import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-removal-test-"));
const previousState = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");

const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
type ViewerConversationId = import("@/lib/accounts/migration/contracts").ViewerConversationId;
const { procBackend } = await import("@/lib/proc");
const { accountRemovalBlockers } = await import("./removal");
const { terminalizeStaleUndeliverableHeldDeliveries } = await import("@/lib/reaperRuntime");

type Registry = InstanceType<typeof AgentRegistry>;

/** Far above any live pid on the platforms the Viewer runs on. */
const DEAD_PID = 2_147_483_646;
/** Blocker evaluation three days after the registry rot was written. */
const DAYS_LATER = { now: () => Date.now() + 3 * 24 * 60 * 60 * 1000 };

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  setAgentRegistryForTests(new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "agent-registry.json")));
});

afterAll(() => {
  setAgentRegistryForTests(null);
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function registry(): Registry {
  const store = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "agent-registry.json"));
  setAgentRegistryForTests(store);
  return store;
}

function liveTmuxHost(pid = process.pid) {
  return {
    kind: "tmux" as const,
    endpoint: "default",
    server: { pid, startIdentity: procBackend.processIdentity(pid) },
    paneId: "%7",
    panePid: { pid, startIdentity: procBackend.processIdentity(pid) },
    windowName: "agent",
    agent: { pid, startIdentity: procBackend.processIdentity(pid) },
    argv: ["claude"],
  };
}

function deadTmuxHost() {
  return { ...liveTmuxHost(DEAD_PID), server: { pid: DEAD_PID, startIdentity: "gone" }, agent: { pid: DEAD_PID, startIdentity: "gone" }, panePid: { pid: DEAD_PID, startIdentity: "gone" } };
}

/** A historical conversation: latest generation on the account, terminal turn, never hosted. */
function deadConversation(store: Registry, artifactPath: string, accountId: string) {
  const observedAt = new Date().toISOString();
  store.ensureConversation("claude", artifactPath, accountId);
  store.reconcileConversations([{
    engine: "claude",
    path: artifactPath,
    accountId,
    launchProfile: emptyLaunchProfile(),
    turn: { state: "terminal", source: "lifecycle", terminalAt: observedAt },
    observedAt,
  }]);
  return store.conversationForPath(artifactPath)!;
}

test("a pending Viewer spawn blocks managed-home removal for its assigned account", () => {
  const store = registry();
  store.beginSpawnRequest({ engine: "claude", cwd: "/repo", accountId: "work" });

  expect(accountRemovalBlockers("claude", "work")).toEqual(["live_sessions"]);
  expect(accountRemovalBlockers("claude", "other")).toEqual([]);
});

test("an unresolved live launch blocks removal of every managed account for its engine", () => {
  const store = registry();
  store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: null });

  expect(accountRemovalBlockers("codex", "work")).toEqual(["live_sessions"]);
  expect(accountRemovalBlockers("claude", "work")).toEqual([]);
});

test("dead history plus stale starting entries and receipts no longer block removal (issue #643)", () => {
  const store = registry();
  // Production shape: ~dozens of historical conversations whose latest generation
  // ran on the account, all terminal and unhosted…
  for (let index = 0; index < 3; index += 1) {
    deadConversation(store, `/accounts/claude/work/projects/-repo/history-${index}.jsonl`, "work");
  }
  // …two registry entries stuck in `starting` whose launch process is long gone…
  store.upsert({
    key: { engine: "claude", sessionId: "cc528380-1111-1111-1111-111111111111" },
    artifactPath: "/accounts/claude/work/projects/-repo/stuck-a.jsonl",
    cwd: "/repo", accountId: "work", status: "starting", host: null,
    claimEpoch: 0, claimOwner: null, pendingAction: "spawn",
  });
  store.upsert({
    key: { engine: "claude", sessionId: "3281d5b9-2222-2222-2222-222222222222" },
    artifactPath: "/accounts/claude/work/projects/-repo/stuck-b.jsonl",
    cwd: "/repo", accountId: "work", status: "live", host: deadTmuxHost(),
    claimEpoch: 0, claimOwner: null, pendingAction: null,
  });
  // …and a launch receipt stuck in `starting` from a pipeline that ended days ago.
  store.beginSpawnRequest({ engine: "claude", cwd: "/repo", accountId: "work" });

  expect(accountRemovalBlockers("claude", "work", DAYS_LATER)).toEqual([]);
});

test("a registered host with a live process still blocks removal", () => {
  const store = registry();
  const artifactPath = "/accounts/claude/work/projects/-repo/live.jsonl";
  deadConversation(store, artifactPath, "work");
  store.upsert({
    key: { engine: "claude", sessionId: "44444444-4444-4444-4444-444444444444" },
    artifactPath,
    cwd: "/repo", accountId: "work", status: "live", host: liveTmuxHost(),
    claimEpoch: 0, claimOwner: null, pendingAction: null,
  });

  expect(accountRemovalBlockers("claude", "work", DAYS_LATER)).toEqual(["live_sessions", "current_conversations"]);
});

test("an undelivered held delivery keeps its conversation current", () => {
  const store = registry();
  const conversation = deadConversation(store, "/accounts/claude/work/projects/-repo/queued.jsonl", "work");
  store.holdDelivery(conversation.id, "still queued");

  expect(accountRemovalBlockers("claude", "work", DAYS_LATER)).toEqual(["current_conversations"]);
});

test("a delivered held delivery leaves its conversation removable", () => {
  const store = registry();
  const conversation = deadConversation(store, "/accounts/claude/work/projects/-repo/done.jsonl", "work");
  const delivery = store.holdDelivery(conversation.id, "already sent");
  store.recordDeliveryOutcome(delivery.id, "delivered");

  expect(accountRemovalBlockers("claude", "work", DAYS_LATER)).toEqual([]);
});

test("a pending migration keeps its conversation current", () => {
  const store = registry();
  const conversation = deadConversation(store, "/accounts/claude/work/projects/-repo/moving.jsonl", "work");
  store.setConversationMigration(conversation.id, {
    intentId: "intent-1",
    phase: "preparing",
    targetId: "default",
    revision: 1,
    error: null,
    updatedAt: new Date().toISOString(),
  });

  expect(accountRemovalBlockers("claude", "work", DAYS_LATER)).toEqual(["current_conversations"]);
});

/** Production shape of issue #652: an `assigned` queued turn whose attempt
    started (state `delivery-uncertain`) but never reported an outcome. */
function uncertainDelivery(store: Registry, conversationId: ViewerConversationId, text: string) {
  const held = store.holdDelivery(conversationId, text);
  expect(held.state).toBe("assigned");
  const uncertain = store.beginDeliveryAttempt(held.id, held.generationId!);
  expect(uncertain?.state).toBe("delivery-uncertain");
  return uncertain!;
}

function settledMigration(store: Registry, conversationId: ViewerConversationId) {
  store.setConversationMigration(conversationId, {
    intentId: "intent-652",
    phase: "rolled-back",
    targetId: "default",
    revision: 1,
    error: null,
    updatedAt: new Date().toISOString(),
  });
}

test("a stale delivery-uncertain delivery on a settled migration no longer blocks removal (issue #652)", () => {
  const store = registry();
  const conversation = deadConversation(store, "/accounts/claude/work/projects/-repo/uncertain.jsonl", "work");
  uncertainDelivery(store, conversation.id, "queued but never resolved");
  settledMigration(store, conversation.id);

  // Reproduces the production block (issue #652): a days-old delivery-uncertain,
  // a rolled-back migration, and no live host — must stop counting as current.
  expect(accountRemovalBlockers("claude", "work", DAYS_LATER)).toEqual([]);
});

test("a delivery-uncertain delivery still blocks during its recovery grace", () => {
  const store = registry();
  const conversation = deadConversation(store, "/accounts/claude/work/projects/-repo/fresh.jsonl", "work");
  uncertainDelivery(store, conversation.id, "attempt just started");
  settledMigration(store, conversation.id);

  // Evaluated at the current time, still inside the recovery grace window.
  expect(accountRemovalBlockers("claude", "work")).toEqual(["current_conversations"]);
});

test("a delivery-uncertain delivery on an unsettled migration still blocks", () => {
  const store = registry();
  const conversation = deadConversation(store, "/accounts/claude/work/projects/-repo/moving-uncertain.jsonl", "work");
  uncertainDelivery(store, conversation.id, "attempt in flight");
  store.setConversationMigration(conversation.id, {
    intentId: "intent-3",
    phase: "preparing",
    targetId: "default",
    revision: 1,
    error: null,
    updatedAt: new Date().toISOString(),
  });

  expect(accountRemovalBlockers("claude", "work", DAYS_LATER)).toEqual(["current_conversations"]);
});

test("a delivery-uncertain delivery with a live host still blocks", () => {
  const store = registry();
  const artifactPath = "/accounts/claude/work/projects/-repo/live-uncertain.jsonl";
  const conversation = deadConversation(store, artifactPath, "work");
  uncertainDelivery(store, conversation.id, "attempt against a live retry target");
  settledMigration(store, conversation.id);
  store.upsert({
    key: { engine: "claude", sessionId: "55555555-5555-5555-5555-555555555555" },
    artifactPath,
    cwd: "/repo", accountId: "work", status: "live", host: liveTmuxHost(),
    claimEpoch: 0, claimOwner: null, pendingAction: null,
  });

  expect(accountRemovalBlockers("claude", "work", DAYS_LATER)).toEqual(["live_sessions", "current_conversations"]);
});

test("committed and rolled-back migrations both settle a delivery-uncertain delivery", () => {
  const store = registry();
  const conversation = deadConversation(store, "/accounts/claude/work/projects/-repo/committed-uncertain.jsonl", "work");
  uncertainDelivery(store, conversation.id, "queued but never resolved");
  store.setConversationMigration(conversation.id, {
    intentId: "intent-4",
    phase: "committed",
    targetId: "default",
    revision: 1,
    error: null,
    updatedAt: new Date().toISOString(),
  });

  expect(accountRemovalBlockers("claude", "work", DAYS_LATER)).toEqual([]);
});

test("the reaper terminalizes a stale delivery-uncertain delivery so it stops being owed (issue #652)", () => {
  const store = registry();
  const conversation = deadConversation(store, "/accounts/claude/work/projects/-repo/reaped.jsonl", "work");
  const uncertain = uncertainDelivery(store, conversation.id, "queued but never resolved");
  settledMigration(store, conversation.id);

  const failed = terminalizeStaleUndeliverableHeldDeliveries(store, Date.now() + 3 * 24 * 60 * 60 * 1000);

  expect(failed).toEqual([uncertain.id]);
  expect(store.readOnlySnapshot().heldDeliveries[uncertain.id]?.state).toBe("failed");
  // Removal stays clear once the registry no longer carries it as owed.
  expect(accountRemovalBlockers("claude", "work", DAYS_LATER)).toEqual([]);
});

test("the reaper leaves an in-grace or in-flight delivery-uncertain delivery owed", () => {
  const store = registry();
  const conversation = deadConversation(store, "/accounts/claude/work/projects/-repo/kept.jsonl", "work");
  const uncertain = uncertainDelivery(store, conversation.id, "attempt just started");
  settledMigration(store, conversation.id);

  // Within the recovery grace: nothing terminalized.
  expect(terminalizeStaleUndeliverableHeldDeliveries(store, Date.now())).toEqual([]);
  expect(store.readOnlySnapshot().heldDeliveries[uncertain.id]?.state).toBe("delivery-uncertain");
});

test("a committed migration leaves its conversation removable", () => {
  const store = registry();
  const conversation = deadConversation(store, "/accounts/claude/work/projects/-repo/moved.jsonl", "work");
  store.setConversationMigration(conversation.id, {
    intentId: "intent-2",
    phase: "committed",
    targetId: "default",
    revision: 1,
    error: null,
    updatedAt: new Date().toISOString(),
  });

  expect(accountRemovalBlockers("claude", "work", DAYS_LATER)).toEqual([]);
});
