import { describe, expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import {
  buildArchiveBranchGroups,
  buildBranchGroups,
  buildProjectSummaries,
  collapsedTrees,
  draftWorkingDirectory,
  descendantCounts,
  isConversation,
  isSubagent,
  kidsIndex,
  quietHistoryRows,
  quietRootsWithActiveDescendants,
  projectDraftWorkingDirectory,
  residualItems,
  resolveProjectView,
  schemeAgeHorizonSeconds,
  subtree,
  withinPlacementHorizon,
} from "./projectModel";

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

const TREE: FileEntry[] = [
  entry({ path: "/root", activity: "live" }),
  entry({ path: "/root/a", parent: "/root", kind: "subagent" }),
  entry({ path: "/root/a/x", parent: "/root/a", kind: "subagent" }),
  entry({ path: "/root/b", parent: "/root", kind: "subagent" }),
  entry({ path: "/other" }),
];

describe("tree primitives", () => {
  test("kidsIndex groups children by parent", () => {
    const kids = kidsIndex(TREE);
    expect(kids.get("/root")?.map((file) => file.path)).toEqual(["/root/a", "/root/b"]);
    expect(kids.get("/other")).toBeUndefined();
  });

  test("subtree returns all descendants, excluding the root itself", () => {
    const kids = kidsIndex(TREE);
    const paths = subtree(TREE[0]!, kids).map((file) => file.path).sort();
    expect(paths).toEqual(["/root/a", "/root/a/x", "/root/b"]);
  });

  test("descendantCounts agrees with subtree for every node", () => {
    const counts = descendantCounts(TREE);
    expect(counts.get("/root")).toBe(3);
    expect(counts.get("/root/a")).toBe(1);
    expect(counts.get("/other")).toBe(0);
  });

  test("subtree survives a parent cycle", () => {
    const cyclic = [
      entry({ path: "/a", parent: "/b" }),
      entry({ path: "/b", parent: "/a" }),
    ];
    const counts = descendantCounts(cyclic);
    expect(counts.get("/a")).toBe(1);
    expect(counts.get("/b")).toBe(1);
  });
});

describe("draftWorkingDirectory", () => {
  test("prefills project drafts from the dominant canonical root and handoffs from their source cwd", () => {
    const files = [
      entry({ path: "/recent-worktree", project: "viewer", cwd: "/repo/.worktrees/fix", projectRoot: "/repo", mtime: 300 }),
      entry({ path: "/older-main", project: "viewer", cwd: "/repo", projectRoot: "/repo", mtime: 200 }),
      entry({ path: "/other-root", project: "viewer", cwd: "/alternate", projectRoot: "/alternate", mtime: 400 }),
      entry({ path: "/elsewhere", project: "other", cwd: "/elsewhere", projectRoot: "/elsewhere", mtime: 500 }),
    ];

    expect(draftWorkingDirectory(files, "viewer")).toBe("/repo");
    expect(draftWorkingDirectory(files, "viewer", "/recent-worktree")).toBe("/repo/.worktrees/fix");
  });

  test("uses the freshest canonical root when project candidates have equal support", () => {
    const files = [
      entry({ path: "/older", project: "viewer", cwd: "/older", projectRoot: "/older", mtime: 100 }),
      entry({ path: "/newer", project: "viewer", cwd: "/newer", projectRoot: "/newer", mtime: 200 }),
    ];

    expect(draftWorkingDirectory(files, "viewer")).toBe("/newer");
  });

  test("uses a project-owned repository fallback before its first conversation exists", () => {
    expect(draftWorkingDirectory([], "viewer", undefined, ["", "/repo"])).toBe("/repo");
  });

  test("prefills a catalog-only project from its full-scan canonical root", () => {
    expect(projectDraftWorkingDirectory([], "viewer", [
      { project: "viewer", projectRoot: "/repo", smt: 100, conversations: 3 },
    ])).toBe("/repo");
  });

  test("prefers the full-scan canonical root when capped rows disagree", () => {
    const files = [
      entry({ path: "/minority", project: "viewer", cwd: "/minority", projectRoot: "/minority", mtime: 500 }),
    ];

    expect(projectDraftWorkingDirectory(files, "viewer", [
      { project: "viewer", projectRoot: "/canonical", smt: 600, conversations: 12 },
    ])).toBe("/canonical");
  });

  test("uses the deterministic server fallback when a project has no cwd metadata", () => {
    expect(projectDraftWorkingDirectory([], "legacy", [], undefined, [], "/home/user/Projects/legacy")).toBe(
      "/home/user/Projects/legacy",
    );
  });

  test("excludes an unresolved deleted scratchpad cwd from ordinary draft root voting", () => {
    const deletedScratchpad = "/tmp/claude-1000/-outside-repos-legacy/deleted-session/scratchpad";
    const files = [entry({
      path: "/sessions/deleted-scratchpad.jsonl",
      project: "legacy",
      cwd: deletedScratchpad,
      projectRoot: null,
      mtime: 900,
    })];

    expect(projectDraftWorkingDirectory(files, "legacy", [], undefined, [], "/home/user/Projects/legacy")).toBe(
      "/home/user/Projects/legacy",
    );
  });
});

describe("buildBranchGroups", () => {
  test("keeps a foreign-parent lineage on each conversation's own project board", () => {
    const foreignRoot = entry({ path: "/latand-root", project: "latand", activity: "live" });
    const viewerBuilder = entry({
      path: "/viewer-builder",
      project: "viewer",
      root: "codex-sessions",
      engine: "codex",
      fmt: "codex",
      parent: foreignRoot.path,
      activity: "live",
    });
    const viewerReviewer = entry({
      path: "/viewer-reviewer",
      project: "viewer",
      root: "codex-sessions",
      engine: "codex",
      fmt: "codex",
      parent: viewerBuilder.path,
      activity: "recent",
    });
    const latandFollowup = entry({
      path: "/latand-followup",
      project: "latand",
      root: "codex-sessions",
      engine: "codex",
      fmt: "codex",
      parent: viewerBuilder.path,
      activity: "live",
    });
    const files = [foreignRoot, viewerBuilder, viewerReviewer, latandFollowup];

    const viewerGroups = buildBranchGroups(files, "viewer");
    expect(viewerGroups).toHaveLength(1);
    expect(viewerGroups[0]!.key).toBe(viewerBuilder.path);
    expect(viewerGroups[0]!.columns.map((column) => column.file.path)).toEqual([
      viewerBuilder.path,
      viewerReviewer.path,
    ]);

    const latandGroups = buildBranchGroups(files, "latand");
    expect(latandGroups.map((group) => group.key).sort()).toEqual([
      foreignRoot.path,
      latandFollowup.path,
    ].sort());
    expect(latandGroups.find((group) => group.key === foreignRoot.path)!.columns.map((column) => column.file.path)).toEqual([
      foreignRoot.path,
    ]);
    expect(latandGroups.find((group) => group.key === latandFollowup.path)!.columns.map((column) => column.file.path)).toEqual([
      latandFollowup.path,
    ]);
  });

  test("keeps a project segment visible when its foreign-parent child becomes idle", () => {
    const projectRoot = entry({ path: "/project-root", project: "viewer", activity: "live" });
    const foreignParent = entry({
      path: "/foreign-parent",
      project: "latand",
      root: "codex-sessions",
      engine: "codex",
      fmt: "codex",
      parent: projectRoot.path,
      activity: "live",
    });
    const segment = entry({
      path: "/project-segment",
      project: "viewer",
      root: "codex-sessions",
      engine: "codex",
      fmt: "codex",
      parent: foreignParent.path,
      activity: "live",
    });

    expect(buildBranchGroups([projectRoot, foreignParent, segment], "viewer").map((group) => group.key).sort()).toEqual([
      projectRoot.path,
      segment.path,
    ].sort());

    const idleSegment = { ...segment, activity: "idle" as const };
    const afterTurn = buildBranchGroups([projectRoot, foreignParent, idleSegment], "viewer");
    expect(afterTurn.map((group) => group.key).sort()).toEqual([
      projectRoot.path,
      segment.path,
    ].sort());
    expect(afterTurn.find((group) => group.key === segment.path)!.columns.map((column) => column.file.path)).toEqual([
      segment.path,
    ]);
  });

  test("a live root promotes its live-owned subagents to connected columns", () => {
    const groups = buildBranchGroups(TREE, "demo");
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.key).toBe("/root");
    expect(group.columns[0]!.file.path).toBe("/root");
    /* Subagents of a live claude session are live-relevant work: each renders
       as a connected column below the root, not a detached chip. */
    expect(group.columns.map((column) => column.file.path)).toEqual(["/root", "/root/a", "/root/a/x", "/root/b"]);
    expect([...group.returnable, ...group.finished]).toHaveLength(0);
  });

  test("a compaction-chain predecessor is no conversation root", () => {
    expect(isConversation(entry({ path: "/root" }))).toBe(true);
    expect(isConversation(entry({ path: "/root", parent: "/older" }))).toBe(false);
  });

  test("an OpenClaw transcript is a conversation root of its own (#1207)", () => {
    const openclaw = { root: "openclaw-sessions" as const, engine: "openclaw" as const, fmt: "openclaw" as const };
    expect(isConversation(entry({ path: "/openclaw/oc-session-alpha.jsonl", ...openclaw }))).toBe(true);
    expect(isSubagent(entry({ path: "/openclaw/oc-session-alpha.jsonl", ...openclaw }))).toBe(false);
  });

  test("a standalone viewer-spawned conversation stays a root despite its spawner parent", () => {
    const lineage = {
      kind: "spawn" as const,
      role: "builder",
      depth: 1,
      parentConversationId: "conversation_parent",
      reviewsConversationId: null,
      memberships: [],
    };
    expect(isConversation(entry({ path: "/spawned", parent: "/other-project/orchestrator", durableLineage: lineage }))).toBe(true);
    /* Pipeline/flow members keep their container placement. */
    const member = {
      ...lineage,
      memberships: [{ kind: "pipeline" as const, containerId: "p1", role: "builder", slot: "s", stageId: null, stageOrder: null, round: null, parentConversationId: null }],
    };
    expect(isConversation(entry({ path: "/member", parent: "/other", durableLineage: member }))).toBe(false);
    /* A handoff branch keeps rendering under its source. */
    expect(isConversation(entry({ path: "/handoff", parent: "/source", handoff: true, durableLineage: lineage }))).toBe(false);
  });

  test("idle roots with active descendants are marked for quiet history", () => {
    const files = [
      entry({ path: "/idle-root", activity: "idle", mtime: 10 }),
      entry({ path: "/idle-root/live-child", parent: "/idle-root", kind: "subagent", activity: "live", mtime: 20 }),
      entry({ path: "/idle-root/running-child", parent: "/idle-root", root: "codex-sessions", engine: "codex", proc: "running", mtime: 25 }),
      entry({ path: "/plain-quiet", activity: "idle", mtime: 30 }),
      entry({ path: "/active-child-only", parent: "/plain-quiet", kind: "subagent", activity: "idle", mtime: 40 }),
    ];
    const groups = buildBranchGroups(files, "demo");
    const activeRoots = new Set(groups.map((group) => group.key));

    expect(activeRoots.has("/idle-root")).toBe(true);
    expect(groups[0]!.columns.map((column) => column.file.path)).toContain("/idle-root/running-child");
    const quietActiveRoots = quietRootsWithActiveDescendants(files, "demo", activeRoots);
    expect(quietActiveRoots).toEqual(new Set(["/idle-root"]));
    expect(residualItems(files, "demo", activeRoots, quietActiveRoots).map((file) => file.path)).toContain("/idle-root");
    expect(residualItems(files, "demo", activeRoots).map((file) => file.path)).not.toContain("/idle-root");
  });

  test("a quiet child conversation of a live owner promotes to a column by default", () => {
    const root = entry({ path: "/implementer", activity: "live" });
    const reviewSubtask = entry({
      path: "/review-subtask",
      root: "codex-sessions",
      engine: "codex",
      fmt: "codex",
      parent: "/implementer",
      activity: "idle",
    });

    /* The owner session (/implementer) is live, so its quiet child is live-
       relevant work and renders as a connected column below it — no explicit
       expansion required. */
    const group = buildBranchGroups([root, reviewSubtask], "demo")[0]!;
    expect(group.columns.map((column) => column.file.path)).toEqual(["/implementer", "/review-subtask"]);
    expect(group.returnable).toHaveLength(0);
  });

  test("expanded flow conversations keep implementer and reviewer children as separate levels", () => {
    const root = entry({ path: "/conversation", activity: "idle" });
    const implementer = entry({
      path: "/implementer",
      root: "codex-sessions",
      engine: "codex",
      fmt: "codex",
      parent: "/conversation",
      activity: "idle",
    });
    const reviewSubtask = entry({
      path: "/review-subtask",
      root: "codex-sessions",
      engine: "codex",
      fmt: "codex",
      parent: "/implementer",
      activity: "idle",
    });

    const group = buildBranchGroups([root, implementer, reviewSubtask], "demo", {
      expandedConversationPaths: new Set(["/implementer", "/review-subtask"]),
    })[0]!;

    expect(group.key).toBe("/conversation");
    expect(group.columns.map((column) => column.file.path)).toEqual(["/conversation", "/implementer", "/review-subtask"]);
    expect(group.returnable).toHaveLength(0);
    expect(group.finished).toHaveLength(0);
  });

  test("engine placement folds a quiet child out of the columns and promotes an idle one back in", () => {
    const root = entry({ path: "/root", activity: "live" });
    const folded = entry({ path: "/root/quiet", parent: "/root", kind: "subagent", activity: "idle", spawnOrigin: "engine" });
    const promoted = entry({ path: "/root/attn", parent: "/root", kind: "subagent", activity: "idle", spawnOrigin: "engine" });

    const group = buildBranchGroups([root, folded, promoted], "demo", {
      enginePlacement: {
        foldedEnginePaths: new Set(["/root/quiet"]),
        promotedEnginePaths: new Set(["/root/attn"]),
      },
    })[0]!;

    const columnPaths = group.columns.map((column) => column.file.path);
    // The folded child never takes a column; it renders only as a tray row.
    expect(columnPaths).not.toContain("/root/quiet");
    // The promoted (idle-but-actionable) child stays a full node.
    expect(columnPaths).toContain("/root/attn");
    // The folded child is not lost — it drops into the group's finished stack.
    expect(group.finished.map((file) => file.path)).toContain("/root/quiet");
  });

  test("a promoted engine child opens its parent group even when the parent is idle", () => {
    const idleParent = entry({ path: "/parent", activity: "idle" });
    const promoted = entry({ path: "/parent/attn", parent: "/parent", kind: "subagent", activity: "idle", spawnOrigin: "engine" });
    const groups = buildBranchGroups([idleParent, promoted], "demo", {
      enginePlacement: { promotedEnginePaths: new Set(["/parent/attn"]) },
    });
    expect(groups.map((group) => group.key)).toContain("/parent");
    const group = groups.find((candidate) => candidate.key === "/parent")!;
    expect(group.columns.map((column) => column.file.path)).toContain("/parent/attn");
  });
});

