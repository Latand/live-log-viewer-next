import type { FlowEngine } from "@/lib/flows/types";
import { firstLineTitle } from "@/lib/tasks/helpers";
import type { BoardTask } from "@/lib/tasks/types";

import { MAX_TASK_LENGTH } from "./limits";
import type { CreatePipelineRequest, Pipeline } from "./types";

export type TaskPipelineSpawnParams = {
  repoDir: string;
  engine: FlowEngine;
  model: string | null;
  effort: string | null;
};

export type TaskPipelineReadModel = BoardTask & { pipelineIds: string[] };

export function projectTaskPipelineIds(
  tasks: readonly BoardTask[],
  pipelines: readonly Pipeline[],
): TaskPipelineReadModel[] {
  return tasks.map((task) => ({
    ...task,
    pipelineIds: pipelines.filter((pipeline) => pipeline.taskIds.includes(task.id)).map((pipeline) => pipeline.id),
  }));
}

/** Pure assignment-time decision. Persistence repeats it under the store lock. */
export function ensurePipelineForTask(
  task: BoardTask,
  pipelines: readonly Pipeline[],
  spawnParams: TaskPipelineSpawnParams,
): CreatePipelineRequest | null {
  const linked = pipelines.some((pipeline) =>
    pipeline.taskIds.includes(task.id) && pipeline.state !== "closed" && !pipeline.hiddenAt);
  if (linked) return null;

  return {
    task: firstLineTitle(task.text).slice(0, MAX_TASK_LENGTH),
    spec: task.text,
    taskIds: [task.id],
    repoDir: spawnParams.repoDir,
    autoStart: false,
    stages: [{
      id: "run",
      kind: "run",
      role: { roleId: "builder" },
      engine: spawnParams.engine,
      model: spawnParams.model,
      effort: spawnParams.effort,
      access: "read-write",
      prompt: "{{task}}",
      next: null,
    }],
  };
}
