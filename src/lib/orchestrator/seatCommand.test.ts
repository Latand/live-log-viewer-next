import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultModelFor } from "@/lib/agent/models";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { resolveSpawnRole } from "@/lib/roles/registry";
import { MAX_STRUCTURED_TEXT_BYTES } from "@/lib/runtime/structuredContent";

import {
  HANDOFF_HEADING,
  HISTORY_BUDGET_BYTES,
  HISTORY_HEADING,
  type HandoffDigestRequest,
} from "./handoffDigest";
import {
  ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE,
  ORCHESTRATOR_PROMPT_VERSION,
  ORCHESTRATOR_SYSTEM_PROMPT,
} from "./prompt";
import { setRetireManagerForTests } from "./retire";
import {
  executeOrchestratorRotation,
  executeOrchestratorSeatRequest,
  productionSeatCommandDependencies,
  type SeatCommandDependencies,
} from "./seatCommand";
import { activeOrchestratorSeats, orchestratorRevocations, orchestratorSeatFor, type OrchestratorSeat } from "./seats";

let sandbox = "";
let previousStateDir: string | undefined;
/** Every host-retirement the production module would perform, observed at the
    REAL seam (`setRetireManagerForTests`), so a mutation that reintroduces a
    retireOutgoingManager call anywhere in the seat flow turns the axis-1
    assertions red instead of silently killing a real agent. */
let retiredHosts: string[] = [];

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-command-"));
  process.env.LLV_STATE_DIR = sandbox;
  retiredHosts = [];
  setRetireManagerForTests(async (conversationId) => {
    retiredHosts.push(conversationId);
    return "killed";
  });
});