describe("automatic placement age horizon", () => {
  const HOUR = 3_600;
  const NOW = 1_754_500_000;

  test("an idle root active earlier today keeps an automatic card", () => {
    const root = entry({ path: "/idle-today", activity: "idle", mtime: NOW - 2 * HOUR });
    expect(buildBranchGroups([root], "demo", { now: NOW }).map((group) => group.key)).toEqual(["/idle-today"]);
  });

  test("a stalled root from yesterday keeps an automatic card", () => {
    const root = entry({ path: "/stalled-yesterday", activity: "stalled", mtime: NOW - 13 * HOUR });
    expect(buildBranchGroups([root], "demo", { now: NOW }).map((group) => group.key)).toEqual(["/stalled-yesterday"]);
  });

  test("a root beyond the horizon loses its automatic card yet stays in quiet history", () => {
    const stale = entry({ path: "/stale", activity: "stalled", mtime: NOW - 120 * HOUR });
    const fresh = entry({ path: "/fresh", activity: "idle", mtime: NOW - HOUR });
    const files = [stale, fresh];
    expect(buildBranchGroups(files, "demo", { now: NOW }).map((group) => group.key)).toEqual(["/fresh"]);
    expect(quietHistoryRows(files, "demo").map((file) => file.path)).toContain("/stale");
  });

  test("a live or running conversation keeps its card whatever its age", () => {
    const live = entry({ path: "/live-old", activity: "live", mtime: NOW - 400 * HOUR });
    const running = entry({ path: "/running-old", activity: "idle", proc: "running", mtime: NOW - 400 * HOUR });
    expect(buildBranchGroups([live, running], "demo", { now: NOW }).map((group) => group.key).sort())
      .toEqual(["/live-old", "/running-old"]);
  });

  test("an explicitly expanded root beyond the horizon still renders", () => {
    const stale = entry({ path: "/stale-expanded", activity: "idle", mtime: NOW - 200 * HOUR });
    const groups = buildBranchGroups([stale], "demo", {
      now: NOW,
      expandedConversationPaths: new Set(["/stale-expanded"]),
    });
    expect(groups.map((group) => group.key)).toEqual(["/stale-expanded"]);
  });

  test("a recently active child never resurrects its stale root's card", () => {
    const root = entry({ path: "/old-root", activity: "idle", mtime: NOW - 200 * HOUR });
    const child = entry({ path: "/old-root/agent", parent: "/old-root", kind: "subagent", activity: "idle", mtime: NOW - 13 * HOUR });
    const groups = buildBranchGroups([root, child], "demo", { now: NOW });
    // The fresh child opens its own group; the root it hangs under stays in
    // quiet history instead of returning to the canvas after weeks of silence.
    expect(groups.map((group) => group.key)).toEqual(["/old-root/agent"]);
    expect(quietHistoryRows([root, child], "demo").map((file) => file.path)).toContain("/old-root");
  });

  test("two fresh children of one stale root share a single group", () => {
    const root = entry({ path: "/old-root", activity: "idle", mtime: NOW - 200 * HOUR });
    const mid = entry({ path: "/old-root/mid", parent: "/old-root", kind: "subagent", activity: "idle", mtime: NOW - 13 * HOUR });
    const leaf = entry({ path: "/old-root/mid/leaf", parent: "/old-root/mid", kind: "subagent", activity: "idle", mtime: NOW - 12 * HOUR });
    const groups = buildBranchGroups([root, mid, leaf], "demo", { now: NOW });
    // One group, not two: the deeper placed descendant joins the topmost
    // placeable ancestor's group (as a settled chip, per the quiet-child rule)
    // instead of opening a duplicate node for the same tree.
    expect(groups.map((group) => group.key)).toEqual(["/old-root/mid"]);
    expect(groups[0]!.columns.map((column) => column.file.path)).toEqual(["/old-root/mid"]);
    expect(groups[0]!.finished.map((file) => file.path)).toContain("/old-root/mid/leaf");
  });

  test("an aged root placed by another rule owns its live descendant instead of doubling it", () => {
    /* Two rules meet on one tree: the operator expanded the aged root, and the
       child is live. The root is on the canvas, so lifting the child to the
       "topmost PLACEABLE ancestor" stopped at the child itself and opened a
       second group for a card the root's group already renders as a column. */
    const root = entry({ path: "/old-root", activity: "idle", mtime: NOW - 200 * HOUR });
    const child = entry({ path: "/old-root/agent", parent: "/old-root", kind: "subagent", activity: "live", mtime: NOW - 200 * HOUR });
    const groups = buildBranchGroups([root, child], "demo", { now: NOW, expandedConversationPaths: new Set(["/old-root"]) });
    expect(groups.map((group) => group.key)).toEqual(["/old-root"]);
    expect(groups[0]!.columns.map((column) => column.file.path)).toEqual(["/old-root", "/old-root/agent"]);
    // Every path the groups render, exactly once.
    const rendered = groups.flatMap((group) => group.columns.map((column) => column.file.path));
    expect(rendered).toEqual([...new Set(rendered)]);
  });

  test("a promoted engine child of an aged root is not emitted twice", () => {
    const root = entry({ path: "/old-root", activity: "idle", mtime: NOW - 200 * HOUR });
    const child = entry({ path: "/old-root/agent", parent: "/old-root", kind: "subagent", activity: "idle", mtime: NOW - 200 * HOUR });
    const groups = buildBranchGroups([root, child], "demo", {
      now: NOW,
      expandedConversationPaths: new Set(["/old-root"]),
      enginePlacement: { promotedEnginePaths: new Set(["/old-root/agent"]) },
    });
    const rendered = groups.flatMap((group) => group.columns.map((column) => column.file.path));
    expect(rendered).toEqual([...new Set(rendered)]);
    expect(rendered).toContain("/old-root/agent");
  });

  test("durable spawn lineage keeps a recent middle conversation inside one root group", () => {
    const spawned = { kind: "spawn", role: null, depth: 0, parentConversationId: "c", reviewsConversationId: null, memberships: [] } as FileEntry["durableLineage"];
    const top = entry({ path: "/top", root: "codex-sessions", engine: "codex", activity: "live", mtime: NOW - HOUR });
    const mid = entry({ path: "/mid", parent: "/top", durableLineage: spawned, activity: "recent", mtime: NOW - HOUR });
    const leaf = entry({ path: "/leaf", parent: "/mid", durableLineage: spawned, activity: "live", mtime: NOW - HOUR });
    const groups = buildBranchGroups([top, mid, leaf], "demo", { now: NOW });
    const rendered = groups.flatMap((group) => group.columns.map((column) => column.file.path));
    expect(rendered).toEqual([...new Set(rendered)]);
    expect(rendered).toContain("/leaf");
    const owner = groups.find((group) => group.columns.some((column) => column.file.path === "/leaf"))!;
    expect(owner.key).toBe("/top");
  });

  test("a stale child under a live root rests as a chip instead of taking a column", () => {
    const root = entry({ path: "/live-root", activity: "live", mtime: NOW - HOUR });
    const stale = entry({ path: "/live-root/ancient", parent: "/live-root", kind: "subagent", activity: "idle", mtime: NOW - 400 * HOUR });
    const fresh = entry({ path: "/live-root/today", parent: "/live-root", kind: "subagent", activity: "idle", mtime: NOW - 3 * HOUR });
    const group = buildBranchGroups([root, stale, fresh], "demo", { now: NOW })[0]!;
    expect(group.columns.map((column) => column.file.path)).toEqual(["/live-root", "/live-root/today"]);
    // Bounded off the canvas, never lost: it stays a chip in the under-deck.
    expect(group.finished.map((file) => file.path)).toContain("/live-root/ancient");
  });

  test("a stale child that is live or running keeps its column under a live root", () => {
    const root = entry({ path: "/live-root", activity: "live", mtime: NOW - HOUR });
    const running = entry({ path: "/live-root/long", parent: "/live-root", kind: "subagent", activity: "idle", proc: "running", mtime: NOW - 400 * HOUR });
    const group = buildBranchGroups([root, running], "demo", { now: NOW })[0]!;
    expect(group.columns.map((column) => column.file.path)).toEqual(["/live-root", "/live-root/long"]);
  });

  test("an explicitly expanded stale child places without its stale root", () => {
    const root = entry({ path: "/old-root", activity: "idle", mtime: NOW - 300 * HOUR });
    const child = entry({ path: "/old-root/agent", parent: "/old-root", kind: "subagent", activity: "idle", mtime: NOW - 300 * HOUR });
    const groups = buildBranchGroups([root, child], "demo", {
      now: NOW,
      expandedConversationPaths: new Set(["/old-root/agent"]),
    });
    expect(groups.map((group) => group.key)).toEqual(["/old-root/agent"]);
    expect(groups[0]!.columns.map((column) => column.file.path)).toEqual(["/old-root/agent"]);
  });

  test("without a clock a stale child still opens its root's group", () => {
    const root = entry({ path: "/old-root", activity: "idle", mtime: 1_000 });
    const child = entry({ path: "/old-root/agent", parent: "/old-root", kind: "subagent", activity: "recent", mtime: 1_000 });
    expect(buildBranchGroups([root, child], "demo").map((group) => group.key)).toEqual(["/old-root"]);
  });

  test("the placement horizon exempts live and running work and bounds the rest", () => {
    const live = entry({ path: "/live", activity: "live", mtime: NOW - 400 * HOUR });
    const running = entry({ path: "/running", activity: "idle", proc: "running", mtime: NOW - 400 * HOUR });
    const recent = entry({ path: "/recent", activity: "recent", mtime: NOW - 400 * HOUR });
    const stale = entry({ path: "/stale", activity: "idle", mtime: NOW - 400 * HOUR });
    const fresh = entry({ path: "/fresh", activity: "idle", mtime: NOW - HOUR });
    for (const file of [live, running, recent, fresh]) {
      expect(withinPlacementHorizon(file, NOW, 48 * HOUR)).toBe(true);
    }
    expect(withinPlacementHorizon(stale, NOW, 48 * HOUR)).toBe(false);
    // No clock: age is unknowable, so nothing is bounded.
    expect(withinPlacementHorizon(stale, 0, 48 * HOUR)).toBe(true);
  });

  test("a cross-project segment follows the horizon once its child is quiet", () => {
    const projectRoot = entry({ path: "/seg-root", project: "viewer", activity: "idle", mtime: NOW - HOUR });
    const foreignParent = entry({
      path: "/foreign",
      project: "latand",
      root: "codex-sessions",
      engine: "codex",
      fmt: "codex",
      parent: "/seg-root",
      activity: "idle",
      mtime: NOW - 200 * HOUR,
    });
    const freshSegment = entry({
      path: "/seg-fresh",
      project: "viewer",
      root: "codex-sessions",
      engine: "codex",
      fmt: "codex",
      parent: "/foreign",
      activity: "idle",
      mtime: NOW - 13 * HOUR,
    });
    const staleSegment = entry({
      path: "/seg-stale",
      project: "viewer",
      root: "codex-sessions",
      engine: "codex",
      fmt: "codex",
      parent: "/foreign",
      activity: "stalled",
      mtime: NOW - 200 * HOUR,
    });
    const groups = buildBranchGroups([projectRoot, foreignParent, freshSegment, staleSegment], "viewer", { now: NOW });
    expect(groups.map((group) => group.key).sort()).toEqual(["/seg-fresh", "/seg-root"]);
  });

  test("a narrowed horizon governs placement", () => {
    const groups = buildBranchGroups([
      entry({ path: "/two-hours", activity: "idle", mtime: NOW - 2 * HOUR }),
      entry({ path: "/thirteen-hours", activity: "idle", mtime: NOW - 13 * HOUR }),
    ], "demo", { now: NOW, ageHorizonSeconds: 6 * HOUR });
    expect(groups.map((group) => group.key)).toEqual(["/two-hours"]);
  });

  test("without a clock (hydration) placement follows the activity rule unchanged", () => {
    const idleOld = entry({ path: "/idle", activity: "idle", mtime: 1_000 });
    const recent = entry({ path: "/recent", activity: "recent", mtime: 1_000 });
    expect(buildBranchGroups([idleOld, recent], "demo").map((group) => group.key)).toEqual(["/recent"]);
  });

  test("the horizon reads its hours from the environment and falls back to two days", () => {
    const previous = process.env.NEXT_PUBLIC_LLV_SCHEME_AGE_HORIZON_HOURS;
    try {
      delete process.env.NEXT_PUBLIC_LLV_SCHEME_AGE_HORIZON_HOURS;
      expect(schemeAgeHorizonSeconds()).toBe(48 * HOUR);
      process.env.NEXT_PUBLIC_LLV_SCHEME_AGE_HORIZON_HOURS = "6";
      expect(schemeAgeHorizonSeconds()).toBe(6 * HOUR);
      process.env.NEXT_PUBLIC_LLV_SCHEME_AGE_HORIZON_HOURS = "nonsense";
      expect(schemeAgeHorizonSeconds()).toBe(48 * HOUR);
      process.env.NEXT_PUBLIC_LLV_SCHEME_AGE_HORIZON_HOURS = "0";
      expect(schemeAgeHorizonSeconds()).toBe(48 * HOUR);
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_LLV_SCHEME_AGE_HORIZON_HOURS;
      else process.env.NEXT_PUBLIC_LLV_SCHEME_AGE_HORIZON_HOURS = previous;
    }
  });
});

