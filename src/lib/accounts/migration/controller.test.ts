import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile, type SuccessorProviderPort } from "./contracts";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-controller-"));
const { reconcileAccountMigrationCycle } = await import("./controller");

afterAll(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("controller migration cycle reconciles and ticks both durable quota policy guards", async () => {
  const ticks: string[] = [];
  const quota = { tick: async (engine: string) => { ticks.push(engine); } };
  const registry = new AgentRegistry(path.join(stateDir, "registry.json"));
  registry.reconcileConversations([{
    engine: "codex",
    path: "/source.jsonl",
    accountId: "source",
    launchProfile: emptyLaunchProfile(),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-10T12:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath("/source.jsonl")!;
  registry.commitMigrationIntent({ engine: "codex", targetId: "target", origin: "manual", requestId: "controller-cycle", expectedRevision: registry.engineRouting("codex").revision });
  const provider: SuccessorProviderPort = {
    async create(input) { return { operationId: input.operationId, nativeId: "successor", path: "/target.jsonl", historyHash: "hash", host: { kind: "codex-app-server", identity: "successor", epoch: 1, verifiedAt: "2026-07-10T12:01:00.000Z" } }; },
    async verify() {},
  };

  await reconcileAccountMigrationCycle(registry, quota as never, provider, { async deliver() { return "delivered"; } });

  expect(ticks.sort()).toEqual(["claude", "codex"]);
  expect(registry.conversation(conversation.id)?.migration?.phase).toBe("committed");
}, 20_000);
