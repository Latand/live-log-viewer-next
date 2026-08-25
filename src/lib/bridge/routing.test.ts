import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "bun:test";

import { agentRegistry } from "@/lib/agent/registry";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "@/lib/orchestrator/seats";

import { bridgeChannelScopeForConversation } from "./routing";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";

let sandbox = "";
const previousStateDir = process.env.LLV_STATE_DIR;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-bridge-routing-"));
  process.env.LLV_STATE_DIR = path.join(sandbox, "state");
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function registerConversation(project: string, clientAttemptId: string): string {
  const registry = agentRegistry();
  const begun = beginLegacySpawnFixture(registry, {
    engine: "codex",
    cwd: sandbox,
    clientAttemptId,
    explicitProject: project,
    launchProfile: { project },
  });
  const sessionId = crypto.randomUUID();
  registry.completeSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId },
    artifactPath: path.join(sandbox, `rollout-${sessionId}.jsonl`),
    cwd: sandbox,
    accountId: null,
    status: "starting",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: "spawn",
  });
  return begun.receipt.conversationId;
}

function seat(project: string, conversationId: string, clientRequestId: string): void {
  beginOrchestratorSeatIntent({ project, mandate: "own the board", clientRequestId, mode: "spawn" });
  completeOrchestratorSeatIntent({ project, clientRequestId, conversationId, path: null });
}

test("an active project seat defines the bridge channel scope", () => {
  const conversationId = registerConversation("proj-a", "spawn_proj_a_1");
  seat("proj-a", conversationId, "seat_proj_a_1");

  expect(bridgeChannelScopeForConversation(conversationId)).toEqual({
    project: "proj-a",
    seatConversationId: conversationId,
  });
});

test("rotation moves bridge scope to the successor and revokes the predecessor", () => {
  const predecessor = registerConversation("proj-a", "spawn_proj_a_1");
  const successor = registerConversation("proj-a", "spawn_proj_a_2");
  seat("proj-a", predecessor, "seat_proj_a_1");
  seat("proj-a", successor, "seat_proj_a_2");

  expect(bridgeChannelScopeForConversation(predecessor)).toBeNull();
  expect(bridgeChannelScopeForConversation(successor)).toEqual({
    project: "proj-a",
    seatConversationId: successor,
  });
});

test("a registered conversation with no project seat has no bridge channel scope", () => {
  const conversationId = registerConversation("proj-a", "spawn_proj_a_without_seat");
  expect(bridgeChannelScopeForConversation(conversationId)).toBeNull();
});
