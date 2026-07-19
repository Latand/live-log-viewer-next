import { expect, test } from "bun:test";

import type { DurableConversationMembership } from "@/lib/agent/registry";
import type { FileEntry } from "@/lib/types";

import { buildBranchGroups } from "@/components/projectModel";
import { stageOpenTarget } from "@/components/pipelines/pipelineModel";
import { buildSchemeLayout } from "@/components/scheme/layout";

import { filterPipelinesForFileScan } from "./visibility";
import type { Pipeline } from "./types";

function file(path: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    path,
    root: "codex-sessions",
    name: path,
    project: "repo",
    title: path,
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...over,
  };
}

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

test("a resumed member keeps its pipeline rail, halo, and open target on the current transcript", () => {
  const sourceId = "conversation_019f4906-3f67-7b72-9fbc-9ec3b5ad1325";
  const memberId = "conversation_019f4906-3f67-7b72-9fbc-9ec3b5ad1326";
  const source = file("/source.jsonl", { conversationId: sourceId, activity: "live" });
  const resumed = file("/new.jsonl", { conversationId: memberId, parent: source.path, kind: "subagent" });
  const archived = file("/old.jsonl", { conversationId: memberId, migratedTo: resumed.path });
  const pipeline = {
    ...hiddenPipeline(memberId),
    hiddenAt: undefined,
    state: "running",
    cursor: { stageId: "verify", state: "running", input: null, activatedBy: null },
    stages: [
      { id: "build", kind: "run", prompt: "build", next: "verify" },
      { id: "verify", kind: "run", prompt: "verify", next: null },
    ],
    runs: [
      { stageId: "build", attempts: [{ n: 1, state: "passed", conversationId: sourceId, agentPath: source.path }] },
      { stageId: "verify", attempts: [{ n: 1, state: "running", conversationId: memberId, agentPath: archived.path }] },
    ],
  } as Pipeline;

  const projected = filterPipelinesForFileScan([pipeline], [source, archived, resumed])[0]!;
  const currentFiles = [source, resumed];
  const layout = buildSchemeLayout(
    buildBranchGroups(currentFiles, "repo"),
    [],
    currentFiles,
    [],
    [],
    [projected],
    [projected],
  );
  const currentAttempt = projected.runs[1]!.attempts[0]!;

  expect(currentAttempt.agentPath).toBe(resumed.path);
  expect(layout.links).toContainEqual(expect.objectContaining({
    kind: "pipeline",
    from: source.path,
    to: resumed.path,
  }));
  expect(layout.groups.find((group) => group.pipeline?.id === projected.id)?.members)
    .toEqual(expect.arrayContaining([source.path, resumed.path]));
  expect(stageOpenTarget(projected.stages[1]!, currentAttempt, undefined, new Set(currentFiles.map((entry) => entry.path))))
    .toEqual({ kind: "path", path: resumed.path });
});
