import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { setBoardFileForTests } from "@/lib/board/store";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-board-route-test-"));
const { PATCH } = await import("./route");

let testFile = "";
beforeEach(() => {
  const state = fs.mkdtempSync(path.join(sandbox, "state-"));
  testFile = path.join(state, "board.json");
  setBoardFileForTests(testFile);
  setAgentRegistryForTests(new AgentRegistry(path.join(state, "agent-registry.json")));
});
afterAll(() => {
  setBoardFileForTests(null);
  setAgentRegistryForTests(null);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function patch(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:8898/api/board", {
    method: "PATCH",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("board route accepts revision-fenced mutations and converges an identical stale replay", async () => {
  const intent = { schemaVersion: 1, project: "viewer", baseRevision: 0, mutations: [{ kind: "remap-paths", pairs: [{ from: "/old", to: "/new" }] }] };
  const first = await PATCH(patch(intent));
  const replay = await PATCH(patch(intent));

  expect(first.status).toBe(200);
  expect(replay.status).toBe(200);
  expect(await first.json()).toMatchObject({ ok: true, board: { revision: 1, pathAliases: { "/old": "/new" } } });
  expect(await replay.json()).toMatchObject({ ok: true, board: { revision: 1 } });
});

test("board route retains scalar patch and revision-zero legacy seed compatibility", async () => {
  const response = await PATCH(patch({ schemaVersion: 1, project: "legacy", baseRevision: 0, patch: { manual: ["/legacy"], taskPanelOpen: true } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, board: { revision: 1, prefs: { manual: ["/legacy"], taskPanelOpen: true } } });
});

test("board route returns the current board for a conflicting mutation and persists presentation intent", async () => {
  const first = await PATCH(patch({ schemaVersion: 1, project: "conflict", baseRevision: 0, mutations: [{ kind: "close", path: "/one" }] }));
  const conflict = await PATCH(patch({ schemaVersion: 1, project: "conflict", baseRevision: 0, mutations: [{ kind: "close", path: "/two" }] }));
  const presentation = await PATCH(patch({ schemaVersion: 1, project: "presentation", baseRevision: 0, mutations: [{ kind: "set-presentation", viewMode: "scheme", taskPanelOpen: true }] }));

  expect(first.status).toBe(200);
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: "BOARD_REVISION_CONFLICT", board: { revision: 1, prefs: { hidden: ["/one"] } } });
  expect(await presentation.json()).toMatchObject({ ok: true, board: { prefs: { viewMode: "scheme", taskPanelOpen: true } } });
});

test("a retried legacy hidden list cannot erase a concurrent close", async () => {
  const seeded = await PATCH(patch({
    schemaVersion: 1,
    project: "legacy-close-race",
    baseRevision: 0,
    patch: { manual: ["/card"], hidden: [] },
  }));
  expect(seeded.status).toBe(200);

  const closed = await PATCH(patch({
    schemaVersion: 1,
    project: "legacy-close-race",
    baseRevision: 1,
    mutations: [{ kind: "close", path: "/card" }],
  }));
  expect(closed.status).toBe(200);

  const conflict = await PATCH(patch({
    schemaVersion: 1,
    project: "legacy-close-race",
    baseRevision: 1,
    patch: { manual: ["/card"], hidden: [], taskPanelOpen: true },
  }));
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ board: { revision: 2, prefs: { hidden: ["/card"] } } });

  const retry = await PATCH(patch({
    schemaVersion: 1,
    project: "legacy-close-race",
    baseRevision: 2,
    patch: { manual: ["/card"], hidden: [], taskPanelOpen: true },
  }));
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({
    ok: true,
    board: { revision: 3, prefs: { manual: [], hidden: ["/card"], taskPanelOpen: true } },
  });
});

