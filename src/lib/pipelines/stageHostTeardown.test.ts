import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";

/* This suite exercises the close path's host teardown, which terminates agent
   processes. Everything it touches is a throwaway registry inside this sandbox
   and a stubbed conversation-action seam — it never reads the shared runtime
   state directory and can never dispatch a real kill. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-stop-host-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
/* Pinned, never inherited: with structured hosting off, even a bypassed module
   mock could not reach the operator's runtime host. */
process.env.LLV_STRUCTURED_HOSTS = "0";
fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

type KillRequest = { conversationId: string; transcriptPath: string; action: string };
const killed: KillRequest[] = [];
let killResult: { status: number; body: Record<string, unknown> } = { status: 200, body: { ok: true, structured: true } };

/** Marks every answer this suite produces, so a test can prove the stubbed
    action — never the real one — served the kill. */
const MOCK_MARKER = "stub-conversation-action";
mock.module("@/lib/conversation/actions", () => ({
  CONVERSATION_ACTIONS: ["interrupt", "kill", "resume", "compact", "dialog-key"] as const,
  applyConversationAction: async (request: KillRequest) => {
    killed.push(request);
    return { status: killResult.status, body: { ...killResult.body, target: MOCK_MARKER } };
  },
}));

const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { procBackend } = await import("@/lib/proc");
const { sessionKeyId } = await import("@/lib/agent/sessionKey");
const { defaultPipelinePorts, stopPipelineStageAgent, stopPipelineStagePane } = await import("./engine");
type RuntimeHostClient = import("@/lib/runtime/client").RuntimeHostClient;

type Registry = InstanceType<typeof AgentRegistry>;

/** Seats a structured conversation whose host process is this test process, so
    the liveness probe reports a resident host without spawning anything. */
function hostedConversation(options: { status?: "live" | "dead"; hosted?: boolean; pane?: TmuxHostEvidence | null } = {}): {
  registry: Registry;
  conversationId: string;
  path: string;
  key: { engine: "codex"; sessionId: string };
} {
  const id = crypto.randomUUID();
  const pathname = path.join(sandbox, `${id}.jsonl`);
  const registry = new AgentRegistry(path.join(sandbox, `${id}.registry.json`), undefined, undefined, { sqliteMode: "off" });
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: sandbox, transport: "structured", accountId: "codex-subscription" });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const settled = registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: id },
    artifactPath: pathname,
    cwd: sandbox,
    accountId: "codex-subscription",
    status: options.status ?? "live",
    host: options.pane ?? null,
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
  return { registry, conversationId: begun.receipt.conversationId, path: pathname, key: { engine: "codex", sessionId: id } };
}

function target(conversationId: string | null, agentPath: string | null = null) {
  return { stageId: "build", attempt: 1, conversationId, agentPath, paneId: null };
}

beforeEach(() => {
  killed.length = 0;
  killResult = { status: 200, body: { ok: true, structured: true } };
});

test("a resident stage host is terminated through the conversation kill control (#670)", async () => {
  /* Prove the seam this suite depends on: the kill control resolves to the stub,
     so no test here can reach the operator's runtime host. */
  const { applyConversationAction } = await import("@/lib/conversation/actions");
  const probe = await applyConversationAction({ conversationId: "", transcriptPath: "", action: "kill" });
  expect((probe.body as { target?: string }).target).toBe(MOCK_MARKER);
  killed.length = 0;

  const fixture = hostedConversation();
  /* Delivered on the spot, the shape a legacy pane kill and a replayed terminal
     kill both produce. */
  killResult = { status: 200, body: { ok: true, structured: true, operationId: "kill-op-1", receipt: { status: "delivered" } } };

  const result = await defaultPipelinePorts().stopStageAgent(target(fixture.conversationId));

  expect(result).toEqual({ outcome: "stopped" });
  expect(killed).toEqual([{ conversationId: fixture.conversationId, transcriptPath: fixture.path, action: "kill" }]);
  setAgentRegistryForTests(null);
});

test("an attempt whose conversation id no longer resolves is found by its transcript (#670)", async () => {
  const fixture = hostedConversation();

  const result = await stopPipelineStageAgent({
    stageId: "build",
    attempt: 1,
    conversationId: "conversation_retired_alias",
    agentPath: fixture.path,
    paneId: null,
  });

  expect(result).toEqual({ outcome: "stopped" });
  expect(killed).toMatchObject([{ conversationId: fixture.conversationId, action: "kill" }]);
  setAgentRegistryForTests(null);
});