afterEach(() => {
  setRetireManagerForTests(null);
  setAgentRegistryForTests(null);
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const AT = "2026-07-29T00:00:00.000Z";
const NEW_ID = "conversation_33333333-3333-4333-8333-333333333333";
const OLD_ID = "conversation_44444444-4444-4444-8444-444444444444";

interface Recorded {
  spawns: Record<string, unknown>[];
  deliveries: { conversationId: string; clientMessageId: string; text: string }[];
  digests: HandoffDigestRequest[];
  identityStamps: OrchestratorSeat[];
}

function dependencies(overrides: Partial<SeatCommandDependencies> = {}): { deps: SeatCommandDependencies; recorded: Recorded } {
  const recorded: Recorded = { spawns: [], deliveries: [], digests: [], identityStamps: [] };
  const deps: SeatCommandDependencies = {
    spawn: async (body) => {
      recorded.spawns.push(body);
      return { status: 200, body: { ok: true, state: "settled", conversationId: NEW_ID, path: "/tmp/new.jsonl", launchId: "launch_1" } };
    },
    deliver: async (input) => {
      recorded.deliveries.push({ conversationId: input.conversationId, clientMessageId: input.clientMessageId, text: input.text });
      return { ok: true, outcome: "delivered" };
    },
    conversationTarget: (conversationId) => ({
      kind: "eligible",
      conversationId,
      path: `/tmp/${conversationId.slice(-4)}.jsonl`,
      cwd: "/workspace",
      project: "proj-a",
      engine: "claude",
    }),
    stampRegistryIdentity: (seat) => { recorded.identityStamps.push(seat); },
    projectTasks: () => [],
    /* No test in this file reaches the real summarizer: the seam is injected,
       so nothing here spawns a process, opens a socket, or reads an account. */
    summarizeHandoffs: async (request) => {
      recorded.digests.push(request);
      return { kind: "fallback", reason: "unavailable" };
    },
    launchSettlement: () => ({ kind: "unknown" }),
    runtimeIdentity: () => ({ engine: null, model: null }),
    now: () => AT,
    ...overrides,
  };
  return { deps, recorded };
}

/** Durable residue of an accepting request that died between begin and
    activate: a pending spawn intent holding the launch receipt id. */
function seedPendingLaunchIntent(input: {
  clientRequestId: string;
  launchId: string | null;
  error?: string | null;
  engine?: string | null;
  model?: string | null;
  legacyRuntimeShape?: boolean;
}): void {
  fs.writeFileSync(path.join(sandbox, "orchestrator-seats.json"), JSON.stringify({
    schemaVersion: 1,
    nextSeatEpoch: 2,
    seats: {},
    pending: {
      "proj-a": {
        project: "proj-a",
        seatEpoch: 1,
        conversationId: null,
        path: null,
        ...(input.legacyRuntimeShape ? {} : {
          engine: input.engine ?? null,
          model: input.model ?? null,
        }),
        mandate: "own the board",
        promptVersion: null,
        predecessorConversationId: null,
        state: "pending",
        intent: { clientRequestId: input.clientRequestId, mode: "spawn", launchId: input.launchId, error: input.error ?? null },
        designatedAt: AT,
        activatedAt: null,
      },
    },
    revocations: [],
  }), "utf8");
}

function seedLegacyActiveSeat(clientRequestId: string): void {
  fs.writeFileSync(path.join(sandbox, "orchestrator-seats.json"), JSON.stringify({
    schemaVersion: 1,
    nextSeatEpoch: 2,
    seats: {
      "proj-a": {
        project: "proj-a",
        seatEpoch: 1,
        conversationId: NEW_ID,
        path: "/tmp/new.jsonl",
        mandate: "own the board",
        promptVersion: null,
        predecessorConversationId: null,
        state: "active",
        intent: { clientRequestId, mode: "spawn", launchId: "launch_legacy", error: null },
        designatedAt: AT,
        activatedAt: AT,
      },
    },
    pending: {},
    revocations: [],
  }), "utf8");
}

const spawnRequest = (clientRequestId = "req_00000001") => ({
  project: "proj-a",
  mandate: "own the board",
  clientRequestId,
  engine: "claude",
  model: "opus",
  cwd: "/tmp",
});

test("spawn mode designates and injects together: mandate rides the spawn prompt and the seat activates", async () => {
  const { deps, recorded } = dependencies();
  const result = await executeOrchestratorSeatRequest(spawnRequest(), deps);
  expect(result.status).toBe(200);
  expect(result.body.conversationId).toBe(NEW_ID);
  expect(recorded.spawns).toHaveLength(1);
  expect(recorded.spawns[0]).toMatchObject({
    role: "orchestrator",
    project: "proj-a",
    title: "orchestrator · own the board",
    clientAttemptId: "req_00000001",
  });
  expect(String(recorded.spawns[0]!.prompt)).toStartWith("own the board");
  expect(String(recorded.spawns[0]!.prompt)).toContain("all mandate missions are complete; standing by");
  const { active, pending } = orchestratorSeatFor("proj-a");
  expect(active?.conversationId).toBe(NEW_ID);
  expect(active?.mandate).toBe("own the board");
  expect(pending).toBeNull();
});

test("spawn mode freezes omitted runtime fields to the resolved orchestrator defaults", async () => {
  const { deps, recorded } = dependencies();
  const result = await executeOrchestratorSeatRequest({
    project: "proj-a",
    mandate: "own the board",
    clientRequestId: "req_00000003",
    cwd: "/tmp",
  }, deps);

  expect(result.status).toBe(200);
  expect(recorded.spawns[0]).toMatchObject({ engine: "claude", model: "opus" });
  expect(orchestratorSeatFor("proj-a").active).toMatchObject({
    engine: "claude",
    model: "opus",
    runtimeIdentityFrozen: true,
  });
});

test("a seat designated after the identity wave stamps registry role, membership, and rotation lineage", async () => {
  const registry = new AgentRegistry(path.join(sandbox, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  const oldPath = path.join(sandbox, "old.jsonl");
  const newPath = path.join(sandbox, "new.jsonl");
  const oldConversation = registry.ensureConversation("claude", oldPath, null);
  const newConversation = registry.ensureConversation("codex", newPath, null);
  registry.runIdentityWaveMigration({
    now: AT,
    transcriptTitle: () => null,
    sharedPathForLegacy: () => null,
    orchestratorSeats: [],
  });
  const { deps } = dependencies({
    conversationTarget: (conversationId) => ({
      kind: "eligible",
      conversationId,
      path: conversationId === oldConversation.id ? oldPath : newPath,
      cwd: sandbox,
      project: "proj-a",
      engine: "claude",
    }),
    stampRegistryIdentity: (seat) => { registry.stampOrchestratorSeatIdentity(seat); },
  });

  await executeOrchestratorSeatRequest({
    project: "proj-a",
    mandate: "own the first wave",
    clientRequestId: "req_00001001",
    conversationId: oldConversation.id,
  }, deps);
  await executeOrchestratorSeatRequest({
    project: "proj-a",
    mandate: "own the next wave",
    clientRequestId: "req_00001002",
    conversationId: newConversation.id,
  }, deps);

  const snapshot = registry.snapshot();
  expect(snapshot.identityMigrations["identity-wave-a-d-913"]).toBeDefined();
  expect(snapshot.conversations[oldConversation.id]).toMatchObject({ agentRole: "orchestrator", delegationDepth: 0 });
  expect(snapshot.conversations[newConversation.id]).toMatchObject({ agentRole: "orchestrator", delegationDepth: 0 });
  expect(snapshot.memberships[newConversation.id]).toContainEqual(expect.objectContaining({
    kind: "orchestrator",
    containerId: "proj-a",
    parentConversationId: oldConversation.id,
  }));
  expect(snapshot.lineageEdges[newConversation.id]).toMatchObject({
    parentConversationId: oldConversation.id,
    role: "orchestrator",
  });
});

test("a completed seat replay repairs a failed registry stamp without revalidating the target", async () => {
  let stampAttempts = 0;
  let targetReads = 0;
  const { deps, recorded } = dependencies({
    conversationTarget: (conversationId) => {
      targetReads += 1;
      return targetReads === 1
        ? { kind: "eligible", conversationId, path: path.join(sandbox, "existing.jsonl"), cwd: sandbox, project: "proj-a", engine: "claude" as const }
        : null;
    },
    stampRegistryIdentity: () => {
      stampAttempts += 1;
      if (stampAttempts === 1) throw new Error("temporary registry write failure");
    },
  });
  const request = {
    project: "proj-a",
    mandate: "own repairs",
    clientRequestId: "req_00001003",
    conversationId: OLD_ID,
  };

  await expect(executeOrchestratorSeatRequest(request, deps)).rejects.toThrow("temporary registry write failure");
  const replay = await executeOrchestratorSeatRequest(request, deps);

  expect(replay).toMatchObject({ status: 200, body: { replayed: true, conversationId: OLD_ID } });
  expect(stampAttempts).toBe(2);
  expect(targetReads).toBe(1);
  expect(recorded.deliveries).toHaveLength(1);
});

test("a caller-edited current-version mandate receives the status directive without changing stored text", async () => {
  const { deps, recorded } = dependencies();
  const mandate = "custom current-version mandate";
  const result = await executeOrchestratorSeatRequest({
    ...spawnRequest("req_00000021"),
    mandate,
    promptVersion: ORCHESTRATOR_PROMPT_VERSION,
  }, deps);

  expect(result.status).toBe(200);
  const delivered = String(recorded.spawns[0]!.prompt);
  expect(delivered).toStartWith(mandate);
  expect(delivered.split(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE)).toHaveLength(2);
  expect(orchestratorSeatFor("proj-a").active).toMatchObject({
    mandate,
    promptVersion: ORCHESTRATOR_PROMPT_VERSION,
  });
});

test("a completed seat replay preserves the incumbent engine and model from its durable intent", async () => {
  const { deps, recorded } = dependencies();
  const request = {
    ...spawnRequest("req_00001005"),
    engine: "codex",
    model: "gpt-5.6-sol",
  };

  expect((await executeOrchestratorSeatRequest(request, deps)).status).toBe(200);
  expect(orchestratorSeatFor("proj-a").active).toMatchObject({
    conversationId: NEW_ID,
    engine: "codex",
    model: "gpt-5.6-sol",
  });

  const replay = await executeOrchestratorSeatRequest({
    project: request.project,
    mandate: request.mandate,
    clientRequestId: request.clientRequestId,
    cwd: request.cwd,
  }, deps);

  expect(replay).toMatchObject({ status: 200, body: { replayed: true, conversationId: NEW_ID } });
  expect(recorded.spawns).toHaveLength(1);
  expect(orchestratorSeatFor("proj-a").active).toMatchObject({ engine: "codex", model: "gpt-5.6-sol" });
});

test("a legacy active seat replay recovers incumbent runtime metadata", async () => {
  const clientRequestId = "req_legacy_active";
  seedLegacyActiveSeat(clientRequestId);
  const { deps } = dependencies({
    runtimeIdentity: () => ({ engine: "codex", model: "gpt-5.6-sol" }),
  });

  const replay = await executeOrchestratorSeatRequest({
    project: "proj-a",
    mandate: "own the board",
    clientRequestId,
    cwd: "/tmp",
  }, deps);

  expect(replay).toMatchObject({ status: 200, body: { replayed: true, conversationId: NEW_ID } });
  expect(orchestratorSeatFor("proj-a").active).toMatchObject({ engine: "codex", model: "gpt-5.6-sol" });
});

test("an admitted asynchronous spawn activates the seat from its durable conversation id", async () => {
  const { deps } = dependencies({
    spawn: async () => ({
      status: 202,
      body: {
        ok: true,
        state: "starting",
        launched: false,
        conversationId: NEW_ID,
        launchId: "launch_async",
      },
    }),
  });

  const result = await executeOrchestratorSeatRequest(spawnRequest(), deps);

  expect(result.status).toBe(202);
  expect(result.body).toMatchObject({
    accepted: true,
    state: "accepted",
    conversationId: NEW_ID,
    launchId: "launch_async",
  });
  expect(orchestratorSeatFor("proj-a").active?.conversationId).toBe(NEW_ID);
  expect(orchestratorSeatFor("proj-a").active?.intent.launchId).toBe("launch_async");
  expect(orchestratorSeatFor("proj-a").pending).toBeNull();
});

test("a restarted caller replays the accepted launch from the durable seat receipt", async () => {
  const { deps } = dependencies({
    spawn: async () => ({
      status: 202,
      body: { ok: true, state: "starting", launched: false, conversationId: NEW_ID, launchId: "launch_resume" },
    }),
  });
  await executeOrchestratorSeatRequest(spawnRequest("req_00000015"), deps);
  const { deps: resumed, recorded } = dependencies({
    spawn: async () => {
      throw new Error("a completed accepted launch must replay from durable state");
    },
  });

  const replay = await executeOrchestratorSeatRequest(spawnRequest("req_00000015"), resumed);

  expect(replay).toMatchObject({
    status: 200,
    body: { replayed: true, accepted: true, state: "accepted", conversationId: NEW_ID, launchId: "launch_resume" },
  });
  expect(recorded.spawns).toEqual([]);
});

test("a failed spawn leaves no active seat and keeps a recoverable pending intent", async () => {
  const { deps } = dependencies({
    spawn: async () => ({ status: 400, body: { error: "directory does not exist" } }),
  });
  const result = await executeOrchestratorSeatRequest(spawnRequest(), deps);
  expect(result.status).toBe(400);
  const { active, pending } = orchestratorSeatFor("proj-a");
  expect(active).toBeNull();
  expect(pending?.intent.error).toBe("directory does not exist");
});

test("a retry after a failed spawn replays the SAME clientAttemptId and completes exactly once", async () => {
  let attempts = 0;
  const { deps, recorded } = dependencies({
    spawn: async (body) => {
      recorded.spawns.push(body);
      attempts += 1;
      return attempts === 1
        ? { status: 500, body: { error: "transient" } }
        : { status: 200, body: { ok: true, conversationId: NEW_ID, path: null } };
    },
  });
  await executeOrchestratorSeatRequest(spawnRequest(), deps);
  const retried = await executeOrchestratorSeatRequest(spawnRequest(), deps);
  expect(retried.status).toBe(200);
  expect(recorded.spawns.map((body) => body.clientAttemptId)).toEqual(["req_00000001", "req_00000001"]);
  expect(orchestratorSeatFor("proj-a").active?.conversationId).toBe(NEW_ID);
});

test("a completed request replayed by its key spawns and delivers NOTHING a second time", async () => {
  const { deps, recorded } = dependencies();
  await executeOrchestratorSeatRequest(spawnRequest(), deps);
  const replay = await executeOrchestratorSeatRequest(spawnRequest(), deps);
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);
  expect(recorded.spawns).toHaveLength(1);
  expect(recorded.deliveries).toHaveLength(0);
});

test("selecting an EXISTING conversation delivers a caller-edited current-version mandate once", async () => {
  const { deps, recorded } = dependencies();
  const result = await executeOrchestratorSeatRequest({
    project: "proj-a",
    mandate: "updated mandate",
    promptVersion: ORCHESTRATOR_PROMPT_VERSION,
    clientRequestId: "req_00000002",
    conversationId: OLD_ID,
  }, deps);
  expect(result.status).toBe(200);
  expect(recorded.spawns).toHaveLength(0);
  expect(recorded.deliveries).toHaveLength(1);
  expect(recorded.deliveries[0]).toMatchObject({
    conversationId: OLD_ID,
    clientMessageId: "orchmandate_req_00000002",
  });
  expect(recorded.deliveries[0]!.text).toStartWith("updated mandate");
  expect(recorded.deliveries[0]!.text.split(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE)).toHaveLength(2);
  expect(orchestratorSeatFor("proj-a").active).toMatchObject({
    conversationId: OLD_ID,
    mandate: "updated mandate",
    promptVersion: ORCHESTRATOR_PROMPT_VERSION,
  });
});

test("adopting a model-less Codex conversation records its engine-specific effective model", async () => {
  const registry = new AgentRegistry(path.join(sandbox, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  setAgentRegistryForTests(registry);
  const transcript = path.join(sandbox, "model-less-codex.jsonl");
  fs.writeFileSync(transcript, "", "utf8");
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd: sandbox,
    role: "orchestrator",
    launchProfile: { title: "Adopt model-less Codex conversation" },
  });
  if (begun.kind !== "created") throw new Error("expected a spawn receipt");
  registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: "model-less-codex" },
    artifactPath: transcript,
    cwd: sandbox,
    accountId: null,
    launchProfile: begun.receipt.launchProfile,
    status: "live",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const target = productionSeatCommandDependencies.conversationTarget(begun.receipt.conversationId);
  if (!target || target.kind !== "eligible") throw new Error("expected an eligible Codex target");
  const { deps } = dependencies({
    conversationTarget: productionSeatCommandDependencies.conversationTarget,
    runtimeIdentity: productionSeatCommandDependencies.runtimeIdentity,
  });

  const result = await executeOrchestratorSeatRequest({
    project: target.project,
    mandate: "Own the Codex project",
    clientRequestId: "req_model_less_codex_1",
    conversationId: begun.receipt.conversationId,
  }, deps);

  expect(result.status).toBe(200);
  expect(orchestratorSeatFor(target.project).active).toMatchObject({
    engine: "codex",
    model: defaultModelFor("codex"),
  });
});

test("a replayed adoption keeps its original target during an ABA-shaped retry", async () => {
  let releaseDelivery: () => void = () => {};
  const gate = new Promise<void>((resolve) => { releaseDelivery = resolve; });
  const { deps, recorded } = dependencies({
    conversationTarget: (conversationId) => ({
      kind: "eligible",
      conversationId,
      path: `/tmp/${conversationId.slice(-4)}.jsonl`,
      cwd: "/workspace",
      project: "proj-a",
      engine: "claude",
    }),
    deliver: async (input) => {
      recorded.deliveries.push({ conversationId: input.conversationId, clientMessageId: input.clientMessageId, text: input.text });
      await gate;
      return { ok: true, outcome: "delivered" };
    },
  });
  const first = executeOrchestratorSeatRequest({
    project: "proj-a",
    mandate: "m",
    clientRequestId: "req_00000014",
    conversationId: OLD_ID,
  }, deps);
  const replay = executeOrchestratorSeatRequest({
    project: "proj-a",
    mandate: "recomposed",
    clientRequestId: "req_00000014",
    conversationId: NEW_ID,
  }, deps);

  expect(recorded.deliveries.map((delivery) => delivery.conversationId)).toEqual([OLD_ID, OLD_ID]);
  releaseDelivery();
  await Promise.all([first, replay]);
  expect(orchestratorSeatFor("proj-a").active?.conversationId).toBe(OLD_ID);
});

test("a failed delivery keeps the incumbent seated and reports a recoverable state", async () => {
  const { deps } = dependencies();
  await executeOrchestratorSeatRequest(spawnRequest(), deps);
  const { deps: failing } = dependencies({
    deliver: async () => ({ ok: false, error: "host is dead" }),
  });
  const result = await executeOrchestratorSeatRequest({
    project: "proj-a",
    mandate: "next mandate",
    clientRequestId: "req_00000003",
    conversationId: OLD_ID,
  }, failing);
  expect(result.status).toBe(502);
  expect(result.body.code).toBe("mandate_delivery_failed");
  expect(orchestratorSeatFor("proj-a").active?.conversationId).toBe(NEW_ID);
  expect(orchestratorSeatFor("proj-a").pending?.intent.error).toBe("host is dead");
});

test("AXIS 1/2 SEPARATION: replacement revokes MANAGER-LEVEL authority only — the predecessor's session is never touched", async () => {
  const { deps } = dependencies();
  await executeOrchestratorSeatRequest(spawnRequest(), deps);
  const result = await executeOrchestratorSeatRequest({
    project: "proj-a",
    mandate: "successor mandate",
    clientRequestId: "req_00000004",
    conversationId: OLD_ID,
  }, deps);
  expect(result.status).toBe(200);
  /* Designation switched, predecessor durably revoked as manager… */
  expect(orchestratorSeatFor("proj-a").active?.conversationId).toBe(OLD_ID);
  /* …and its host and ordinary Viewer access are left exactly as they were:
     revocation is an axis-2 act, killing a session would be an axis-1 one.
     Observed at the REAL retire seam, so a production call to
     retireOutgoingManager anywhere in this flow turns this red. */
  expect(retiredHosts).toEqual([]);
});

test("an unknown existing conversation is refused before any intent exists", async () => {
  const { deps } = dependencies({ conversationTarget: () => null });
  const result = await executeOrchestratorSeatRequest({
    project: "proj-a",
    mandate: "m",
    clientRequestId: "req_00000006",
    conversationId: OLD_ID,
  }, deps);
  expect(result.status).toBe(404);
  expect(orchestratorSeatFor("proj-a").pending).toBeNull();
});

test("adoption refuses a conversation whose project, cwd, transcript, or lifecycle is ineligible before creating an intent", async () => {
  const candidates = [
    { kind: "eligible", conversationId: OLD_ID, path: "/tmp/old.jsonl", cwd: "/workspace", project: "proj-b" },
    { kind: "ineligible", code: "invalid_cwd", error: "conversation cwd is unavailable" },
    { kind: "ineligible", code: "missing_transcript", error: "conversation transcript is unavailable" },
    { kind: "ineligible", code: "conversation_ineligible", error: "conversation is superseded" },
  ];

  for (const [index, candidate] of candidates.entries()) {
    const { deps, recorded } = dependencies({
      conversationTarget: () => candidate as never,
    });
    const result = await executeOrchestratorSeatRequest({
      project: "proj-a",
      mandate: "m",
      clientRequestId: `req_00000${index}2`,
      conversationId: OLD_ID,
    }, deps);

    expect(result.status).toBe(409);
    expect(recorded.spawns).toEqual([]);
    expect(recorded.deliveries).toEqual([]);
    expect(orchestratorSeatFor("proj-a").pending).toBeNull();
  }
});

test("rotation composes a bounded handoff, switches designation atomically, and links both cards", async () => {
  const { deps } = dependencies();
  await executeOrchestratorSeatRequest(spawnRequest(), deps);

  const SUCCESSOR = "conversation_55555555-5555-4555-8555-555555555555";
  const { deps: rotating } = dependencies({
    spawn: async (body) => {
      recorded2.push(body);
      return { status: 200, body: { ok: true, conversationId: SUCCESSOR, path: "/tmp/successor.jsonl" } };
    },
    projectTasks: () => [
      { id: "task_1", status: "doing", text: "Ship the handoff", },
      { id: "task_2", status: "inbox", text: "Review the successor", },
    ],
  });
  const recorded2: Record<string, unknown>[] = [];
  const result = await executeOrchestratorRotation({
    project: "proj-a",
    clientRequestId: "req_00000010",
    handoffNotes: "Prioritize the review queue.",
  }, rotating);

  expect(result.status).toBe(200);
  expect(result.body.rotatedFrom).toMatchObject({ conversationId: NEW_ID });
  const spawnedPrompt = String(recorded2[0]!.prompt);
  /* Successor mandate = incumbent mandate + bounded handoff naming the
     predecessor, its transcript, the open tasks and the caller's notes. */
  expect(spawnedPrompt).toStartWith("own the board");
  expect(spawnedPrompt).toContain(NEW_ID);
  expect(spawnedPrompt).toContain("[doing] Ship the handoff (task_1)");
  expect(spawnedPrompt).toContain("Prioritize the review queue.");
  expect(spawnedPrompt).toContain("all mandate missions are complete; standing by");

  const { active } = orchestratorSeatFor("proj-a");
  expect(active?.conversationId).toBe(SUCCESSOR);
  /* Bidirectional lineage, both cards preserved: the seat names its
     predecessor, the revocation names its successor, and nothing killed or
     superseded the incumbent's session. */
  expect(active?.predecessorConversationId).toBe(NEW_ID);
  expect(orchestratorRevocations()).toEqual([expect.objectContaining({
    conversationId: NEW_ID,
    successorConversationId: SUCCESSOR,
  })]);
  expect(retiredHosts).toEqual([]);
});

test("a current-version rotation override receives one directive while its stored mandate stays raw", async () => {
  const seeded = dependencies();
  await executeOrchestratorSeatRequest({
    ...spawnRequest("req_00000022"),
    mandate: ORCHESTRATOR_SYSTEM_PROMPT,
    promptVersion: ORCHESTRATOR_PROMPT_VERSION,
  }, seeded.deps);

  const successor = "conversation_66666666-6666-4666-8666-666666666666";
  const { deps, recorded } = dependencies({
    spawn: async (body) => {
      recorded.spawns.push(body);
      return { status: 200, body: { ok: true, conversationId: successor, path: "/tmp/successor-override.jsonl" } };
    },
  });
  const result = await executeOrchestratorRotation({
    project: "proj-a",
    clientRequestId: "req_00000023",
    mandate: "rotation override mandate",
  }, deps);

  expect(result.status).toBe(200);
  const delivered = String(recorded.spawns[0]!.prompt);
  expect(delivered).toStartWith("rotation override mandate");
  expect(delivered.split(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE)).toHaveLength(2);
  const active = orchestratorSeatFor("proj-a").active;
  expect(active).toMatchObject({ conversationId: successor, promptVersion: ORCHESTRATOR_PROMPT_VERSION });
  expect(active?.mandate).toStartWith("rotation override mandate");
  expect(active?.mandate).not.toContain(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE);
});

test("an adoption racing an in-flight rotation is refused while the rotation keeps one durable successor", async () => {
  const seeded = dependencies();
  await executeOrchestratorSeatRequest(spawnRequest("req_00000020"), seeded.deps);

  let releaseSpawn: () => void = () => {};
  const gate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
  const successor = "conversation_77777777-7777-4777-8777-777777777777";
  const { deps, recorded } = dependencies({
    spawn: async (body) => {
      recorded.spawns.push(body);
      await gate;
      return { status: 200, body: { ok: true, conversationId: successor, path: "/tmp/successor.jsonl" } };
    },
  });
  const rotating = executeOrchestratorRotation({ project: "proj-a", clientRequestId: "req_00000021" }, deps);
  const adoption = await executeOrchestratorSeatRequest({
    project: "proj-a",
    mandate: "adopt me",
    clientRequestId: "req_00000022",
    conversationId: OLD_ID,
  }, deps);

  expect(adoption).toMatchObject({ status: 409, body: { code: "seat_intent_in_progress" } });
  expect(recorded.deliveries).toEqual([]);
  releaseSpawn();
  const rotated = await rotating;

  expect(rotated.status).toBe(200);
  expect(orchestratorSeatFor("proj-a").active?.conversationId).toBe(successor);
  expect(orchestratorRevocations()).toEqual([expect.objectContaining({ conversationId: NEW_ID, successorConversationId: successor })]);
});

test("HIGH 5: a spawn-mode designation for an ALREADY-SEATED project refuses instead of silently unseating the incumbent", async () => {
  const { deps, recorded } = dependencies();
  await executeOrchestratorSeatRequest(spawnRequest(), deps);
  expect(recorded.spawns).toHaveLength(1);

  /* An ordinary retry-with-a-fresh-key, or a second create for a project that
     already has its orchestrator: this must NOT become an accidental rotation
     with no handoff. */
  const refused = await executeOrchestratorSeatRequest(spawnRequest("req_00000099"), deps);
  expect(refused.status).toBe(409);
  expect(refused.body.code).toBe("already_designated");
  expect(String(refused.body.error)).toContain("rotate_orchestrator");
  /* Nothing spawned, nothing revoked, incumbent untouched. */
  expect(recorded.spawns).toHaveLength(1);
  expect(orchestratorRevocations()).toEqual([]);
  expect(orchestratorSeatFor("proj-a").active?.conversationId).toBe(NEW_ID);
  expect(orchestratorSeatFor("proj-a").pending).toBeNull();

  /* Rotation remains the explicit way through (proven in the rotation test),
     and the internal replaceIncumbent opt-in it uses works: */
  const replaced = await executeOrchestratorSeatRequest({ ...spawnRequest("req_00000100"), replaceIncumbent: true }, deps);
  expect(replaced.status).toBe(200);
});

test("rotation with no incumbent refuses and points at create", async () => {
  const { deps } = dependencies();
  const result = await executeOrchestratorRotation({ project: "proj-a", clientRequestId: "req_00000011" }, deps);
  expect(result.status).toBe(409);
  expect(result.body.code).toBe("no_incumbent");
});

test("a STILL-LIVE pending replay completes with the ORIGINAL mandate, not a recomposed one", async () => {
  /* No recorded error and no settlement to reconcile: the intent is genuinely
     in flight, so its own key finishes IT — a retry that recomposed its text
     must not deliver a second variant against the same spawn receipt. */
  seedPendingLaunchIntent({ clientRequestId: "req_00000001", launchId: "launch_live", engine: "claude", model: "opus" });
  const { deps, recorded } = dependencies({
    spawn: async (body) => {
      recorded.spawns.push(body);
      return { status: 200, body: { ok: true, conversationId: NEW_ID, path: null } };
    },
  });

  await executeOrchestratorSeatRequest({ ...spawnRequest(), mandate: "recomposed differently" }, deps);

  const prompts = recorded.spawns.map((body) => String(body.prompt));
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toStartWith("own the board");
  expect(prompts[0]!.split(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE)).toHaveLength(2);
  expect(prompts[0]).not.toContain("recomposed differently");
});

test("a same-key retry after a TERMINAL spawn rejection recomposes instead of respawning the failed mandate", async () => {
  let attempts = 0;
  const { deps, recorded } = dependencies({
    spawn: async (body) => {
      recorded.spawns.push(body);
      attempts += 1;
      return attempts === 1
        ? { status: 500, body: { error: "transient" } }
        : { status: 200, body: { ok: true, conversationId: NEW_ID, path: null } };
    },
  });
  await executeOrchestratorSeatRequest(spawnRequest(), deps);
  expect(orchestratorSeatFor("proj-a").pending?.intent.error).toBe("transient");

  /* Ambiguous failures keep the key client-side, so the retry arrives on the
     SAME one. The errored intent is terminal: it is cleared, not replayed, and
     the corrected mandate is the one that spawns (issue #1067 AC 5). */
  await executeOrchestratorSeatRequest({ ...spawnRequest(), mandate: "recomposed differently" }, deps);

  const prompts = recorded.spawns.map((body) => String(body.prompt));
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toStartWith("recomposed differently");
  /* The successor title is derived from the mandate that actually spawned, so
     the recomposed retry is titled by ITS text, not the failed one's. */
  expect(recorded.spawns.map((body) => body.title)).toEqual([
    "orchestrator · own the board",
    "orchestrator · recomposed differently",
  ]);
  const { active, pending, history } = orchestratorSeatFor("proj-a");
  expect(active?.conversationId).toBe(NEW_ID);
  expect(pending).toBeNull();
  expect(history).toMatchObject([{ reason: "terminal_error", seat: { intent: { clientRequestId: "req_00000001", error: "transient" } } }]);
});

test("a STILL-LIVE pending pre-spawn replay keeps the ORIGINAL engine and model", async () => {
  /* Runtime identity is frozen at designation (PR #916). A live pending intent
     is finished by its own key, so a retry naming a different engine/model must
     spawn the identity the seat already carries. */
  seedPendingLaunchIntent({
    clientRequestId: "req_00000001",
    launchId: "launch_live",
    engine: "claude",
    model: "opus",
  });
  const { deps, recorded } = dependencies({
    spawn: async (body) => {
      recorded.spawns.push(body);
      return { status: 200, body: { ok: true, conversationId: NEW_ID, path: null } };
    },
  });

  await executeOrchestratorSeatRequest({
    ...spawnRequest(),
    engine: "codex",
    model: "gpt-5.6-sol",
  }, deps);

  expect(recorded.spawns.map((body) => ({ engine: body.engine, model: body.model }))).toEqual([
    { engine: "claude", model: "opus" },
  ]);
  expect(orchestratorSeatFor("proj-a").active).toMatchObject({ engine: "claude", model: "opus" });
});

test("rotation preserves the requested effort end to end into the successor spawn body", async () => {
  const { deps, recorded } = dependencies();
  await executeOrchestratorSeatRequest(spawnRequest(), deps);

  const rotated = await executeOrchestratorRotation({
    project: "proj-a",
    clientRequestId: "req_00000030",
    effort: "medium",
  }, deps);

  expect(rotated.status).toBe(200);
  expect(recorded.spawns).toHaveLength(2);
  expect(recorded.spawns[1]).toMatchObject({ effort: "medium" });
});

test("rotation preserves the requested Codex speed end to end into the successor spawn body", async () => {
  const { deps, recorded } = dependencies();
  await executeOrchestratorSeatRequest(spawnRequest(), deps);

  const rotated = await executeOrchestratorRotation({
    project: "proj-a",
    clientRequestId: "req_00000031",
    fast: true,
  }, deps);

  expect(rotated.status).toBe(200);
  expect(recorded.spawns).toHaveLength(2);
  expect(recorded.spawns[1]).toMatchObject({ fast: true });
});

test("rotation leaves the successor speed unset when the caller does not request one", async () => {
  const { deps, recorded } = dependencies();
  await executeOrchestratorSeatRequest(spawnRequest(), deps);

  const rotated = await executeOrchestratorRotation({
    project: "proj-a",
    clientRequestId: "req_00000032",
  }, deps);

  expect(rotated.status).toBe(200);
  expect(recorded.spawns).toHaveLength(2);
  expect(recorded.spawns[1]).not.toHaveProperty("fast");
});

test("the stuck shape from #878: an errored pending intent no longer blocks rotation and stays readable in history", async () => {
  const { deps } = dependencies();
  await executeOrchestratorSeatRequest(spawnRequest("req_00000041"), deps);

  /* Wedge the project: a replacement attempt whose spawn terminally failed
     leaves a pending intent carrying the error. */
  const failing = dependencies({
    spawn: async () => ({ status: 409, body: { error: "spawn attempt conflicts with its original request" } }),
  });
  await executeOrchestratorSeatRequest({ ...spawnRequest("req_00000042"), replaceIncumbent: true }, failing.deps);
  expect(orchestratorSeatFor("proj-a").pending?.intent.error).toBe("spawn attempt conflicts with its original request");

  const SUCCESSOR = "conversation_88888888-8888-4888-8888-888888888888";
  const rotating = dependencies({
    spawn: async () => ({ status: 200, body: { ok: true, conversationId: SUCCESSOR, path: "/tmp/successor.jsonl" } }),
  });
  const rotated = await executeOrchestratorRotation({ project: "proj-a", clientRequestId: "req_00000043" }, rotating.deps);

  expect(rotated.status).toBe(200);
  const { active, pending, history } = orchestratorSeatFor("proj-a");
  expect(active?.conversationId).toBe(SUCCESSOR);
  expect(pending).toBeNull();
  /* Terminalized, not deleted: the wedged attempt's evidence survives. */
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    reason: "terminal_error",
    seat: { intent: { clientRequestId: "req_00000042", error: "spawn attempt conflicts with its original request" } },
  });
});

