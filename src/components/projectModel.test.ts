import { describe, expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import {
  buildArchiveBranchGroups,
  buildBranchGroups,
  buildProjectSummaries,
  draftWorkingDirectory,
  descendantCounts,
  isConversation,
  kidsIndex,
  quietHistoryRows,
  quietRootsWithActiveDescendants,
  projectDraftWorkingDirectory,
  residualItems,
  resolveProjectView,
  subtree,
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
});

describe("buildArchiveBranchGroups", () => {
  test("a hydrated quiet project root renders as an archive group", () => {
    const quietRoot = entry({ path: "/stikon-old", project: "stikon-dispatcher", mtime: 50 });
    const groups = buildArchiveBranchGroups([quietRoot], "stikon-dispatcher", 100);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.columns.map((column) => column.file.path)).toEqual(["/stikon-old"]);
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
      { project: "Pr-Gram", conversations: 3, smt: 1_700_000_100 },
    ]);

    expect(summaries).toEqual([
      {
        project: "Pr-Gram",
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
