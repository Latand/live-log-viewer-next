import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";

const previousStateDir = process.env.LLV_STATE_DIR;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-tasks-read-model-"));
process.env.LLV_STATE_DIR = sandbox;

const route = await import("./route");
const { buildPipeline, savePipelines } = await import("@/lib/pipelines/store");
const { saveTasks, TASKS_FILE } = await import("@/lib/tasks/store");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("GET derives pipelineIds including closed history and filters stale task ids", async () => {
  const task: BoardTask = {
    id: "task-read-1",
    project: "viewer",
    status: "assigned",
    text: "Read model",
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
  const pipeline = buildPipeline({
    id: "history1",
    task: "History",
    taskIds: [task.id, "deleted-task"],
    project: "viewer",
    repoDir: "/repo",
    stages: [{
      id: "run",
      kind: "run",
      "prompt": "run",
      next: null,
      effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null },
    }],
    srcPath: null,
    srcConversationId: null,
    now: "now",
  });
  pipeline.state = "closed";
  pipeline.cursor = null;
  pipeline.closedAt = "later";
  pipeline.hiddenAt = "later";
  saveTasks([task]);
  savePipelines([pipeline]);

  const response = await (route as { GET(): Promise<Response> }).GET();
  const body = await response.json() as { tasks: Array<BoardTask & { pipelineIds: string[] }> };

  expect(body.tasks).toEqual([{ ...task, pipelineIds: [pipeline.id] }]);
  expect((JSON.parse(fs.readFileSync(TASKS_FILE, "utf8")).tasks[0] as BoardTask & { pipelineIds?: string[] }).pipelineIds).toBeUndefined();
  expect((JSON.parse(fs.readFileSync(path.join(sandbox, "pipelines.json"), "utf8")).pipelines[0] as Pipeline).taskIds).toEqual([task.id, "deleted-task"]);
});
