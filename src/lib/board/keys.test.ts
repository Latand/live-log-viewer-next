import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { IDLE_COLLAPSE_KEY, keyRevisionAt, MAX_RETIRED_KEY_REVISIONS, mutationKeys, pathKey, VIEW_MODE_KEY } from "./keys";
import { boardFor, migrateBoardProjects, mutateBoard, remapBoardPaths } from "./store";

/*
 * The durable contract behind convergence (#38): every write stamps the causal
 * revision of the keys it changed. This is what makes ABA detectable — a value
 * driven away and back is indistinguishable by comparison, and unmistakable by
 * revision. Any surface that wants revision-fenced per-project durable settings
 * relies on exactly these properties: revisions advance on every write, move
 * only the keys a write changed, are durable across a restart, unify across an
 * alias boundary so one logical key has one clock, and survive tombstone GC by
 * leaving a floor behind rather than forgetting.
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

test("a remap unifies the two names onto one clock without burning it", () => {
  const file = temporaryFile();
  mutateBoard("proj", 0, [{ kind: "restore", path: "/old", placement: "manual" }], file);
  expect(at(file, pathKey("/old"))).toBe(1);

  remapBoardPaths("proj", [{ from: "/old", to: "/new" }], { filePath: file });
  const board = boardFor("proj", file);
  expect(board.prefs.manual).toEqual(["/new"]);
  /* One logical thing, one clock. The alias source stops holding a clock of its
     own — two names with independent clocks is ABA across an alias boundary, and
     a stale writer naming /old would look unopposed against a write naming /new.
     Both names now read the same revision. */
  expect(board.keyRevisions?.[pathKey("/old")]).toBeUndefined();
  expect(keyRevisionAt(board, pathKey("/old"))).toBe(1);
  expect(keyRevisionAt(board, pathKey("/new"))).toBe(1);
  /* Succession is bookkeeping, not a competing operator decision, so the rename
     alone does not advance the clock and cannot fence unrelated queued intent. */
  expect(keyRevisionAt(board, pathKey("/new"))).toBe(1);

  /* An informed post-remap write advances the shared clock, and the old name
     sees it — which is what fences a stale pre-remap writer. */
  mutateBoard("proj", board.revision, [{ kind: "close", path: "/new" }], file);
  expect(keyRevisionAt(boardFor("proj", file), pathKey("/old"))).toBe(3);
});

test("a merged alias class keeps the newer of the two clocks", () => {
  const file = temporaryFile();
  mutateBoard("proj", 0, [{ kind: "restore", path: "/old", placement: "manual" }], file); // path:/old = 1
  mutateBoard("proj", 1, [{ kind: "restore", path: "/new", placement: "manual" }], file); // path:/new = 2
  mutateBoard("proj", 2, [{ kind: "remap-paths", pairs: [{ from: "/old", to: "/new" }] }], file);

  /* Merging takes the maximum, so a rename can only ever move a class's clock
     forward. Intent formed against /old at revision 1 is now correctly fenced by
     the write that landed on /new at revision 2 — collapsing to the lower clock
     would un-supersede it. */
  const board = boardFor("proj", file);
  expect(keyRevisionAt(board, pathKey("/old"))).toBeGreaterThanOrEqual(2);
  expect(keyRevisionAt(board, pathKey("/old"))).toBe(keyRevisionAt(board, pathKey("/new")));
});

