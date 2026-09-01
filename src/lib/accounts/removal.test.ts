import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-removal-test-"));
const previousState = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");

const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
type ViewerConversationId = import("@/lib/accounts/migration/contracts").ViewerConversationId;
const { procBackend } = await import("@/lib/proc");
const { AccountHistoryInventoryBlockedError, accountRemovalBlockers, cleanupAccountProviderSidecars, removeHistoryFreeAccountHome } = await import("./removal");
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

test("Codex log artifacts block deletion and name the history path", () => {
  const home = path.join(sandbox, "codex-log-home");
  const relative = path.join("log", "codex-tui.log");
  const artifact = path.join(home, relative);
  fs.mkdirSync(path.dirname(artifact), { recursive: true, mode: 0o700 });
  fs.writeFileSync(artifact, "session log\n", { mode: 0o600 });

  let caught: unknown;
  try { removeHistoryFreeAccountHome("codex", "work", home); }
  catch (error) { caught = error; }

  expect(caught).toBeInstanceOf(AccountHistoryInventoryBlockedError);
  expect((caught as InstanceType<typeof AccountHistoryInventoryBlockedError>).report.artifacts).toContainEqual({
    path: relative,
    classification: "history",
    history: true,
  });
  expect(fs.readFileSync(artifact, "utf8")).toBe("session log\n");
});

test("Codex SQLite session data blocks deletion and names the database path", () => {
  const home = path.join(sandbox, "codex-sqlite-home");
  const relative = "state_5.sqlite";
  const artifact = path.join(home, relative);
  fs.mkdirSync(home, { mode: 0o700 });
  fs.writeFileSync(artifact, "sqlite session data", { mode: 0o600 });

  let caught: unknown;
  try { removeHistoryFreeAccountHome("codex", "work", home); }
  catch (error) { caught = error; }

  expect(caught).toBeInstanceOf(AccountHistoryInventoryBlockedError);
  expect((caught as InstanceType<typeof AccountHistoryInventoryBlockedError>).report.artifacts).toContainEqual({
    path: relative,
    classification: "history",
    history: true,
  });
  expect(fs.readFileSync(artifact, "utf8")).toBe("sqlite session data");
});

test("an unclassified account-home file blocks deletion and names the unknown path", () => {
  const home = path.join(sandbox, "unknown-artifact-home");
  const relative = "future-provider-state.bin";
  const artifact = path.join(home, relative);
  fs.mkdirSync(home, { mode: 0o700 });
  fs.writeFileSync(artifact, "unrecognized state", { mode: 0o600 });

  let caught: unknown;
  try { removeHistoryFreeAccountHome("codex", "work", home); }
  catch (error) { caught = error; }

  expect(caught).toBeInstanceOf(AccountHistoryInventoryBlockedError);
  expect((caught as InstanceType<typeof AccountHistoryInventoryBlockedError>).report.artifacts).toContainEqual({
    path: relative,
    classification: "unknown",
    history: false,
  });
  expect(fs.readFileSync(artifact, "utf8")).toBe("unrecognized state");
});

test("an unknown file appearing after preflight blocks anchored removal", () => {
  const home = path.join(sandbox, "late-unknown-home");
  const relative = "late-unknown.bin";
  const artifact = path.join(home, relative);
  fs.mkdirSync(home, { mode: 0o700 });
  const originalOpen = fs.openSync;
  let injected = false;
  fs.openSync = ((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (!injected && path.resolve(String(target)) === path.resolve(home)) {
      injected = true;
      fs.writeFileSync(artifact, "late state", { mode: 0o600 });
    }
    return originalOpen(target, flags, mode);
  }) as typeof fs.openSync;

  let caught: unknown;
  try { removeHistoryFreeAccountHome("codex", "work", home); }
  catch (error) { caught = error; }
  finally { fs.openSync = originalOpen; }

  expect(caught).toBeInstanceOf(AccountHistoryInventoryBlockedError);
  expect((caught as InstanceType<typeof AccountHistoryInventoryBlockedError>).report.artifacts).toContainEqual({
    path: relative,
    classification: "unknown",
    history: false,
  });
  expect(fs.readFileSync(artifact, "utf8")).toBe("late state");
});

test("an incomplete directory inventory blocks deletion and names the unreadable path", () => {
  const home = path.join(sandbox, "unreadable-inventory-home");
  const relative = "unreadable-directory";
  const unreadable = path.join(home, relative);
  fs.mkdirSync(unreadable, { recursive: true, mode: 0o700 });
  const originalRead = fs.readdirSync;
  fs.readdirSync = ((target: fs.PathLike, options?: unknown) => {
    if (path.resolve(String(target)) === path.resolve(unreadable)) {
      throw Object.assign(new Error("directory inventory denied"), { code: "EACCES" });
    }
    return originalRead(target, options as never);
  }) as typeof fs.readdirSync;

  let caught: unknown;
  try { removeHistoryFreeAccountHome("codex", "work", home); }
  catch (error) { caught = error; }
  finally { fs.readdirSync = originalRead; }

  expect(caught).toBeInstanceOf(AccountHistoryInventoryBlockedError);
  expect((caught as InstanceType<typeof AccountHistoryInventoryBlockedError>).report.error).toEqual({
    path: relative,
    message: "directory inventory denied",
  });
  expect(fs.existsSync(unreadable)).toBe(true);
});

