import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { persistProjectAliases } from "@/lib/projects/aliases";

import {
  ORCHESTRATOR_SEAT_HISTORY_CAP,
  activeOrchestratorSeats,
  activeOrchestratorSeatsForMigration,
  activeOrchestratorSeatsOrUnknown,
  beginOrchestratorSeatIntent,
  completeOrchestratorSeatIntent,
  failOrchestratorSeatIntent,
  orchestratorRevocations,
  orchestratorSeatFor,
  readOrchestratorSeatFile,
  rekeyOrchestratorSeatPaths,
  revokedOrchestratorSeatConversationsOrUnknown,
} from "./seats";

let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-orchestrator-seats-"));
  process.env.LLV_STATE_DIR = sandbox;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const AT = "2026-07-29T00:00:00.000Z";

test("begin persists a pending intent that grants nothing and is replayable by key", () => {
  const begun = beginOrchestratorSeatIntent({ project: "proj-a", mandate: "run the board", clientRequestId: "req_0000001", mode: "spawn", now: AT });
  expect(begun.kind).toBe("begun");
  expect(begun.seat.state).toBe("pending");
  expect(begun.seat.seatEpoch).toBe(1);
  expect(activeOrchestratorSeats()).toEqual([]);
  expect(orchestratorSeatFor("proj-a").pending?.mandate).toBe("run the board");

  const replay = beginOrchestratorSeatIntent({ project: "proj-a", mandate: "ignored on replay", clientRequestId: "req_0000001", mode: "spawn", now: AT });
  expect(replay.kind).toBe("replay");
  expect(replay.seat.mandate).toBe("run the board");
});

test("complete activates exactly once and replays idempotently afterwards", () => {
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "m", clientRequestId: "req_0000001", mode: "spawn", now: AT });
  const first = completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000001", conversationId: "conversation_a", path: "/tmp/a.jsonl", now: AT });
  expect(first.kind).toBe("activated");
  if (first.kind === "activated") expect(first.revoked).toBeNull();

  const again = completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000001", conversationId: "conversation_a", path: "/tmp/a.jsonl", now: AT });
  expect(again.kind).toBe("replay");
  expect(orchestratorRevocations()).toEqual([]);

  const beganAfter = beginOrchestratorSeatIntent({ project: "proj-a", mandate: "m", clientRequestId: "req_0000001", mode: "spawn", now: AT });
  expect(beganAfter.kind).toBe("completed");
});

test("replacement revokes the predecessor in the same write and bumps the epoch", () => {
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "first", clientRequestId: "req_0000001", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000001", conversationId: "conversation_a", path: null, now: AT });

  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "second", clientRequestId: "req_0000002", mode: "spawn", now: AT });
  /* Predecessor stays authoritative while the successor is pending. */
  expect(orchestratorSeatFor("proj-a").active?.conversationId).toBe("conversation_a");

  const swapped = completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000002", conversationId: "conversation_b", path: null, now: AT });
  expect(swapped.kind).toBe("activated");
  if (swapped.kind === "activated") {
    expect(swapped.revoked).toEqual({
      project: "proj-a",
      conversationId: "conversation_a",
      seatEpoch: 1,
      revokedAt: AT,
      /* Bidirectional lineage: the revocation names its successor… */
      successorConversationId: "conversation_b",
      /* Nothing named an actor for this designation, so provenance stays
         unknown; the operator is never assumed (#1402). */
      triggeredBy: null,
    });
    expect(swapped.seat.seatEpoch).toBe(2);
    /* …and the successor seat names its predecessor. */
    expect(swapped.seat.predecessorConversationId).toBe("conversation_a");
  }
  expect(orchestratorSeatFor("proj-a").active?.conversationId).toBe("conversation_b");
});