test("a closed conversation stays hidden when a registry successor arrives without a client remap", async () => {
  const registry = new AgentRegistry(path.join(path.dirname(testFile), "agent-registry.json"));
  setAgentRegistryForTests(registry);
  const source = "/predecessor.jsonl";
  const successor = "/successor.jsonl";
  const conversation = registry.ensureConversation("codex", source, "account-a");

  const seeded = await PATCH(patch({
    schemaVersion: 1,
    project: "successor-close",
    baseRevision: 0,
    patch: { manual: [source] },
  }));
  expect(seeded.status).toBe(200);
  const closed = await PATCH(patch({
    schemaVersion: 1,
    project: "successor-close",
    baseRevision: 1,
    mutations: [{ kind: "close", path: source }],
  }));
  expect(closed.status).toBe(200);

  registry.commitMigrationIntent({
    engine: "codex",
    targetId: "account-b",
    origin: "manual",
    requestId: "successor-close",
    expectedRevision: registry.engineRouting("codex").revision,
  });
  const revision = registry.conversation(conversation.id)!.migration!.revision;
  registry.transitionConversationMigration(conversation.id, revision, ["requested", "waiting-turn"], { phase: "preparing" });
  registry.transitionConversationMigration(conversation.id, revision, ["preparing"], { phase: "successor-starting" });
  registry.transitionConversationMigration(conversation.id, revision, ["successor-starting"], { phase: "verifying" });
  registry.commitSuccessor(conversation.id, { id: "successor", path: successor, accountId: "account-b" }, revision);

  const reconciled = await PATCH(patch({
    schemaVersion: 1,
    project: "successor-close",
    baseRevision: 2,
    mutations: [{ kind: "reconcile-roots", roots: [successor], removeManual: [] }],
  }));
  expect(reconciled.status).toBe(200);
  expect(await reconciled.json()).toMatchObject({
    ok: true,
    board: {
      pathAliases: { [source]: successor },
      prefs: { manual: [], hidden: [successor] },
    },
  });
});

test("a pre-commit continuity path cannot create a reverse board alias", async () => {
  const registry = new AgentRegistry(path.join(path.dirname(testFile), "agent-registry.json"));
  setAgentRegistryForTests(registry);
  const source = "/continuity-predecessor.jsonl";
  const successor = "/continuity-successor.jsonl";
  const conversation = registry.ensureConversation("codex", source, "account-a");
  registry.recordConversationContinuityPath(conversation.id, successor);

  const seeded = await PATCH(patch({
    schemaVersion: 1,
    project: "pre-commit-continuity",
    baseRevision: 0,
    patch: { manual: [source] },
  }));
  expect(seeded.status).toBe(200);
  const closed = await PATCH(patch({
    schemaVersion: 1,
    project: "pre-commit-continuity",
    baseRevision: 1,
    mutations: [{ kind: "close", path: source }],
  }));
  expect(closed.status).toBe(200);
  const closedBody = await closed.json() as { board: { pathAliases: Record<string, string> } };
  expect(closedBody).toMatchObject({
    board: { revision: 2, pathAliases: {}, prefs: { hidden: [source] } },
  });
  expect(closedBody.board.pathAliases).toEqual({});

  registry.commitMigrationIntent({
    engine: "codex",
    targetId: "account-b",
    origin: "manual",
    requestId: "pre-commit-continuity",
    expectedRevision: registry.engineRouting("codex").revision,
  });
  const revision = registry.conversation(conversation.id)!.migration!.revision;
  registry.transitionConversationMigration(conversation.id, revision, ["requested", "waiting-turn"], { phase: "preparing" });
  registry.transitionConversationMigration(conversation.id, revision, ["preparing"], { phase: "successor-starting" });
  registry.transitionConversationMigration(conversation.id, revision, ["successor-starting"], { phase: "verifying" });
  registry.commitSuccessor(conversation.id, { id: "continuity-successor", path: successor, accountId: "account-b" }, revision);

  const reconciled = await PATCH(patch({
    schemaVersion: 1,
    project: "pre-commit-continuity",
    baseRevision: 2,
    mutations: [{ kind: "reconcile-roots", roots: [successor], removeManual: [] }],
  }));
  expect(reconciled.status).toBe(200);
  expect(await reconciled.json()).toMatchObject({
    ok: true,
    board: {
      revision: 3,
      pathAliases: { [source]: successor },
      prefs: { manual: [], hidden: [successor] },
    },
  });
});

