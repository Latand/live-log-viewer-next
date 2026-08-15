import { expect, test } from "bun:test";
import { NextRequest } from "next/server";

import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { POST } from "./route";

function entry(path: string, engine: "claude" | "codex"): FileEntry {
  return {
    path,
    root: engine === "claude" ? "claude-projects" : "codex-sessions",
    name: `${engine}.jsonl`,
    project: "project-fixture",
    title: "fixture",
    engine,
    kind: "session",
    fmt: engine,
    parent: null,
    mtime: 1,
    size: 1,
    activity: "recent",
    derivationComplete: true,
    proc: "done",
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

test("one authorized task fan-out records one durable operator gesture across retry and delivery failure", async () => {
  const task: BoardTask = {
    id: "task-fanout-one",
    project: "project-fixture",
    status: "inbox",
    text: "Dispatch this task",
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-08-15T10:00:00.000Z",
    updatedAt: "2026-08-15T10:00:00.000Z",
  };
  const files = [entry("/sessions/a.jsonl", "claude"), entry("/sessions/b.jsonl", "codex")];
  const recorded = new Map<string, unknown>();
  let deliveries = 0;
  const dependencies = {
    loadTasks: () => [task],
    listFiles: async () => files,
    deliverConversationMessage: async () => {
      deliveries += 1;
      return { ok: false as const, outcome: "failed" as const, error: "offline", status: 503 };
    },
    mutateTasks: <R>(mutator: (tasks: BoardTask[]) => { tasks?: BoardTask[]; result: R }) => mutator([task]).result,
    recordOperatorActivity: (input: { idempotencyKey?: string }) => {
      const key = input.idempotencyKey ?? "";
      recorded.set(key, input);
      return { key: "a".repeat(64), engine: "claude" as const, project: task.project, atMs: 1 };
    },
    settleOperatorCompatibility: () => {},
  };
  const request = () => new NextRequest("http://127.0.0.1/api/tasks/task-fanout-one/send", {
    method: "POST",
    headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify({ paths: files.map((file) => file.path), clientRequestId: "task-send-gesture-one" }),
  });
  const context = { params: Promise.resolve({ id: task.id }) };

  const first = await POST.withDependencies(request(), context, dependencies);
  const retry = await POST.withDependencies(request(), context, dependencies);

  expect([first.status, retry.status]).toEqual([200, 200]);
  expect(deliveries).toBe(4);
  expect([...recorded.values()]).toEqual([{
    idempotencyKey: "task-send:task-send-gesture-one",
    resolvedAttribution: { engine: "claude", project: "project-fixture" },
  }]);
});