test("#1402: a designation's trigger survives the file — on the seat it created and on the seat it ended", () => {
  const trigger = { kind: "agent" as const, conversationId: "conversation_a", seatEpoch: 1 };
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "first", clientRequestId: "req_0000001", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000001", conversationId: "conversation_a", path: null, now: AT });

  /* The seat rotating ITSELF: the actor is written on the intent, before the
     successor exists, and read back off disk by every later reader. */
  beginOrchestratorSeatIntent({
    project: "proj-a",
    mandate: "second",
    clientRequestId: "req_0000002",
    mode: "spawn",
    triggeredBy: trigger,
    now: AT,
  });
  expect(orchestratorSeatFor("proj-a").pending?.triggeredBy).toEqual(trigger);

  completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000002", conversationId: "conversation_b", path: null, now: AT });
  expect(orchestratorSeatFor("proj-a").active?.triggeredBy).toEqual(trigger);
  expect(orchestratorRevocations()).toEqual([expect.objectContaining({
    conversationId: "conversation_a",
    successorConversationId: "conversation_b",
    triggeredBy: trigger,
  })]);

  /* Provenance is unknown or it is absent — never half-written. */
  const raw = JSON.parse(fs.readFileSync(path.join(sandbox, "orchestrator-seats.json"), "utf8")) as Record<string, unknown>;
  const seats = raw.seats as Record<string, Record<string, unknown>>;
  seats["proj-a"]!.triggeredBy = { kind: "impostor", conversationId: "conversation_z" };
  fs.writeFileSync(path.join(sandbox, "orchestrator-seats.json"), JSON.stringify(raw), "utf8");
  expect(orchestratorSeatFor("proj-a").active?.triggeredBy).toBeNull();
});

test("editing the mandate for the SAME conversation revokes nothing", () => {
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "v1", clientRequestId: "req_0000001", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000001", conversationId: "conversation_a", path: null, now: AT });
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "v2", clientRequestId: "req_0000002", mode: "existing", conversationId: "conversation_a", now: AT });
  const updated = completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000002", conversationId: "conversation_a", path: null, now: AT });
  expect(updated.kind).toBe("activated");
  expect(orchestratorRevocations()).toEqual([]);
  expect(orchestratorSeatFor("proj-a").active?.mandate).toBe("v2");
});

test("a failed intent stays pending with its error and never unseats the incumbent", () => {
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "first", clientRequestId: "req_0000001", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000001", conversationId: "conversation_a", path: null, now: AT });
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "second", clientRequestId: "req_0000002", mode: "spawn", now: AT });
  failOrchestratorSeatIntent("proj-a", "req_0000002", "spawn failed");
  const { active, pending } = orchestratorSeatFor("proj-a");
  expect(active?.conversationId).toBe("conversation_a");
  expect(pending?.intent.error).toBe("spawn failed");
});

test("a concurrent key cannot displace a pending intent, and a stale completion reports missing", () => {
  expect(completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000009", conversationId: "conversation_x", path: null, now: AT }).kind).toBe("missing");
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "a", clientRequestId: "req_0000001", mode: "spawn", now: AT });
  const competing = beginOrchestratorSeatIntent({ project: "proj-a", mandate: "b", clientRequestId: "req_0000002", mode: "spawn", now: AT });
  expect(competing.kind).toBe("in_progress");
  expect(completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000001", conversationId: "conversation_x", path: null, now: AT }).kind).toBe("activated");
  expect(completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000002", conversationId: "conversation_y", path: null, now: AT }).kind).toBe("missing");
});

const LATER = "2026-07-29T01:00:00.000Z";

function seatRow(overrides: {
  seatEpoch: number;
  state: "pending" | "active";
  conversationId: string | null;
  clientRequestId: string;
  error?: string | null;
  launchId?: string | null;
  activatedAt?: string | null;
}): Record<string, unknown> {
  return {
    project: "proj-a",
    seatEpoch: overrides.seatEpoch,
    conversationId: overrides.conversationId,
    path: null,
    mandate: `mandate for ${overrides.clientRequestId}`,
    promptVersion: null,
    predecessorConversationId: null,
    state: overrides.state,
    intent: { clientRequestId: overrides.clientRequestId, mode: "spawn", launchId: overrides.launchId ?? null, error: overrides.error ?? null },
    designatedAt: AT,
    activatedAt: overrides.activatedAt ?? null,
  };
}

test("a pending intent carrying a terminal error is terminalized into durable history and a NEW key proceeds", () => {
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "first try", clientRequestId: "req_0000001", mode: "spawn", now: AT });
  failOrchestratorSeatIntent("proj-a", "req_0000001", "spawn attempt conflicts with its original request");

  const begun = beginOrchestratorSeatIntent({ project: "proj-a", mandate: "second try", clientRequestId: "req_0000002", mode: "spawn", now: LATER });
  expect(begun.kind).toBe("begun");

  const { pending, history } = orchestratorSeatFor("proj-a");
  expect(pending?.intent.clientRequestId).toBe("req_0000002");
  /* Evidence preserved, never deleted: key, mandate, epoch, mode, error and
     timestamps all stay readable after terminalization. */
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    reason: "terminal_error",
    terminalizedAt: LATER,
    seat: {
      seatEpoch: 1,
      mandate: "first try",
      designatedAt: AT,
      intent: { clientRequestId: "req_0000001", mode: "spawn", error: "spawn attempt conflicts with its original request" },
    },
  });
  /* Durable, not in-memory: a fresh read of the file still carries it. */
  expect(readOrchestratorSeatFile().history).toHaveLength(1);
});