test("a repeated migration cannot alias its pending successor backward", async () => {
  const registry = new AgentRegistry(path.join(path.dirname(testFile), "agent-registry.json"));
  setAgentRegistryForTests(registry);
  const first = "/generation-one.jsonl";
  const second = "/generation-two.jsonl";
  const third = "/generation-three.jsonl";
  const conversation = registry.ensureConversation("codex", first, "account-a");

  registry.commitMigrationIntent({
    engine: "codex",
    targetId: "account-b",
    origin: "manual",
    requestId: "first-migration",
    expectedRevision: registry.engineRouting("codex").revision,
  });
  const firstRevision = registry.conversation(conversation.id)!.migration!.revision;
  registry.transitionConversationMigration(conversation.id, firstRevision, ["requested", "waiting-turn"], { phase: "preparing" });
  registry.transitionConversationMigration(conversation.id, firstRevision, ["preparing"], { phase: "successor-starting" });
  registry.transitionConversationMigration(conversation.id, firstRevision, ["successor-starting"], { phase: "verifying" });
  registry.commitSuccessor(conversation.id, { id: "generation-two", path: second, accountId: "account-b" }, firstRevision);

  const placed = await PATCH(patch({
    schemaVersion: 1,
    project: "repeated-migration",
    baseRevision: 0,
    mutations: [{ kind: "restore", path: second, placement: "manual" }],
  }));
  expect(placed.status).toBe(200);
  expect(await placed.json()).toMatchObject({
    board: { revision: 1, pathAliases: { [first]: second }, prefs: { manual: [second] } },
  });

  registry.commitMigrationIntent({
    engine: "codex",
    targetId: "account-c",
    origin: "manual",
    requestId: "second-migration",
    expectedRevision: registry.engineRouting("codex").revision,
  });
  const secondRevision = registry.conversation(conversation.id)!.migration!.revision;
  registry.recordConversationContinuityPath(conversation.id, third);

  const closed = await PATCH(patch({
    schemaVersion: 1,
    project: "repeated-migration",
    baseRevision: 1,
    mutations: [{ kind: "close", path: second }],
  }));
  expect(closed.status).toBe(200);
  const closedBody = await closed.json() as { board: { pathAliases: Record<string, string> } };
  expect(closedBody).toMatchObject({
    board: { revision: 2, prefs: { hidden: [second] } },
  });
  expect(closedBody.board.pathAliases).toEqual({ [first]: second });

  registry.transitionConversationMigration(conversation.id, secondRevision, ["requested", "waiting-turn"], { phase: "preparing" });
  registry.transitionConversationMigration(conversation.id, secondRevision, ["preparing"], { phase: "successor-starting" });
  registry.transitionConversationMigration(conversation.id, secondRevision, ["successor-starting"], { phase: "verifying" });
  registry.commitSuccessor(conversation.id, { id: "generation-three", path: third, accountId: "account-c" }, secondRevision);

  const reconciled = await PATCH(patch({
    schemaVersion: 1,
    project: "repeated-migration",
    baseRevision: 2,
    mutations: [{ kind: "reconcile-roots", roots: [third], removeManual: [] }],
  }));
  expect(reconciled.status).toBe(200);
  expect(await reconciled.json()).toMatchObject({
    ok: true,
    board: {
      revision: 3,
      pathAliases: { [first]: third, [second]: third },
      prefs: { manual: [], hidden: [third] },
    },
  });
});

test("a scanner-discovered repeated successor stays pending before its provider callback", async () => {
  const registry = new AgentRegistry(path.join(path.dirname(testFile), "agent-registry.json"));
  setAgentRegistryForTests(registry);
  const first = "/scanner-generation-a.jsonl";
  const second = "/scanner-generation-b.jsonl";
  const third = "/scanner-generation-c.jsonl";
  const conversation = registry.ensureConversation("codex", first, "account-a");

  registry.commitMigrationIntent({
    engine: "codex",
    targetId: "account-b",
    origin: "manual",
    requestId: "scanner-first-migration",
    expectedRevision: registry.engineRouting("codex").revision,
  });
  const firstRevision = registry.conversation(conversation.id)!.migration!.revision;
  registry.transitionConversationMigration(conversation.id, firstRevision, ["requested", "waiting-turn"], { phase: "preparing" });
  registry.transitionConversationMigration(conversation.id, firstRevision, ["preparing"], { phase: "successor-starting" });
  registry.transitionConversationMigration(conversation.id, firstRevision, ["successor-starting"], { phase: "verifying" });
  registry.commitSuccessor(conversation.id, { id: "scanner-generation-b", path: second, accountId: "account-b" }, firstRevision);

  const placed = await PATCH(patch({
    schemaVersion: 1,
    project: "scanner-successor",
    baseRevision: 0,
    mutations: [{ kind: "restore", path: second, placement: "manual" }],
  }));
  expect(placed.status).toBe(200);

  registry.commitMigrationIntent({
    engine: "codex",
    targetId: "account-c",
    origin: "manual",
    requestId: "scanner-second-migration",
    expectedRevision: registry.engineRouting("codex").revision,
  });
  const secondRevision = registry.conversation(conversation.id)!.migration!.revision;
  registry.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    accountId: "account-c",
    conversationId: conversation.id,
    purpose: "migration-successor",
    expectedArtifactPath: third,
  });
  registry.reconcileConversations([{
    engine: "codex",
    path: third,
    accountId: "account-c",
    launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
    turn: { state: "idle", source: "assistant", terminalAt: null },
    observedAt: "2026-07-11T09:00:00.000Z",
  }]);
  expect(registry.conversation(conversation.id)?.migration?.pendingContinuityPaths).toEqual([third]);

  const closed = await PATCH(patch({
    schemaVersion: 1,
    project: "scanner-successor",
    baseRevision: 1,
    mutations: [{ kind: "close", path: third }],
  }));
  expect(closed.status).toBe(200);
  const closedBody = await closed.json() as { board: { pathAliases: Record<string, string> } };
  expect(closedBody).toMatchObject({ board: { revision: 2, prefs: { hidden: [third] } } });
  expect(closedBody.board.pathAliases).toEqual({ [first]: second });

  registry.transitionConversationMigration(conversation.id, secondRevision, ["requested", "waiting-turn"], { phase: "preparing" });
  registry.transitionConversationMigration(conversation.id, secondRevision, ["preparing"], { phase: "successor-starting" });
  registry.transitionConversationMigration(conversation.id, secondRevision, ["successor-starting"], { phase: "verifying" });
  registry.commitSuccessor(conversation.id, { id: "scanner-generation-c", path: third, accountId: "account-c" }, secondRevision);

  const reconciled = await PATCH(patch({
    schemaVersion: 1,
    project: "scanner-successor",
    baseRevision: 2,
    mutations: [{ kind: "reconcile-roots", roots: [third], removeManual: [] }],
  }));
  expect(reconciled.status).toBe(200);
  expect(await reconciled.json()).toMatchObject({
    ok: true,
    board: {
      revision: 3,
      pathAliases: { [first]: third, [second]: third },
      prefs: { manual: [], hidden: [third] },
    },
  });
});