test("a pending intent whose accepted launch settled reconciles to the launched conversation and rotation proceeds", async () => {
  seedPendingLaunchIntent({ clientRequestId: "req_00000050", launchId: "launch_42" });

  const SUCCESSOR = "conversation_99999999-9999-4999-8999-999999999999";
  const { deps } = dependencies({
    launchSettlement: ({ launchId, clientRequestId }) =>
      launchId === "launch_42" && clientRequestId === "req_00000050"
        ? { kind: "settled", conversationId: NEW_ID, path: "/tmp/new.jsonl", launchId: "launch_42" }
        : { kind: "unknown" },
    spawn: async () => ({ status: 200, body: { ok: true, conversationId: SUCCESSOR, path: "/tmp/successor.jsonl" } }),
  });

  const rotated = await executeOrchestratorRotation({ project: "proj-a", clientRequestId: "req_00000051" }, deps);

  expect(rotated.status).toBe(200);
  /* The launch converged to its seat first; rotation then replaced it with a
     durable revocation, so lineage names the reconciled conversation. */
  expect(rotated.body.rotatedFrom).toMatchObject({ conversationId: NEW_ID });
  const { active, pending } = orchestratorSeatFor("proj-a");
  expect(active?.conversationId).toBe(SUCCESSOR);
  expect(pending).toBeNull();
  expect(activeOrchestratorSeats()).toHaveLength(1);
  expect(orchestratorRevocations()).toEqual([expect.objectContaining({ conversationId: NEW_ID, successorConversationId: SUCCESSOR })]);
});