test("collapsed tree cards keep unsettled work and leave idle history off the canvas", () => {
  const idleRoot = entry({ path: "/idle-root" });
  const idleChild = entry({ path: "/idle-child", parent: idleRoot.path, kind: "subagent" });
  const stalledRoot = entry({ path: "/stalled-root" });
  const stalledChild = entry({
    path: "/stalled-child",
    parent: stalledRoot.path,
    kind: "subagent",
    activity: "stalled",
  });

  expect(collapsedTrees([idleRoot, idleChild, stalledRoot, stalledChild], "demo", new Set())
    .map((card) => card.root.path)).toEqual(["/stalled-root"]);
});

describe("buildArchiveBranchGroups", () => {
  test("a hydrated quiet project root renders as an archive group", () => {
    const quietRoot = entry({ path: "/example-old", project: "example-dispatcher", mtime: 50 });
    const groups = buildArchiveBranchGroups([quietRoot], "example-dispatcher", 100);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.columns.map((column) => column.file.path)).toEqual(["/example-old"]);
  });

  test("keeps ancestors for a fresh child so the scheme can draw the edge", () => {
    const oldRoot = entry({ path: "/old-root", mtime: 10 });
    const freshChild = entry({ path: "/old-root/fresh", parent: "/old-root", kind: "subagent", mtime: 200 });
    const groups = buildArchiveBranchGroups([oldRoot, freshChild, entry({ path: "/other", mtime: 20 })], "demo", 1);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.columns.map((column) => column.file.path)).toEqual(["/old-root", "/old-root/fresh"]);
  });

  test("caps by recent project rows before adding parent closure", () => {
    const rows = Array.from({ length: 105 }, (_, i) => entry({ path: `/root-${i}`, mtime: i }));
    const groups = buildArchiveBranchGroups(rows, "demo", 100);

    expect(groups).toHaveLength(100);
    expect(groups.some((group) => group.key === "/root-0")).toBe(false);
    expect(groups.some((group) => group.key === "/root-104")).toBe(true);
  });

  test("archives each project segment once across a foreign lineage", () => {
    const projectRoot = entry({ path: "/archive-root", project: "viewer", mtime: 30 });
    const foreignParent = entry({
      path: "/archive-foreign",
      project: "latand",
      root: "codex-sessions",
      engine: "codex",
      fmt: "codex",
      parent: projectRoot.path,
      mtime: 20,
    });
    const projectLeaf = entry({
      path: "/archive-leaf",
      project: "viewer",
      root: "codex-sessions",
      engine: "codex",
      fmt: "codex",
      parent: foreignParent.path,
      mtime: 10,
    });

    const groups = buildArchiveBranchGroups([projectRoot, foreignParent, projectLeaf], "viewer", 100);
    expect(groups.map((group) => group.key).sort()).toEqual([projectRoot.path, projectLeaf.path].sort());
    const occurrences = groups.flatMap((group) => [
      ...group.columns.map((column) => column.file.path),
      ...group.finished.map((file) => file.path),
    ]);
    expect(occurrences.filter((path) => path === projectLeaf.path)).toHaveLength(1);
    expect(groups.find((group) => group.key === projectRoot.path)!.columns.map((column) => column.file.path)).toEqual([
      projectRoot.path,
    ]);
  });
});

