import { expect, test } from "bun:test";

import type { BoardTask } from "@/lib/tasks/types";

import { buildPipeline } from "./store";
import { ensurePipelineForTask } from "./taskBinding";

const role = {
  roleId: "builder" as const,
  engine: "codex" as const,
  model: "gpt-5.6-sol",
  effort: "high",
  access: "read-write" as const,
  promptScaffold: "Build",
};

const spawnIdentity = {
  launchId: "launch-task-binding",
  conversationId: "conversation_task_binding",
};

function task(): BoardTask {
  return {
    id: "task-binding-1",
    project: "viewer",
    status: "inbox",
    text: "Durable binding\nFull acceptance criteria",
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
}

test("an unlinked task produces a minimal builder pipeline request", () => {
  const decision = ensurePipelineForTask(task(), [], {
    repoDir: "/repo",
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    ...spawnIdentity,
    srcPath: "/sessions/assigned.jsonl",
  });

  expect(decision).toEqual({
    task: "Durable binding",
    spec: "Durable binding\nFull acceptance criteria",
    taskIds: ["task-binding-1"],
    repoDir: "/repo",
    src: "/sessions/assigned.jsonl",
    autoStart: false,
    stages: [{
      id: "run",
      kind: "run",
      role: { roleId: "builder" },
      engine: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      access: "read-write",
      "prompt": "{{task}}",
      next: null,
    }],
  });
});

test("live links suppress auto-create while closed and hidden links remain history", () => {
  const linked = buildPipeline({
    id: "linked01",
    task: "linked",
    taskIds: [task().id],
    project: "viewer",
    repoDir: "/repo",
    stages: [{ id: "run", kind: "run", prompt: "run", next: null, effectiveRole: role }],
    srcPath: null,
    srcConversationId: null,
    now: "now",
  });

  expect(ensurePipelineForTask(task(), [linked], { repoDir: "/repo", engine: "codex", model: null, effort: null, ...spawnIdentity, srcPath: "/sessions/assigned.jsonl" })).toBeNull();

  linked.state = "closed";
  linked.cursor = null;
  linked.closedAt = "later";
  expect(ensurePipelineForTask(task(), [linked], { repoDir: "/repo", engine: "codex", model: null, effort: null, ...spawnIdentity, srcPath: "/sessions/assigned.jsonl" })).not.toBeNull();

  linked.state = "provisioning";
  linked.cursor = { stageId: "run", state: "pending", input: null, activatedBy: null };
  linked.closedAt = null;
  linked.hiddenAt = "later";
  expect(ensurePipelineForTask(task(), [linked], { repoDir: "/repo", engine: "codex", model: null, effort: null, ...spawnIdentity, srcPath: "/sessions/assigned.jsonl" })).not.toBeNull();
});

test("auto-create bounds a valid long board-task title to the pipeline limit", () => {
  const longTask = task();
  longTask.text = "x".repeat(4_500);

  const decision = ensurePipelineForTask(longTask, [], {
    repoDir: "/repo",
    engine: "codex",
    model: null,
    effort: null,
    ...spawnIdentity,
    srcPath: "/sessions/assigned.jsonl",
  });

  expect(decision?.task).toHaveLength(4_000);
  expect(decision?.spec).toHaveLength(4_500);
});