/** A queued receipt is what the runtime answers first; these cover what the
    close may conclude from it. */
function queuedKill() {
  killResult = { status: 202, body: { ok: true, structured: true, operationId: "kill-op-queued", receipt: { status: "queued" } } };
}

function confirmationProbes(overrides: Partial<Parameters<typeof stopPipelineStageAgent>[1]> = {}) {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
    client: null,
    ...overrides,
  };
}

function statusClient(receipt: { status: string; reason?: string | null }): RuntimeHostClient {
  return {
    operationStatus: async (operationId: string) => ({ operationId, receipt: { ...receipt, at: "now" }, replayed: false }),
  } as unknown as RuntimeHostClient;
}

test("a queued kill with no evidence of termination is unconfirmed, never a clean stop (#670)", async () => {
  const fixture = hostedConversation();
  queuedKill();

  const result = await stopPipelineStageAgent(target(fixture.conversationId), confirmationProbes());

  expect(result).toEqual({
    outcome: "unconfirmed",
    operationId: "kill-op-queued",
    detail: "kill accepted as queued but termination was not confirmed",
  });
  expect(killed).toHaveLength(1);
  setAgentRegistryForTests(null);
});

test("a queued kill confirmed by the host leaving the registry is a stop (#670)", async () => {
  const fixture = hostedConversation();
  queuedKill();
  /* The runtime tears the host down while the close waits — exactly what the
     durable projection records after a delivered kill. */
  const probes = confirmationProbes();
  const result = await stopPipelineStageAgent(target(fixture.conversationId), {
    ...probes,
    sleep: async (ms: number) => {
      await probes.sleep(ms);
      fixture.registry.terminateStructuredHost(fixture.key);
    },
  });

  expect(result).toEqual({ outcome: "stopped" });
  setAgentRegistryForTests(null);
});

test("a queued kill confirmed by its durable receipt is a stop (#670)", async () => {
  const fixture = hostedConversation();
  queuedKill();

  const result = await stopPipelineStageAgent(
    target(fixture.conversationId),
    confirmationProbes({ client: statusClient({ status: "delivered" }) }),
  );

  expect(result).toEqual({ outcome: "stopped" });
  setAgentRegistryForTests(null);
});