test("a fully-owned home and provider sidecar delete without following an outside symlink", () => {
  const root = path.join(sandbox, "fully-owned-accounts");
  const home = path.join(root, "work");
  const sidecar = path.join(root, "work.lock");
  const outside = path.join(sandbox, "owned-capability-target");
  const sentinel = path.join(outside, "keep.txt");
  fs.mkdirSync(path.join(home, "projects"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, ".credentials.json"), "{}", { mode: 0o600 });
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.writeFileSync(sentinel, "keep", { mode: 0o600 });
  fs.symlinkSync(outside, path.join(home, "skills"));
  fs.mkdirSync(sidecar, { mode: 0o700 });
  fs.writeFileSync(path.join(sidecar, "provider.lock"), "owned", { mode: 0o600 });

  expect(removeHistoryFreeAccountHome("claude", "work", home)).toBe(true);
  expect(cleanupAccountProviderSidecars(root, "work", [".lock"])).toEqual({
    removed: ["work.lock"],
    unresolved: [],
  });
  expect(fs.existsSync(home)).toBe(false);
  expect(fs.existsSync(sidecar)).toBe(false);
  expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
});

test("platforms without fd anchoring leave homes and sidecars pending", () => {
  const home = path.join(sandbox, "non-linux-home");
  const root = path.join(sandbox, "non-linux-accounts");
  const sidecar = path.join(root, "work.lock");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(sidecar, { recursive: true, mode: 0o700 });
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  try {
    expect(removeHistoryFreeAccountHome("claude", "work", home)).toBe(false);
    expect(cleanupAccountProviderSidecars(root, "work", [".lock"])).toEqual({ removed: [], unresolved: ["work.lock"] });
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
  expect(fs.existsSync(home)).toBe(true);
  expect(fs.existsSync(sidecar)).toBe(true);
});

test("sidecar cleanup stays anchored when the account root becomes an outside symlink", () => {
  const root = path.join(sandbox, "anchored-sidecars");
  const movedRoot = `${root}-moved`;
  const sidecar = path.join(root, "work.lock");
  const outside = path.join(sandbox, "outside-sidecars");
  const outsideSidecar = path.join(outside, "work.lock");
  const marker = path.join(outsideSidecar, "keep.txt");
  fs.mkdirSync(sidecar, { recursive: true, mode: 0o700 });
  fs.mkdirSync(outsideSidecar, { recursive: true, mode: 0o700 });
  fs.writeFileSync(marker, "keep", { mode: 0o600 });
  const originalLstat = fs.lstatSync;
  let swapped = false;
  fs.lstatSync = ((target: fs.PathLike, options?: unknown) => {
    if (!swapped && String(target).startsWith("/proc/self/fd/") && path.basename(String(target)) === "work.lock") {
      swapped = true;
      fs.renameSync(root, movedRoot);
      fs.symlinkSync(outside, root);
    }
    return originalLstat(target, options as never);
  }) as typeof fs.lstatSync;

  let result;
  try { result = cleanupAccountProviderSidecars(root, "work", [".lock"]); }
  finally { fs.lstatSync = originalLstat; }

  expect(result).toEqual({ removed: ["work.lock"], unresolved: [] });
  expect(fs.readFileSync(marker, "utf8")).toBe("keep");
});

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
  beginLegacySpawnFixture(store, { engine: "claude", cwd: "/repo", accountId: "work" });

  expect(accountRemovalBlockers("claude", "work")).toEqual(["live_sessions"]);
  expect(accountRemovalBlockers("claude", "other")).toEqual([]);
});

test("an unresolved live launch blocks removal of every managed account for its engine", () => {
  const store = registry();
  beginLegacySpawnFixture(store, { engine: "codex", cwd: "/repo", accountId: null });

  expect(accountRemovalBlockers("codex", "work")).toEqual(["live_sessions"]);
  expect(accountRemovalBlockers("claude", "work")).toEqual([]);
});

test("an aged queued pin blocks every account until its durable receipt settles", () => {
  const store = registry();
  const begun = beginLegacySpawnFixture(store, {
    engine: "claude",
    cwd: "/repo",
    transport: "structured",
    accountId: "work",
    accountPin: true,
    launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Queued account work" }),
  });
  if (begun.kind !== "created") throw new Error("expected queued receipt");
  store.queuePinnedSpawn(begun.receipt.launchId, {
    version: 1,
    retryAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
    accountId: "work",
    locale: "en",
    spec: { engine: "claude", command: "claude", cwd: "/repo", windowName: "queued-pin", launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Queued account work" }) },
    ["prompt"]: "continue",
    imageRefs: [],
    parentArtifactPath: null,
    pipelineSourceConversationId: null,
  }, "queued for account capacity");
  store.releaseStartingStructuredSpawn(begun.receipt.launchId, begun.receipt.admissionOwner!);

  expect(accountRemovalBlockers("claude", "work", DAYS_LATER)).toEqual(["live_sessions"]);
  expect(accountRemovalBlockers("claude", "other", DAYS_LATER)).toEqual(["live_sessions"]);
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
  beginLegacySpawnFixture(store, { engine: "claude", cwd: "/repo", accountId: "work" });

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

test("a live pid with unreadable start identity remains a deletion blocker", () => {
  const store = registry();
  const artifactPath = "/accounts/claude/work/projects/-repo/identity-unknown.jsonl";
  deadConversation(store, artifactPath, "work");
  const host = liveTmuxHost(DEAD_PID);
  host.agent.startIdentity = "recorded-agent";
  host.panePid.startIdentity = "recorded-pane";
  store.upsert({
    key: { engine: "claude", sessionId: "77777777-7777-7777-7777-777777777777" },
    artifactPath,
    cwd: "/repo", accountId: "work", status: "live", host,
    claimEpoch: 0, claimOwner: null, pendingAction: null,
  });

  expect(accountRemovalBlockers("claude", "work", {
    now: DAYS_LATER.now,
    pidAlive: () => true,
    processIdentity: () => null,
  })).toEqual(["live_sessions", "current_conversations"]);
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
