import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { mintBridgeConfirmation } from "@/lib/bridge/confirmation";
import { parseBridgeTrailer } from "@/lib/bridge/directive";
import { recordManagerReport } from "@/lib/bridge/service";
import { drainBridgeReports, openBridgeChannel } from "@/lib/bridge/store";
import { authorizedManagerSeats } from "@/lib/orchestrator/authority";
import {
  activeOrchestratorSeats,
  beginOrchestratorSeatIntent,
  completeOrchestratorSeatIntent,
  orchestratorRevocations,
} from "@/lib/orchestrator/seats";
import { adoptOrchestratorRecord } from "@/lib/orchestrator/store";

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

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

let posted: { pathname: string; body: Record<string, unknown> }[] = [];

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
    legacyManagerConversationId: () => null,
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
    /* The caller's own project holds the designated orchestrator; a legacy
       record is ALSO written and must be irrelevant to routing. */
    seatProject("proj-voice", "conversation_manager");
    adoptOrchestratorRecord({
      conversationId: "conversation_legacy_pointer",
      path: null,
      createdAt: new Date().toISOString(),
    });
  }
}

function bindings(callerProject: string | null = "proj-voice") {
  posted = [];
  const control: ViewerControlDependencies = {
    async post(pathname, body) {
      posted.push({ pathname, body });
      return { outcome: "delivered", operationId: "op-1" };
    },
  };
  /* The caller's canonical project as the production resolver would derive it
     from the voice conversation's cwd through projectInfoFromCwd. */
  return viewerMcpBindings(undefined, control, {
    callerProject: () => callerProject,
    authorizedSeats: realSeatAuthority,
  } as never);
}

