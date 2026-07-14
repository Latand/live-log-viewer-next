import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { spawnParentSelector, spawnRequestDigest } from "@/lib/agent/spawnIdentity";
import { spawnResponseForReceipt } from "@/lib/agent/spawnResponse";
import { resolveSpawnLineage, resolveSpawnLineageParent, resolveSpawnParent, SpawnParentError } from "@/lib/agent/spawnParent";
import { authenticatedAgentSpawnCaller, isAgentInitiatedSpawn } from "./admission";
import { POST } from "./route";

function registry(): AgentRegistry {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-route-"));
  return new AgentRegistry(path.join(dir, "agent-registry.json"));
}

test("agent-initiated spawn without lineage returns a teaching 400", async () => {
  const response = await POST(new NextRequest("http://127.0.0.1:8898/api/spawn", {
    method: "POST",
    headers: { host: "127.0.0.1:8898", "content-type": "application/json" },
    body: JSON.stringify({ engine: "codex", cwd: "/repo", prompt: "help" }),
  }));

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: expect.stringContaining("POST http://127.0.0.1:8898/api/spawn"),
  });
});

test("same-origin browser requests use the Viewer spawn surface", () => {
  const request = new NextRequest("http://127.0.0.1:8898/api/spawn", {
    headers: { host: "127.0.0.1:8898", origin: "http://127.0.0.1:8898", "sec-fetch-site": "same-origin" },
  });

  expect(isAgentInitiatedSpawn(request)).toBe(false);
  expect(isAgentInitiatedSpawn(new NextRequest("http://127.0.0.1:8898/api/spawn"))).toBe(true);
});

test("agent capability binds src to the caller conversation", () => {
  const store = registry();
  const capability = "C".repeat(43);
  const callerPath = "/sessions/caller-019f4906-3f67-7b72-9fbc-9ec3b5ad1325.jsonl";
  const begun = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    spawnCapabilityDigest: crypto.createHash("sha256").update(capability).digest("hex"),
  });
  if (begun.kind !== "created") throw new Error("expected create");
  const settled = store.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1325" },
    artifactPath: callerPath,
    cwd: "/repo",
    accountId: "terra",
    status: "live",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  expect(settled.kind).toBe("settled");
  const request = new NextRequest("http://127.0.0.1:8898/api/spawn", {
    headers: { "x-llv-spawn-capability": capability },
  });

  expect(authenticatedAgentSpawnCaller(request, callerPath, store)).toEqual({
    conversationId: begun.receipt.conversationId,
  });

  const other = store.ensureConversation("codex", "/sessions/other.jsonl", "terra");
  expect(authenticatedAgentSpawnCaller(request, other.generations[0]!.path, store)).toEqual({
    error: "src must identify the authenticated caller conversation",
  });
});

test("agent callers cannot grant themselves native sub-agent permission", async () => {
  const response = await POST(new NextRequest("http://127.0.0.1:8898/api/spawn", {
    method: "POST",
    headers: { host: "127.0.0.1:8898", "content-type": "application/json" },
    body: JSON.stringify({ src: "/caller.jsonl", role: "orchestrator", allowSubagents: true }),
  }));

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "allowSubagents requires an authenticated Viewer operator spawn" });
});

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

test("a pane-bound launch verification failure returns launched false with its teaching error", () => {
  const store = registry();
  const begun = store.beginSpawnRequest({ engine: "claude", cwd: "/repo", accountId: "botfatherdev-2" });
  if (begun.kind !== "created") throw new Error("expected a new receipt");
  store.bindSpawnPane(begun.receipt.launchId, { endpoint: "/tmp", server: { pid: 9, startIdentity: "9:a" }, paneId: "%9", panePid: { pid: 99, startIdentity: "99:a" }, target: "agents:9.0" });
  store.failSpawn(begun.receipt.launchId, "Claude account botfatherdev-2 needs re-login. Open Accounts, sign in, and retry.");

  expect(spawnResponseForReceipt(store.snapshot().receipts[begun.receipt.launchId]!)).toMatchObject({
    launched: false,
    state: "conflict",
    error: "Claude account botfatherdev-2 needs re-login. Open Accounts, sign in, and retry.",
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

test("reviewer spawn requires one reviewed conversation and resolves its stable identity", () => {
  const store = registry();
  const implementerPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
  const implementer = store.ensureConversation("codex", implementerPath, "terra");

  expect(() => resolveSpawnLineageParent({ role: "reviewer" }, store)).toThrow(SpawnParentError);
  expect(resolveSpawnLineageParent({ role: "reviewer", reviews: implementer.id }, store)).toEqual({
    conversationId: implementer.id,
    engine: "codex",
    artifactPath: implementerPath,
    sessionKey: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1326" },
  });
  expect(() => resolveSpawnLineageParent({ role: "builder", reviews: implementer.id }, store)).toThrow(SpawnParentError);
});

test("reviewer lineage keeps the caller and reviewed implementer distinct", () => {
  const store = registry();
  const callerPath = "/sessions/caller-019f4906-3f67-7b72-9fbc-9ec3b5ad1325.jsonl";
  const implementerPath = "/sessions/implementer-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
  const caller = store.ensureConversation("codex", callerPath, "terra");
  const implementer = store.ensureConversation("codex", implementerPath, "terra");

  const lineage = resolveSpawnLineage({ role: "reviewer", parentConversationId: caller.id, reviews: implementer.id }, store);

  expect(lineage.parent?.conversationId).toBe(caller.id);
  expect(lineage.reviewed?.conversationId).toBe(implementer.id);
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
