import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { persistProjectAliases } from "@/lib/projects/aliases";

import {
  activeOrchestratorSeats,
  beginOrchestratorSeatIntent,
  completeOrchestratorSeatIntent,
  failOrchestratorSeatIntent,
  orchestratorRevocations,
  orchestratorSeatFor,
  readOrchestratorSeatFile,
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

test("a malformed file reads as empty and the epoch counter postdates everything on file", () => {
  fs.writeFileSync(path.join(sandbox, "orchestrator-seats.json"), "{not json", "utf8");
  expect(activeOrchestratorSeats()).toEqual([]);

  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "m", clientRequestId: "req_0000001", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000001", conversationId: "conversation_a", path: null, now: AT });
  const raw = JSON.parse(fs.readFileSync(path.join(sandbox, "orchestrator-seats.json"), "utf8")) as { nextSeatEpoch: number };
  raw.nextSeatEpoch = 0;
  fs.writeFileSync(path.join(sandbox, "orchestrator-seats.json"), JSON.stringify(raw), "utf8");
  expect(readOrchestratorSeatFile().nextSeatEpoch).toBe(2);
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
