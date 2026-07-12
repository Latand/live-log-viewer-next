import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";
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