test("replaying the accepting request's own key after its launch settled converges without spawning again", async () => {
  seedPendingLaunchIntent({ clientRequestId: "req_00000050", launchId: "launch_42" });

  const { deps, recorded } = dependencies({
    launchSettlement: () => ({ kind: "settled", conversationId: NEW_ID, path: "/tmp/new.jsonl", launchId: "launch_42" }),
    spawn: async () => {
      throw new Error("a settled accepted launch must reconcile from durable state, never spawn again");
    },
  });

  const replay = await executeOrchestratorSeatRequest(spawnRequest("req_00000050"), deps);

  expect(replay.status).toBe(200);
  expect(replay.body).toMatchObject({ replayed: true, conversationId: NEW_ID });
  expect(recorded.spawns).toEqual([]);
  expect(orchestratorSeatFor("proj-a").active?.conversationId).toBe(NEW_ID);
  expect(orchestratorSeatFor("proj-a").pending).toBeNull();
});

test("creator-death reconciliation restores seat metadata from the pending intent", async () => {
  seedPendingLaunchIntent({
    clientRequestId: "req_00000052",
    launchId: "launch_52",
    engine: "codex",
    model: "gpt-5.6-sol",
  });
  const { deps } = dependencies({
    launchSettlement: () => ({ kind: "settled", conversationId: NEW_ID, path: "/tmp/new.jsonl", launchId: "launch_52" }),
    spawn: async () => {
      throw new Error("a settled accepted launch must reconcile from durable state, never spawn again");
    },
  });

  const replay = await executeOrchestratorSeatRequest({
    project: "proj-a",
    mandate: "own the board",
    clientRequestId: "req_00000052",
    cwd: "/tmp",
  }, deps);

  expect(replay).toMatchObject({ status: 200, body: { replayed: true, conversationId: NEW_ID } });
  expect(orchestratorSeatFor("proj-a").active).toMatchObject({ engine: "codex", model: "gpt-5.6-sol" });
});