describe("quietHistoryRows", () => {
  test("returns root conversations only when roots exist", () => {
    const files = [
      entry({ path: "/root-old", mtime: 10 }),
      entry({ path: "/root-new", mtime: 30 }),
      entry({ path: "/root-new/child", parent: "/root-new", kind: "subagent", mtime: 40 }),
      entry({ path: "/codex-child", root: "codex-sessions", engine: "codex", fmt: "codex", parent: "/root-new", mtime: 50 }),
      entry({ path: "/other-project", project: "elsewhere", mtime: 60 }),
    ];

    expect(quietHistoryRows(files, "demo").map((file) => file.path)).toEqual(["/root-new", "/root-old"]);
  });

  test("falls back to project rows when no root conversations exist", () => {
    const files = [
      entry({ path: "/child-only", parent: "/missing", kind: "subagent", mtime: 10 }),
      entry({ path: "/task", root: "claude-tasks", engine: "shell", kind: "background", fmt: "plain", mtime: 20 }),
    ];

    expect(quietHistoryRows(files, "demo").map((file) => file.path)).toEqual(["/task", "/child-only"]);
  });
});

describe("resolveProjectView", () => {
  test("defaults quiet projects with history rows to the list", () => {
    expect(resolveProjectView({ preferredView: null, hasNodes: false, hasArchiveNodes: true, hasHistoryRows: true })).toBe("list");
  });

  test("defaults active projects to the scheme", () => {
    expect(resolveProjectView({ preferredView: null, hasNodes: true, hasArchiveNodes: false, hasHistoryRows: true })).toBe("scheme");
  });

  test("an explicit list selection wins even while the scheme has live nodes", () => {
    /* Issue #177 item 7: the Схема/Список toggle must switch reliably; a saved
       «list» choice is honored whenever history rows exist to show. */
    expect(resolveProjectView({ preferredView: "list", hasNodes: true, hasArchiveNodes: false, hasHistoryRows: true })).toBe("list");
  });

  test("a list selection with no history rows falls back to the active scheme", () => {
    expect(resolveProjectView({ preferredView: "list", hasNodes: true, hasArchiveNodes: false, hasHistoryRows: false })).toBe("scheme");
  });

  test("keeps an explicit scheme selection when an archive scheme exists", () => {
    expect(resolveProjectView({ preferredView: "scheme", hasNodes: false, hasArchiveNodes: true, hasHistoryRows: true })).toBe("scheme");
  });
});

