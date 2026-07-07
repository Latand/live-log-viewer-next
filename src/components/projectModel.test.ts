import { describe, expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import {
  buildArchiveBranchGroups,
  buildBranchGroups,
  buildProjectSummaries,
  descendantCounts,
  isConversation,
  kidsIndex,
  quietRootsWithActiveDescendants,
  residualItems,
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

describe("buildBranchGroups", () => {
  test("a live root opens a group with its subtree accounted for", () => {
    const groups = buildBranchGroups(TREE, "demo");
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.key).toBe("/root");
    expect(group.columns[0]!.file.path).toBe("/root");
    /* Quiet subagents of a live claude session stay returnable chips. */
    const chipPaths = [...group.returnable, ...group.finished].map((file) => file.path).sort();
    expect(chipPaths).toEqual(["/root/a", "/root/a/x", "/root/b"]);
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
});

describe("buildArchiveBranchGroups", () => {
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
