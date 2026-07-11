import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

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
