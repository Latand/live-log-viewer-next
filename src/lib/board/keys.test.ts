import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { mutationKeys, pathKey, VIEW_MODE_KEY } from "./keys";
import { boardFor, mutateBoard, remapBoardPaths } from "./store";

/*
 * The durable contract behind convergence (#38): every write stamps the causal
 * revision of the keys it changed. This is what makes ABA detectable — a value
 * driven away and back is indistinguishable by comparison, and unmistakable by
 * revision. Any surface that wants revision-fenced per-project durable settings
 * relies on exactly these four properties.
 */

function temporaryFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llv-board-keys-")), "board.json");
}
const at = (file: string, key: string) => boardFor("proj", file).keyRevisions?.[key];

test("a key's causal revision advances on every write, so A→B→A stays distinguishable", () => {
  const file = temporaryFile();
  mutateBoard("proj", 0, [{ kind: "set-presentation", viewMode: "scheme" }], file);
  const first = at(file, VIEW_MODE_KEY);
  expect(first).toBe(1);

  mutateBoard("proj", 1, [{ kind: "set-presentation", viewMode: "list" }], file);
  mutateBoard("proj", 2, [{ kind: "set-presentation", viewMode: "scheme" }], file);

  /* The value is back where it started and the board is NOT — which is the
     whole point. A view holding intent formed when this key read revision 1 can
     still tell that two writers have spoken since. */
  expect(boardFor("proj", file).prefs.viewMode).toBe("scheme");
  expect(at(file, VIEW_MODE_KEY)).toBe(3);
  expect(at(file, VIEW_MODE_KEY)!).toBeGreaterThan(first!);
});

test("a write moves only the keys it changed", () => {
  const file = temporaryFile();
  mutateBoard("proj", 0, [
    { kind: "restore", path: "/a", placement: "manual" },
    { kind: "restore", path: "/b", placement: "manual" },
  ], file);
  expect(at(file, pathKey("/a"))).toBe(1);
  expect(at(file, pathKey("/b"))).toBe(1);

  mutateBoard("proj", 1, [{ kind: "close", path: "/a" }], file);
  /* /b was untouched, so intent another device formed about /b is still valid
     and must not be fenced by an unrelated write. */
  expect(at(file, pathKey("/a"))).toBe(2);
  expect(at(file, pathKey("/b"))).toBe(1);
  expect(at(file, VIEW_MODE_KEY)).toBeUndefined();
});

test("causal revisions are durable and survive a restart", () => {
  const file = temporaryFile();
  mutateBoard("proj", 0, [{ kind: "set-favorite", id: "conv-1", favorite: true }], file);
  mutateBoard("proj", 1, [{ kind: "set-favorite", id: "conv-1", favorite: false }], file);
  /* `boardFor` re-reads the file, so this is the restart: the fence cannot be
     rebuilt from memory after a redeploy and must come off disk. */
  expect(boardFor("proj", file).keyRevisions).toEqual({ "favorite:conv-1": 2 });

  /* A board written before this metadata existed reads back with an empty map —
     every key then looks never-written, which is right: no client can hold
     intent that predates a revision nobody recorded. */
  fs.writeFileSync(file, JSON.stringify({ projects: { proj: {
    schemaVersion: 1, revision: 7, updatedAt: "2026-07-10T00:00:00.000Z",
    prefs: { manual: ["/a"], hidden: [], expanded: [], viewMode: null, taskPanelOpen: false },
  } } }), "utf8");
  expect(boardFor("proj", file).keyRevisions).toEqual({});
  mutateBoard("proj", 7, [{ kind: "close", path: "/a" }], file);
  expect(at(file, pathKey("/a"))).toBe(8);
});

test("a remap carries a placement without burning the old path's causal revision", () => {
  const file = temporaryFile();
  mutateBoard("proj", 0, [{ kind: "restore", path: "/old", placement: "manual" }], file);
  expect(at(file, pathKey("/old"))).toBe(1);

  remapBoardPaths("proj", [{ from: "/old", to: "/new" }], { filePath: file });
  /* Succession bookkeeping is not a competing operator decision: the placement
     followed the conversation, so queued intent naming /old is not superseded
     by the rename alone. The retired alias source is pruned from the map. */
  const board = boardFor("proj", file);
  expect(board.prefs.manual).toEqual(["/new"]);
  expect(board.keyRevisions?.[pathKey("/old")]).toBe(1);
});

test("mutationKeys names every key a mutation contends on", () => {
  expect(mutationKeys({ kind: "close", path: "/a" })).toEqual(["path:/a"]);
  expect(mutationKeys({ kind: "reconcile-roots", roots: ["/a"], removeManual: ["/b"] })).toEqual(["path:/a", "path:/b"]);
  expect(mutationKeys({ kind: "remap-paths", pairs: [{ from: "/a", to: "/b" }] })).toEqual(["path:/a", "path:/b"]);
  expect(mutationKeys({ kind: "set-engine-child-fold", id: "c1", path: "/a", folded: true })).toEqual(["fold:c1", "path:/a"]);
  /* A presentation mutation contends only on the fields it actually carries, so
     setting the task panel never fences a queued view-mode switch. */
  expect(mutationKeys({ kind: "set-presentation", taskPanelOpen: true })).toEqual(["taskPanelOpen"]);
  expect(mutationKeys({ kind: "set-presentation", viewMode: null })).toEqual(["viewMode"]);
});
