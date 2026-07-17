import { expect, test } from "bun:test";

import { NextRequest } from "next/server";

import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

import { postFlow } from "./createHandler";

const entry = {
  path: "/sessions/implementer.jsonl",
  root: "codex-sessions",
  name: "implementer.jsonl",
  project: "viewer",
  title: "Builder",
  engine: "codex",
  kind: "session",
  fmt: "codex",
  parent: null,
  mtime: 1,
  size: 1,
  activity: "idle",
  proc: null,
  pid: null,
  model: null,
  pendingQuestion: null,
  waitingInput: null,
} satisfies FileEntry;

function request(): NextRequest {
  return new NextRequest("http://127.0.0.1:8898/api/flows", {
    method: "POST",
    headers: { host: "127.0.0.1:8898", "content-type": "application/json" },
    body: JSON.stringify({ implementerPath: entry.path }),
  });
}

test("flow creation resolves only the selected transcript", async () => {
  const resolved: string[] = [];
  let received: FileEntry[] = [];
  const flow = { id: "fast-flow" } as Flow;
  const response = await postFlow(request(), {
    resolveEntry(pathname) {
      resolved.push(pathname);
      return entry;
    },
    async createFlow(_body, entries) {
      received = entries;
      return { flow };
    },
  });

  expect(response.status).toBe(201);
  expect(resolved).toEqual([entry.path]);
  expect(received).toEqual([entry]);
  expect(await response.json()).toEqual({ ok: true, flow });
});

test("flow creation rejects an unindexed exact transcript", async () => {
  let createCalled = false;
  const response = await postFlow(request(), {
    resolveEntry: () => null,
    async createFlow() {
      createCalled = true;
      return {};
    },
  });

  expect(response.status).toBe(404);
  expect(createCalled).toBeFalse();
});
