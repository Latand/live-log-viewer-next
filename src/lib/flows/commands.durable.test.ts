import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const previousStateDir = process.env.LLV_STATE_DIR;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-durable-create-"));
process.env.LLV_STATE_DIR = sandbox;

const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { createFlowFromRequest } = await import("./commands");
const { saveFlows } = await import("./store");

const registry = new AgentRegistry(path.join(sandbox, "registry.json"), undefined, undefined, { sqliteMode: "off" });
setAgentRegistryForTests(registry);

afterAll(() => {
  setAgentRegistryForTests(null);
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("durable implementer identity creates a flow without scanner or live-host evidence", async () => {
  saveFlows([]);
  const transcript = path.join(import.meta.dir, "fixtures", "codex-review-2026-07-12.jsonl");
  const implementer = registry.ensureConversation("codex", transcript, null);

  const result = await createFlowFromRequest({
    implementerPath: transcript,
    implementerConversationId: implementer.id,
    deliverKickoff: false,
    roles: {
      implementer: { engine: "codex", model: "gpt-5.6-sol", effort: "high" },
      reviewer: { engine: "codex", model: "gpt-5.6-sol", effort: "high" },
    },
    baseMode: "head",
    baseRef: "12ad73656844d3583d44ae718d003c7f2f2c6ace",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
  }, []);

  expect(result.error).toBeUndefined();
  expect(result.flow).toMatchObject({
    cwd: "/repo",
    implementerPath: transcript,
    implementerConversationId: implementer.id,
    kickoffDelivery: null,
    state: "waiting_ready",
  });
});
