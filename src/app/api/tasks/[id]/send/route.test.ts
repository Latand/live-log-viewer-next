import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { recordDirectOperatorWakatimeActivity } from "@/lib/wakatime/operatorActivity";
import { enqueueProductionOperatorHeartbeat } from "@/lib/wakatime/sync";

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

test("a corrupt WakaTime state file does not refuse an authorized task fan-out", async () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-task-send-corrupt-state-"));
  const stateFile = path.join(stateDirectory, "wakatime-state.json");
  const corruptBytes = Buffer.alloc(4_096, 0);
  fs.writeFileSync(stateFile, corruptBytes, { mode: 0o600 });
  const task: BoardTask = {
    id: "task-corrupt-state",
    project: "project-fixture",
    status: "inbox",
    text: "Dispatch this task",
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-09-10T09:00:00.000Z",
    updatedAt: "2026-09-10T09:00:00.000Z",
  };
  const files = [entry("/sessions/corrupt-state.jsonl", "codex")];
  const outcomes: string[] = [];
  let deliveries = 0;

  try {
    const response = await POST.withDependencies(
      new NextRequest("http://127.0.0.1/api/tasks/task-corrupt-state/send", {
        method: "POST",
        headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ paths: files.map((file) => file.path), clientRequestId: "task-send-corrupt-state" }),
      }),
      { params: Promise.resolve({ id: task.id }) },
      {
        loadTasks: () => [task],
        listFiles: async () => files,
        deliverConversationMessage: async () => {
          deliveries += 1;
          return { ok: true as const, outcome: "delivered-to-live" as const, target: "agents:5.0" };
        },
        mutateTasks: <R,>(mutator: (tasks: BoardTask[]) => { tasks?: BoardTask[]; result: R }) => mutator([task]).result,
        recordOperatorActivity: (input) => recordDirectOperatorWakatimeActivity(input, {
          enabled: () => true,
          now: () => Date.parse("2026-09-10T09:00:00.000Z"),
          registrySnapshot: () => { throw new Error("resolved attribution should avoid registry access"); },
          enqueue: (heartbeat) => enqueueProductionOperatorHeartbeat(heartbeat, stateFile, () => true),
          reportStorageFailure: (event, fields) => { outcomes.push(`${event}:${String(fields.outcome)}`); },
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(deliveries).toBe(1);
    expect(outcomes).toEqual(["operator_activity_not_stored:state_unreadable"]);
    expect(fs.readFileSync(stateFile)).toEqual(corruptBytes);
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});
