import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { AgentRegistry, type ConversationObservation } from "@/lib/agent/registry";
import type { FileEntry } from "@/lib/types";

import { advanceConversationMigration, reconcileMigrationInventory } from "./coordinator";
import { emptyLaunchProfile, type SuccessorProviderPort } from "./contracts";

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function observation(pathname: string, accountId: string, state: "idle" | "busy"): ConversationObservation {
  return {
    engine: "codex",
    path: pathname,
    accountId,
    launchProfile: emptyLaunchProfile({ cwd: path.dirname(pathname), project: "viewer" }),
    turn: { state, source: state === "busy" ? "tool" : "empty", terminalAt: null },
    observedAt: "2026-08-31T18:03:00.000Z",
  };
}

function provider(nativeId: string, pathname: string): SuccessorProviderPort {
  return {
    virtualSource: true,
    async create(input) {
      return {
        operationId: input.operationId,
        nativeId,
        path: pathname,
        continuityPaths: [],
        historyHash: `history-${nativeId}`,
        host: {
          kind: "codex-app-server",
          identity: `host-${nativeId}`,
          epoch: 1,
          verifiedAt: "2026-08-31T18:03:01.000Z",
        },
      };
    },
    async verify() {},
  };
}

function deadTurnEntry(pathname: string): FileEntry {
  const stat = fs.statSync(pathname);
  return {
    path: pathname,
    root: "codex-sessions",
    name: path.basename(pathname),
    project: "viewer",
    title: "dead switch source",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: stat.mtimeMs / 1000,
    size: stat.size,
    activity: "stalled",
    activityReason: "jsonl_turn_stalled",
    derivationComplete: true,
    proc: null,
    pid: null,
    model: "gpt",
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
}

async function heldDeadTurnFixture() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-dead-switch-turn-"));
  sandboxes.push(sandbox);
  const registry = new AgentRegistry(path.join(sandbox, "agent-registry.json"));
  const sourcePath = path.join(sandbox, "source.jsonl");
  const deadPath = path.join(sandbox, "dead-successor.jsonl");
  const finalPath = path.join(sandbox, "live-successor.jsonl");

  registry.reconcileConversations([observation(sourcePath, "account-a", "idle")]);
  const conversation = registry.conversationForPath(sourcePath)!;
  registry.requestConversationReseat(conversation.id, "account-b");
  const first = await advanceConversationMigration(
    conversation.id,
    registry,
    provider("dead-successor", deadPath),
  );
  expect(first.migration?.phase).toBe("committed");
  expect(first.generations.at(-1)?.host).not.toBeNull();

  fs.writeFileSync(deadPath, `${JSON.stringify({
    type: "event_msg",
    timestamp: "2026-08-31T18:04:00.000Z",
    payload: { type: "task_started" },
  })}\n`);
  registry.reconcileConversations([observation(deadPath, "account-b", "busy")]);
  const current = registry.conversation(conversation.id)!;
  const generation = current.generations.at(-1)!;
  registry.upsert({
    key: { engine: "codex", sessionId: generation.id },
    artifactPath: deadPath,
    cwd: sandbox,
    accountId: "account-b",
    launchProfile: generation.launchProfile,
    status: "dead",
    host: null,
    structuredHost: null,
    claimEpoch: 1,
    claimOwner: null,
    pendingAction: null,
  });
  expect(registry.requestConversationReseat(conversation.id, "account-c").migration?.phase).toBe("waiting-turn");

  return { registry, conversationId: conversation.id, generationId: generation.id, deadPath, finalPath, sandbox };
}

test("a switch hold over a provably dead post-migration turn resolves without hanging", async () => {
  const { registry, conversationId, deadPath, finalPath } = await heldDeadTurnFixture();

  await reconcileMigrationInventory(registry, [deadTurnEntry(deadPath)]);
  expect(registry.conversation(conversationId)?.turn.state).toBe("idle");

  const resolved = await advanceConversationMigration(
    conversationId,
    registry,
    provider("live-successor", finalPath),
  );
  expect(resolved.migration?.phase).toBe("committed");
  expect(resolved.generations.at(-1)?.path).toBe(finalPath);
});

test("a terminal status with retained host evidence authorizes no switch release", async () => {
  const { registry, conversationId, generationId, deadPath, sandbox } = await heldDeadTurnFixture();
  const currentEntry = Object.values(registry.readOnlySnapshot().entries)
    .find((entry) => entry.key.sessionId === generationId)!;
  const { updatedAt: _updatedAt, ...entry } = currentEntry;
  registry.upsert({
    ...entry,
    host: {
      kind: "tmux",
      endpoint: "tmux:contradictory",
      server: { pid: 301, startIdentity: "server:301" },
      paneId: "%30",
      panePid: { pid: 302, startIdentity: "pane:302" },
      windowName: "contradictory-host",
      agent: { pid: 303, startIdentity: "agent:303" },
      argv: ["codex", "resume", generationId],
    },
    cwd: sandbox,
  });

  await reconcileMigrationInventory(registry, [deadTurnEntry(deadPath)]);

  const held = registry.conversation(conversationId)!;
  expect(held.turn.state).toBe("busy");
  expect(held.migration?.phase).toBe("waiting-turn");
});
