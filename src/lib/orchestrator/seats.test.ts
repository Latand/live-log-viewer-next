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
    });
    expect(swapped.seat.seatEpoch).toBe(2);
    /* …and the successor seat names its predecessor. */
    expect(swapped.seat.predecessorConversationId).toBe("conversation_a");
  }
  expect(orchestratorSeatFor("proj-a").active?.conversationId).toBe("conversation_b");
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