test("a pending intent below the project's active seat epoch is abandoned: a NEW key proceeds and the intent moves to history", () => {
  /* The observed stuck shape: an unrelated seat activated at a higher epoch
     while an old pending intent (no terminal error) lingered below it. */
  fs.writeFileSync(path.join(sandbox, "orchestrator-seats.json"), JSON.stringify({
    schemaVersion: 1,
    nextSeatEpoch: 38,
    seats: { "proj-a": seatRow({ seatEpoch: 37, state: "active", conversationId: "conversation_b", clientRequestId: "req_0000037", activatedAt: AT }) },
    pending: { "proj-a": seatRow({ seatEpoch: 31, state: "pending", conversationId: null, clientRequestId: "req_0000031" }) },
    revocations: [],
  }), "utf8");

  const begun = beginOrchestratorSeatIntent({ project: "proj-a", mandate: "recover", clientRequestId: "req_0000040", mode: "spawn", now: LATER });
  expect(begun.kind).toBe("begun");
  expect(begun.seat.seatEpoch).toBe(38);

  const { active, pending, history } = orchestratorSeatFor("proj-a");
  expect(active?.seatEpoch).toBe(37);
  expect(pending?.intent.clientRequestId).toBe("req_0000040");
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    reason: "superseded_epoch",
    seat: { seatEpoch: 31, intent: { clientRequestId: "req_0000031", error: null } },
  });
});

test("a genuinely in-flight intent — no error, epoch at or above the active seat — still blocks a different key", () => {
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "first", clientRequestId: "req_0000001", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000001", conversationId: "conversation_a", path: null, now: AT });
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "second", clientRequestId: "req_0000002", mode: "spawn", now: AT });

  const blocked = beginOrchestratorSeatIntent({ project: "proj-a", mandate: "third", clientRequestId: "req_0000003", mode: "spawn", now: AT });
  expect(blocked.kind).toBe("in_progress");
  if (blocked.kind === "in_progress") expect(blocked.seat.intent.clientRequestId).toBe("req_0000002");
  expect(orchestratorSeatFor("proj-a").history).toEqual([]);
});

/* Issue #1067 AC 5: a recorded intent error is TERMINAL, and terminal outranks
   the idempotency key. The old contract handed the errored row back as a
   `replay` for its own key to "finish", which re-delivered the stored mandate —
   the very text that failed — and kept the failed row in the blocking pending
   position, which is the permanent "last designation failed" banner in the
   incident. The next begin now clears it whichever key sends it. */
