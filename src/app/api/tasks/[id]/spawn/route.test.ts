import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { AgentRegistry, type SpawnReceipt } from "@/lib/agent/registry";
import type { BoardTask } from "@/lib/tasks/types";

import { POST } from "./route";

test("task attribution failure replays one launched pane into one durable assignment", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "llv-task-spawn-282-"));
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const sessionId = crypto.randomUUID();
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  let tasks: BoardTask[] = [{
    id: "08b5e4ec-89c5-4064-9118-51661c4f080b",
    project: "live-log-viewer-next",
    status: "inbox",
    text: "Own issue #282",
    placement: "pinned",
    pos: { x: 0, y: 0 },
    assignments: [],
    createdAt: "2026-07-15T18:06:00.000Z",
    updatedAt: "2026-07-15T18:06:00.000Z",
  }];
  let writes = 0;
  let spawnCalls = 0;
  const dependencies = {
    registry: () => registry,
    loadTasks: () => tasks,
    mutateTasks: (mutator: (current: BoardTask[]) => { tasks?: BoardTask[]; result: unknown }) => {
      writes += 1;
      if (writes === 2) throw new Error("task assignment write failed after launch");
      const mutation = mutator(tasks);
      if (mutation.tasks) tasks = mutation.tasks;
      return mutation.result;
    },
    resolveSpawnAccount: () => ({
      engine: "claude" as const,
      accountId: "claude-work",
      kind: "managed" as const,
      home: cwd,
      transcriptRoot: cwd,
      env: { NODE_ENV: "test" },
    }),
    resolveSpawnedTranscriptPath: async () => artifactPath,
    spawnAgentWithPrompt: async (_spec: unknown, _prompt: string, receipt: SpawnReceipt) => {
      spawnCalls += 1;
      const binding = {
        endpoint: "/tmp",
        server: { pid: 90, startIdentity: "90:one" },
        paneId: "%18",
        panePid: { pid: 3627416, startIdentity: "3627416:one" },
        target: "agents:18.0",
      };
      registry.bindSpawnPane(receipt.launchId, binding);
      const host = {
        kind: "tmux" as const,
        ...binding,
        windowName: "claude-builder",
        agent: { pid: 3627417, startIdentity: "3627417:one" },
        argv: ["claude"],
      };
      registry.markSpawnHostVerified(receipt.launchId, host);
      registry.markSpawnPromptDelivered(receipt.launchId);
      fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "user", message: { content: "Own issue #282" } })}\n`);
      return { paneId: "%18", display: "agents:18.0", panePid: 3627416, host, receipt };
    },
  } as Parameters<typeof POST.withDependencies>[2];
  const request = () => new NextRequest("http://127.0.0.1/api/tasks/08b5e4ec-89c5-4064-9118-51661c4f080b/spawn", {
    method: "POST",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({
      engine: "claude",
      model: "opus",
      effort: "high",
      cwd,
      clientAttemptId: "task_282_post_launch_write_20260715_a1",
    }),
  });
  const context = { params: Promise.resolve({ id: tasks[0]!.id }) };

  const uncertain = await POST.withDependencies(request(), context, dependencies);
  const uncertainBody = await uncertain.json();
  expect(uncertain.status).toBe(202);
  expect(uncertainBody).toMatchObject({
    ok: true,
    launchId: expect.any(String),
    conversationId: expect.stringMatching(/^conversation_/),
    path: artifactPath,
    panePid: 3627416,
    assignment: "spawning",
    initialMessage: "delivered",
    error: "task assignment write failed after launch",
  });

  const replay = await POST.withDependencies(request(), context, dependencies);
  const replayBody = await replay.json();
  expect(replay.status).toBe(200);
  expect(replayBody).toMatchObject({
    launchId: uncertainBody.launchId,
    conversationId: uncertainBody.conversationId,
    path: artifactPath,
    assignment: "delivered",
    initialMessage: "delivered",
  });
  expect(spawnCalls).toBe(1);
  expect(tasks[0]?.assignments).toEqual([expect.objectContaining({
    launchId: uncertainBody.launchId,
    clientAttemptId: "task_282_post_launch_write_20260715_a1",
    conversationId: uncertainBody.conversationId,
    path: artifactPath,
    panePid: 3627416,
    state: "delivered",
  })]);
});

test("pre-pane spawn failure returns an ownerless task to inbox", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "llv-task-ownerless-failure-"));
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  let tasks: BoardTask[] = [{
    id: "4f337f38-48dd-44af-bf15-5b544ce3ea13",
    project: "live-log-viewer-next",
    status: "inbox",
    text: "Repair release ownership",
    placement: "pinned",
    pos: { x: 0, y: 0 },
    assignments: [],
    createdAt: "2026-07-17T10:00:00.000Z",
    updatedAt: "2026-07-17T10:00:00.000Z",
  }];
  const dependencies = {
    registry: () => registry,
    loadTasks: () => tasks,
    mutateTasks: (mutator: (current: BoardTask[]) => { tasks?: BoardTask[]; result: unknown }) => {
      const mutation = mutator(tasks);
      if (mutation.tasks) tasks = mutation.tasks;
      return mutation.result;
    },
    resolveSpawnAccount: () => ({
      engine: "claude" as const,
      accountId: "claude-work",
      kind: "managed" as const,
      home: cwd,
      transcriptRoot: cwd,
      env: { NODE_ENV: "test" },
    }),
    resolveSpawnedTranscriptPath: async () => {
      throw new Error("transcript lookup must stay unreachable");
    },
    spawnAgentWithPrompt: async () => {
      throw new Error("process exited before pane creation");
    },
  } as Parameters<typeof POST.withDependencies>[2];
  const response = await POST.withDependencies(new NextRequest(
    "http://127.0.0.1/api/tasks/4f337f38-48dd-44af-bf15-5b544ce3ea13/spawn",
    {
      method: "POST",
      headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({
        engine: "claude",
        cwd,
        clientAttemptId: "task_ownerless_failure_20260717_a1",
      }),
    },
  ), { params: Promise.resolve({ id: tasks[0]!.id }) }, dependencies);
  const body = await response.json();
  const launchId = body.launchId;

  expect(response.status).toBe(500);
  expect(body).toMatchObject({
    launchId: expect.any(String),
    assignment: "failed",
    state: "failed",
    retrySafe: true,
    task: { status: "inbox" },
  });
  expect(tasks[0]).toMatchObject({
    status: "inbox",
    assignments: [{
      launchId,
      path: null,
      panePid: null,
      state: "failed",
      error: "process exited before pane creation",
    }],
  });
  const receiptSnapshot = registry.snapshot().receipts;
  expect(Object.keys(receiptSnapshot)).toContain(launchId);
  expect(receiptSnapshot[launchId]).toMatchObject({
    state: "failed",
    error: "process exited before pane creation",
  });
});
