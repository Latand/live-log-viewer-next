import { expect, test } from "bun:test";

import type { DurableConversationMembership } from "@/lib/agent/registry";
import type { FileEntry } from "@/lib/types";

import { filterPipelinesForFileScan } from "./visibility";
import type { Pipeline } from "./types";

function hiddenPipeline(conversationId: string): Pipeline {
  return {
    id: "pipeline-hidden",
    task: "durable",
    project: "repo",
    repoDir: "/missing/repo",
    worktreeDir: "/missing/worktree",
    branch: "pipeline/durable-pipeline-hidden",
    baseBranch: "main",
    baseRef: "base",
    lastPassedCommit: "head",
    stages: [],
    runs: [{ stageId: "build", attempts: [{ conversationId, agentPath: "/old.jsonl" } as never] }],
    cursor: null,
    state: "closed",
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    closedAt: "2026-01-01T01:00:00.000Z",
    hiddenAt: "2026-01-01T01:00:00.000Z",
  };
}

test("a pinned resumed member restores its hidden pipeline read model", () => {
  const conversationId = "conversation_019f4906-3f67-7b72-9fbc-9ec3b5ad1326";
  const file = { path: "/resumed.jsonl", conversationId } as FileEntry;
  const archived = { path: "/old.jsonl", conversationId, migratedTo: file.path } as FileEntry;
  const membership = {
    conversationId,
    kind: "pipeline",
    containerId: "pipeline-hidden",
    role: "builder",
    slot: "build:1",
    stageId: "build",
    stageOrder: 0,
    round: null,
    parentConversationId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as DurableConversationMembership;

  expect(filterPipelinesForFileScan([hiddenPipeline(conversationId)], [file, archived], {
    pinnedPaths: new Set(),
    memberships: { [conversationId]: [membership] },
  })).toEqual([]);
  expect(filterPipelinesForFileScan([hiddenPipeline(conversationId)], [file, archived], {
    pinnedPaths: new Set([file.path]),
    memberships: { [conversationId]: [membership] },
  })[0]).toMatchObject({
    id: "pipeline-hidden",
    state: "closed",
    restored: true,
    runs: [{ attempts: [{ conversationId, agentPath: "/resumed.jsonl" }] }],
  });
});