test("an errored pending intent is terminalized by its OWN key, not replayed", () => {
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "oversized", clientRequestId: "req_0000001", mode: "spawn", now: AT });
  failOrchestratorSeatIntent("proj-a", "req_0000001", "structured message text exceeds the 32000-byte envelope bound");

  const again = beginOrchestratorSeatIntent({ project: "proj-a", mandate: "recomposed and small", clientRequestId: "req_0000001", mode: "spawn", now: AT });

  expect(again.kind).toBe("begun");
  /* The fresh intent carries the RECOMPOSED mandate, not the stored one. */
  expect(again.seat.mandate).toBe("recomposed and small");
  expect(again.seat.intent.error).toBeNull();
  if (again.kind === "begun") expect(again.terminalized?.reason).toBe("terminal_error");
  const seats = orchestratorSeatFor("proj-a");
  expect(seats.history).toMatchObject([{
    reason: "terminal_error",
    seat: { mandate: "oversized", intent: { clientRequestId: "req_0000001" } },
  }]);
  /* One pending row, and it is the new one — nothing hangs. */
  expect(seats.pending?.seatEpoch).toBe(again.seat.seatEpoch);
  expect(seats.pending?.intent.error).toBeNull();
});

test("a still-live pending intent is replayed by its own key so the caller can finish it", () => {
  const begun = beginOrchestratorSeatIntent({ project: "proj-a", mandate: "run the board", clientRequestId: "req_0000001", mode: "spawn", now: AT });

  const replay = beginOrchestratorSeatIntent({ project: "proj-a", mandate: "ignored on replay", clientRequestId: "req_0000001", mode: "spawn", now: AT });

  expect(replay.kind).toBe("replay");
  expect(replay.seat.seatEpoch).toBe(begun.seat.seatEpoch);
  expect(replay.seat.mandate).toBe("run the board");
  expect(orchestratorSeatFor("proj-a").history).toEqual([]);
});

test("terminalized history is bounded so the seat file cannot grow without limit", () => {
  const key = (index: number) => `req_1${String(index).padStart(6, "0")}`;
  const rounds = ORCHESTRATOR_SEAT_HISTORY_CAP + 10;
  for (let index = 0; index < rounds; index += 1) {
    beginOrchestratorSeatIntent({ project: "proj-a", mandate: `m${index}`, clientRequestId: key(index), mode: "spawn", now: AT });
    failOrchestratorSeatIntent("proj-a", key(index), "boom");
  }
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "final", clientRequestId: "req_2000000", mode: "spawn", now: AT });

  const history = orchestratorSeatFor("proj-a").history;
  expect(history).toHaveLength(ORCHESTRATOR_SEAT_HISTORY_CAP);
  /* Oldest entries are the ones trimmed. */
  expect(history.at(-1)?.seat.mandate).toBe(`m${rounds - 1}`);
});

test("the epoch counter postdates history epochs so a recovered file never reissues a terminalized epoch", () => {
  fs.writeFileSync(path.join(sandbox, "orchestrator-seats.json"), JSON.stringify({
    schemaVersion: 1,
    nextSeatEpoch: 1,
    seats: {},
    pending: {},
    revocations: [],
    history: [{
      seat: seatRow({ seatEpoch: 5, state: "pending", conversationId: null, clientRequestId: "req_0000005", error: "boom" }),
      reason: "terminal_error",
      terminalizedAt: AT,
    }],
  }), "utf8");
  const begun = beginOrchestratorSeatIntent({ project: "proj-a", mandate: "m", clientRequestId: "req_0000006", mode: "spawn", now: AT });
  expect(begun.kind).toBe("begun");
  expect(begun.seat.seatEpoch).toBe(6);
});

test("a malformed file reads as empty and the epoch counter postdates everything on file", () => {
  fs.writeFileSync(path.join(sandbox, "orchestrator-seats.json"), "{not json", "utf8");
  expect(activeOrchestratorSeats()).toEqual([]);
  expect(() => activeOrchestratorSeatsForMigration()).toThrow("orchestrator seat evidence is malformed");

  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "m", clientRequestId: "req_0000001", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000001", conversationId: "conversation_a", path: null, now: AT });
  const raw = JSON.parse(fs.readFileSync(path.join(sandbox, "orchestrator-seats.json"), "utf8")) as { nextSeatEpoch: number };
  raw.nextSeatEpoch = 0;
  fs.writeFileSync(path.join(sandbox, "orchestrator-seats.json"), JSON.stringify(raw), "utf8");
  expect(readOrchestratorSeatFile().nextSeatEpoch).toBe(2);
});

