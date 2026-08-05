import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry } from "@/lib/agent/registry";

import {
  ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE,
  ORCHESTRATOR_PROMPT_VERSION,
  ORCHESTRATOR_SYSTEM_PROMPT,
} from "./prompt";
import { setRetireManagerForTests } from "./retire";
import { executeOrchestratorRotation, executeOrchestratorSeatRequest, type SeatCommandDependencies } from "./seatCommand";
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
  identityStamps: OrchestratorSeat[];
}

function dependencies(overrides: Partial<SeatCommandDependencies> = {}): { deps: SeatCommandDependencies; recorded: Recorded } {
  const recorded: Recorded = { spawns: [], deliveries: [], identityStamps: [] };
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
    }),
    stampRegistryIdentity: (seat) => { recorded.identityStamps.push(seat); },
    projectTasks: () => [],
    launchSettlement: () => ({ kind: "unknown" }),
    now: () => AT,
    ...overrides,
  };
  return { deps, recorded };
}

/** Durable residue of an accepting request that died between begin and
    activate: a pending spawn intent holding the launch receipt id. */
function seedPendingLaunchIntent(input: { clientRequestId: string; launchId: string | null; error?: string | null }): void {
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
        ? { kind: "eligible", conversationId, path: path.join(sandbox, "existing.jsonl"), cwd: sandbox, project: "proj-a" }
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

test("a pending replay completes with the ORIGINAL mandate, not a recomposed one", async () => {
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
  /* The retry recomposes a different mandate; the durable intent's text wins. */
  await executeOrchestratorSeatRequest({ ...spawnRequest(), mandate: "recomposed differently" }, deps);
  const prompts = recorded.spawns.map((body) => String(body.prompt));
  expect(prompts[0]).toBe(prompts[1]);
  expect(prompts[0]).toStartWith("own the board");
  expect(prompts[0]!.split(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE)).toHaveLength(2);
  expect(prompts[0]).not.toContain("recomposed differently");
  expect(recorded.spawns.map((body) => body.title)).toEqual([
    "orchestrator · own the board",
    "orchestrator · own the board",
  ]);
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