test("a pending repeated migration preserves deferred historical continuity tombstones", async () => {
  const registry = new AgentRegistry(path.join(path.dirname(testFile), "agent-registry.json"));
  setAgentRegistryForTests(registry);
  const first = "/deferred-generation-a.jsonl";
  const fork = "/deferred-fork-b.jsonl";
  const second = "/deferred-generation-b.jsonl";
  const conversation = registry.ensureConversation("codex", first, "account-a");

  registry.commitMigrationIntent({
    engine: "codex",
    targetId: "account-b",
    origin: "manual",
    requestId: "deferred-first-migration",
    expectedRevision: registry.engineRouting("codex").revision,
  });
  const firstRevision = registry.conversation(conversation.id)!.migration!.revision;
  registry.recordConversationContinuityPath(conversation.id, fork);

  const closed = await PATCH(patch({
    schemaVersion: 1,
    project: "deferred-continuity",
    baseRevision: 0,
    mutations: [{ kind: "close", path: fork }],
  }));
  expect(closed.status).toBe(200);
  expect(await closed.json()).toMatchObject({
    board: { revision: 1, pathAliases: {}, prefs: { hidden: [fork] } },
  });

  registry.transitionConversationMigration(conversation.id, firstRevision, ["requested", "waiting-turn"], { phase: "preparing" });
  registry.transitionConversationMigration(conversation.id, firstRevision, ["preparing"], { phase: "successor-starting" });
  registry.transitionConversationMigration(conversation.id, firstRevision, ["successor-starting"], { phase: "verifying" });
  registry.commitSuccessor(conversation.id, { id: "deferred-generation-b", path: second, accountId: "account-b" }, firstRevision);

  registry.commitMigrationIntent({
    engine: "codex",
    targetId: "account-c",
    origin: "manual",
    requestId: "deferred-second-migration",
    expectedRevision: registry.engineRouting("codex").revision,
  });

  const reconciled = await PATCH(patch({
    schemaVersion: 1,
    project: "deferred-continuity",
    baseRevision: 1,
    mutations: [{ kind: "reconcile-roots", roots: [second], removeManual: [] }],
  }));
  expect(reconciled.status).toBe(200);
  expect(await reconciled.json()).toMatchObject({
    ok: true,
    board: {
      revision: 2,
      pathAliases: { [first]: second, [fork]: second },
      prefs: { manual: [], hidden: [second] },
    },
  });
});

test("a corrupt conversation registry cannot block a valid close", async () => {
  fs.writeFileSync(path.join(path.dirname(testFile), "agent-registry.json"), "{ corrupt", "utf8");

  const response = await PATCH(patch({
    schemaVersion: 1,
    project: "corrupt-registry",
    baseRevision: 0,
    mutations: [{ kind: "close", path: "/card" }],
  }));

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    board: { revision: 1, prefs: { hidden: ["/card"] } },
  });
});
