import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, mock, test } from "bun:test";

/* This suite exercises the close path's host teardown, which terminates agent
   processes. Everything it touches is a throwaway registry inside this sandbox
   and a stubbed conversation-action seam — it never reads the shared runtime
   state directory and can never dispatch a real kill. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-stop-host-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

type KillRequest = { conversationId: string; transcriptPath: string; action: string };
const killed: KillRequest[] = [];
let killResult: { status: number; body: Record<string, unknown> } = { status: 200, body: { ok: true, structured: true } };

mock.module("@/lib/conversation/actions", () => ({
  CONVERSATION_ACTIONS: ["interrupt", "kill", "resume", "compact", "dialog-key"] as const,
  applyConversationAction: async (request: KillRequest) => {
    killed.push(request);
    return killResult;
  },
}));

const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { procBackend } = await import("@/lib/proc");
const { sessionKeyId } = await import("@/lib/agent/sessionKey");
const { defaultPipelinePorts } = await import("./engine");

type Registry = InstanceType<typeof AgentRegistry>;

/** Seats a structured conversation whose host process is this test process, so
    the liveness probe reports a resident host without spawning anything. */
function hostedConversation(options: { status?: "live" | "dead"; hosted?: boolean } = {}): {
  registry: Registry;
  conversationId: string;
  path: string;
} {
  const id = crypto.randomUUID();
  const pathname = path.join(sandbox, `${id}.jsonl`);
  const registry = new AgentRegistry(path.join(sandbox, `${id}.registry.json`), undefined, undefined, { sqliteMode: "off" });
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd: sandbox, transport: "structured", accountId: "codex-subscription" });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const settled = registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: id },
    artifactPath: pathname,
    cwd: sandbox,
    accountId: "codex-subscription",
    status: options.status ?? "live",
    host: null,
    structuredHost: options.hosted === false ? null : {
      kind: "codex-app-server",
      endpoint: "fake:stdio",
      process: { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) },
      eventCursor: 1,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 1,
      activeTurnRef: "turn-live",
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "structured-host:test",
    pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error("structured conversation was unavailable");
  /* Fence the fixture itself: a "not-running" verdict must come from the seated
     host state, never from an entry the registry silently failed to record. */
  const entry = registry.readOnlySnapshot().entries[sessionKeyId({ engine: "codex", sessionId: id })];
  if (!entry) throw new Error("registry fixture did not record the session entry");
  expect(entry.status).toBe(options.status ?? "live");
  setAgentRegistryForTests(registry);
  return { registry, conversationId: begun.receipt.conversationId, path: pathname };
}

function target(conversationId: string | null, agentPath: string | null = null) {
  return { stageId: "build", attempt: 1, conversationId, agentPath, paneId: null };
}

beforeEach(() => {
  killed.length = 0;
  killResult = { status: 200, body: { ok: true, structured: true } };
});

test("a resident stage host is terminated through the conversation kill control (#670)", async () => {
  const fixture = hostedConversation();

  const result = await defaultPipelinePorts().stopStageAgent(target(fixture.conversationId));

  expect(result).toEqual({ outcome: "stopped" });
  expect(killed).toEqual([{ conversationId: fixture.conversationId, transcriptPath: fixture.path, action: "kill" }]);
  setAgentRegistryForTests(null);
});

test("a stage whose host is already gone reports not-running without dispatching a kill (#670)", async () => {
  const dead = hostedConversation({ status: "dead" });
  expect(await defaultPipelinePorts().stopStageAgent(target(dead.conversationId))).toEqual({ outcome: "not-running" });

  const unhosted = hostedConversation({ hosted: false });
  expect(await defaultPipelinePorts().stopStageAgent(target(unhosted.conversationId))).toEqual({ outcome: "not-running" });

  const unknown = hostedConversation();
  expect(await defaultPipelinePorts().stopStageAgent(target("conversation_missing"))).toEqual({ outcome: "not-running" });
  expect(await defaultPipelinePorts().stopStageAgent(target(null, path.join(sandbox, "never-seen.jsonl")))).toEqual({ outcome: "not-running" });
  expect(unknown.registry.conversation(unknown.conversationId as `conversation_${string}`)).not.toBeNull();

  expect(killed).toEqual([]);
  setAgentRegistryForTests(null);
});

test("a refused kill surfaces the still-running host instead of claiming a stop (#670)", async () => {
  const fixture = hostedConversation();
  killResult = { status: 503, body: { error: "structured runtime host is unavailable" } };

  expect(await defaultPipelinePorts().stopStageAgent(target(fixture.conversationId)))
    .toEqual({ outcome: "failed", error: "structured runtime host is unavailable" });

  killResult = { status: 200, body: { ok: false, outcome: "failed" } };
  expect(await defaultPipelinePorts().stopStageAgent(target(fixture.conversationId)))
    .toEqual({ outcome: "failed", error: "stage host kill was refused with status 200" });
  setAgentRegistryForTests(null);
});