describe("buildProjectSummaries with workflows", () => {
  const wf = (overrides: Partial<import("@/lib/workflows/types").Workflow>) =>
    ({
      id: "wf1",
      name: "demo",
      task: "t",
      project: "wf-only-project",
      repoDir: "/repo",
      worktreeDir: "/repo-wf-wf1",
      branch: "wf/t-wf1",
      baseBranch: "",
      baseRef: "",
      template: { name: "demo", stages: [], finish: "pr" },
      stageRuns: [],
      stageIndex: 0,
      flowId: null,
      fixerPath: null,
      state: "provisioning",
      pausedState: null,
      stateDetail: null,
      mode: "auto",
      setupPid: null,
      srcPath: null,
      prUrl: null,
      createdAt: "2026-07-05T00:00:00.000Z",
      closedAt: null,
      ...overrides,
    }) as import("@/lib/workflows/types").Workflow;

  test("a workflow-only project gets a rail row before any transcript exists", () => {
    const summaries = buildProjectSummaries(TREE, 2_000, [wf({})]);
    const row = summaries.find((summary) => summary.project === "wf-only-project");
    expect(row).toBeDefined();
    /* Provisioning counts as running work; the project sorts like a live one. */
    expect(row!.liveCount).toBe(1);
    expect(row!.smt).toBeGreaterThan(0);
  });

  test("a parked workflow lights the attention badge on its project", () => {
    const summaries = buildProjectSummaries([], 2_000, [wf({ state: "needs_decision" })]);
    expect(summaries[0]!.attentionCount).toBe(1);
    expect(summaries[0]!.liveCount).toBe(0);
  });

  test("closed workflows leave navigation alone", () => {
    expect(buildProjectSummaries([], 2_000, [wf({ state: "closed" })])).toHaveLength(0);
  });

  test("a workflow-only repository uses its separate display label", () => {
    const project = "repo-0123456789abcdef0123456789abcdef";
    const summaries = buildProjectSummaries(
      [],
      2_000,
      [wf({ project })],
      [],
      [],
      { [project]: "workflow-repository" },
    );
    expect(summaries[0]).toMatchObject({ project, displayName: "workflow-repository" });
  });
});