test("a board written before keys were unified normalizes its alias clocks on read", () => {
  const file = temporaryFile();
  /* The shape an earlier build could leave behind: an alias in place, and the
     source still holding a clock of its own. Canonicalizing only on lookup would
     leave that clock unreachable, so /new would read as never-written and a
     stale writer naming either name would sail through. */
  fs.writeFileSync(file, JSON.stringify({ projects: { proj: {
    schemaVersion: 1, revision: 9, updatedAt: "2026-07-27T00:00:00.000Z",
    pathAliases: { "/old": "/new" }, explicitManual: ["/new"],
    keyRevisions: { "path:/old": 7, "path:/new": 3 },
    prefs: { manual: ["/new"], hidden: [], expanded: [], favorites: [], viewMode: null, taskPanelOpen: false },
  } } }), "utf8");

  const board = boardFor("proj", file);
  expect(board.keyRevisions?.[pathKey("/old")]).toBeUndefined();
  /* Merged by maximum, so the older name's history is inherited rather than
     lost, and both names answer with it. */
  expect(board.keyRevisions?.[pathKey("/new")]).toBe(7);
  expect(keyRevisionAt(board, pathKey("/old"))).toBe(7);
});

test("a project-key migration carries source causal history forward", () => {
  const file = temporaryFile();
  const state = (revision: number, keyRevisions: Record<string, number>) => ({
    schemaVersion: 1, revision, updatedAt: "2026-07-27T00:00:00.000Z",
    pathAliases: {}, explicitManual: ["/x"], keyRevisions,
    prefs: { manual: ["/x"], hidden: [], expanded: [], favorites: [], viewMode: null, taskPanelOpen: false },
  });
  /* The same project under two keys — a catalog repair is about to unify them.
     The source has seen far more of this conversation's history than the target:
     /x was closed and reopened there, ending exactly where the target has it. */
  fs.writeFileSync(file, JSON.stringify({ projects: {
    "old-key": state(40, { "path:/x": 40 }),
    "new-key": state(3, { "path:/x": 3 }),
  } }), "utf8");

  expect(migrateBoardProjects(new Map([["old-key", "new-key"]]), file)).toBe(true);
  const board = boardFor("new-key", file);
  expect(board.prefs.manual).toEqual(["/x"]);
  /* A migrated key is the SAME logical key, so its clock has to survive the
     move. Restarting it from the target's history rewinds the class past writes
     that really happened, and intent formed before them stops being fenced. */
  expect(keyRevisionAt(board, pathKey("/x"))).toBeGreaterThanOrEqual(40);
});

test("compaction raises a floor instead of erasing causal history", () => {
  const file = temporaryFile();
  const keyRevisions: Record<string, number> = { "favorite:ancient": 5 };
  for (let index = 0; index < MAX_RETIRED_KEY_REVISIONS + 40; index += 1) keyRevisions[`favorite:dead-${index}`] = 100 + index;
  fs.writeFileSync(file, JSON.stringify({ projects: { proj: {
    schemaVersion: 1, revision: 900, updatedAt: "2026-07-27T00:00:00.000Z",
    pathAliases: {}, explicitManual: [], keyRevisions,
    prefs: { manual: [], hidden: [], expanded: [], favorites: [], viewMode: null, taskPanelOpen: false },
  } } }), "utf8");

  mutateBoard("proj", 900, [{ kind: "set-presentation", viewMode: "list" }], file);
  const board = boardFor("proj", file);

  /* Bounded: the map cannot grow with every id the operator ever touched. */
  expect(Object.keys(board.keyRevisions ?? {}).length).toBeLessThanOrEqual(MAX_RETIRED_KEY_REVISIONS + 8);
  /* Safe: what was dropped is not forgotten. An evicted key reads the floor, so
     it can still supersede intent older than the history that was discarded —
     reporting zero would quietly re-enable every stale writer. */
  expect(board.keyRevisions?.["favorite:ancient"]).toBeUndefined();
  expect(board.keyRevisionFloor).toBeGreaterThan(5);
  expect(keyRevisionAt(board, "favorite:ancient")).toBe(board.keyRevisionFloor!);
  /* Live keys keep their exact clock rather than being flattened to the floor. */
  expect(board.keyRevisions?.[VIEW_MODE_KEY]).toBe(901);
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
  expect(mutationKeys({ kind: "set-presentation", idleCollapseMinutes: null })).toEqual([IDLE_COLLAPSE_KEY]);
});
