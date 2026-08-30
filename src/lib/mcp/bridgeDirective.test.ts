import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseBridgeTrailer } from "@/lib/bridge/directive";
import { bridgeAsksForSeats, recordManagerReport } from "@/lib/bridge/service";
import { drainBridgeReports, openBridgeChannel } from "@/lib/bridge/store";
import { authorizedManagerSeats } from "@/lib/orchestrator/authority";
import {
  activeOrchestratorSeats,
  beginOrchestratorSeatIntent,
  completeOrchestratorSeatIntent,
  orchestratorRevocations,
} from "@/lib/orchestrator/seats";
import { VIEWER_SPAWN_CAPABILITY_ENV, VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";

import { viewerMcpBindings, type ViewerControlDependencies } from "./bindings";

/**
 * Intent, flowing user -> voice -> manager, through production code (#691 §4).
 *
 * The gateway does not compose a directive id or address a recipient: it says what
 * the user asked for and which turn it belongs to, and this tool derives the rest.
 * That is what makes retry-after-a-lost-receipt safe — the id is a function of the
 * turn, so the manager's durable receipt recognizes the retry instead of taking the
 * instruction twice.
 */

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;
const originalSpawnCapability = process.env[VIEWER_SPAWN_CAPABILITY_ENV];

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  if (originalSpawnCapability === undefined) delete process.env[VIEWER_SPAWN_CAPABILITY_ENV];
  else process.env[VIEWER_SPAWN_CAPABILITY_ENV] = originalSpawnCapability;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

let posted: { pathname: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];

/** REAL seat activation through the durable store — the designation evidence
    routing actually reads. */
function seatProject(project: string, conversationId: string): void {
  beginOrchestratorSeatIntent({ project, mandate: "own the board", clientRequestId: `seed_${project}`, mode: "spawn" });
  completeOrchestratorSeatIntent({ project, clientRequestId: `seed_${project}`, conversationId, path: null });
}

/** The validated seat authority over the REAL store, with permissive registry
    facts — designation evidence is real, only the registry is stubbed. */
function realSeatAuthority() {
  return authorizedManagerSeats({
    activeSeats: activeOrchestratorSeats,
    revocations: orchestratorRevocations,
    conversationFacts: () => ({ superseded: false, hasGeneration: true, project: null }),
    resolveAlias: (id) => id,
  });
}

function sandbox(withManager = true): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-bridge-directive-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
  openBridgeChannel("root_directive");
  if (withManager) {
    /* The caller's own project holds the designated orchestrator. */
    seatProject("proj-voice", "conversation_manager");
  }
}

function bindings(
  callerProject: string | null = "proj-voice",
  canonicalSeatConversationId?: (conversationId: string) => string,
  /** What the delivery path answers. `delivered` is arrival; `queued` is
      acceptance, and the two must not settle a decision request alike. */
  deliveryOutcome: "delivered" | "queued" = "delivered",
) {
  posted = [];
  const control: ViewerControlDependencies = {
    async post(pathname, body, headers) {
      posted.push({ pathname, body, headers: headers ?? {} });
      return { outcome: deliveryOutcome, operationId: "op-1" };
    },
  };
  /* The caller's canonical project as the production resolver would derive it
     from the voice conversation's cwd through projectInfoFromCwd. */
  return viewerMcpBindings(undefined, control, {
    callerProject: () => callerProject,
    authorizedSeats: realSeatAuthority,
    ...(canonicalSeatConversationId ? { canonicalSeatConversationId } : {}),
  } as never);
}

test("a directive is addressed to the project's active seat regardless of a caller-supplied target", async () => {
  sandbox();
  process.env[VIEWER_SPAWN_CAPABILITY_ENV] = "d".repeat(43);
  const tools = bindings();
  const receipt = await tools.bridge_directive({
    clientRequestId: "ignored-by-the-derivation",
    rootTurnId: "turn_0199",
    utterance: 0,
    instruction: "start a reviewer on the auth branch",
    /* A gateway that tried to redirect its own relay must not be able to. */
    conversationId: "conversation_some_worker",
  });

  expect(posted).toHaveLength(1);
  expect(posted[0]!.body.conversationId).toBe("conversation_manager");
  expect(posted[0]!.headers[VIEWER_SPAWN_CAPABILITY_HEADER]).toBe("d".repeat(43));
  expect(receipt).toMatchObject({ managerConversationId: "conversation_manager" });
});

test("the delivery id is derived from the root turn, so a retry is one instruction", async () => {
  sandbox();
  const tools = bindings();
  const args = {
    clientRequestId: "d1",
    rootTurnId: "turn_0199",
    utterance: 0,
    instruction: "start a reviewer",
  };
  await tools.bridge_directive(args);
  await tools.bridge_directive({ ...args, clientRequestId: "a-different-request-id" });

  const keys = posted.map((call) => call.body.clientMessageId);
  expect(keys).toEqual(["bridge_d_turn_0199_0", "bridge_d_turn_0199_0"]);

  /* A second utterance in the same turn is a different instruction. */
  await tools.bridge_directive({ ...args, utterance: 1 });
  expect(posted.at(-1)!.body.clientMessageId).toBe("bridge_d_turn_0199_1");
});

