import { expect, test } from "bun:test";
import { NextRequest } from "next/server";

import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";

import { DELETE, POST } from "./route";

test("POST ensures a pipeline from the attached conversation profile", async () => {
  let tasks: BoardTask[] = [{
    id: "task-1",
    project: "viewer",
    status: "inbox",
    text: "Attach existing builder",
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  }];
  const bindingCalls: unknown[] = [];
  const dependencies = {
    loadTasks: () => tasks,
    mutateTasks: (mutator: (current: BoardTask[]) => { tasks?: BoardTask[]; result: unknown }) => {
      const mutation = mutator(tasks);
      if (mutation.tasks) tasks = mutation.tasks;
      return mutation.result;
    },
    spawnParamsForPath: () => ({ repoDir: "/repo", engine: "codex" as const, model: "gpt-5.6-sol", effort: "high" }),
    ensureTaskPipelineForAssignment: async (task: BoardTask, spawnParams: unknown) => {
      bindingCalls.push({ taskId: task.id, spawnParams });
      return { pipeline: { id: "pipeline-test" } as Pipeline };
    },
  } as Parameters<typeof POST.withDependencies>[2];
  const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/tasks/task-1/assignment", {
    method: "POST",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ path: "/sessions/builder.jsonl" }),
  }), { params: Promise.resolve({ id: "task-1" }) }, dependencies);

  expect(response.status).toBe(200);
  expect(bindingCalls).toEqual([{
    taskId: "task-1",
    spawnParams: { repoDir: "/repo", engine: "codex", model: "gpt-5.6-sol", effort: "high" },
  }]);
  expect(tasks[0]!.assignments).toEqual([expect.objectContaining({ path: "/sessions/builder.jsonl", state: "handoff" })]);

  const replay = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/tasks/task-1/assignment", {
    method: "POST",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ path: "/sessions/builder.jsonl" }),
  }), { params: Promise.resolve({ id: "task-1" }) }, dependencies);
  expect(replay.status).toBe(200);
  expect(bindingCalls).toHaveLength(1);
});

test("DELETE rejects a body without a stable assignment handle", async () => {
  const request = new NextRequest("http://127.0.0.1/api/tasks/task-1/assignment", {
    method: "DELETE",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ path: " ", conversationId: "", panePid: null }),
  });
  const response = await DELETE(request, { params: Promise.resolve({ id: "task-1" }) });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "launchId, path, conversationId or panePid is required" });
});
