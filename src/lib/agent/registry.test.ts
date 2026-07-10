import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";

const KEY = { engine: "codex" as const, sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1326" };

function registry(ownerAlive: (owner: { pid: number; startIdentity: string | null }) => boolean = () => true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-"));
  return new AgentRegistry(path.join(dir, "agent-registry.json"), ownerAlive);
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
});