test("a legacy pending seat recovers runtime metadata from its launch settlement", async () => {
  seedPendingLaunchIntent({
    clientRequestId: "req_legacy_pending",
    launchId: "launch_legacy_pending",
    legacyRuntimeShape: true,
  });
  const { deps } = dependencies({
    launchSettlement: () => ({
      kind: "settled",
      conversationId: NEW_ID,
      path: "/tmp/new.jsonl",
      launchId: "launch_legacy_pending",
      engine: "codex",
      model: "gpt-5.6-sol",
    }),
  });

  const replay = await executeOrchestratorSeatRequest({
    project: "proj-a",
    mandate: "own the board",
    clientRequestId: "req_legacy_pending",
    cwd: "/tmp",
  }, deps);

  expect(replay).toMatchObject({ status: 200, body: { replayed: true, conversationId: NEW_ID } });
  expect(orchestratorSeatFor("proj-a").active).toMatchObject({ engine: "codex", model: "gpt-5.6-sol" });
});

test("an unsettled legacy pending seat fails closed when runtime provenance is unavailable", async () => {
  seedPendingLaunchIntent({
    clientRequestId: "req_legacy_unknown",
    launchId: "launch_legacy_unknown",
    legacyRuntimeShape: true,
  });
  const { deps, recorded } = dependencies();

  const replay = await executeOrchestratorSeatRequest({
    project: "proj-a",
    mandate: "own the board",
    clientRequestId: "req_legacy_unknown",
    engine: "codex",
    model: "gpt-5.6-sol",
    cwd: "/tmp",
  }, deps);

  expect(replay).toMatchObject({
    status: 409,
    body: { code: "legacy_runtime_identity_unavailable" },
  });
  expect(recorded.spawns).toEqual([]);
  expect(orchestratorSeatFor("proj-a").pending?.intent.error).toContain("runtime identity");
});

test("a pending intent whose launch terminally failed records the failure and stops blocking a fresh designation", async () => {
  seedPendingLaunchIntent({ clientRequestId: "req_00000050", launchId: "launch_42" });

  const { deps } = dependencies({
    launchSettlement: () => ({ kind: "failed", error: "launch exited before a transcript materialized" }),
  });

  const result = await executeOrchestratorSeatRequest(spawnRequest("req_00000052"), deps);

  expect(result.status).toBe(200);
  const { active, pending, history } = orchestratorSeatFor("proj-a");
  expect(active?.conversationId).toBe(NEW_ID);
  expect(pending).toBeNull();
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    reason: "terminal_error",
    seat: { intent: { clientRequestId: "req_00000050", launchId: "launch_42", error: "launch exited before a transcript materialized" } },
  });
});

test("an unsettled accepted launch still returns 409 seat_intent_in_progress for a different key", async () => {
  seedPendingLaunchIntent({ clientRequestId: "req_00000050", launchId: "launch_42" });

  const { deps, recorded } = dependencies({
    launchSettlement: () => ({ kind: "unknown" }),
  });

  const blocked = await executeOrchestratorSeatRequest(spawnRequest("req_00000053"), deps);

  expect(blocked).toMatchObject({ status: 409, body: { code: "seat_intent_in_progress" } });
  expect(recorded.spawns).toEqual([]);
  expect(orchestratorSeatFor("proj-a").pending?.intent.clientRequestId).toBe("req_00000050");
});

test("validation refuses a missing project, empty mandate, and malformed request id", async () => {
  const { deps } = dependencies();
  expect((await executeOrchestratorSeatRequest({ mandate: "m", clientRequestId: "req_00000007" }, deps)).status).toBe(400);
  expect((await executeOrchestratorSeatRequest({ project: "proj-a", mandate: "  ", clientRequestId: "req_00000007" }, deps)).status).toBe(400);
  expect((await executeOrchestratorSeatRequest({ project: "proj-a", mandate: "m", clientRequestId: "no" }, deps)).status).toBe(400);
});

test("spawn-mode seat creation rejects an explicit model outside the engine catalog before intent or spawn", async () => {
  const { deps, recorded } = dependencies();
  const result = await executeOrchestratorSeatRequest({
    ...spawnRequest(),
    engine: "codex",
    model: "gpt-5.6-codex",
  }, deps);

  expect(result).toEqual({
    status: 400,
    body: { error: "invalid codex model id \"gpt-5.6-codex\"; valid codex model ids: gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna" },
  });
  expect(recorded.spawns).toEqual([]);
  expect(orchestratorSeatFor("proj-a")).toMatchObject({ active: null, pending: null });
});

/* Issue #903: a spawn falling back to the server's own working directory
   minted seats in /app — outside every scanner root — that held authority
   while permanently inert. */
test("spawn mode without a cwd fails closed instead of inheriting the server process directory", async () => {
  const previous = process.env.LLV_ORCHESTRATOR_CWD;
  delete process.env.LLV_ORCHESTRATOR_CWD;
  try {
    const { deps, recorded } = dependencies();
    const request: Record<string, unknown> = { ...spawnRequest("req_00000201") };
    delete request.cwd;
    const result = await executeOrchestratorSeatRequest(request, deps);
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("cwd_unresolved");
    expect(recorded.spawns).toHaveLength(0);
    expect(orchestratorSeatFor("proj-a").active).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.LLV_ORCHESTRATOR_CWD;
    else process.env.LLV_ORCHESTRATOR_CWD = previous;
  }
});

test("spawn mode without a cwd honors the operator override", async () => {
  const previous = process.env.LLV_ORCHESTRATOR_CWD;
  process.env.LLV_ORCHESTRATOR_CWD = "/operator/checkout";
  try {
    const { deps, recorded } = dependencies();
    const request: Record<string, unknown> = { ...spawnRequest("req_00000202") };
    delete request.cwd;
    const result = await executeOrchestratorSeatRequest(request, deps);
    expect(result.status).toBe(200);
    expect(recorded.spawns[0]).toMatchObject({ cwd: "/operator/checkout" });
  } finally {
    if (previous === undefined) delete process.env.LLV_ORCHESTRATOR_CWD;
    else process.env.LLV_ORCHESTRATOR_CWD = previous;
  }
});

test("rotation without a cwd continues in the predecessor's checkout", async () => {
  const previous = process.env.LLV_ORCHESTRATOR_CWD;
  delete process.env.LLV_ORCHESTRATOR_CWD;
  try {
    const { deps, recorded } = dependencies();
    const seeded = await executeOrchestratorSeatRequest(spawnRequest("req_00000203"), deps);
    expect(seeded.status).toBe(200);
    const rotated = await executeOrchestratorRotation({
      project: "proj-a",
      clientRequestId: "req_00000204",
    }, deps);
    expect(rotated.status).toBe(200);
    expect(recorded.spawns).toHaveLength(2);
    expect(recorded.spawns[1]).toMatchObject({ cwd: "/workspace" });
  } finally {
    if (previous === undefined) delete process.env.LLV_ORCHESTRATOR_CWD;
    else process.env.LLV_ORCHESTRATOR_CWD = previous;
  }
});

test("rotation rejects an explicit successor model outside the engine catalog before spawning", async () => {
  const { deps, recorded } = dependencies();
  expect((await executeOrchestratorSeatRequest(spawnRequest("req_00000205"), deps)).status).toBe(200);

  const rotated = await executeOrchestratorRotation({
    project: "proj-a",
    clientRequestId: "req_00000206",
    engine: "claude",
    model: "claude-fable-5",
  }, deps);

  expect(rotated.status).toBe(400);
  expect(rotated.body.error).toBe("invalid claude model id \"claude-fable-5\"; valid claude model ids: opus, fable, sonnet, haiku");
  expect(recorded.spawns).toHaveLength(1);
  expect(orchestratorSeatFor("proj-a")).toMatchObject({ active: { conversationId: NEW_ID }, pending: null });
});

/* Issue #1067: rotation used to append a fresh handoff to the incumbent's FULL
   mandate, so handoffs stacked verbatim until the designation crossed the
   32000-byte structured envelope and died pending forever. Everything below
   pins the bounded composition that replaced it. */

/** Invented conversation ids, assembled from parts so no id-shaped literal
    enters a public artifact. */
const successorId = (index: number): string =>
  `conversation_${"5".repeat(8)}-${"5".repeat(4)}-4${"5".repeat(3)}-8${"5".repeat(3)}-${String(index).padStart(12, "0")}`;

const handoffToken = (index: number): string => `handoff-note-${String(index).padStart(2, "0")}`;

