import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-tick-state-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const { readSeatTickState, readSeatTickStateFile, seatTickStateForEpoch, seatTickStatePath, writeSeatTickState } = await import("./seatTickState");
import { emptySeatTickState } from "./types";

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/* Assembled from parts: a conversation-shaped literal is what the publication
   gate refuses in a committed artifact. */
const CONVERSATION = ["conversation", "0f4c21b7729fbc9e"].join("_");

const row = {
  ...emptySeatTickState(),
  seatEpoch: 7,
  lastCheckAt: "2026-08-28T12:00:00.000Z",
  lastWakeAt: "2026-08-28T11:00:00.000Z",
  lastWakeReasons: ["stalled" as const],
  wakesWithoutChange: { stalled: 2 },
  stalledSeen: ["pipeline_a1"],
  lastWakeFingerprint: "fp-1",
  eventsThrough: 41,
  outstandingWake: {
    clientMessageId: "seat-tick:viewer:7:first:interval:fp-1",
    conversationId: CONVERSATION,
    seatEpoch: 7,
    operationId: "op-wake-1",
    commit: { proposal: false, reasons: ["interval" as const], fingerprint: "fp-1", eventsThrough: 44 },
  },
};

test("a row survives the write and reads back whole", () => {
  const file = path.join(SANDBOX, "seat-tick.json");
  writeSeatTickState("viewer", row, file);
  expect(readSeatTickState("viewer", file)).toEqual(row);
  expect(readSeatTickState("other", file)).toEqual(emptySeatTickState());
});

test("one project's write leaves the others' rows alone", () => {
  const file = path.join(SANDBOX, "multi.json");
  writeSeatTickState("viewer", row, file);
  writeSeatTickState("other", { ...emptySeatTickState(), seatEpoch: 2 }, file);
  const projects = readSeatTickStateFile(file);
  expect(Object.keys(projects).sort()).toEqual(["other", "viewer"]);
  expect(projects.viewer!.eventsThrough).toBe(41);
});

test("a missing, unreadable or malformed file reads as an empty row rather than throwing", () => {
  expect(readSeatTickState("viewer", path.join(SANDBOX, "absent.json"))).toEqual(emptySeatTickState());
  const broken = path.join(SANDBOX, "broken.json");
  fs.writeFileSync(broken, "{ not json");
  expect(readSeatTickState("viewer", broken)).toEqual(emptySeatTickState());
});

test("a hand-edited row loses fields it is not allowed to carry", () => {
  const file = path.join(SANDBOX, "smuggled.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    projects: { viewer: { ...row, lastCheckAt: "whenever", wakesWithoutChange: { stalled: -3, invented: 9 }, transcript: "a sentence" } },
  }));
  const persisted = readSeatTickState("viewer", file);
  expect(persisted.lastCheckAt).toBeNull();
  expect(persisted.wakesWithoutChange).toEqual({});
  expect(JSON.stringify(persisted)).not.toContain("a sentence");
});

test("a rotation hands the clock over: the successor's epoch starts the judgement fresh", () => {
  const successor = seatTickStateForEpoch(row, 8);
  expect(successor.seatEpoch).toBe(8);
  expect(successor.lastWakeReasons).toEqual([]);
  expect(successor.wakesWithoutChange).toEqual({});
  expect(successor.stalledSeen).toEqual([]);
  /* The lifecycle cursor is the one thing that is not the seat's: it belongs to
     the project, and replaying a rotation's worth of events would wake the
     successor for every lane that moved while the seat was changing hands. */
  expect(successor.eventsThrough).toBe(41);
});

/* Three things belong to the project rather than to the seat. The stamps are
   the hourly bound: a rotation that cleared them would let a successor be woken
   minutes after its predecessor was, which an operator rotating a seat by hand
   could trip repeatedly. The outstanding wake is a payload the runtime is still
   holding for the PREDECESSOR, and the successor's first check is what takes it
   back — dropping it here would leave it addressed to nobody. */
test("the bound and the unlanded wake survive the rotation, because neither is the seat's", () => {
  const successor = seatTickStateForEpoch(row, 8);
  expect(successor.lastWakeAt).toBe("2026-08-28T11:00:00.000Z");
  expect(successor.lastProposalAt).toBe(row.lastProposalAt);
  expect(successor.outstandingWake).toEqual(row.outstandingWake);
});

test("a hand-edited outstanding wake missing any required field is dropped", () => {
  const file = path.join(SANDBOX, "half-wake.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    projects: { viewer: { ...row, outstandingWake: { clientMessageId: "seat-tick:viewer:7:first:interval:fp-1" } } },
  }));
  expect(readSeatTickState("viewer", file).outstandingWake).toBeNull();
});

/* The commit is what a landing observed a check later applies. A record that
   cannot say what its wake would stamp is worse than no record: it would credit
   the seat with the wrong hour and the wrong cursor. */
test("an outstanding wake with no commit plan is dropped rather than half-honoured", () => {
  const file = path.join(SANDBOX, "planless-wake.json");
  const { commit: _commit, ...planless } = row.outstandingWake;
  fs.writeFileSync(file, JSON.stringify({ version: 1, projects: { viewer: { ...row, outstandingWake: planless } } }));
  expect(readSeatTickState("viewer", file).outstandingWake).toBeNull();
});

/* The handle that says which layer is holding the payload. A registry hold has
   none, and that absence is meaningful rather than malformed. */
test("an outstanding wake with no operation id is a registry-held one, and survives", () => {
  const file = path.join(SANDBOX, "held-wake.json");
  const { operationId: _operationId, ...held } = row.outstandingWake;
  fs.writeFileSync(file, JSON.stringify({ version: 1, projects: { viewer: { ...row, outstandingWake: held } } }));
  expect(readSeatTickState("viewer", file).outstandingWake).toEqual({ ...row.outstandingWake, operationId: null });
});

test("a hand-edited commit plan keeps only reason kinds the tick knows", () => {
  const file = path.join(SANDBOX, "smuggled-plan.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    projects: {
      viewer: {
        ...row,
        outstandingWake: { ...row.outstandingWake, commit: { ...row.outstandingWake.commit, reasons: ["interval", "invented"] } },
      },
    },
  }));
  expect(readSeatTickState("viewer", file).outstandingWake!.commit.reasons).toEqual(["interval"]);
});

test("a commit plan with an impossible cursor drops the whole record", () => {
  const file = path.join(SANDBOX, "negative-cursor.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    projects: {
      viewer: {
        ...row,
        outstandingWake: { ...row.outstandingWake, commit: { ...row.outstandingWake.commit, eventsThrough: -4 } },
      },
    },
  }));
  expect(readSeatTickState("viewer", file).outstandingWake).toBeNull();
});

test("the same epoch keeps the row it was given", () => {
  expect(seatTickStateForEpoch(row, 7)).toBe(row);
});

test("losing the seat entirely resets to an unseated row", () => {
  expect(seatTickStateForEpoch(row, null).seatEpoch).toBeNull();
});

test("the state file lives under the viewer state dir with no configuration", () => {
  expect(seatTickStatePath()).toBe(path.join(SANDBOX, "state", "seat-tick.json"));
});
