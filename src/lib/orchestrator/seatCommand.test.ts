import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { executeOrchestratorRotation, executeOrchestratorSeatRequest, type SeatCommandDependencies } from "./seatCommand";
import { orchestratorRevocations, orchestratorSeatFor } from "./seats";
import { readOrchestratorRecord } from "./store";

let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-command-"));
  process.env.LLV_STATE_DIR = sandbox;
});

afterEach(() => {
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
  legacySyncs: { conversationId: string }[];
  /** Ordinary-session mutations against either conversation. The two-axis
      contract requires this to stay EMPTY on every seat operation. */
  retired: string[];
}

function dependencies(overrides: Partial<SeatCommandDependencies> = {}): { deps: SeatCommandDependencies; recorded: Recorded } {
  const recorded: Recorded = { spawns: [], deliveries: [], legacySyncs: [], retired: [] };
  const deps: SeatCommandDependencies = {
    spawn: async (body) => {
      recorded.spawns.push(body);
      return { status: 200, body: { ok: true, state: "settled", conversationId: NEW_ID, path: "/tmp/new.jsonl", launchId: "launch_1" } };
    },
    deliver: async (input) => {
      recorded.deliveries.push({ conversationId: input.conversationId, clientMessageId: input.clientMessageId, text: input.text });
      return { ok: true, outcome: "delivered" };
    },
    conversationTarget: (conversationId) => ({ conversationId, path: `/tmp/${conversationId.slice(-4)}.jsonl` }),
    syncLegacyRecord: (input) => { recorded.legacySyncs.push({ conversationId: input.conversationId }); },
    projectTasks: () => [],
    now: () => AT,
    ...overrides,
  };
  return { deps, recorded };
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
    ["prompt"]: "own the board",
    clientAttemptId: "req_00000001",
  });
  const { active, pending } = orchestratorSeatFor("proj-a");
  expect(active?.conversationId).toBe(NEW_ID);
  expect(active?.mandate).toBe("own the board");
  expect(pending).toBeNull();
  expect(recorded.legacySyncs).toEqual([{ conversationId: NEW_ID }]);
});

test("a failed spawn leaves NEITHER half: no active seat, no legacy record, a recoverable pending intent", async () => {
  const { deps, recorded } = dependencies({
    spawn: async () => ({ status: 400, body: { error: "directory does not exist" } }),
  });
  const result = await executeOrchestratorSeatRequest(spawnRequest(), deps);
  expect(result.status).toBe(400);
  const { active, pending } = orchestratorSeatFor("proj-a");
  expect(active).toBeNull();
  expect(pending?.intent.error).toBe("directory does not exist");
  expect(recorded.legacySyncs).toEqual([]);
  expect(readOrchestratorRecord()).toBeNull();
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

test("selecting an EXISTING conversation delivers the mandate without spawning a duplicate", async () => {
  const { deps, recorded } = dependencies();
  const result = await executeOrchestratorSeatRequest({
    project: "proj-a",
    mandate: "updated mandate",
    clientRequestId: "req_00000002",
    conversationId: OLD_ID,
  }, deps);
  expect(result.status).toBe(200);
  expect(recorded.spawns).toHaveLength(0);
  expect(recorded.deliveries).toEqual([{
    conversationId: OLD_ID,
    clientMessageId: "orchmandate_req_00000002",
    text: "updated mandate",
  }]);
  expect(orchestratorSeatFor("proj-a").active?.conversationId).toBe(OLD_ID);
});

test("a failed delivery keeps the incumbent seated and reports a recoverable state", async () => {
  const { deps } = dependencies();
  await executeOrchestratorSeatRequest(spawnRequest(), deps);
  const { deps: failing, recorded } = dependencies({
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
  expect(recorded.legacySyncs).toEqual([]);
});

test("AXIS 1/2 SEPARATION: replacement revokes MANAGER-LEVEL authority only — the predecessor's session is never touched", async () => {
  const { deps, recorded } = dependencies();
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
     revocation is an axis-2 act, killing a session would be an axis-1 one. */
  expect(recorded.retired).toEqual([]);
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

test("rotation composes a bounded handoff, switches designation atomically, and links both cards", async () => {
  const { deps } = dependencies();
  await executeOrchestratorSeatRequest(spawnRequest(), deps);

  const SUCCESSOR = "conversation_55555555-5555-4555-8555-555555555555";
  const { deps: rotating, recorded } = dependencies({
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
  expect(recorded.retired).toEqual([]);
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
  expect(recorded.spawns.map((body) => body.prompt)).toEqual(["own the board", "own the board"]);
});

test("validation refuses a missing project, empty mandate, and malformed request id", async () => {
  const { deps } = dependencies();
  expect((await executeOrchestratorSeatRequest({ mandate: "m", clientRequestId: "req_00000007" }, deps)).status).toBe(400);
  expect((await executeOrchestratorSeatRequest({ project: "proj-a", mandate: "  ", clientRequestId: "req_00000007" }, deps)).status).toBe(400);
  expect((await executeOrchestratorSeatRequest({ project: "proj-a", mandate: "m", clientRequestId: "no" }, deps)).status).toBe(400);
});