test("an unestablished seat store answers unknown, and an absent one answers none", () => {
  /* Automatic host retirement (#747) asks the seat question with the opposite
     consequence to authority: reading an unreadable file as "no seats" would
     clear a live orchestrator for the kill, and an orchestrator is exactly the
     host that sits quiet for hours between operator messages. A machine that
     never designated one has no file, and that is a real "no seats". */
  expect(activeOrchestratorSeatsOrUnknown()).toEqual([]);

  const file = path.join(sandbox, "orchestrator-seats.json");
  fs.writeFileSync(file, "{not json", "utf8");
  expect(activeOrchestratorSeatsOrUnknown()).toBeNull();
  /* The authority reader keeps answering empty for exactly the same file. */
  expect(activeOrchestratorSeats()).toEqual([]);

  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99, nextSeatEpoch: 1, seats: {}, pending: {}, revocations: [], history: [] }), "utf8");
  expect(activeOrchestratorSeatsOrUnknown()).toBeNull();

  fs.rmSync(file);
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "m", clientRequestId: "req_0000001", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000001", conversationId: "conversation_a", path: null, now: AT });
  expect(activeOrchestratorSeatsOrUnknown()?.map((seat) => seat.conversationId)).toEqual(["conversation_a"]);
});

test("a rotated-away conversation reads as revoked, and a re-designated one stops reading so", () => {
  /* The fact automatic host retirement (#1245) ends a predecessor on. Rotation
     revokes authority and leaves the host, so this is the only durable thing
     that says the seat it holds is over. */
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "first", clientRequestId: "req_0000001", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000001", conversationId: "conversation_a", path: null, now: AT });
  expect([...revokedOrchestratorSeatConversationsOrUnknown()!]).toEqual([]);

  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "second", clientRequestId: "req_0000002", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000002", conversationId: "conversation_b", path: null, now: AT });
  expect([...revokedOrchestratorSeatConversationsOrUnknown()!]).toEqual(["conversation_a"]);
  /* The successor is not revoked by its predecessor's revocation. */
  expect(revokedOrchestratorSeatConversationsOrUnknown()!.has("conversation_b")).toBe(false);

  /* The ABA guard: seating the SAME conversation again mints a strictly newer
     epoch, so the standing revocation at epoch 1 no longer stands at or above
     every epoch a seat names it at, and the identity is live again. */
  beginOrchestratorSeatIntent({ project: "proj-b", mandate: "third", clientRequestId: "req_0000003", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-b", clientRequestId: "req_0000003", conversationId: "conversation_a", path: null, now: AT });
  expect([...revokedOrchestratorSeatConversationsOrUnknown()!]).toEqual([]);
});

test("a pending seat protects its conversation from reading as revoked", () => {
  /* An intent that has not settled yet still names the conversation at a newer
     epoch than the revocation, and retiring its host mid-designation would
     kill the seat the operator is in the middle of creating. */
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "first", clientRequestId: "req_0000001", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000001", conversationId: "conversation_a", path: null, now: AT });
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "second", clientRequestId: "req_0000002", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000002", conversationId: "conversation_b", path: null, now: AT });
  expect([...revokedOrchestratorSeatConversationsOrUnknown()!]).toEqual(["conversation_a"]);

  beginOrchestratorSeatIntent({
    project: "proj-c", mandate: "adopt the predecessor", clientRequestId: "req_0000004",
    mode: "existing", conversationId: "conversation_a", now: AT,
  });
  expect([...revokedOrchestratorSeatConversationsOrUnknown()!]).toEqual([]);
});

test("a pending intent that failed terminally stops masking the revocation", () => {
  /* The protection above lapses at the error. A recorded error is the intent's
     TERMINAL state, and the row keeps its pending position until the NEXT
     designation for that project moves it to history — a call that may never
     come. Reading the failed row as a seat would leave the predecessor's
     revocation masked, and its host running, indefinitely: the revoked seat
     that keeps acting is the whole reason #1245 exists. */
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "first", clientRequestId: "req_0000001", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000001", conversationId: "conversation_a", path: null, now: AT });
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "second", clientRequestId: "req_0000002", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000002", conversationId: "conversation_b", path: null, now: AT });

  beginOrchestratorSeatIntent({
    project: "proj-c", mandate: "adopt the predecessor", clientRequestId: "req_0000004",
    mode: "existing", conversationId: "conversation_a", now: AT,
  });
  expect([...revokedOrchestratorSeatConversationsOrUnknown()!]).toEqual([]);

  failOrchestratorSeatIntent("proj-c", "req_0000004", "the mandate could not be delivered");
  /* Still in the pending position, and no longer protecting anything. */
  expect(readOrchestratorSeatFile().pending["proj-c"]?.intent.error).toBe("the mandate could not be delivered");
  expect([...revokedOrchestratorSeatConversationsOrUnknown()!]).toEqual(["conversation_a"]);
});

test("revoked standing follows an identity across a migration alias, in both directions", () => {
  /* The caller joins this set against the registry's CANONICAL conversation id,
     and the seat file keeps whatever id each row was written with. One
     migration between the two is enough to decide a host's fate the wrong way
     round, so the resolver is applied to both sides of the epoch comparison —
     exactly as the authority resolver applies its own. */
  const migrated = (conversationId: string) => (conversationId === "conversation_a" ? "conversation_a2" : conversationId);

  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "first", clientRequestId: "req_0000001", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000001", conversationId: "conversation_a", path: null, now: AT });
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "second", clientRequestId: "req_0000002", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000002", conversationId: "conversation_b", path: null, now: AT });

  /* Unresolved, the revocation names an id the caller never asks about, and the
     rotated-away host reads as a live seat forever. */
  expect([...revokedOrchestratorSeatConversationsOrUnknown()!]).toEqual(["conversation_a"]);
  expect([...revokedOrchestratorSeatConversationsOrUnknown(migrated)!]).toEqual(["conversation_a2"]);

  /* The other direction: the identity is re-designated under the id it was
     migrated ONTO. The newer epoch has to lift the older revocation, or the
     sweep would retire a seat somebody is sitting in. */
  beginOrchestratorSeatIntent({ project: "proj-c", mandate: "third", clientRequestId: "req_0000005", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-c", clientRequestId: "req_0000005", conversationId: "conversation_a2", path: null, now: AT });
  expect([...revokedOrchestratorSeatConversationsOrUnknown(migrated)!]).toEqual([]);
});

test("an unestablished seat store answers unknown for revocations too", () => {
  /* Same discipline as the active-seat reader beside it, and for the mirror
     reason: silence read as "revoked by nobody" keeps a rotated-away
     orchestrator alive forever, and silence read as "revoked" would clear a
     seated one for the kill. An absent file is a real "nothing revoked". */
  expect([...revokedOrchestratorSeatConversationsOrUnknown()!]).toEqual([]);

  const file = path.join(sandbox, "orchestrator-seats.json");
  fs.writeFileSync(file, "{not json", "utf8");
  expect(revokedOrchestratorSeatConversationsOrUnknown()).toBeNull();
});

test("identity migration rekeys the active seat path idempotently", () => {
  const legacyPath = path.join(sandbox, "legacy.jsonl");
  const sharedPath = path.join(sandbox, "shared.jsonl");
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "m", clientRequestId: "req_0000001", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({
    project: "proj-a",
    clientRequestId: "req_0000001",
    conversationId: "conversation_a",
    path: legacyPath,
    now: AT,
  });

  rekeyOrchestratorSeatPaths([{ legacyPath, sharedPath }]);
  rekeyOrchestratorSeatPaths([{ legacyPath, sharedPath }]);
  expect(orchestratorSeatFor("proj-a").active?.path).toBe(sharedPath);
});

test("whole-file rewrites preserve explicit legacy-unfrozen runtime provenance", () => {
  fs.writeFileSync(path.join(sandbox, "orchestrator-seats.json"), JSON.stringify({
    schemaVersion: 1,
    nextSeatEpoch: 2,
    seats: {
      "proj-a": {
        project: "proj-a",
        seatEpoch: 1,
        conversationId: "conversation_a",
        path: null,
        engine: null,
        model: null,
        runtimeIdentityFrozen: false,
        mandate: "legacy seat",
        promptVersion: null,
        predecessorConversationId: null,
        state: "active",
        intent: { clientRequestId: "req_legacy_1", mode: "spawn", launchId: null, error: null },
        designatedAt: AT,
        activatedAt: AT,
      },
    },
    pending: {},
    revocations: [],
  }), "utf8");

  expect(orchestratorSeatFor("proj-a").active?.runtimeIdentityFrozen).toBe(false);
  beginOrchestratorSeatIntent({
    project: "proj-b",
    mandate: "rewrite the seat file",
    clientRequestId: "req_rewrite_1",
    mode: "spawn",
    engine: "claude",
    model: "opus",
    now: AT,
  });
  expect(orchestratorSeatFor("proj-a").active?.runtimeIdentityFrozen).toBe(false);
});

test("seats are independent per project", () => {
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "a", clientRequestId: "req_0000001", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000001", conversationId: "conversation_a", path: null, now: AT });
  beginOrchestratorSeatIntent({ project: "proj-b", mandate: "b", clientRequestId: "req_0000002", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-b", clientRequestId: "req_0000002", conversationId: "conversation_b", path: null, now: AT });
  expect(activeOrchestratorSeats().map((seat) => seat.conversationId).sort()).toEqual(["conversation_a", "conversation_b"]);
  expect(orchestratorRevocations()).toEqual([]);
});

test("a named project alias and its canonical identity resolve to one seat", () => {
  const canonical = "repo-0123456789abcdef0123456789abcdef";
  expect(persistProjectAliases([
    { source: "named-project", target: canonical, displayName: "named-project" },
  ])).toBe(true);

  beginOrchestratorSeatIntent({ project: "named-project", mandate: "m", clientRequestId: "req_0000001", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: canonical, clientRequestId: "req_0000001", conversationId: "conversation_a", path: null, now: AT });

  expect(orchestratorSeatFor("named-project").active?.conversationId).toBe("conversation_a");
  expect(orchestratorSeatFor(canonical).active).toMatchObject({ project: canonical, conversationId: "conversation_a" });
  expect(activeOrchestratorSeats()).toHaveLength(1);
});

test("a persisted pre-canonical alias seat is recovered under its canonical project", () => {
  const canonical = "repo-0123456789abcdef0123456789abcdef";
  expect(persistProjectAliases([
    { source: "legacy-project", target: canonical, displayName: "legacy-project" },
  ])).toBe(true);
  fs.writeFileSync(path.join(sandbox, "orchestrator-seats.json"), JSON.stringify({
    schemaVersion: 1,
    nextSeatEpoch: 2,
    seats: {
      "legacy-project": {
        project: "legacy-project",
        seatEpoch: 1,
        conversationId: "conversation_a",
        path: null,
        mandate: "m",
        promptVersion: null,
        predecessorConversationId: null,
        state: "active",
        intent: { clientRequestId: "req_0000001", mode: "spawn", launchId: null, error: null },
        designatedAt: AT,
        activatedAt: AT,
      },
    },
    pending: {},
    revocations: [],
  }), "utf8");

  expect(orchestratorSeatFor(canonical).active).toMatchObject({ project: canonical, conversationId: "conversation_a" });
  expect(orchestratorSeatFor("legacy-project").active?.conversationId).toBe("conversation_a");
  expect(activeOrchestratorSeats()).toHaveLength(1);
});
