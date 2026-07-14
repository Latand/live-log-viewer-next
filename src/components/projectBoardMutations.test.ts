import { expect, test } from "bun:test";

import { applyBoardMutations } from "@/lib/board/mutations";
import type { BoardProjectStateV1 } from "@/lib/view/types";
import type { FileEntry } from "@/lib/types";

import { planBoardConvergence, planClose, planRootReconciliation, planSuccessionRemap } from "./projectBoardMutations";

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects",
    name: overrides.path,
    project: "demo",
    title: overrides.path,
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1_000,
    size: 10,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

const boardOf = (prefs: Partial<BoardProjectStateV1["prefs"]>, pathAliases: Record<string, string> = {}): BoardProjectStateV1 => ({
  schemaVersion: 1,
  revision: 1,
  updatedAt: new Date(0).toISOString(),
  pathAliases,
  prefs: { manual: [], hidden: [], expanded: [], favorites: [], viewMode: null, taskPanelOpen: false, ...prefs },
});

const catalogOf = (files: FileEntry[]): Map<string, FileEntry> => new Map(files.map((file) => [file.path, file]));

/* 17: the reconciliation planner seeds only root group keys and retires the
   child/subagent and catalog-absent pollution — with no positional cap. */
test("17: planRootReconciliation seeds only root group keys past the former cap", () => {
  const groups = Array.from({ length: 41 }, (_, i) => ({ key: `/root-${i}`, orphanTask: false }));
  const child = entry({ path: "/root-0/child", parent: "/root-0", kind: "subagent" });
  const catalog = catalogOf([child, ...groups.map((group) => entry({ path: group.key }))]);
  const manual = ["/root-0", child.path, "/absent.jsonl"];

  const mutation = planRootReconciliation({ groups, manual, catalog });

  expect(mutation.kind).toBe("reconcile-roots");
  /* Every current root, beyond the old 40-entry truncation, and no child columns. */
  expect(mutation.roots).toEqual(groups.map((group) => group.key));
  expect(mutation.roots).toHaveLength(41);
  expect(mutation.roots).not.toContain(child.path);
  /* Child pollution and a catalog-absent entry are retired; a current root is kept. */
  expect(mutation.removeManual).toContain(child.path);
  expect(mutation.removeManual).toContain("/absent.jsonl");
  expect(mutation.removeManual).not.toContain("/root-0");
  /* Applying it seeds every root, drops the pollution, and is a fixed point. */
  const once = applyBoardMutations(boardOf({ manual }), [mutation]);
  expect(once.prefs.manual).toEqual(groups.map((group) => group.key));
  const twice = applyBoardMutations(once, [planRootReconciliation({ groups, manual: once.prefs.manual, catalog })]);
  expect(twice.prefs.manual).toEqual(once.prefs.manual);
});

/* An orphan-task group never seeds a durable root. */
test("17b: planRootReconciliation excludes orphan-task groups", () => {
  const groups = [
    { key: "/conv", orphanTask: false },
    { key: "/bash-task", orphanTask: true },
  ];
  const mutation = planRootReconciliation({ groups, manual: [], catalog: new Map() });
  expect(mutation.roots).toEqual(["/conv"]);
});

test("capped reconciliation preserves manual paths omitted from the scheme window", () => {
  const visibleChild = entry({ path: "/visible-child", parent: "/visible-root", kind: "subagent" });
  const mutation = planRootReconciliation({
    groups: [{ key: "/visible-root", orphanTask: false }],
    manual: [visibleChild.path, "/capped-out-root"],
    catalog: catalogOf([visibleChild]),
    catalogComplete: false,
  });

  expect(mutation.removeManual).toEqual([visibleChild.path]);
});

test("complete conversation membership preserves a capped-out background task placement", () => {
  const mutation = planRootReconciliation({
    groups: [],
    manual: ["/tasks/capped-out.output", "/sessions/deleted.jsonl"],
    catalog: new Map(),
    catalogComplete: true,
  });

  expect(mutation.removeManual).toEqual(["/sessions/deleted.jsonl"]);
});

/* 18: the convergence planner orders the succession remap before reconciliation
   so a predecessor's tombstone follows the identity onto the successor and the
   successor is never re-seeded into manual. */
test("18: planBoardConvergence orders remap before reconciliation and keeps a hidden successor hidden", () => {
  const successor = entry({ path: "/new", predecessorPath: "/old" });
  const groups = [{ key: "/new", orphanTask: false }];
  const catalog = catalogOf([successor]);

  const batch = planBoardConvergence({ files: [successor], groups, manual: [], catalog, project: "demo" });

  expect(batch[0]?.kind).toBe("remap-paths");
  expect(batch[1]?.kind).toBe("reconcile-roots");

  /* Predecessor hidden before the batch; successor active as a root. */
  const result = applyBoardMutations(boardOf({ hidden: ["/old"] }), batch);
  expect(result.prefs.hidden).toEqual(["/new"]);
  expect(result.prefs.manual).not.toContain("/new");

  /* Reversing the order would let reconciliation seed /new before the remap moved
     the tombstone — the ordering guarantee this planner encodes. */
  const remap = planSuccessionRemap([successor], "demo")!;
  const reconcile = planRootReconciliation({ groups, manual: [], catalog });
  const reversed = applyBoardMutations(boardOf({ hidden: ["/old"] }), [reconcile, remap]);
  /* Even reversed, normalization keeps hidden dominant. The canonical batch
     carries an explicit ordering guarantee. */
  expect(batch.map((mutation) => mutation.kind)).toEqual(["remap-paths", "reconcile-roots"]);
  expect(reversed.prefs.hidden).toEqual(["/new"]);
});

test("18b: planSuccessionRemap emits one deduped pair per successor and null when none", () => {
  const successor = entry({ path: "/new", predecessorPath: "/old" });
  const foreign = entry({ path: "/x", project: "other", predecessorPath: "/y" });
  expect(planSuccessionRemap([successor, foreign], "demo")).toEqual({ kind: "remap-paths", pairs: [{ from: "/old", to: "/new" }] });
  expect(planSuccessionRemap([entry({ path: "/plain" })], "demo")).toBeNull();
});

/* 19: closing a node emits exactly one durable close, independent of whether the
   path is currently an auto column, and clears its ephemeral jump target. */
test("19: planClose emits one durable close independent of autoPaths and clears ephemeral", () => {
  const result = planClose("/x", ["/x", "/y"]);
  expect(result.mutation).toEqual({ kind: "close", path: "/x" });
  /* Only the closed path leaves the ephemeral set. */
  expect(result.ephemeral).toEqual(["/y"]);
  /* The mutation has no render-state input and produces the same result for
     every current auto-column state. */
  expect(planClose("/x", []).mutation).toEqual(planClose("/x", ["/x"]).mutation);
  /* And it durably tombstones every membership shape when applied. */
  const closed = applyBoardMutations(boardOf({ manual: ["/x"], expanded: ["/x"] }), [result.mutation]);
  expect(closed.prefs.hidden).toEqual(["/x"]);
  expect(closed.prefs.manual).not.toContain("/x");
  expect(closed.prefs.expanded).not.toContain("/x");
});
