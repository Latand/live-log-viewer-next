import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-removal-test-"));
const previousState = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");

const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { accountRemovalBlockers } = await import("./removal");

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  setAgentRegistryForTests(new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "agent-registry.json")));
});

afterAll(() => {
  setAgentRegistryForTests(null);
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("a pending Viewer spawn blocks managed-home removal for its assigned account", () => {
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "agent-registry.json"));
  setAgentRegistryForTests(registry);
  registry.beginSpawnRequest({ engine: "claude", cwd: "/repo", accountId: "work" });

  expect(accountRemovalBlockers("claude", "work")).toEqual(["live_sessions"]);
  expect(accountRemovalBlockers("claude", "other")).toEqual([]);
});

test("an unresolved live launch blocks removal of every managed account for its engine", () => {
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "agent-registry.json"));
  setAgentRegistryForTests(registry);
  registry.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: null });

  expect(accountRemovalBlockers("codex", "work")).toEqual(["live_sessions"]);
  expect(accountRemovalBlockers("claude", "work")).toEqual([]);
});

test("a current conversation blocks removal even after its host becomes inactive", () => {
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "agent-registry.json"));
  setAgentRegistryForTests(registry);
  registry.ensureConversation("codex", "/history.jsonl", "work");

  expect(accountRemovalBlockers("codex", "work")).toEqual(["current_conversations"]);
  expect(accountRemovalBlockers("codex", "other")).toEqual([]);
});
