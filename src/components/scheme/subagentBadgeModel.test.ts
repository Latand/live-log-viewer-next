import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { subagentsOf } from "./subagentBadgeModel";

function entry(overrides: Partial<FileEntry> & { path: string; conversationId: string }): FileEntry {
  return {
    root: "codex-sessions",
    name: overrides.name ?? overrides.path,
    project: "viewer",
    title: overrides.title ?? overrides.conversationId,
    engine: overrides.engine ?? "codex",
    kind: "session",
    fmt: "codex",
    parent: overrides.parent ?? null,
    mtime: overrides.mtime ?? 1,
    size: 1,
    activity: overrides.activity ?? "recent",
    proc: overrides.proc ?? null,
    pid: null,
    model: overrides.model ?? null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
    path: overrides.path,
    conversationId: overrides.conversationId,
  };
}

test("subagentsOf returns direct lineage children with active spawn order before closed retries", () => {
  const parent = entry({ path: "/parent", conversationId: "parent" });
  const closed = entry({
    path: "/closed",
    conversationId: "closed",
    parent: parent.path,
    sessionStartedAt: "2026-07-19T08:00:00Z",
    proc: "done",
  });
  const activeFirst = entry({
    path: "/active-first",
    conversationId: "active-first",
    sessionStartedAt: "2026-07-19T09:00:00Z",
    activity: "live",
    proc: "running",
    durableLineage: {
      kind: "spawn",
      role: "builder",
      parentConversationId: parent.conversationId!,
      reviewsConversationId: null,
      memberships: [],
    },
  });
  const activeSecond = entry({
    path: "/active-second",
    conversationId: "active-second",
    parent: parent.path,
    sessionStartedAt: "2026-07-19T10:00:00Z",
    activity: "recent",
  });
  const grandchild = entry({
    path: "/grandchild",
    conversationId: "grandchild",
    parent: activeFirst.path,
    activity: "live",
  });
  const backgroundTask = entry({
    path: "/background-task",
    conversationId: "background-task",
    parent: parent.path,
    root: "claude-tasks",
    engine: "shell",
    kind: "task",
    title: "Background task output",
    activity: "live",
  });

  expect(subagentsOf("parent", [closed, grandchild, backgroundTask, activeSecond, parent, activeFirst])).toEqual([
    {
      id: "active-first",
      path: "/active-first",
      title: "active-first",
      engine: "codex",
      model: null,
      state: "running",
      avatarSeed: "active-first",
    },
    {
      id: "active-second",
      path: "/active-second",
      title: "active-second",
      engine: "codex",
      model: null,
      state: "live",
      avatarSeed: "active-second",
    },
    {
      id: "closed",
      path: "/closed",
      title: "closed",
      engine: "codex",
      model: null,
      state: "closed",
      avatarSeed: "closed",
    },
  ]);
});

test("a live engine-native Workflow child renders as a titled badge under its parent (issue #339)", () => {
  const parent = entry({ path: "/proj/parent.jsonl", conversationId: "parent", engine: "claude", fmt: "claude", root: "claude-projects" });
  const workflowChild = entry({
    path: "/proj/parent/subagents/workflows/wf-1/agent-abc.jsonl",
    conversationId: "wf-child",
    parent: parent.path,
    engine: "claude",
    fmt: "claude",
    root: "claude-projects",
    kind: "subagent",
    title: "Audit the synthetic config loader",
    activity: "live",
    proc: "running",
    spawnOrigin: "engine",
    durableLineage: {
      kind: "spawn",
      role: null,
      parentConversationId: "parent",
      reviewsConversationId: null,
      memberships: [],
    },
  });

  expect(subagentsOf("parent", [parent, workflowChild])).toEqual([
    {
      id: "wf-child",
      path: "/proj/parent/subagents/workflows/wf-1/agent-abc.jsonl",
      title: "Audit the synthetic config loader",
      engine: "claude",
      model: null,
      state: "running",
      avatarSeed: "wf-child",
    },
  ]);
});

test("subagentsOf carries the current non-archived generation path for navigation", () => {
  const parent = entry({ path: "/parent", conversationId: "parent" });
  /* Two live generations of one child share a conversation id; the stale one
     sorts first in file order but must never be the navigation target. */
  const stale = entry({
    path: "/child-gen1",
    conversationId: "child",
    parent: parent.path,
    generation: 1,
    mtime: 5,
    title: "Child",
  });
  const current = entry({
    path: "/child-gen2",
    conversationId: "child",
    parent: parent.path,
    generation: 2,
    mtime: 6,
    title: "Child",
  });

  expect(subagentsOf("parent", [stale, current, parent])).toEqual([
    expect.objectContaining({ id: "child", path: "/child-gen2" }),
  ]);
});

test("subagentsOf keeps the highest generation when duplicate transcript entries disagree on mtime", () => {
  const parent = entry({ path: "/parent", conversationId: "parent" });
  const current = entry({
    path: "/child-current",
    conversationId: "child",
    parent: parent.path,
    generation: 2,
    mtime: 10,
    title: "Current generation",
  });
  const stale = entry({
    path: "/child-stale",
    conversationId: "child",
    parent: parent.path,
    generation: 1,
    mtime: 20,
    title: "Stale generation",
  });

  expect(subagentsOf("parent", [parent, current, stale])).toEqual([
    expect.objectContaining({ id: "child", title: "Current generation" }),
  ]);
});

test("subagentsOf marks an unscanned structured-spawn placeholder unavailable", () => {
  const parent = entry({ path: "/parent", conversationId: "parent" });
  const unscanned = entry({
    path: "spawn:launch-child",
    conversationId: "child",
    parent: parent.path,
    activity: "live",
    spawn: {
      launchId: "launch-child",
      clientAttemptId: null,
      accountId: null,
      state: "starting",
      initialMessage: "pending",
      retrySafe: false,
      error: null,
    },
  });

  expect(subagentsOf("parent", [parent, unscanned])).toEqual([
    expect.objectContaining({ id: "child", state: "dead" }),
  ]);
});
