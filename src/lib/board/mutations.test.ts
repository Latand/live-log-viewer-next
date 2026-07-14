import { describe, expect, test } from "bun:test";

import { applyBoardMutations } from "./mutations";

const board = (prefs: Partial<{ manual: string[]; hidden: string[]; expanded: string[]; favorites: string[] }> = {}) => ({
  schemaVersion: 1 as const,
  revision: 7,
  updatedAt: "2026-07-10T00:00:00.000Z",
  pathAliases: {},
  prefs: { manual: [], hidden: [], expanded: [], favorites: [], viewMode: null, taskPanelOpen: false, ...prefs },
});

describe("board mutations", () => {
  test("close tombstones manual, expanded, and unclassified paths idempotently", () => {
    for (const source of [board({ manual: ["/manual"] }), board({ expanded: ["/expanded"] }), board()]) {
      const path = source.prefs.manual[0] ?? source.prefs.expanded[0] ?? "/unclassified";
      const closed = applyBoardMutations(source, [{ kind: "close", path }]);
      expect(closed.prefs).toMatchObject({ manual: [], expanded: [], hidden: [path] });
      expect(applyBoardMutations(closed, [{ kind: "close", path }])).toEqual(closed);
    }
  });

  test("close and remap commute through persistent aliases", () => {
    const closedThenRemapped = applyBoardMutations(board(), [
      { kind: "close", path: "/old" },
      { kind: "remap-paths", pairs: [{ from: "/old", to: "/new" }] },
    ]);
    const remappedThenClosed = applyBoardMutations(board(), [
      { kind: "remap-paths", pairs: [{ from: "/old", to: "/new" }] },
      { kind: "close", path: "/old" },
    ]);
    expect(closedThenRemapped).toEqual(remappedThenClosed);
    expect(closedThenRemapped).toMatchObject({ pathAliases: { "/old": "/new" }, prefs: { hidden: ["/new"] } });
  });

  test("simultaneous remap deduplicates and gives hidden precedence in every membership list", () => {
    const remapped = applyBoardMutations(board({
      manual: ["/a", "/b", "/manual"],
      hidden: ["/b", "/hidden"],
      expanded: ["/a", "/expanded"],
    }), [{ kind: "remap-paths", pairs: [{ from: "/a", to: "/b" }, { from: "/manual", to: "/hidden" }] }]);
    expect(remapped.prefs).toMatchObject({ manual: [], hidden: ["/b", "/hidden"], expanded: ["/expanded"] });
  });

  test("remap replaces provisional target membership with predecessor placement", () => {
    const mutation = { kind: "remap-paths" as const, pairs: [{ from: "/source", to: "/target" }] };
    const automatic = applyBoardMutations(board({ manual: ["/target"] }), [mutation]);
    const expanded = applyBoardMutations(board({ manual: ["/target"], expanded: ["/source"] }), [mutation]);
    const manual = applyBoardMutations(board({ manual: ["/source", "/target"] }), [mutation]);

    expect(automatic.prefs.manual).toEqual([]);
    expect(expanded.prefs).toMatchObject({ manual: [], expanded: ["/target"] });
    expect(manual.prefs.manual).toEqual(["/target"]);
    expect(applyBoardMutations(expanded, [mutation])).toEqual(expanded);
  });

  test("a remapped automatic root stays automatic through root reconciliation", () => {
    const remapped = applyBoardMutations(board(), [{ kind: "remap-paths", pairs: [{ from: "/source", to: "/target" }] }]);
    const reconciled = applyBoardMutations(remapped, [{ kind: "reconcile-roots", roots: ["/target"], removeManual: [] }]);

    expect(reconciled.pathAliases).toEqual({ "/source": "/target" });
    expect(reconciled.prefs).toMatchObject({ manual: [], hidden: [], expanded: [] });
  });

  test("reconciles every root without a numeric cap, removes transient children, and is idempotent", () => {
    const roots = Array.from({ length: 61 }, (_, index) => `/root-${index}`);
    const first = applyBoardMutations(board({ manual: ["/transient-child"], hidden: ["/closed-root"] }), [{
      kind: "reconcile-roots",
      roots,
      removeManual: ["/transient-child"],
    }]);
    expect(first.prefs.manual).toEqual(roots);
    expect(first.explicitManual).toEqual([]);
    expect(first.prefs.hidden).toEqual(["/closed-root"]);
    expect(applyBoardMutations(first, [{ kind: "reconcile-roots", roots, removeManual: ["/transient-child"] }])).toEqual(first);
  });

  test("manual restore records durable provenance for a reconciled root until its placement changes", () => {
    const seeded = applyBoardMutations(board(), [{ kind: "reconcile-roots", roots: ["/root"], removeManual: [] }]);
    const pinned = applyBoardMutations(seeded, [{ kind: "restore", path: "/root", placement: "manual" }]);

    expect(pinned.prefs.manual).toEqual(["/root"]);
    expect(pinned.explicitManual).toEqual(["/root"]);
    expect(applyBoardMutations(pinned, [{ kind: "reconcile-roots", roots: ["/root"], removeManual: [] }]).explicitManual).toEqual(["/root"]);
    expect(applyBoardMutations(pinned, [{ kind: "close", path: "/root" }]).explicitManual).toEqual([]);
  });

  test("explicit role-aware restore survives reconciliation", () => {
    const restored = applyBoardMutations(board({ hidden: ["/root"] }), [{ kind: "restore", path: "/root", placement: "expanded" }]);
    expect(restored.prefs).toMatchObject({ hidden: [], manual: [], expanded: ["/root"] });
    const reconciled = applyBoardMutations(restored, [{ kind: "reconcile-roots", roots: ["/root"], removeManual: [] }]);
    expect(reconciled.prefs).toMatchObject({ manual: ["/root"], expanded: ["/root"] });
  });

  test("set-favorite adds and removes durable ids idempotently", () => {
    const on = applyBoardMutations(board(), [{ kind: "set-favorite", id: "conv-1", favorite: true }]);
    expect(on.prefs.favorites).toEqual(["conv-1"]);
    // A second add is a no-op (deduped), not a duplicate.
    expect(applyBoardMutations(on, [{ kind: "set-favorite", id: "conv-1", favorite: true }]).prefs.favorites).toEqual(["conv-1"]);
    const off = applyBoardMutations(on, [{ kind: "set-favorite", id: "conv-1", favorite: false }]);
    expect(off.prefs.favorites).toEqual([]);
    // Removing an absent id leaves the set untouched.
    expect(applyBoardMutations(off, [{ kind: "set-favorite", id: "conv-1", favorite: false }]).prefs.favorites).toEqual([]);
  });

  test("favorites are durable ids kept out of the path alias/hidden machinery", () => {
    /* A favorite keyed on a conversation id must survive a resume that remaps
       the transcript path and a close that hides that path — neither should
       touch the favorites set. */
    const seeded = applyBoardMutations(board({ manual: ["/old"] }), [{ kind: "set-favorite", id: "conv-9", favorite: true }]);
    const remapped = applyBoardMutations(seeded, [{ kind: "remap-paths", pairs: [{ from: "/old", to: "/new" }] }]);
    expect(remapped.prefs.favorites).toEqual(["conv-9"]);
    const closed = applyBoardMutations(remapped, [{ kind: "close", path: "/new" }]);
    expect(closed.prefs).toMatchObject({ hidden: ["/new"], favorites: ["conv-9"] });
  });
});