test("the user's words travel as prose, with the correlation trailer on its own line", async () => {
  sandbox();
  const tools = bindings();
  recordManagerReport({
    key: "q1",
    class: "question",
    at: new Date().toISOString(),
    body: "merge #726 despite the flaky test?",
  });
  const seq = drainBridgeReports().reports.at(-1)!.seq;

  await tools.bridge_directive({
    clientRequestId: "d1",
    rootTurnId: "turn_0200",
    utterance: 0,
    instruction: "he says hold it until the test is fixed",
    ref: seq,
  });

  const body = String(posted[0]!.body.text);
  expect(body.startsWith("he says hold it until the test is fixed")).toBe(true);
  expect(parseBridgeTrailer(body)).toEqual({ ref: seq });
});

/**
 * #1168 — the trailer is what SETTLES the manager's open ask, so the relay path
 * has to record it against the seat it just delivered to. A report seq is
 * log-global: recorded on the number alone, one project's directive would close
 * another project's decision request.
 */
test("the trailer settles the ask of the seat this directive reached, and no other project's", async () => {
  sandbox();
  seatProject("proj-other", "conversation_manager_other");
  const tools = bindings();
  const asked = recordManagerReport({
    key: "lane-4-blocked",
    class: "blocked",
    at: new Date().toISOString(),
    project: "proj-voice",
    targetSeatConversationId: "conversation_manager",
    body: "cannot proceed: pick a base branch",
  });
  expect([...bridgeAsksForSeats().keys()]).toEqual(["conversation_manager"]);

  /* Delivered — and pointedly not settling the other project's report. */
  await tools.bridge_directive({
    clientRequestId: "d-cross",
    rootTurnId: "turn_cross",
    utterance: 0,
    instruction: "go ahead",
    project: "proj-other",
    ref: asked!.seq,
  });
  expect(posted).toHaveLength(1);
  expect(bridgeAsksForSeats().size).toBe(1);

  await tools.bridge_directive({
    clientRequestId: "d-answer",
    rootTurnId: "turn_answer",
    utterance: 0,
    instruction: "cut it from main",
    project: "proj-voice",
    ref: asked!.seq,
  });
  expect(bridgeAsksForSeats().size).toBe(0);
});

test("a directive that was only accepted leaves the ask standing, and says it is unsettled", async () => {
  /* #1131: `queued` means the runtime admitted the operation, not that the
     manager read anything. Recording the answer there cleared a pending
     decision that a dropped delivery means nobody ever saw — the ask vanished
     from the operator's card while the instruction behind it never arrived. */
  sandbox();
  const tools = bindings("proj-voice", undefined, "queued");
  const asked = recordManagerReport({
    key: "lane-9-blocked",
    class: "blocked",
    at: new Date().toISOString(),
    project: "proj-voice",
    targetSeatConversationId: "conversation_manager",
    body: "cannot proceed: pick a base branch",
  });
  expect(bridgeAsksForSeats().size).toBe(1);

  const receipt = await tools.bridge_directive({
    clientRequestId: "d-unsettled",
    rootTurnId: "turn_unsettled",
    utterance: 0,
    instruction: "cut it from main",
    project: "proj-voice",
    ref: asked!.seq,
  });

  expect(receipt).toMatchObject({ outcome: "queued", settled: false, operationId: "op-1" });
  /* Still open, and answerable by the operation id the receipt just returned. */
  expect(bridgeAsksForSeats().size).toBe(1);
});

test("a seat rekeyed since it asked is still the seat this directive settles (#1168 final review, HIGH 1)", async () => {
  /* The relay knows the seat only by the identity the seat authority hands it.
     The LOG knows it by whatever it was called when the report was routed, and
     a migration rekeys the conversation between those two moments. The
     attention projection already resolves the recorded id through the registry
     — so unless this path resolves both sides the same way, the rekey that put
     the ask on the operator's card is the rekey that made it unanswerable. */
  sandbox();
  const preMigrationSeatId = "conversation_manager_before_migration";
  const tools = bindings("proj-voice", (id) => (id === preMigrationSeatId ? "conversation_manager" : id));
  const asked = recordManagerReport({
    key: "lane-4-blocked",
    class: "blocked",
    at: new Date().toISOString(),
    project: "proj-voice",
    targetSeatConversationId: preMigrationSeatId,
    body: "cannot proceed: pick a base branch",
  });
  const resolver = (id: string) => (id === preMigrationSeatId ? "conversation_manager" : id);
  expect([...bridgeAsksForSeats({ canonicalConversationId: resolver }).keys()]).toEqual(["conversation_manager"]);

  await tools.bridge_directive({
    clientRequestId: "d-rekeyed",
    rootTurnId: "turn_rekeyed",
    utterance: 0,
    instruction: "cut it from main",
    project: "proj-voice",
    ref: asked!.seq,
  });

  expect(posted).toHaveLength(1);
  expect(bridgeAsksForSeats({ canonicalConversationId: resolver }).size).toBe(0);
});

