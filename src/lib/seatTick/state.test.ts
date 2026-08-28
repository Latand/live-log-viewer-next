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

const { readSeatTickState, readSeatTickStateFile, seatTickStateForEpoch, seatTickStatePath, writeSeatTickState } = await import("./state");
import { emptySeatTickState } from "./types";

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const row = {
  ...emptySeatTickState(),
  seatEpoch: 7,
  lastCheckAt: "2026-08-28T12:00:00.000Z",
  lastWakeAt: "2026-08-28T11:00:00.000Z",
  lastWakeReasons: ["stalled" as const],
  wakesWithoutChange: { stalled: 2 },
  stalledSeen: ["pipeline_a1"],
  lastWakeFingerprint: "fp-1",
  digestThrough: 41,
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
  expect(projects.viewer!.digestThrough).toBe(41);
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

test("a rotation hands the clock over: the successor's epoch starts the bookkeeping fresh", () => {
  const successor = seatTickStateForEpoch(row, 8);
  expect(successor.seatEpoch).toBe(8);
  expect(successor.lastWakeAt).toBeNull();
  expect(successor.wakesWithoutChange).toEqual({});
  expect(successor.stalledSeen).toEqual([]);
  /* The lifecycle cursor is the one thing that is not the seat's: it belongs to
     the project, and replaying a rotation's worth of events would wake the
     successor for every lane that moved while the seat was changing hands. */
  expect(successor.digestThrough).toBe(41);
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
