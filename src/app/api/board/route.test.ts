import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { setBoardFileForTests } from "@/lib/board/store";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-board-route-test-"));
const { PATCH } = await import("./route");

let testFile = "";
beforeEach(() => {
  testFile = path.join(fs.mkdtempSync(path.join(sandbox, "state-")), "board.json");
  setBoardFileForTests(testFile);
});
afterAll(() => {
  setBoardFileForTests(null);
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
