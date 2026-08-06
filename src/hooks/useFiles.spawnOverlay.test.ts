import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { createFilesClientCache } from "./useFiles";

/* The spawned-conversation overlay (issue #919): the composer applies the
   receipt-built `spawn:<launchId>` card into the client cache the moment the
   spawn receipt arrives, so the board renders the live window ahead of any
   `/api/files` round-trip. The server's own rows always outrank the overlay by
   path and by conversation identity, so the transcript merging in later can
   never duplicate what the stream-first render already showed. */

function row(path: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path,
    root: "codex-sessions",
    name: path,
    project: "project-a",
    title: "T",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "recent",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

const provisional = row("spawn:launch-919", {
  size: 0,
  activity: "live",
  conversationId: "conversation_919",
  spawnOrigin: "viewer",
  spawn: {
    launchId: "launch-919",
    clientAttemptId: "attempt-919",
    accountId: null,
    conversationId: "conversation_919",
    generation: 1,
    state: "queued",
    initialMessage: "queued",
    retrySafe: false,
    error: null,
  },
});

function body(files: FileEntry[], launchRoutes: Record<string, string> = {}) {
  return JSON.stringify({ files, flows: [], pipelines: [], workflows: [], tasks: [], launchRoutes, systemHealth: { tmux: { status: "healthy" } } });
}

test("a receipt overlay renders immediately and survives a stale scan that does not carry it", async () => {
  const bodies = [body([row("/other.jsonl")]), body([row("/other.jsonl")])];
  let call = 0;
  const cache = createFilesClientCache(async () => new Response(bodies[call++]!, { status: 200 }));

  await cache.revalidate();
  cache.applySpawnedConversation(provisional);
  expect(cache.read().files.map((entry) => entry.path)).toEqual(["/other.jsonl", "spawn:launch-919"]);

  /* A stale scan (started before the receipt existed) must not orphan the
     launch: the overlay keeps composing until a scan confirms the conversation. */
  await cache.revalidate();
  expect(cache.read().files.map((entry) => entry.path)).toEqual(["/other.jsonl", "spawn:launch-919"]);
});

test("the feed's own spawn projection replaces the overlay without duplication", async () => {
  const serverSpawnRow = row("spawn:launch-919", {
    activity: "live",
    conversationId: "conversation_919",
    spawn: { ...provisional.spawn!, state: "queued" },
  });
  const cache = createFilesClientCache(async () =>
    new Response(body([serverSpawnRow], { "spawn:launch-919": "conversation_919" }), { status: 200 }));

  cache.applySpawnedConversation(provisional);
  await cache.revalidate();

  const files = cache.read().files;
  expect(files.filter((entry) => entry.path === "spawn:launch-919")).toHaveLength(1);
  /* The server row, complete with its authoritative state, is what serves. */
  expect(files.find((entry) => entry.path === "spawn:launch-919")).toEqual(serverSpawnRow);
});

test("the materialized transcript merges in by conversation id without a duplicate window", async () => {
  const transcript = row("/sessions/rollout-919.jsonl", { conversationId: "conversation_919" });
  const cache = createFilesClientCache(async () =>
    new Response(body([transcript], { "spawn:launch-919": "conversation_919" }), { status: 200 }));

  cache.applySpawnedConversation(provisional);
  expect(cache.read().files.map((entry) => entry.path)).toEqual(["spawn:launch-919"]);

  await cache.revalidate();
  /* One surface per conversation: the transcript row IS the conversation now,
     and the overlay is retired rather than lingering as a second card. */
  expect(cache.read().files.map((entry) => entry.path)).toEqual(["/sessions/rollout-919.jsonl"]);
  expect(cache.read().files.filter((entry) => entry.conversationId === "conversation_919")).toHaveLength(1);
});
