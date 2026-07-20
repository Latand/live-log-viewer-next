import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";

import { viewerMcpBindings } from "./bindings";

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

test("spawn_agent reaches spawn validation through the operator admission lane", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-binding-spawn-"));
  sandboxes.push(sandbox);
  process.env.LLV_STATE_DIR = sandbox;
  const spawnAgent = viewerMcpBindings().spawn_agent;
  const missingCwd = path.join(sandbox, "missing-cwd");

  for (const request of [
    { clientRequestId: "mcp-roleless-spawn", engine: "codex", cwd: missingCwd, prompt: "probe" },
    { clientRequestId: "mcp-builder-spawn", role: "builder", cwd: missingCwd, prompt: "probe" },
  ]) {
    await expect(spawnAgent(request)).rejects.toThrow(`directory does not exist: ${missingCwd}`);
  }
  expect(fs.readFileSync(path.join(sandbox, "operator-spawn-capability"), "utf8").trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("link_task_to_pipeline binds the latest operational attempt after historical adoption", async () => {
  const operationalPath = "/pipeline/operational.jsonl";
  const operationalConversationId = "conversation_operational";
  const historicalPath = "/pipeline/historical-child.jsonl";
  const pipeline = {
    id: "pipeline-mcp-operational",
    srcPath: null,
    srcConversationId: null,
    runs: [{ stageId: "build", attempts: [
      {
        n: 1,
        state: "running",
        historical: false,
        agentPath: operationalPath,
        conversationId: operationalConversationId,
      },
      {
        n: 2,
        state: "passed",
        historical: true,
        agentPath: historicalPath,
        conversationId: "conversation_historical_child",
      },
    ] }],
  } as unknown as Pipeline;
  let tasks: BoardTask[] = [{
    id: "task-mcp-operational",
    project: "live-log-viewer-next",
    status: "inbox",
    text: "Link the operational pipeline member",
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-07-20T10:30:00.000Z",
    updatedAt: "2026-07-20T10:30:00.000Z",
  }];
  const bindings = viewerMcpBindings({
    getPipelines: () => ({ pipelines: [pipeline] }),
    mutateTasks: (mutator) => {
      const mutation = mutator(tasks);
      if (mutation.tasks) tasks = mutation.tasks;
      return mutation.result;
    },
    isoNow: () => "2026-07-20T10:31:00.000Z",
  });

  const result = await bindings.link_task_to_pipeline({
    taskId: tasks[0]!.id,
    pipelineId: pipeline.id,
    clientRequestId: "mcp-link-operational-attempt",
  });

  expect(result).toMatchObject({
    conversationId: operationalConversationId,
    transcriptPath: operationalPath,
  });
  expect(tasks[0]!.assignments).toEqual([expect.objectContaining({
    conversationId: operationalConversationId,
    path: operationalPath,
    state: "handoff",
  })]);
});

test("link_task_to_pipeline follows the cursor retry after a fail-edge loop-back", async () => {
  const retryPath = "/pipeline/build-retry.jsonl";
  const retryConversationId = "conversation_build_retry";
  const stalePath = "/pipeline/stale-verify.jsonl";
  const pipeline = {
    id: "pipeline-mcp-loop-back",
    srcPath: null,
    srcConversationId: null,
    stages: [
      { id: "build", kind: "run" },
      { id: "verify", kind: "run" },
    ],
    runs: [
      { stageId: "build", attempts: [
        {
          n: 1,
          state: "passed",
          historical: false,
          agentPath: "/pipeline/build-first.jsonl",
          conversationId: "conversation_build_first",
          startedAt: "2026-07-20T11:10:00.000Z",
          completedAt: "2026-07-20T11:11:00.000Z",
        },
        {
          n: 2,
          state: "running",
          historical: false,
          agentPath: retryPath,
          conversationId: retryConversationId,
          startedAt: "2026-07-20T11:13:00.000Z",
          completedAt: null,
          activatedBy: { stageId: "verify", attempt: 1, edge: "fail" },
        },
      ] },
      { stageId: "verify", attempts: [{
        n: 1,
        state: "failed",
        historical: false,
        agentPath: stalePath,
        conversationId: "conversation_stale_verify",
        startedAt: "2026-07-20T11:11:00.000Z",
        completedAt: "2026-07-20T11:12:00.000Z",
      }] },
    ],
    cursor: {
      stageId: "build",
      state: "running",
      input: "Fix the failed verification",
      activatedBy: { stageId: "verify", attempt: 1, edge: "fail" },
    },
    state: "running",
  } as unknown as Pipeline;
  let tasks: BoardTask[] = [{
    id: "task-mcp-loop-back",
    project: "live-log-viewer-next",
    status: "inbox",
    text: "Link the active loop-back retry",
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-07-20T11:14:00.000Z",
    updatedAt: "2026-07-20T11:14:00.000Z",
  }];
  const bindings = viewerMcpBindings({
    getPipelines: () => ({ pipelines: [pipeline] }),
    mutateTasks: (mutator) => {
      const mutation = mutator(tasks);
      if (mutation.tasks) tasks = mutation.tasks;
      return mutation.result;
    },
    isoNow: () => "2026-07-20T11:15:00.000Z",
  });

  const result = await bindings.link_task_to_pipeline({
    taskId: tasks[0]!.id,
    pipelineId: pipeline.id,
    clientRequestId: "mcp-link-loop-back-attempt",
  });

  expect(result).toMatchObject({
    conversationId: retryConversationId,
    transcriptPath: retryPath,
  });
  expect(tasks[0]!.assignments).toEqual([expect.objectContaining({
    conversationId: retryConversationId,
    path: retryPath,
    state: "handoff",
  })]);
  expect(tasks[0]!.assignments[0]!.path).not.toBe(stalePath);
});
