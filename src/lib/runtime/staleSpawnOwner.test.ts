import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";

import type { RuntimeHostClient } from "./client";
import { reconcileTerminalSpawnsHeldByLiveOwners } from "./staleSpawnOwner";
import { STALE_STRUCTURED_SPAWN_TIMEOUT_MS } from "./structuredSpawn";

test("a terminal operation releases a stale launch from a long-lived admission owner", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-terminal-owner-"));
  const store = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const begun = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    transport: "structured",
    accountId: "work",
    clientAttemptId: "terminal_owner_attempt_a1",
    requestDigest: "d".repeat(64),
    launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
  });
  if (begun.kind !== "created") throw new Error("expected structured launch creation");
  const receipt = begun.receipt;
  const client = {
    operationStatus: async (operationId: string) => operationId === receipt.launchId ? {
      receipt: {
        operationId,
        idempotencyKey: operationId,
        conversationId: receipt.conversationId,
        kind: "spawn" as const,
        status: "failed" as const,
        reason: "synthetic terminal spawn failure",
        at: new Date().toISOString(),
        revision: 2,
      },
      replayed: false,
    } : null,
    snapshot: async () => ({ revision: 0, sessions: [] }),
  } as unknown as RuntimeHostClient;

  try {
    const result = await reconcileTerminalSpawnsHeldByLiveOwners(store, client, {
      now: () => Date.now() + STALE_STRUCTURED_SPAWN_TIMEOUT_MS + 60_000,
      ownerAlive: () => true,
    });

    expect(result).toEqual({ examined: 1, terminalized: [receipt.launchId], recovered: [] });
    expect(store.snapshot().receipts[receipt.launchId]).toMatchObject({
      state: "failed",
      error: "synthetic terminal spawn failure",
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an open operation remains owned by its healthy admission process", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-open-owner-"));
  const store = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const begun = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    transport: "structured",
    accountId: "work",
    clientAttemptId: "open_owner_attempt_a1",
    requestDigest: "e".repeat(64),
    launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
  });
  if (begun.kind !== "created") throw new Error("expected structured launch creation");
  const receipt = begun.receipt;
  const client = {
    operationStatus: async (operationId: string) => ({
      receipt: {
        operationId,
        idempotencyKey: operationId,
        conversationId: receipt.conversationId,
        kind: "spawn" as const,
        status: "delivering" as const,
        reason: null,
        at: new Date().toISOString(),
        revision: 1,
      },
      replayed: false,
    }),
  } as unknown as RuntimeHostClient;

  try {
    const result = await reconcileTerminalSpawnsHeldByLiveOwners(store, client, {
      now: () => Date.now() + STALE_STRUCTURED_SPAWN_TIMEOUT_MS + 60_000,
      ownerAlive: () => true,
    });

    expect(result).toEqual({ examined: 0, terminalized: [], recovered: [] });
    expect(store.snapshot().receipts[receipt.launchId]?.state).toBe("starting");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