test("buildProjectSummaries keeps a pipeline-only project reachable and marks decisions", () => {
  const pipeline = {
    id: "pipeline-1",
    project: "pipeline-project",
    state: "needs_decision",
    createdAt: "2026-01-01T00:00:00.000Z",
  } as never;
  const summaries = buildProjectSummaries([], 2_000, [], [], [pipeline]);
  expect(summaries).toMatchObject([{ project: "pipeline-project", liveCount: 0, attentionCount: 1 }]);
});

describe("buildProjectSummaries with project catalog", () => {
  test("adds catalog-only projects as muted summaries", () => {
    const summaries = buildProjectSummaries([], 2_000, [], [
      { project: "catalog-project", conversations: 3, smt: 1_700_000_100 },
    ]);

    expect(summaries).toEqual([
      {
        project: "catalog-project",
        displayName: "catalog-project",
        liveCount: 0,
        attentionCount: 0,
        conversations: 3,
        smt: 1_700_000_100,
        catalogOnly: true,
      },
    ]);
  });

  test("catalog counts enrich projects already in the recent shortlist", () => {
    const summaries = buildProjectSummaries([entry({ path: "/recent", project: "Pr-Gram", mtime: 100 })], 2_000, [], [
      { project: "Pr-Gram", conversations: 7, smt: 50 },
    ]);

    expect(summaries[0]).toMatchObject({
      project: "Pr-Gram",
      conversations: 7,
      smt: 100,
      catalogOnly: false,
    });
  });
});
