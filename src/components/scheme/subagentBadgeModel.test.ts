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
      title: "active-first",
      engine: "codex",
      model: null,
      state: "running",
      avatarSeed: "active-first",
    },
    {
      id: "active-second",
      title: "active-second",
      engine: "codex",
      model: null,
      state: "live",
      avatarSeed: "active-second",
    },
    {
      id: "closed",
      title: "closed",
      engine: "codex",
      model: null,
      state: "closed",
      avatarSeed: "closed",
    },
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