/** One prior handoff section in the exact shape rotation writes them. */
function handoffSection(index: number): string {
  return [
    HANDOFF_HEADING,
    `You are replacing orchestrator conversation ${OLD_ID} for project proj-a. Its manager authority is revoked.`,
    "No open board tasks are recorded for this project.",
    `Notes from the caller:\n${handoffToken(index)}`,
  ].join("\n\n");
}

function stackedMandate(core: string, count: number): string {
  return [core, ...Array.from({ length: count }, (_, index) => handoffSection(index + 1))].join("\n\n");
}

/** What spawn mode actually asserts against the envelope: the orchestrator
    role scaffold, a blank line, and the mandate. */
function launchBytes(prompt: string): number {
  const role = resolveSpawnRole({ role: "orchestrator", roleParams: { mode: "standard" } });
  const scaffold = role.ok && role.value ? role.value.scaffold : "";
  return Buffer.byteLength(`${scaffold}\n\n${prompt}`, "utf8");
}

function historySection(mandate: string): string {
  const start = mandate.indexOf(HISTORY_HEADING);
  if (start < 0) return "";
  const end = mandate.indexOf(HANDOFF_HEADING, start);
  return mandate.slice(start, end < 0 ? undefined : end).trim();
}

async function seatIncumbent(mandate: string, clientRequestId: string): Promise<void> {
  const { deps } = dependencies();
  const seeded = await executeOrchestratorSeatRequest({ ...spawnRequest(clientRequestId), mandate }, deps);
  expect(seeded.status).toBe(200);
}

test("AC1: three stacked handoffs compact into ONE rotation history section", async () => {
  const core = "own the board";
  await seatIncumbent(stackedMandate(core, 3), "req_00001001");

  const successor = successorId(1);
  const { deps, recorded } = dependencies({
    spawn: async (body) => {
      recorded.spawns.push(body);
      return { status: 200, body: { ok: true, conversationId: successor, path: "/tmp/successor.jsonl" } };
    },
    summarizeHandoffs: async (request) => {
      recorded.digests.push(request);
      return { kind: "digest", text: "Decisions:\n- kept the digest token" };
    },
  });

  const rotated = await executeOrchestratorRotation({ project: "proj-a", clientRequestId: "req_00001002" }, deps);

  expect(rotated.status).toBe(200);
  const prompt = String(recorded.spawns[0]!.prompt);
  expect(prompt).toStartWith(core);
  /* Exactly one of each section, and the stacked bodies are gone. */
  expect(prompt.split(HISTORY_HEADING)).toHaveLength(2);
  expect(prompt.split(HANDOFF_HEADING)).toHaveLength(2);
  expect(prompt).toContain("kept the digest token");
  for (const index of [1, 2, 3]) expect(prompt).not.toContain(handoffToken(index));
  /* The summarizer saw every prior handoff and the predecessor's transcript. */
  expect(recorded.digests).toHaveLength(1);
  expect(recorded.digests[0]).toMatchObject({
    project: "proj-a",
    priorHistory: null,
    predecessor: { path: "/tmp/3333.jsonl", engine: "claude" },
  });
  expect(recorded.digests[0]!.priorHandoffs).toHaveLength(3);
  /* The STORED successor mandate has the same shape, so the next rotation
     starts from a compact base rather than a growing one. */
  const stored = orchestratorSeatFor("proj-a").active!.mandate;
  expect(stored.split(HISTORY_HEADING)).toHaveLength(2);
  expect(stored.split(HANDOFF_HEADING)).toHaveLength(2);
  expect(rotated.body.handoff).toMatchObject({ history: "digest", reason: null, historyDropped: false });
});

test("AC1: the desktop draft's explicit stacked mandate compacts the same way", async () => {
  const core = "own the board";
  await seatIncumbent("own the board", "req_00001005");

  const { deps, recorded } = dependencies({
    spawn: async (body) => {
      recorded.spawns.push(body);
      return { status: 200, body: { ok: true, conversationId: successorId(2), path: "/tmp/successor.jsonl" } };
    },
    summarizeHandoffs: async (request) => {
      recorded.digests.push(request);
      return { kind: "digest", text: "Decisions:\n- digest from the posted draft" };
    },
  });

  /* The rotate draft prefills its textarea from the stored mandate, so the
     stacked text usually arrives in the REQUEST, not from the store. */
  const rotated = await executeOrchestratorRotation({
    project: "proj-a",
    clientRequestId: "req_00001006",
    mandate: stackedMandate(core, 3),
  }, deps);

  expect(rotated.status).toBe(200);
  const prompt = String(recorded.spawns[0]!.prompt);
  expect(prompt).toStartWith(core);
  expect(prompt.split(HISTORY_HEADING)).toHaveLength(2);
  expect(prompt.split(HANDOFF_HEADING)).toHaveLength(2);
  expect(prompt).toContain("digest from the posted draft");
  for (const index of [1, 2, 3]) expect(prompt).not.toContain(handoffToken(index));
  expect(recorded.digests[0]!.priorHandoffs).toHaveLength(3);
});

test("AC1: a second rotation feeds the previous digest and only the newest handoff to the summarizer", async () => {
  await seatIncumbent(stackedMandate("own the board", 2), "req_00001010");

  const first = dependencies({
    spawn: async () => ({ status: 200, body: { ok: true, conversationId: successorId(3), path: "/tmp/successor-1.jsonl" } }),
    summarizeHandoffs: async () => ({ kind: "digest", text: "Decisions:\n- first generation digest" }),
  });
  expect((await executeOrchestratorRotation({ project: "proj-a", clientRequestId: "req_00001011" }, first.deps)).status).toBe(200);

  const second = dependencies({
    spawn: async () => ({ status: 200, body: { ok: true, conversationId: successorId(4), path: "/tmp/successor-2.jsonl" } }),
    summarizeHandoffs: async (request) => {
      second.recorded.digests.push(request);
      return { kind: "digest", text: "Decisions:\n- second generation digest" };
    },
  });
  const rotated = await executeOrchestratorRotation({ project: "proj-a", clientRequestId: "req_00001012" }, second.deps);

  expect(rotated.status).toBe(200);
  expect(second.recorded.digests).toHaveLength(1);
  expect(second.recorded.digests[0]!.priorHistory).toContain("first generation digest");
  /* Only the previous rotation's own handoff is left to summarize — the older
     ones live inside the digest now. */
  expect(second.recorded.digests[0]!.priorHandoffs).toHaveLength(1);
});

test("AC1: a first rotation renders no history section and never calls the summarizer", async () => {
  await seatIncumbent("own the board", "req_00001015");

  const { deps, recorded } = dependencies({
    spawn: async (body) => {
      recorded.spawns.push(body);
      return { status: 200, body: { ok: true, conversationId: successorId(5), path: "/tmp/successor.jsonl" } };
    },
  });
  const rotated = await executeOrchestratorRotation({ project: "proj-a", clientRequestId: "req_00001016" }, deps);

  expect(rotated.status).toBe(200);
  expect(recorded.digests).toEqual([]);
  expect(String(recorded.spawns[0]!.prompt)).not.toContain(HISTORY_HEADING);
  expect(rotated.body.handoff).toMatchObject({ history: "none", reason: null, historyDropped: false });
});

test("AC3: a failed summarizer falls back to the latest two handoffs, verbatim and within budget", async () => {
  await seatIncumbent(stackedMandate("own the board", 4), "req_00001020");

  const { deps, recorded } = dependencies({
    spawn: async (body) => {
      recorded.spawns.push(body);
      return { status: 200, body: { ok: true, conversationId: successorId(6), path: "/tmp/successor.jsonl" } };
    },
    summarizeHandoffs: async () => ({ kind: "fallback", reason: "timeout" }),
  });

  const rotated = await executeOrchestratorRotation({ project: "proj-a", clientRequestId: "req_00001021" }, deps);

  expect(rotated.status).toBe(200);
  const prompt = String(recorded.spawns[0]!.prompt);
  expect(prompt).toContain(handoffToken(4));
  expect(prompt).toContain(handoffToken(3));
  expect(prompt).not.toContain(handoffToken(1));
  expect(prompt).not.toContain(handoffToken(2));
  expect(prompt.split(HISTORY_HEADING)).toHaveLength(2);
  expect(prompt.split(HANDOFF_HEADING)).toHaveLength(2);
  expect(Buffer.byteLength(historySection(prompt), "utf8"))
    .toBeLessThanOrEqual(HISTORY_BUDGET_BYTES + Buffer.byteLength(`${HISTORY_HEADING}\n`, "utf8"));
  expect(rotated.body.handoff).toMatchObject({ history: "fallback", reason: "timeout", historyDropped: false });
});

test("AC3: a throwing summarizer never blocks the rotation", async () => {
  await seatIncumbent(stackedMandate("own the board", 2), "req_00001025");

  const { deps, recorded } = dependencies({
    spawn: async (body) => {
      recorded.spawns.push(body);
      return { status: 200, body: { ok: true, conversationId: successorId(7), path: "/tmp/successor.jsonl" } };
    },
    summarizeHandoffs: async () => { throw new Error("headless runner is unreachable"); },
  });

  const rotated = await executeOrchestratorRotation({ project: "proj-a", clientRequestId: "req_00001026" }, deps);

  expect(rotated.status).toBe(200);
  expect(rotated.body.handoff).toMatchObject({ history: "fallback", reason: "error" });
  expect(String(recorded.spawns[0]!.prompt)).toContain(handoffToken(2));
  expect(orchestratorSeatFor("proj-a").active?.conversationId).toBe(successorId(7));
});

