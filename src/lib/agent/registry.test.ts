import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";

const KEY = { engine: "codex" as const, sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1326" };

function registry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-"));
  return new AgentRegistry(path.join(dir, "agent-registry.json"));
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
});