test("a directive is addressed to the manager the record names, not to whoever the caller says", async () => {
  sandbox();
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

test("a deploy answer carries the nonce and SHA the manager must verify", async () => {
  sandbox();
  const tools = bindings();
  const sha = "4f3c1b9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a";
  const confirmation = mintBridgeConfirmation({ sha });
  recordManagerReport({
    key: "c1",
    class: "confirmation_request",
    at: new Date().toISOString(),
    body: "gates green",
    confirmation,
  });
  const seq = drainBridgeReports().reports.at(-1)!.seq;

  await tools.bridge_directive({
    clientRequestId: "d1",
    rootTurnId: "turn_0201",
    utterance: 0,
    instruction: "yes, ship it",
    ref: seq,
    nonce: confirmation.nonce,
    sha,
  });

  expect(parseBridgeTrailer(String(posted[0]!.body.text))).toEqual({ ref: seq, nonce: confirmation.nonce, sha });
});

test("a half-formed confirmation answer is refused rather than relayed as a bare reference", async () => {
  sandbox();
  const tools = bindings();
  await expect(tools.bridge_directive({
    clientRequestId: "d1",
    rootTurnId: "turn_0202",
    utterance: 0,
    instruction: "yes",
    ref: 1,
    nonce: "abc",
  })).rejects.toThrow(/nonce and sha/);
  expect(posted).toEqual([]);
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

/* CHOSEN SEMANTICS: the legacy single-instance record remains the DEFAULT
   recipient for an un-scoped directive; a directive carrying `project` resolves
   through the VALIDATED per-project seat authority, so seating project B never
   redirects project A's directives. */

function seatedBindings() {
  posted = [];
  const control: ViewerControlDependencies = {
    async post(pathname, body) {
      posted.push({ pathname, body });
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
  /* REAL seat activations, in this order: A first, then B, so B is the most
     recently seated project AND the one the last-writer legacy record names. */
  seatProject("proj-a", "conversation_a");
  seatProject("proj-b", "conversation_b");
  adoptOrchestratorRecord({ conversationId: "conversation_b", path: null, createdAt: new Date().toISOString() });

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

/* ── #795: direct operator deploy intent ─────────────────────────────────── */

const PINNED = "4f3c1b9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a";

/** Bindings whose caller the server attributes explicitly — the intent path
    trusts ONLY this attribution, never anything in the arguments. */
function attributedBindings(
  kind: "gateway" | "agent" | "manager",
  resolveRemoteMain: () => Promise<string> = async () => PINNED,
) {
  posted = [];
  const control: ViewerControlDependencies = {
    async post(pathname, body) {
      posted.push({ pathname, body });
      return { outcome: "delivered", operationId: "op-1" };
    },
  };
  return viewerMcpBindings(undefined, control, {
    callerProject: () => "proj-voice",
    authorizedSeats: realSeatAuthority,
    callerAttribution: () => ({
      kind,
      conversationId: kind === "manager" ? "conversation_manager" : "conversation_x",
      role: kind === "agent" ? "builder" : null,
    }),
    resolveRemoteMain,
  } as never);
}

test("#795: the operator's deploy words pin remote main and ride to the manager as a machine trailer", async () => {
  sandbox();
  const tools = attributedBindings("gateway");

  const receipt = await tools.bridge_directive({
    clientRequestId: "d1",
    rootTurnId: "turn_dep",
    utterance: 0,
    instruction: "deploy it",
    intent: "deploy",
  });

  expect(posted).toHaveLength(1);
  const trailer = parseBridgeTrailer(String(posted[0]!.body.text));
  expect(trailer?.sha).toBe(PINNED);
  expect(trailer?.nonce).toBeTruthy();

  /* The gateway hears enough to speak plainly; the nonce stays with the manager. */
  expect(receipt).toMatchObject({ deployIntent: { revision: PINNED, replayed: false } });
  expect((receipt as { deployIntent: Record<string, unknown> }).deployIntent.nonce).toBeUndefined();

  /* And the operator is never re-prompted: the authorization row never drains. */
  expect(drainBridgeReports().reports).toEqual([]);
});

test("#795: a relay retry of the same turn replays the same authorization", async () => {
  sandbox();
  const tools = attributedBindings("gateway");
  const args = { rootTurnId: "turn_dep", utterance: 0, instruction: "deploy it", intent: "deploy" };

  const first = await tools.bridge_directive({ clientRequestId: "d1", ...args }) as { deployIntent: { ref: number } };
  const again = await tools.bridge_directive({ clientRequestId: "d2", ...args }) as { deployIntent: { ref: number; replayed: boolean } };
  expect(again.deployIntent.replayed).toBe(true);
  expect(again.deployIntent.ref).toBe(first.deployIntent.ref);

  const trailers = posted.map((post) => parseBridgeTrailer(String(post.body.text)));
  expect(trailers[0]).toEqual(trailers[1]);
});

test("#795: an agent caller cannot mint a deploy intent — the manager included", async () => {
  sandbox();
  for (const kind of ["agent", "manager"] as const) {
    const tools = attributedBindings(kind);
    await expect(tools.bridge_directive({
      clientRequestId: "d1",
      rootTurnId: `turn_${kind}`,
      utterance: 0,
      instruction: "deploy it",
      intent: "deploy",
    })).rejects.toThrow(/voice gateway/i);
    expect(posted).toEqual([]);
  }
  expect(drainBridgeReports().reports).toEqual([]);
});

test("#795: an unpinnable remote refuses fail-closed — nothing authorized, nothing delivered", async () => {
  sandbox();
  const tools = attributedBindings("gateway", async () => { throw new Error("remote unreachable"); });
  await expect(tools.bridge_directive({
    clientRequestId: "d1",
    rootTurnId: "turn_dep",
    utterance: 0,
    instruction: "deploy it",
    intent: "deploy",
  })).rejects.toThrow(/NOT accepted/);
  expect(posted).toEqual([]);
  expect(drainBridgeReports().reports).toEqual([]);
});

test("#795: a deploy intent cannot smuggle an explicit trailer", async () => {
  sandbox();
  const tools = attributedBindings("gateway");
  await expect(tools.bridge_directive({
    clientRequestId: "d1",
    rootTurnId: "turn_dep",
    utterance: 0,
    instruction: "deploy it",
    intent: "deploy",
    ref: 3,
    nonce: "n",
    sha: PINNED,
  })).rejects.toThrow(/cannot be combined/);
  expect(posted).toEqual([]);
});

test("#795: an unknown intent value is refused outright", async () => {
  sandbox();
  const tools = attributedBindings("gateway");
  await expect(tools.bridge_directive({
    clientRequestId: "d1",
    rootTurnId: "turn_dep",
    utterance: 0,
    instruction: "do things",
    intent: "restart",
  })).rejects.toThrow(/intent/);
  expect(posted).toEqual([]);
});