test("with no orchestrator designated for the caller's project the directive is refused, not delivered somewhere else", async () => {
  sandbox(false);
  const tools = bindings();
  await expect(tools.bridge_directive({
    clientRequestId: "d1",
    rootTurnId: "turn_0203",
    utterance: 0,
    instruction: "start a reviewer",
  })).rejects.toThrow(/orchestrator|manager/i);
  expect(posted).toEqual([]);
});

test("a directive refuses input that would break its own id derivation", async () => {
  sandbox();
  const tools = bindings();
  for (const args of [
    { rootTurnId: "turn with spaces", utterance: 0, instruction: "go" },
    { rootTurnId: "turn_1", utterance: -1, instruction: "go" },
    { rootTurnId: "turn_1", utterance: 0, instruction: "   " },
  ]) {
    await expect(tools.bridge_directive({ clientRequestId: "d1", ...args })).rejects.toThrow();
  }
  expect(posted).toEqual([]);
});

/* ── MEDIUM 6 (#758 review): per-project directive routing ───────────────── */

/* A directive carrying `project` resolves through validated per-project seat
   authority, so seating project B never redirects project A's directives. */

function seatedBindings() {
  posted = [];
  const control: ViewerControlDependencies = {
    async post(pathname, body, headers) {
      posted.push({ pathname, body, headers: headers ?? {} });
      return { outcome: "delivered", operationId: "op-1" };
    },
  };
  return viewerMcpBindings(undefined, control, {
    authorizedSeats: () => [
      { conversationId: "conversation_a", path: "/tmp/a.jsonl", project: "proj-a" },
      { conversationId: "conversation_b", path: "/tmp/b.jsonl", project: "proj-b" },
    ],
  } as never);
}

test("a project-scoped directive reaches THAT project's orchestrator even after another project was seated", async () => {
  sandbox();
  const tools = seatedBindings();

  await tools.bridge_directive({ clientRequestId: "d-a", rootTurnId: "turn_a", utterance: 0, instruction: "status?", project: "proj-a" });
  await tools.bridge_directive({ clientRequestId: "d-b", rootTurnId: "turn_b", utterance: 0, instruction: "status?", project: "proj-b" });

  expect(posted.map((post) => post.body.conversationId)).toEqual(["conversation_a", "conversation_b"]);
});

/* ── FIX 2 (post-#758 operator decision): unscoped routing follows the CALLING
      VOICE SESSION'S canonical project, never a global last-writer record ──── */

test("FIX 2 ACCEPTANCE: seat A, then seat B — an unscoped directive from a voice session in project A reaches A's orchestrator", async () => {
  sandbox(false);
  /* REAL seat activations, in this order: A first, then B. */
  seatProject("proj-a", "conversation_a");
  seatProject("proj-b", "conversation_b");

  /* The caller is a voice session whose canonical project is A. */
  const tools = bindings("proj-a");
  const receipt = await tools.bridge_directive({
    clientRequestId: "d-unscoped",
    rootTurnId: "turn_unscoped",
    utterance: 0,
    instruction: "status?",
  });

  expect(posted).toHaveLength(1);
  expect(posted[0]!.body.conversationId).toBe("conversation_a");
  expect(receipt).toMatchObject({ managerConversationId: "conversation_a" });
});

test("FIX 2: an unresolvable caller project fails closed DIAGNOSTICALLY — never another project's orchestrator", async () => {
  sandbox();
  /* A registered voice session always has a cwd and therefore a canonical
     project; this state is invariant-violating, and the refusal says so
     instead of guessing or falling back to whatever was seated last. */
  const tools = bindings(null);
  await expect(tools.bridge_directive({
    clientRequestId: "d-lost",
    rootTurnId: "turn_lost",
    utterance: 0,
    instruction: "status?",
  })).rejects.toThrow(/invariant/i);
  expect(posted).toEqual([]);
});

test("a project with no VALIDATED seat refuses rather than falling back to another project's orchestrator", async () => {
  sandbox();
  const tools = seatedBindings();
  await expect(tools.bridge_directive({
    clientRequestId: "d-x",
    rootTurnId: "turn_x",
    utterance: 0,
    instruction: "status?",
    project: "proj-unknown",
  })).rejects.toThrow();
  expect(posted).toEqual([]);
});