test("AC4: an oversized mandate is refused with an actionable 413 before any intent exists", async () => {
  const { deps, recorded } = dependencies();
  const oversized = "x".repeat(MAX_STRUCTURED_TEXT_BYTES);

  const spawnMode = await executeOrchestratorSeatRequest({ ...spawnRequest("req_00001030"), mandate: oversized }, deps);

  expect(spawnMode.status).toBe(413);
  expect(spawnMode.body).toMatchObject({ code: "mandate_too_large", bound: MAX_STRUCTURED_TEXT_BYTES });
  expect(Number(spawnMode.body.overhead)).toBeGreaterThan(0);
  expect(Number(spawnMode.body.excess))
    .toBe(Number(spawnMode.body.bytes) + Number(spawnMode.body.overhead) - MAX_STRUCTURED_TEXT_BYTES);
  expect(String(spawnMode.body.error)).toContain("shorten the mandate by at least");
  /* Nothing was attempted and nothing is pending: the mandate never became a
     durable intent that would fail delivery on every retry. */
  expect(recorded.spawns).toEqual([]);
  expect(orchestratorSeatFor("proj-a")).toMatchObject({ active: null, pending: null });

  const existingMode = await executeOrchestratorSeatRequest({
    project: "proj-a",
    mandate: oversized,
    clientRequestId: "req_00001031",
    conversationId: OLD_ID,
  }, deps);

  /* Existing-mode delivery asserts the text alone, so it carries no overhead. */
  expect(existingMode.status).toBe(413);
  expect(existingMode.body).toMatchObject({ code: "mandate_too_large", overhead: 0 });
  expect(recorded.deliveries).toEqual([]);
  expect(orchestratorSeatFor("proj-a").pending).toBeNull();
});

test("AC4: rotation drops the history, then trims the notes, and refuses only when the core alone cannot be delivered", async () => {
  await seatIncumbent("own the board", "req_00001035");

  const { deps, recorded } = dependencies({
    spawn: async (body) => {
      recorded.spawns.push(body);
      return { status: 200, body: { ok: true, conversationId: successorId(8), path: "/tmp/successor.jsonl" } };
    },
    summarizeHandoffs: async () => ({ kind: "digest", text: "d".repeat(4_000) }),
  });

  const trimmed = await executeOrchestratorRotation({
    project: "proj-a",
    clientRequestId: "req_00001036",
    mandate: stackedMandate("c".repeat(29_000), 2),
    handoffNotes: "n".repeat(2_000),
  }, deps);

  expect(trimmed.status).toBe(200);
  const prompt = String(recorded.spawns[0]!.prompt);
  expect(prompt).not.toContain(HISTORY_HEADING);
  expect(prompt).toContain("…[truncated]");
  expect(launchBytes(prompt)).toBeLessThanOrEqual(MAX_STRUCTURED_TEXT_BYTES);
  expect(trimmed.body.handoff).toMatchObject({ history: "digest", historyDropped: true });
  expect(Number((trimmed.body.handoff as Record<string, unknown>).notesTruncatedTo)).toBeLessThan(2_000);

  /* A core that leaves no room for even a minimal handoff is refused outright
     — with the incumbent still seated and nothing pending. */
  const seatedBefore = orchestratorSeatFor("proj-a").active?.conversationId;
  const refused = await executeOrchestratorRotation({
    project: "proj-a",
    clientRequestId: "req_00001037",
    mandate: "c".repeat(31_000),
  }, deps);

  expect(refused.status).toBe(413);
  expect(refused.body).toMatchObject({ code: "mandate_too_large", bound: MAX_STRUCTURED_TEXT_BYTES });
  expect(refused.body.rotatedFrom).toMatchObject({ conversationId: seatedBefore });
  expect(recorded.spawns).toHaveLength(1);
  const { active, pending } = orchestratorSeatFor("proj-a");
  expect(pending).toBeNull();
  expect(active?.conversationId).toBe(seatedBefore);
});

test("AC5: a designation whose delivery fails is terminal and the next rotation clears it", async () => {
  await seatIncumbent("own the board", "req_00001040");

  const envelopeError = "structured message text exceeds the 32000-byte envelope bound";
  const failing = dependencies({
    spawn: async () => ({ status: 413, body: { error: envelopeError } }),
  });
  const failed = await executeOrchestratorRotation({ project: "proj-a", clientRequestId: "req_00001041" }, failing.deps);

  expect(failed.status).toBe(413);
  expect(orchestratorSeatFor("proj-a").pending?.intent.error).toBe(envelopeError);
  expect(orchestratorSeatFor("proj-a").active?.conversationId).toBe(NEW_ID);

  const successor = successorId(9);
  const healthy = dependencies({
    spawn: async () => ({ status: 200, body: { ok: true, conversationId: successor, path: "/tmp/successor.jsonl" } }),
  });
  const rotated = await executeOrchestratorRotation({ project: "proj-a", clientRequestId: "req_00001042" }, healthy.deps);

  expect(rotated.status).toBe(200);
  const { active, pending, history } = orchestratorSeatFor("proj-a");
  expect(active?.conversationId).toBe(successor);
  /* No dead banner survives: the failed intent is terminalized into history. */
  expect(pending).toBeNull();
  expect(history[0]).toMatchObject({
    reason: "terminal_error",
    seat: { intent: { clientRequestId: "req_00001041", error: envelopeError } },
  });
});

test("AC5: an existing-mode designation whose delivery fails is cleared by the next create", async () => {
  await seatIncumbent("own the board", "req_00001045");

  const failing = dependencies({ deliver: async () => ({ ok: false, error: "host is dead" }) });
  const failed = await executeOrchestratorSeatRequest({
    project: "proj-a",
    mandate: "adopt me",
    clientRequestId: "req_00001046",
    conversationId: OLD_ID,
  }, failing.deps);

  expect(failed.status).toBe(502);
  expect(orchestratorSeatFor("proj-a").pending?.intent.error).toBe("host is dead");

  const { deps } = dependencies();
  const created = await executeOrchestratorSeatRequest({
    project: "proj-a",
    mandate: "adopt me properly",
    clientRequestId: "req_00001047",
    conversationId: OLD_ID,
  }, deps);

  expect(created.status).toBe(200);
  const { active, pending, history } = orchestratorSeatFor("proj-a");
  expect(active?.conversationId).toBe(OLD_ID);
  expect(pending).toBeNull();
  expect(history[0]).toMatchObject({ reason: "terminal_error", seat: { intent: { clientRequestId: "req_00001046" } } });
});

/* A 5xx or a lost response classifies AMBIGUOUS client-side, so the draft KEEPS
   its key and retries with it (`classifySeatFailure` in seatState.ts). That
   retry used to hit the errored intent's same-key replay, which re-sent the
   STORED mandate — the very text that had just failed — and left the failed row
   in the blocking pending position: the permanent banner from the incident. */

test("AC5: retrying a failed rotation with its OWN key delivers the recomposed mandate, not the one that failed", async () => {
  await seatIncumbent(stackedMandate("own the board", 3), "req_00001060");

  const envelopeError = "structured message text exceeds the 32000-byte envelope bound";
  const failing = dependencies({
    spawn: async (body) => {
      failing.recorded.spawns.push(body);
      return { status: 502, body: { error: envelopeError } };
    },
  });
  const failed = await executeOrchestratorRotation({
    project: "proj-a",
    clientRequestId: "req_00001061",
    handoffNotes: "first attempt",
  }, failing.deps);

  expect(failed.status).toBe(502);
  expect(orchestratorSeatFor("proj-a").pending?.intent.error).toBe(envelopeError);

  const successor = successorId(11);
  const retry = dependencies({
    spawn: async (body) => {
      retry.recorded.spawns.push(body);
      return { status: 200, body: { ok: true, conversationId: successor, path: "/tmp/successor.jsonl" } };
    },
  });
  const rotated = await executeOrchestratorRotation({
    project: "proj-a",
    clientRequestId: "req_00001061",
    handoffNotes: "second attempt",
  }, retry.deps);

  expect(rotated.status).toBe(200);
  /* Recomposed, not replayed: the spawned prompt carries THIS attempt's notes,
     one history section and one handoff — the stored mandate is gone. */
  expect(retry.recorded.spawns).toHaveLength(1);
  const prompt = String(retry.recorded.spawns[0]!.prompt);
  expect(prompt).toContain("second attempt");
  expect(prompt).not.toContain("first attempt");
  expect(prompt.split(HANDOFF_HEADING)).toHaveLength(2);
  expect(prompt.split(HISTORY_HEADING)).toHaveLength(2);

  const { active, pending, history } = orchestratorSeatFor("proj-a");
  expect(active?.conversationId).toBe(successor);
  expect(pending).toBeNull();
  expect(history).toMatchObject([{ reason: "terminal_error", seat: { intent: { clientRequestId: "req_00001061", error: envelopeError } } }]);
});

test("AC5: retrying a failed existing-mode designation with its OWN key clears it and delivers the edited mandate", async () => {
  await seatIncumbent("own the board", "req_00001065");

  const failing = dependencies({ deliver: async () => ({ ok: false, error: "host is dead" }) });
  const failed = await executeOrchestratorSeatRequest({
    project: "proj-a",
    mandate: "adopt me",
    clientRequestId: "req_00001066",
    conversationId: OLD_ID,
  }, failing.deps);

  expect(failed.status).toBe(502);
  expect(orchestratorSeatFor("proj-a").pending?.intent.error).toBe("host is dead");

  const { deps, recorded } = dependencies();
  const retried = await executeOrchestratorSeatRequest({
    project: "proj-a",
    mandate: "adopt me, corrected",
    clientRequestId: "req_00001066",
    conversationId: OLD_ID,
  }, deps);

  expect(retried.status).toBe(200);
  expect(recorded.deliveries).toHaveLength(1);
  expect(recorded.deliveries[0]!.text).toContain("adopt me, corrected");
  /* Exactly-once survives the fresh intent: the message id is derived from the
     key, so a first delivery that actually landed is still deduplicated. */
  expect(recorded.deliveries[0]!.clientMessageId).toBe("orchmandate_req_00001066");

  const { active, pending, history } = orchestratorSeatFor("proj-a");
  expect(active?.conversationId).toBe(OLD_ID);
  expect(active?.mandate).toContain("adopt me, corrected");
  expect(pending).toBeNull();
  expect(history).toMatchObject([{ reason: "terminal_error", seat: { intent: { clientRequestId: "req_00001066" } } }]);
});

