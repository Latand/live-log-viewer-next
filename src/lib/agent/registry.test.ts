import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";

const KEY = { engine: "codex" as const, sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1326" };

function registry(ownerAlive: (owner: { pid: number; startIdentity: string | null }) => boolean = () => true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-"));
  return new AgentRegistry(path.join(dir, "agent-registry.json"), ownerAlive);
}

function spawnEntry(pathname: string, accountId = "terra") {
  return {
    key: { engine: "codex" as const, sessionId: pathname.match(/[0-9a-f-]{36}/)?.[0] ?? "019f4906-3f67-7b72-9fbc-9ec3b5ad1326" },
    artifactPath: pathname,
    cwd: "/repo",
    accountId,
    status: "live" as const,
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  };
}

describe("agent registry", () => {
  test("writes receipts and a canonical atomic entry", () => {
    const store = registry();
    const receipt = store.beginSpawn("codex", "/repo");
    const entry = store.completeSpawn(receipt.launchId, {
      key: KEY, artifactPath: "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl", cwd: "/repo", accountId: null,
      status: "starting", host: null, claimEpoch: 0, claimOwner: null, pendingAction: "spawn",
    });
    expect(entry.key).toEqual(KEY);
    expect(store.snapshot().receipts[receipt.launchId]?.state).toBe("completed");
  });

  test("serializes durable operations", async () => {
    const store = registry();
    store.upsert({ key: KEY, artifactPath: "/a", cwd: "/repo", accountId: null, status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
    expect(await store.withOperationLock(KEY, { pid: 1, startIdentity: "1:one" }, async () => "done")).toBe("done");
    await expect(store.withOperationLock(KEY, { pid: 1, startIdentity: "1:one" }, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });

  test("reclaims a lock only after its recorded process identity is stale", () => {
    const store = registry(() => false);
    const lock = `${store.filename}.write-lock`;
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: 42, startIdentity: "42:old" }));
    expect(() => store.beginSpawn("codex", "/repo")).not.toThrow();
  });

  test("preserves corrupt registry bytes and rejects mutation", () => {
    const store = registry();
    fs.mkdirSync(path.dirname(store.filename), { recursive: true });
    fs.writeFileSync(store.filename, "{ broken");
    expect(() => store.beginSpawn("codex", "/repo")).toThrow("cannot be read");
    expect(fs.readFileSync(store.filename, "utf8")).toBe("{ broken");
  });

  test("upgrades v1, retains stable identity, and commits an A to B to A generation chain", () => {
    const store = registry();
    fs.writeFileSync(store.filename, JSON.stringify({ version: 1, entries: {}, receipts: {}, importedResumePanes: false, legacyResumePanes: { serverPid: null, panes: {} } }));
    const conversation = store.ensureConversation("codex", "/a.jsonl", "a");
    expect(store.snapshot().version).toBe(2);
    store.setConversationMigration(conversation.id, { intentId: "intent-a", phase: "verifying", targetId: "b", revision: 1, error: null, updatedAt: new Date().toISOString() });
    store.commitSuccessor(conversation.id, { id: "native-b", path: "/b.jsonl", accountId: "b" }, 1);
    store.setConversationMigration(conversation.id, { intentId: "intent-b", phase: "verifying", targetId: "a", revision: 2, error: null, updatedAt: new Date().toISOString() });
    const final = store.commitSuccessor(conversation.id, { id: "native-a2", path: "/a2.jsonl", accountId: "a" }, 2);
    expect(final.id).toBe(conversation.id);
    expect(final.generations.map((generation) => generation.path)).toEqual(["/a.jsonl", "/b.jsonl", "/a2.jsonl"]);
    expect(store.canonicalPath("/a.jsonl")).toBe("/a2.jsonl");
  });

  test("coalesces durable intents and enforces policy compare-and-set", () => {
    const store = registry();
    const first = store.upsertMigrationIntent("claude", "a", "auto", "first");
    const latest = store.upsertMigrationIntent("claude", "b", "manual", "second");
    expect(latest.id).toBe(first.id);
    expect(latest.targetId).toBe("b");
    expect(latest.revision).toBe(2);
    expect(() => store.setAutoBalancePolicy("claude", true, 1)).toThrow("revision is stale");
    expect(store.setAutoBalancePolicy("claude", true, 0).enabled).toBe(true);
  });

  test("normalizes legacy v2 migration fields for restart recovery", () => {
    const store = registry();
    const conversation = store.ensureConversation("codex", "/legacy.jsonl", "a");
    store.setConversationMigration(conversation.id, {
      intentId: "legacy-intent",
      phase: "requested",
      targetId: "b",
      revision: 3,
      error: null,
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    const raw = JSON.parse(fs.readFileSync(store.filename, "utf8")) as { conversations: Record<string, { migration: Record<string, unknown> }> };
    delete raw.conversations[conversation.id]!.migration.operationId;
    delete raw.conversations[conversation.id]!.migration.sourceGenerationId;
    delete raw.conversations[conversation.id]!.migration.providerReceipt;
    delete raw.conversations[conversation.id]!.migration.errorCode;
    fs.writeFileSync(store.filename, JSON.stringify(raw));

    const recovered = new AgentRegistry(store.filename).conversation(conversation.id)!;
    expect(recovered.migration).toMatchObject({
      operationId: `legacy-intent:${conversation.id}:3`,
      sourceGenerationId: recovered.generations[0]!.id,
      providerReceipt: null,
      errorCode: null,
    });
  });

  test("replays one client attempt, reserves its stable conversation, and rejects a changed request", () => {
    const store = registry();
    const first = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "terra", clientAttemptId: "attempt_0001", requestDigest: "digest-a" });
    expect(first.kind).toBe("created");
    if (first.kind !== "created") throw new Error("expected create");
    const replay = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "terra", clientAttemptId: "attempt_0001", requestDigest: "digest-a" });
    expect(replay).toMatchObject({ kind: "replay", receipt: { launchId: first.receipt.launchId, conversationId: first.receipt.conversationId } });
    const conflict = store.beginSpawnRequest({ engine: "codex", cwd: "/other", accountId: "terra", clientAttemptId: "attempt_0001", requestDigest: "digest-b" });
    expect(conflict.kind).toBe("conflict");
  });

  test("settles observer then route exactly once with receipt-owned account and profile", () => {
    const store = registry();
    const begun = store.beginSpawnRequest({
      engine: "codex", cwd: "/repo", accountId: "terra", parentConversationId: "conversation_parent",
      parentSessionKey: { engine: "codex", sessionId: "parent-session" }, parentArtifactPath: "/sessions/parent-session.jsonl",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", model: "gpt-5.6", parentConversationId: "conversation_parent" }),
    });
    if (begun.kind !== "created") throw new Error("expected create");
    const born = new AgentRegistry(store.filename).snapshot();
    expect(born.lineageEdges[begun.receipt.conversationId]).toMatchObject({
      childConversationId: begun.receipt.conversationId,
      parentConversationId: "conversation_parent",
      childSessionKey: null,
      parentSessionKey: { engine: "codex", sessionId: "parent-session" },
      childArtifactPath: null,
      parentArtifactPath: "/sessions/parent-session.jsonl",
      source: "viewer-spawn",
      evidence: { launchId: begun.receipt.launchId },
    });
    const receipt = store.bindSpawnPane(begun.receipt.launchId, { endpoint: "/tmp", server: { pid: 9, startIdentity: "9:a" }, paneId: "%9", panePid: { pid: 99, startIdentity: "99:a" }, target: "agents:9.0" });
    expect(receipt.state).toBe("pane-bound");
    store.markSpawnPromptDelivered(receipt.launchId);
    const path = "/sessions/019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const observed = store.completeObservedSpawn(receipt.launchId, {
      ...spawnEntry(path, "wrong-account"),
      host: { kind: "tmux", endpoint: "/tmp", server: { pid: 9, startIdentity: "9:a" }, paneId: "%9", panePid: { pid: 99, startIdentity: "99:a" }, windowName: "codex", agent: { pid: 100, startIdentity: "100:a" }, argv: ["codex"] },
    });
    expect(observed.kind).toBe("settled");
    const route = store.settleSpawn(receipt.launchId, spawnEntry(path));
    expect(route).toMatchObject({ kind: "settled", receipt: { completionMode: "route-recovered", accountId: "terra", conversationId: begun.receipt.conversationId } });
    const snapshot = store.snapshot();
    expect(snapshot.conversations[begun.receipt.conversationId]?.generations).toHaveLength(1);
    expect(snapshot.conversationRevision.codex).toBe(1);
    expect(snapshot.entries["codex:019f4906-3f67-7b72-9fbc-9ec3b5ad1326"]?.launchProfile?.parentConversationId).toBe("conversation_parent");
    expect(snapshot.lineageEdges[begun.receipt.conversationId]).toMatchObject({
      childSessionKey: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1326" },
      childArtifactPath: path,
    });
  });

  test("keeps simultaneous same-engine same-cwd receipts isolated and fails conflicting artifacts closed", () => {
    const store = registry();
    const first = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "a" });
    const second = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "b" });
    if (first.kind !== "created" || second.kind !== "created") throw new Error("expected creates");
    const firstPath = "/sessions/019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const secondPath = "/sessions/019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl";
    expect(store.settleSpawn(first.receipt.launchId, spawnEntry(firstPath)).kind).toBe("settled");
    expect(store.settleSpawn(second.receipt.launchId, spawnEntry(secondPath, "b")).kind).toBe("settled");
    const conflict = store.settleSpawn(second.receipt.launchId, spawnEntry(firstPath, "b"));
    expect(conflict).toMatchObject({ kind: "conflict", code: "spawn_artifact_conflict" });
    expect(store.snapshot().receipts[first.receipt.launchId]?.artifactPath).toBe(firstPath);
    expect(store.snapshot().receipts[second.receipt.launchId]?.artifactPath).toBe(secondPath);
  });

  test("normalizes a legacy receipt after restart without changing its schema version", () => {
    const store = registry();
    fs.writeFileSync(store.filename, JSON.stringify({
      version: 2, entries: {}, receipts: { legacy: { launchId: "legacy", engine: "codex", cwd: "/repo", createdAt: "2026-07-10T00:00:00.000Z", state: "starting", artifactPath: null, error: null, launchProfile: { cwd: "/repo" } } },
      importedResumePanes: false, legacyResumePanes: { serverPid: null, panes: {} }, conversations: {}, conversationRevision: { claude: 0, codex: 0 }, migrationIntents: {}, engineRouting: { claude: { activeAccountId: null, revision: 0 }, codex: { activeAccountId: null, revision: 0 } }, autoBalance: {}, quotaObservations: {}, heldDeliveries: {},
    }));
    const restarted = new AgentRegistry(store.filename).snapshot();
    expect(restarted.version).toBe(2);
    expect(restarted.receipts.legacy).toMatchObject({ clientAttemptId: null, pane: null, key: null, state: "starting" });
    expect(restarted.receipts.legacy?.conversationId.startsWith("conversation_")).toBe(true);
  });

  test("keeps birth-account provenance while attaching an active migration intent", () => {
    const store = registry();
    const receipt = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "birth" });
    if (receipt.kind !== "created") throw new Error("expected create");
    const intent = store.upsertMigrationIntent("codex", "target", "manual", "move-after-spawn");
    const path = "/sessions/019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";

    const settled = store.settleSpawn(receipt.receipt.launchId, spawnEntry(path, "target"));

    expect(settled).toMatchObject({ kind: "settled", entry: { accountId: "birth" }, conversation: { migration: { intentId: intent.id, targetId: "target" } } });
  });
});