test("a queued kill whose operation terminally failed leaves the host still running (#670)", async () => {
  const fixture = hostedConversation();
  queuedKill();

  const result = await stopPipelineStageAgent(
    target(fixture.conversationId),
    confirmationProbes({ client: statusClient({ status: "failed", reason: "host process did not exit" }) }),
  );

  expect(result).toEqual({ outcome: "failed", error: "host process did not exit" });
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

/* #1501: the typed "no control channel" answer is the one refusal the stop
   may act on by itself, from the registry row's recorded identity. The
   fixture row here names this test process without a boot epoch, so the
   fallback must refuse by name and signal nothing; the full process cases run
   in stageHostGenerationClose.integration.test.ts. */
test("a typed no-channel answer enters the identity path, which refuses an incomplete row without a signal (#1501)", async () => {
  const fixture = hostedConversation();
  killResult = { status: 503, body: { error: "structured runtime host is unavailable", code: "runtime-host-unavailable" } };
  let signalled = 0;

  const result = await stopPipelineStageAgent(target(fixture.conversationId), {
    termination: { signal: () => { signalled += 1; } },
  });

  expect(result).toMatchObject({ outcome: "failed" });
  const error = (result as { error: string }).error;
  expect(error).toContain("boot epoch is unknown");
  expect(error).toContain("nothing was signalled");
  expect(error).toContain("no structured control channel");
  expect(signalled).toBe(0);
  expect(killed).toHaveLength(1);
  setAgentRegistryForTests(null);
});

test("an untyped refusal never enters the identity path (#1501)", async () => {
  const fixture = hostedConversation();
  killResult = { status: 503, body: { error: "structured runtime host is unavailable" } };
  let signalled = 0;

  const result = await stopPipelineStageAgent(target(fixture.conversationId), {
    termination: { signal: () => { signalled += 1; } },
  });

  expect(result).toEqual({ outcome: "failed", error: "structured runtime host is unavailable" });
  expect(signalled).toBe(0);
  setAgentRegistryForTests(null);
});

test("the residency probe reads host state without dispatching anything (#670)", async () => {
  const live = hostedConversation();
  const ports = defaultPipelinePorts();
  expect(await ports.stageHostResident(target(live.conversationId))).toBeTrue();

  /* What the tick trusts to retire an unconfirmed record: the host is gone. */
  live.registry.terminateStructuredHost(live.key);
  expect(await ports.stageHostResident(target(live.conversationId))).toBeFalse();
  expect(await ports.stageHostResident(target("conversation_never_seen"))).toBeFalse();
  expect(killed).toEqual([]);
  setAgentRegistryForTests(null);
});

type TmuxHostEvidence = import("@/lib/agent/registry").TmuxHostEvidence;

/** Durable tmux evidence shaped like a real spawn record. */
function paneEvidence(paneId: string): TmuxHostEvidence {
  const identity = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
  return {
    kind: "tmux",
    endpoint: { tmuxTmpdir: path.join(sandbox, "tmux"), socketName: "default" },
    windowName: "stage-build",
    server: identity,
    agent: identity,
    paneId,
    panePid: identity,
    target: paneId,
  } as unknown as TmuxHostEvidence;
}

test("a stage pane is killed only when its recorded identity still matches (#670)", async () => {
  const fixture = hostedConversation({ status: "dead", hosted: false, pane: paneEvidence("%3") });
  const attempted: TmuxHostEvidence[] = [];

  const stopped = await stopPipelineStagePane(
    { stageId: "build", attempt: 1, conversationId: fixture.conversationId, agentPath: null, paneId: "%3" },
    {
      killHostIfMatches: async (host) => { attempted.push(host); return true; },
      paneSnapshot: async () => ({ windowName: "stage-build", command: "codex" }),
    },
  );

  expect(stopped).toEqual({ outcome: "stopped" });
  expect(attempted).toHaveLength(1);
  expect(attempted[0]!.paneId).toBe("%3");
  setAgentRegistryForTests(null);
});

test("a recycled pane id is reported unknown and never signalled (#670)", async () => {
  /* The tmux server restarted and %3 now belongs to someone else's window, so
     the identity check refuses. Nothing may be killed here. */
  const changed = hostedConversation({ status: "dead", hosted: false, pane: paneEvidence("%3") });
  let signalled = 0;

  const mismatch = await stopPipelineStagePane(
    { stageId: "build", attempt: 1, conversationId: changed.conversationId, agentPath: null, paneId: "%3" },
    {
      killHostIfMatches: async () => { signalled += 1; return false; },
      paneSnapshot: async () => ({ windowName: "stage-build", command: "codex" }),
    },
  );
  expect(mismatch).toMatchObject({ outcome: "unknown" });
  expect((mismatch as { detail: string }).detail).toContain("%3");
  setAgentRegistryForTests(null);

  /* No durable evidence at all: the stored id names a pane we cannot claim. */
  const unknown = hostedConversation({ status: "dead", hosted: false });
  const orphan = await stopPipelineStagePane(
    { stageId: "build", attempt: 1, conversationId: unknown.conversationId, agentPath: null, paneId: "%3" },
    {
      killHostIfMatches: async () => { signalled += 1; return true; },
      paneSnapshot: async () => ({ windowName: "stage-build", command: "codex" }),
    },
  );
  expect(orphan).toMatchObject({ outcome: "unknown" });
  /* The mismatching kill probe ran once and refused; the evidence-less case
     never reached a kill at all. */
  expect(signalled).toBe(1);

  /* Nothing running in the pane at all is simply nothing to stop. */
  const quiet = await stopPipelineStagePane(
    { stageId: "build", attempt: 1, conversationId: unknown.conversationId, agentPath: null, paneId: "%3" },
    { killHostIfMatches: async () => { signalled += 1; return true; }, paneSnapshot: async () => null },
  );
  expect(quiet).toEqual({ outcome: "not-running" });
  expect(signalled).toBe(1);
  expect(killed).toEqual([]);
  setAgentRegistryForTests(null);
});
