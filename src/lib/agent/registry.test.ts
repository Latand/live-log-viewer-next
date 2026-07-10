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
});
