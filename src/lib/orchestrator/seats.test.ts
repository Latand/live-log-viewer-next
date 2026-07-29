import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    expect(swapped.revoked).toEqual({ project: "proj-a", conversationId: "conversation_a", seatEpoch: 1, revokedAt: AT });
    expect(swapped.seat.seatEpoch).toBe(2);
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

test("completing an unknown or superseded key reports missing instead of guessing", () => {
  expect(completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000009", conversationId: "conversation_x", path: null, now: AT }).kind).toBe("missing");
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "a", clientRequestId: "req_0000001", mode: "spawn", now: AT });
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "b", clientRequestId: "req_0000002", mode: "spawn", now: AT });
  /* The newer intent replaced the abandoned one; the stale key cannot complete. */
  expect(completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_0000001", conversationId: "conversation_x", path: null, now: AT }).kind).toBe("missing");
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
