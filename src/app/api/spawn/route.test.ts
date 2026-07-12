import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { spawnParentSelector, spawnRequestDigest } from "@/lib/agent/spawnIdentity";
import { spawnResponseForReceipt } from "@/lib/agent/spawnResponse";
import { resolveSpawnParent } from "@/lib/agent/spawnParent";

function registry(): AgentRegistry {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-route-"));
  return new AgentRegistry(path.join(dir, "agent-registry.json"));
}

test("spawn route projects a launched path-pending receipt as a truthful success", () => {
  const store = registry();
  const begun = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "terra", clientAttemptId: "attempt_path_pending", requestDigest: "digest" });
  if (begun.kind !== "created") throw new Error("expected a new receipt");
  store.bindSpawnPane(begun.receipt.launchId, { endpoint: "/tmp", server: { pid: 9, startIdentity: "9:a" }, paneId: "%9", panePid: { pid: 99, startIdentity: "99:a" }, target: "agents:9.0" });
  expect(spawnResponseForReceipt(store.snapshot().receipts[begun.receipt.launchId]!)).toMatchObject({ launched: false, target: "%9" });
  store.markSpawnHostVerified(begun.receipt.launchId, {
    kind: "tmux", endpoint: "/tmp", server: { pid: 9, startIdentity: "9:a" }, paneId: "%9",
    panePid: { pid: 99, startIdentity: "99:a" }, windowName: "codex-new",
    agent: { pid: 100, startIdentity: "100:a" }, argv: ["codex"],
  });
  store.markSpawnPromptDelivered(begun.receipt.launchId);
  const pending = store.markSpawnPathPending(begun.receipt.launchId);

  expect(spawnResponseForReceipt(pending, null)).toMatchObject({
    ok: true,
    launched: true,
    retrySafe: false,
    state: "path-pending",
    path: null,
    target: "%9",
    launchId: begun.receipt.launchId,
    conversationId: begun.receipt.conversationId,
  });
});

test("spawn route accepts an explicit stable parent conversation identity", () => {
  const store = registry();
  const parentPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
  const parent = store.ensureConversation("codex", parentPath, "terra");

  expect(resolveSpawnParent({ parentConversationId: parent.id }, store)).toEqual({
    conversationId: parent.id,
    engine: "codex",
    artifactPath: parentPath,
    sessionKey: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1326" },
  });
});

function digestForParent(body: { parentConversationId: string }): string {
  return spawnRequestDigest({
    engine: "codex",
    cwd: "/repo",
    model: "gpt-test",
    effort: "high",
    fast: false,
    accountId: "terra",
    role: "worker",
    parent: spawnParentSelector(body),
    prompt: "implement",
    images: [],
  });
}

test("spawn replay keeps its identity after parent succession", () => {
  const store = registry();
  const firstParentPath = "/sessions/parent-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
  const secondParentPath = "/sessions/parent-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl";
  const parent = store.ensureConversation("codex", firstParentPath, "terra");
  const body = { parentConversationId: parent.id };
  const firstEvidence = resolveSpawnParent(body, store)!;
  const digest = digestForParent(body);
  const first = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    accountId: "terra",
    clientAttemptId: "attempt_parent_succession",
    requestDigest: digest,
    parentConversationId: firstEvidence.conversationId,
    parentSessionKey: firstEvidence.sessionKey,
    parentArtifactPath: firstEvidence.artifactPath,
  });
  if (first.kind !== "created") throw new Error("expected create");
  const resumed = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    accountId: "terra",
    conversationId: parent.id,
    purpose: "resume-successor",
  });
  if (resumed.kind !== "created") throw new Error("expected resume receipt");
  expect(store.settleSpawn(resumed.receipt.launchId, {
    key: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1327" },
    artifactPath: secondParentPath,
    cwd: "/repo",
    accountId: "terra",
    status: "unhosted",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  })).toMatchObject({ kind: "settled" });
  const secondEvidence = resolveSpawnParent(body, store)!;

  expect(secondEvidence.artifactPath).toBe(secondParentPath);
  expect(store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    accountId: "terra",
    clientAttemptId: "attempt_parent_succession",
    requestDigest: digestForParent(body),
    parentConversationId: secondEvidence.conversationId,
    parentSessionKey: secondEvidence.sessionKey,
    parentArtifactPath: secondEvidence.artifactPath,
  })).toMatchObject({ kind: "replay", receipt: { launchId: first.receipt.launchId } });
  expect(store.snapshot().lineageEdges[first.receipt.conversationId]).toMatchObject({
    parentArtifactPath: firstParentPath,
    parentSessionKey: firstEvidence.sessionKey,
  });
});

test("spawn replay keeps its identity after parent alias adoption", () => {
  const store = registry();
  const sourcePath = "/sessions/source-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
  const provisionalPath = "/sessions/provisional-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl";
  const canonical = store.ensureConversation("codex", sourcePath, "terra");
  store.reconcileConversations([{
    engine: "codex",
    path: provisionalPath,
    accountId: "work",
    launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-12T12:00:00.000Z",
  }]);
  const provisional = store.conversationForPath(provisionalPath)!;
  const body = { parentConversationId: provisional.id };
  const firstEvidence = resolveSpawnParent(body, store)!;
  const digest = digestForParent(body);
  const first = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    accountId: "terra",
    clientAttemptId: "attempt_parent_alias",
    requestDigest: digest,
    parentConversationId: firstEvidence.conversationId,
    parentSessionKey: firstEvidence.sessionKey,
    parentArtifactPath: firstEvidence.artifactPath,
  });
  if (first.kind !== "created") throw new Error("expected create");
  const migration = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    accountId: "work",
    conversationId: canonical.id,
    purpose: "migration-successor",
    expectedArtifactPath: provisionalPath,
  });
  if (migration.kind !== "created") throw new Error("expected migration receipt");
  expect(store.settleSpawn(migration.receipt.launchId, {
    key: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1327" },
    artifactPath: provisionalPath,
    cwd: "/repo",
    accountId: "work",
    status: "unhosted",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  })).toMatchObject({ kind: "settled" });
  const secondEvidence = resolveSpawnParent(body, store)!;

  expect(secondEvidence.conversationId).toBe(canonical.id);
  expect(store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    accountId: "terra",
    clientAttemptId: "attempt_parent_alias",
    requestDigest: digestForParent(body),
    parentConversationId: secondEvidence.conversationId,
    parentSessionKey: secondEvidence.sessionKey,
    parentArtifactPath: secondEvidence.artifactPath,
  })).toMatchObject({ kind: "replay", receipt: { launchId: first.receipt.launchId } });
});
