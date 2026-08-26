import { expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { internalServiceHeaders } from "@/lib/agent/operatorAuthority";
import { recordDirectOperatorWakatimeActivity } from "@/lib/wakatime/operatorActivity";
import type { FileEntry, PendingQuestion } from "@/lib/types";

import { POST } from "./route";

test("disabled WakaTime leaves a legacy dialog answer unchanged and touches no activity state", async () => {
  let registryReads = 0;
  const entry = {
    path: "/sessions/answer-fixture.jsonl",
    root: "claude-projects",
    name: "answer-fixture.jsonl",
    project: "fixture",
    title: "fixture",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "recent",
    derivationComplete: true,
    proc: "running",
    pid: 42,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
  const pending = { toolUseId: "tool-answer-one" } as PendingQuestion;
  const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/answer", {
    method: "POST",
    headers: {
      host: "127.0.0.1",
      origin: "http://127.0.0.1",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      transcriptPath: entry.path,
      toolUseId: pending.toolUseId,
      kind: "single",
      option: 0,
    }),
  }), {
    knownState: async () => ({ entry, pending, result: null }),
    resolveTarget: async () => "agents:1.0",
    recordOperatorActivity: (input) => recordDirectOperatorWakatimeActivity(input, {
      enabled: () => false,
      registrySnapshot: () => {
        registryReads += 1;
        throw new Error("disabled recording touched the registry");
      },
    }),
    deliverAnswer: async () => "Proceed",
    confirmAnswered: async () => "Proceed",
    paneScreen: async () => "",
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, answer: "Proceed" });
  expect(registryReads).toBe(0);
});

test("a pending answer records one direct operator gesture and excludes internal service traffic", async () => {
  const entry = {
    path: "/sessions/operator-answer-fixture.jsonl",
    root: "claude-projects",
    name: "operator-answer-fixture.jsonl",
    project: "project-fixture",
    title: "fixture",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "recent",
    derivationComplete: true,
    proc: "running",
    pid: 43,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
  const recorded: Array<Parameters<typeof recordDirectOperatorWakatimeActivity>[0]> = [];
  const dependencies = {
    knownState: async (_transcriptPath: string, toolUseId: string) => ({
      entry,
      pending: { toolUseId } as PendingQuestion,
      result: null,
    }),
    resolveTarget: async () => "agents:2.0",
    recordOperatorActivity: (input: Parameters<typeof recordDirectOperatorWakatimeActivity>[0]) => {
      recorded.push(input);
      return { key: "d".repeat(64), engine: "claude" as const, project: entry.project, atMs: 1 };
    },
    deliverAnswer: async () => "Continue",
    confirmAnswered: async () => "Continue",
    paneScreen: async () => "",
  };
  const post = (toolUseId: string, headers: Record<string, string> = {}) => POST.withDependencies(
    new NextRequest("http://127.0.0.1/api/answer", {
      method: "POST",
      headers: {
        host: "127.0.0.1",
        origin: "http://127.0.0.1",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        transcriptPath: entry.path,
        toolUseId,
        kind: "single",
        option: 0,
      }),
    }),
    dependencies,
  );

  const direct = await post("tool-answer-direct-one");
  const synthetic = await post("tool-answer-synthetic-one", internalServiceHeaders("mcp"));

  expect([direct.status, synthetic.status]).toEqual([200, 200]);
  expect(recorded).toEqual([expect.objectContaining({
    path: entry.path,
    idempotencyKey: "question:tool-answer-direct-one",
  })]);
});
