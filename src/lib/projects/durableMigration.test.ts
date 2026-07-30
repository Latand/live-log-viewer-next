import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-project-migration-"));
const ORIGINAL_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });

const { persistProjectAliases, resetProjectAliasesForTests } = await import("./aliases");
const { boardFor, migrateBoardProjects, mutateBoard } = await import("@/lib/board/store");
const { loadTasks } = await import("@/lib/tasks/store");
const { loadFlows, saveFlows } = await import("@/lib/flows/store");
const { buildPipeline, loadPipelines, savePipelines } = await import("@/lib/pipelines/store");
const { buildWorkflow, loadWorkflows, saveWorkflows } = await import("@/lib/workflows/store");

afterAll(() => {
  if (ORIGINAL_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ORIGINAL_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("pre-change board, task, flow, pipeline, and workflow records load under one repository identity", () => {
  const legacyA = "shared-repository";
  const legacyB = "-alternate-root-shared-repository";
  const target = "repo-0123456789abcdef0123456789abcdef";
  const boardFile = path.join(process.env.LLV_STATE_DIR!, "board.json");
  const tasksFile = path.join(process.env.LLV_STATE_DIR!, "tasks.json");

  mutateBoard(legacyA, 0, [{ kind: "restore", path: "/conversation-a", placement: "manual" }], boardFile);
  mutateBoard(legacyB, 0, [{ kind: "restore", path: "/conversation-b", placement: "manual" }], boardFile);
  fs.writeFileSync(tasksFile, JSON.stringify({
    tasks: [{
      id: "task-a",
      project: legacyA,
      status: "inbox",
      text: "Preserve the task",
      placement: "unplaced",
      assignments: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  }));
  saveFlows([{
    id: "flow-a",
    template: "implement-review-loop",
    project: legacyB,
    cwd: path.join(SANDBOX, "repository"),
    implementerPath: path.join(SANDBOX, "implementer.jsonl"),
    implementerConversationId: null,
    roles: {
      implementer: { engine: "codex", model: null, effort: "medium" },
      reviewer: { engine: "codex", model: null, effort: "xhigh" },
    },
    reviewerFallback: null,
    baseMode: "head",
    baseRef: "HEAD",
    mode: "manual",
    reviewerMode: "headless",
    roundLimit: 1,
    headRef: null,
    targetSha: null,
    state: "reviewing",
    pausedState: null,
    stateDetail: null,
    kickoffDelivery: null,
    rounds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
  }]);
  savePipelines([buildPipeline({
    id: "pipe0001",
    task: "Preserve the pipeline",
    project: legacyA,
    repoDir: path.join(SANDBOX, "repository"),
    stages: [{
      id: "build",
      kind: "run",
      "prompt": "",
      next: null,
      effectiveRole: {
        roleId: null,
        engine: "codex",
        model: null,
        effort: "medium",
        access: "read-write",
        promptScaffold: null,
      },
    }],
    srcPath: null,
    srcConversationId: null,
    now: "2026-01-01T00:00:00.000Z",
  })]);
  const template = {
    name: "migration",
    finish: "pr" as const,
    stages: [
      {
        kind: "implement" as const,
        agent: { engine: "codex" as const, model: null, effort: "medium" },
        scope: "Implement",
      },
      {
        kind: "review-loop" as const,
        reviewer: { engine: "codex" as const, model: null, effort: "xhigh" },
        fixer: { engine: "codex" as const, model: null, effort: "low" },
        roundLimit: 1,
        reviewerMode: "headless" as const,
      },
    ],
  };
  saveWorkflows([buildWorkflow({
    id: "work0001",
    name: "migration",
    task: "Preserve the workflow",
    project: legacyB,
    repoDir: path.join(SANDBOX, "repository"),
    template,
    mode: "manual",
    now: "2026-01-01T00:00:00.000Z",
  })]);

  expect(migrateBoardProjects(new Map([[legacyA, target], [legacyB, target]]), boardFile)).toBe(true);
  expect(persistProjectAliases([
    { source: legacyA, target, displayName: "shared-repository" },
    { source: legacyB, target, displayName: "shared-repository" },
  ])).toBe(true);
  resetProjectAliasesForTests();

  expect(boardFor(legacyA, boardFile).prefs.manual).toEqual(["/conversation-a", "/conversation-b"]);
  expect(loadTasks(tasksFile).map((task) => task.project)).toEqual([target]);
  expect(loadFlows().map((flow) => flow.project)).toEqual([target]);
  expect(loadPipelines().map((pipeline) => pipeline.project)).toEqual([target]);
  expect(loadWorkflows().map((workflow) => workflow.project)).toEqual([target]);
});
