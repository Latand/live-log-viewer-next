import { expect, test } from "bun:test";
import { NextRequest } from "next/server";

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