/** Twelve rotations, each with the maximum handoff payload the caps allow. */
async function rotateTwelveTimes(
  project: string,
  summarizeHandoffs: SeatCommandDependencies["summarizeHandoffs"],
): Promise<string[]> {
  const seeded = dependencies({
    conversationTarget: (conversationId) => ({ kind: "eligible", conversationId, path: "/tmp/incumbent.jsonl", cwd: "/workspace", project, engine: "claude" }),
  });
  const created = await executeOrchestratorSeatRequest({
    ...spawnRequest(`req_${project}_seed_0001`),
    project,
    mandate: ORCHESTRATOR_SYSTEM_PROMPT,
  }, seeded.deps);
  expect(created.status).toBe(200);

  const prompts: string[] = [];
  for (let rotation = 1; rotation <= 12; rotation += 1) {
    const { deps } = dependencies({
      conversationTarget: (conversationId) => ({ kind: "eligible", conversationId, path: "/tmp/incumbent.jsonl", cwd: "/workspace", project, engine: "claude" }),
      spawn: async (body) => {
        prompts.push(String(body.prompt));
        return { status: 200, body: { ok: true, conversationId: successorId(100 + rotation), path: "/tmp/successor.jsonl" } };
      },
      projectTasks: () => Array.from({ length: 12 }, (_, index) => ({
        id: `task_${index + 1}`,
        status: "doing",
        text: "t".repeat(200),
      })),
      summarizeHandoffs,
    });
    const rotated = await executeOrchestratorRotation({
      project,
      clientRequestId: `req_${project}_rot_${String(rotation).padStart(4, "0")}`,
      handoffNotes: "n".repeat(2_000),
    }, deps);
    expect(rotated.status).toBe(200);
  }
  return prompts;
}

test("AC6: twelve rotations keep every successor mandate inside the structured envelope", async () => {
  const summarized = await rotateTwelveTimes("proj-a", async () => ({ kind: "digest", text: "d".repeat(3_800) }));
  const fellBack = await rotateTwelveTimes("proj-b", async () => ({ kind: "fallback", reason: "exhausted" }));

  expect(summarized).toHaveLength(12);
  expect(fellBack).toHaveLength(12);
  for (const prompt of [...summarized, ...fellBack]) {
    expect(launchBytes(prompt)).toBeLessThanOrEqual(MAX_STRUCTURED_TEXT_BYTES);
    expect(prompt.split(HANDOFF_HEADING)).toHaveLength(2);
  }
  /* The first rotation has nothing to compact; every later one carries exactly
     one history section however many rotations preceded it. */
  for (const prompt of [...summarized.slice(1), ...fellBack.slice(1)]) {
    expect(prompt.split(HISTORY_HEADING)).toHaveLength(2);
  }
});

test("a rotation whose summarizer is slow cannot revoke the designation that settled while it waited", async () => {
  await seatIncumbent(stackedMandate("own the board", 2), "req_00001200");
  const superseded = orchestratorSeatFor("proj-a").active!;

  let enterSummarizer = (): void => {};
  const entered = new Promise<void>((resolve) => { enterSummarizer = resolve; });
  let releaseSummarizer = (): void => {};
  const released = new Promise<void>((resolve) => { releaseSummarizer = resolve; });

  const stale = dependencies({
    spawn: async (body) => {
      stale.recorded.spawns.push(body);
      return { status: 200, body: { ok: true, conversationId: successorId(20), path: "/tmp/stale-successor.jsonl" } };
    },
    summarizeHandoffs: async (request) => {
      stale.recorded.digests.push(request);
      enterSummarizer();
      await released;
      return { kind: "digest", text: "Decisions:\n- composed against the superseded incumbent" };
    },
  });
  const rotating = executeOrchestratorRotation({ project: "proj-a", clientRequestId: "req_00001201" }, stale.deps);
  await entered;

  /* A newer designation settles WHILE the rotation is parked in its summarizer,
     so the rotation's incumbent, its mandate and its handoff are all stale. */
  const newer = dependencies({
    spawn: async () => ({ status: 200, body: { ok: true, conversationId: successorId(21), path: "/tmp/newer.jsonl" } }),
  });
  const seated = await executeOrchestratorSeatRequest({
    ...spawnRequest("req_00001202"),
    mandate: "own the board, freshly designated",
    replaceIncumbent: true,
  }, newer.deps);
  expect(seated.status).toBe(200);

  releaseSummarizer();
  const rotated = await rotating;

  /* Refused with the conflict, not silently applied on top of the newer seat. */
  expect(rotated.status).toBe(409);
  expect(rotated.body).toMatchObject({
    code: "incumbent_changed",
    currentConversationId: successorId(21),
    rotatedFrom: { conversationId: superseded.conversationId, seatEpoch: superseded.seatEpoch },
  });
  /* No successor was spawned for it and no intent is left pending. */
  expect(stale.recorded.spawns).toEqual([]);
  expect(orchestratorSeatFor("proj-a").pending).toBeNull();
  /* The newer orchestrator still holds the seat, unrevoked. */
  const active = orchestratorSeatFor("proj-a").active!;
  expect(active.conversationId).toBe(successorId(21));
  expect(active.seatEpoch).toBeGreaterThan(superseded.seatEpoch);
  expect(activeOrchestratorSeats().map((seat) => seat.conversationId)).toEqual([successorId(21)]);
  expect(orchestratorRevocations().some((revocation) => revocation.conversationId === successorId(21))).toBeFalse();
  /* Rotating again recomposes from the seated orchestrator and succeeds. */
  const retried = dependencies({
    spawn: async (body) => {
      retried.recorded.spawns.push(body);
      return { status: 200, body: { ok: true, conversationId: successorId(22), path: "/tmp/retried.jsonl" } };
    },
  });
  const second = await executeOrchestratorRotation({ project: "proj-a", clientRequestId: "req_00001203" }, retried.deps);
  expect(second.status).toBe(200);
  expect(String(retried.recorded.spawns[0]!.prompt)).toStartWith("own the board, freshly designated");
  expect(orchestratorSeatFor("proj-a").active!.conversationId).toBe(successorId(22));
});

/** A second designation already in flight beside the seated incumbent: its
    launch was accepted, but the request that accepted it never activated the
    intent, so only reconciliation can seat it. */
function seedPendingBesideIncumbent(input: { clientRequestId: string; launchId: string }): void {
  const file = path.join(sandbox, "orchestrator-seats.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8")) as { nextSeatEpoch: number; pending: Record<string, unknown> };
  state.pending["proj-a"] = {
    project: "proj-a",
    seatEpoch: state.nextSeatEpoch,
    conversationId: null,
    path: null,
    engine: "claude",
    model: "opus",
    runtimeIdentityFrozen: true,
    mandate: "own the board, freshly designated",
    promptVersion: null,
    predecessorConversationId: null,
    state: "pending",
    intent: { clientRequestId: input.clientRequestId, mode: "spawn", launchId: input.launchId, error: null },
    designatedAt: AT,
    activatedAt: null,
  };
  state.nextSeatEpoch += 1;
  fs.writeFileSync(file, JSON.stringify(state), "utf8");
}

test("a pending launch that settles DURING summarization is seated, and the stale rotation cannot replace it", async () => {
  await seatIncumbent(stackedMandate("own the board", 2), "req_00001210");
  const superseded = orchestratorSeatFor("proj-a").active!;
  const newer = successorId(30);
  seedPendingBesideIncumbent({ clientRequestId: "req_00001211", launchId: "launch_newer" });

  /* The settlement flips exactly once, inside the summarizer: UNKNOWN when the
     rotation reconciles and reads its incumbent, SETTLED by the time it
     composes. No timers, no interleaved requests — just the durable receipt
     changing under a rotation that is parked on an await. */
  let summarized = false;
  const stale = dependencies({
    spawn: async (body) => {
      stale.recorded.spawns.push(body);
      return { status: 200, body: { ok: true, conversationId: successorId(31), path: "/tmp/stale-successor.jsonl" } };
    },
    summarizeHandoffs: async (request) => {
      stale.recorded.digests.push(request);
      summarized = true;
      return { kind: "digest", text: "Decisions:\n- composed against the superseded incumbent" };
    },
    launchSettlement: () => (summarized
      ? { kind: "settled", conversationId: newer, path: "/tmp/newer.jsonl", launchId: "launch_newer" }
      : { kind: "unknown" }),
  });

  const rotated = await executeOrchestratorRotation({ project: "proj-a", clientRequestId: "req_00001212" }, stale.deps);

  expect(rotated.status).toBe(409);
  expect(rotated.body).toMatchObject({
    code: "incumbent_changed",
    rotatedFrom: { conversationId: superseded.conversationId, seatEpoch: superseded.seatEpoch },
  });
  /* Nothing was spawned for the stale rotation and no intent is left pending. */
  expect(stale.recorded.spawns).toEqual([]);
  expect(orchestratorSeatFor("proj-a").pending).toBeNull();
  /* The reconciled designation holds the seat, unrevoked. */
  const active = orchestratorSeatFor("proj-a").active!;
  expect(active.conversationId).toBe(newer);
  expect(active.seatEpoch).toBeGreaterThan(superseded.seatEpoch);
  expect(activeOrchestratorSeats().map((seat) => seat.conversationId)).toEqual([newer]);
  expect(orchestratorRevocations().some((revocation) => revocation.conversationId === newer)).toBeFalse();
});
