import { describe, expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { buildBranchGroups, buildProjectSummaries, descendantCounts, isConversation, kidsIndex, subtree } from "./projectModel";

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects",
    name: overrides.path,
    project: "demo",
    title: overrides.path,
    engine: "claude",
    kind: "сесія",
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
  entry({ path: "/root/a", parent: "/root", kind: "субагент" }),
  entry({ path: "/root/a/x", parent: "/root/a", kind: "субагент" }),
  entry({ path: "/root/b", parent: "/root", kind: "субагент" }),
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
