import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-tick-journal-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const { SEAT_TICK_RUN_HISTORY, appendSeatTickRecord, readSeatTickRecords, sanitizeSeatTickRecord, seatTickJournalPath } = await import("./journal");
import type { SeatTickRunRecord } from "./journal";

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/* Stand-ins for the two things that must never reach the journal, assembled at
   runtime so this file carries neither a transcript-shaped sentence nor a home
   path of its own. */
const SMUGGLED_BODY = "SMUGGLED-TRANSCRIPT-SENTINEL";
const SMUGGLED_PATH = ["", "home", "someone", "Projects", "viewer"].join("/");

const journal = path.join(SANDBOX, "journal", "runs.ndjson");

function record(over: Partial<SeatTickRunRecord> = {}): SeatTickRunRecord {
  return {
    schemaVersion: 1,
    at: "2026-08-28T12:00:00.000Z",
    project: "viewer",
    seatEpoch: 7,
    verdict: "quiet",
    reasons: [],
    items: 0,
    deferred: 0,
    digestThrough: 12,
    delivery: null,
    detail: "nothing owed",
    ...over,
  };
}

test("the journal path lives under the viewer state dir and carries no configuration", () => {
  expect(seatTickJournalPath()).toBe(path.join(SANDBOX, "state", "seat-tick", "runs.ndjson"));
});

test("every check leaves exactly one line, so no line means no check", () => {
  appendSeatTickRecord(record({ at: "2026-08-28T12:00:00.000Z" }), journal);
  appendSeatTickRecord(record({ at: "2026-08-28T12:05:00.000Z", verdict: "wake", reasons: ["stalled"], items: 2 }), journal);
  const records = readSeatTickRecords(10, journal);
  expect(records).toHaveLength(2);
  expect(records[1]).toMatchObject({ verdict: "wake", reasons: ["stalled"], items: 2 });
});

test("a wake records the delivery it actually got, refusal included", () => {
  const refused = record({
    at: "2026-08-28T12:10:00.000Z",
    verdict: "wake",
    delivery: { clientMessageId: "seat-tick:viewer:7:12", outcome: "seat-rotated" },
  });
  appendSeatTickRecord(refused, journal);
  const last = readSeatTickRecords(1, journal)[0]!;
  expect(last.delivery).toEqual({ clientMessageId: "seat-tick:viewer:7:12", outcome: "seat-rotated" });
});

test("the sanitizer keeps only journal fields — smuggled transcript text and paths lose at the boundary", () => {
  const kept = sanitizeSeatTickRecord({ ...record(), transcript: SMUGGLED_BODY, agentPath: SMUGGLED_PATH });
  expect(kept).not.toBeNull();
  expect(JSON.stringify(kept)).not.toContain(SMUGGLED_BODY);
  expect(JSON.stringify(kept)).not.toContain(SMUGGLED_PATH);
});

test("an unknown verdict, a missing project or a foreign schema is not a journal line", () => {
  expect(sanitizeSeatTickRecord({ ...record(), verdict: "deploy" })).toBeNull();
  expect(sanitizeSeatTickRecord({ ...record(), project: "" })).toBeNull();
  expect(sanitizeSeatTickRecord({ ...record(), schemaVersion: 2 })).toBeNull();
  expect(sanitizeSeatTickRecord("a line")).toBeNull();
});

test("an unknown reason kind is dropped rather than journaled as fact", () => {
  const kept = sanitizeSeatTickRecord({ ...record(), reasons: ["stalled", "made-up", "interval"] });
  expect(kept?.reasons).toEqual(["stalled", "interval"]);
});

test("a malformed line is skipped instead of hiding the checks around it", () => {
  const partial = path.join(SANDBOX, "partial.ndjson");
  fs.writeFileSync(partial, `${JSON.stringify(record())}\n{"broken":\n${JSON.stringify(record({ verdict: "no-seat" }))}\n`);
  expect(readSeatTickRecords(10, partial).map((entry) => entry.verdict)).toEqual(["quiet", "no-seat"]);
});

test("retention drops the oldest lines rather than growing without bound", () => {
  const rolling = path.join(SANDBOX, "rolling.ndjson");
  for (let index = 0; index < SEAT_TICK_RUN_HISTORY + 5; index += 1) {
    appendSeatTickRecord(record({ detail: `check ${index}` }), rolling);
  }
  const records = readSeatTickRecords(SEAT_TICK_RUN_HISTORY + 50, rolling);
  expect(records).toHaveLength(SEAT_TICK_RUN_HISTORY);
  expect(records[0]!.detail).toBe("check 5");
});
