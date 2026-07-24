import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-removal-test-"));
const previousState = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");

const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { procBackend } = await import("@/lib/proc");
const { accountRemovalBlockers } = await import("./removal");

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
