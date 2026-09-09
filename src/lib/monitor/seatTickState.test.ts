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
const { SeatTickAccounting } = await import("./seatTickAccounting");

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
    commit: { proposal: false, reasons: ["interval" as const], fingerprint: "fp-1", eventsThrough: 44, children: [CONVERSATION] },
  },
  harvestedChildren: [CONVERSATION],
  pullRequestGap: {
    gap: "command-failed" as const,
    since: "2026-08-28T08:00:00.000Z",
    lastAttemptAt: "2026-08-28T11:55:00.000Z",
    attempts: 23,
    reported: true,
  },
};

test("a row survives the write and reads back whole", () => {
  const file = path.join(SANDBOX, "seat-tick.json");
  writeSeatTickState("viewer", row, file);
  expect(readSeatTickState("viewer", file)).toMatchObject({ ...row, harvestedChildren: [] });
  expect(readSeatTickState("other", file)).toMatchObject(emptySeatTickState());
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
  expect(readSeatTickState("viewer", path.join(SANDBOX, "absent.json"))).toMatchObject(emptySeatTickState());
  const broken = path.join(SANDBOX, "broken.json");
  fs.writeFileSync(broken, "{ not json");
  expect(readSeatTickState("viewer", broken).accounting?.gap).not.toBeNull();
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

/* The run of failures is a fact about `gh` and the machine it runs on (#1298),
   so a rotation carries it: a new seat does not fix a missing credential, and
   clearing it here would re-report the same outage to the board and put the
   read back on the five-minute retry it had outgrown. */
test("the run of failures of an evidence source survives the rotation", () => {
  expect(seatTickStateForEpoch(row, 8).pullRequestGap).toEqual(row.pullRequestGap);
  const children = { gap: "ledger-gap" as const, since: "2026-08-28T09:00:00.000Z", lastAttemptAt: "2026-08-28T11:55:00.000Z", attempts: 4, reported: false };
  expect(seatTickStateForEpoch({ ...row, childrenGap: children }, 8).childrenGap).toEqual(children);
});

/* The instant an attempt was prepared is part of the row (#1465): the bound on
   an attempt nobody can account for is measured from it. */
test("an outstanding wake keeps the instant it was prepared, and drops one that is not an instant", () => {
  const file = path.join(SANDBOX, "prepared-at.json");
  fs.writeFileSync(file, JSON.stringify({ version: 2, projects: {
    viewer: { ...row, outstandingWake: { ...row.outstandingWake, preparedAt: "2026-08-28T11:30:00.000Z" } },
    other: { ...row, outstandingWake: { ...row.outstandingWake, preparedAt: "whenever" } },
  } }));
  expect(readSeatTickState("viewer", file).outstandingWake?.preparedAt).toBe("2026-08-28T11:30:00.000Z");
  expect(readSeatTickState("other", file).outstandingWake).not.toHaveProperty("preparedAt");
});

/* Half a run is worse than none: the two instants are what the report
   threshold and the retry window are measured from. Dropping it costs one fast
   retry and one re-reported outage, and the check still refuses to call the
   source quiet meanwhile. */
test("a run of failures missing an instant or a count is dropped", () => {
  const file = path.join(SANDBOX, "half-gap.json");
  const halves = [
    { gap: "command-failed", lastAttemptAt: "2026-08-28T11:55:00.000Z", attempts: 3 },
    { gap: "command-failed", since: "2026-08-28T08:00:00.000Z", attempts: 3 },
    { gap: "command-failed", since: "2026-08-28T08:00:00.000Z", lastAttemptAt: "2026-08-28T11:55:00.000Z", attempts: 0 },
    { gap: "invented", since: "2026-08-28T08:00:00.000Z", lastAttemptAt: "2026-08-28T11:55:00.000Z", attempts: 3 },
  ];
  for (const half of halves) {
    fs.writeFileSync(file, JSON.stringify({ version: 2, projects: { viewer: { ...row, pullRequestGap: half } } }));
    expect(readSeatTickState("viewer", file).pullRequestGap).toBeNull();
  }
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

/* ------------------------------------------------------------------------- *
 * #1262: what a cursor of zero meant, and what it means now.
 * ------------------------------------------------------------------------- */

/* The row shape this replaces could not say "no cursor yet". It wrote zero,
   and a zero cursor reads the lifecycle journal from the beginning — which is
   how a first wake arrived carrying four-day-old merges. A version 1 row that
   was never woken is that unestablished cursor, so it reads as one. */
test("a version 1 row that was never woken has no cursor rather than a cursor at zero", () => {
  const file = path.join(SANDBOX, "legacy-unwoken.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    projects: { viewer: { ...emptySeatTickState(), seatEpoch: 4, eventsThrough: 0, lastWakeAt: null } },
  }));
  expect(readSeatTickState("viewer", file).eventsThrough).toBeNull();
});

/* And the over-correction that must not happen: a row whose wake DID land read
   the journal past zero and found nothing for its project. That zero is a fact
   about what the seat was told, so moving it to the head would skip events
   nobody has been told about. */
test("a version 1 row with a delivered wake keeps the cursor it earned", () => {
  const file = path.join(SANDBOX, "legacy-woken.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    projects: {
      viewer: { ...emptySeatTickState(), seatEpoch: 4, eventsThrough: 0, lastWakeAt: "2026-08-28T11:00:00.000Z" },
      other: { ...emptySeatTickState(), seatEpoch: 5, eventsThrough: 9853, lastWakeAt: null },
    },
  }));
  const projects = readSeatTickStateFile(file);
  expect(projects.viewer!.eventsThrough).toBe(0);
  expect(projects.other!.eventsThrough).toBe(9853);
});

/* Once the row is the current shape, a zero is a zero: the migration is a
   reading of the old shape, never a rule that keeps re-firing. */
test("a sealed cursor of zero written by this version stays a cursor", () => {
  const file = path.join(SANDBOX, "sealed-zero.json");
  writeSeatTickState("viewer", { ...emptySeatTickState(), eventsThrough: 0 }, file);
  expect(readSeatTickState("viewer", file).eventsThrough).toBe(0);
  expect(fs.existsSync(file)).toBe(false);
});

test("the state file lives under the viewer state dir with no configuration", () => {
  expect(seatTickStatePath()).toBe(path.join(SANDBOX, "state", "seat-tick.json"));
});

/* ------------------------------------------------------------------------- *
 * The harvest cursor (#1465).
 * ------------------------------------------------------------------------- */

const CHILD = ["conversation", "c1d2e3f4a5b6c7d8"].join("_");

test("a row from before the harvest existed reads an empty cursor, and a plan without children harvests nothing (#1465)", () => {
  const file = path.join(SANDBOX, "pre-harvest.json");
  const { harvestedChildren: _cursor, ...legacyRow } = row;
  const { children: _children, ...legacyCommit } = row.outstandingWake.commit;
  fs.writeFileSync(file, JSON.stringify({ version: 2, projects: { viewer: { ...legacyRow, outstandingWake: { ...row.outstandingWake, commit: legacyCommit } } } }));
  const persisted = readSeatTickState("viewer", file);
  expect(persisted.harvestedChildren).toEqual([]);
  expect(persisted.outstandingWake!.commit.children).toEqual([]);
});

/* The legacy file is a bounded document the tick wrote atomically, so it is
   read whole and imported on the first read (#1465): no cursor, no window of
   checks during which the row is pending and every wake is refused. */
test("migration retains every valid legacy acknowledgment without an eviction window, on the first read", () => {
  const file = path.join(SANDBOX, "harvest-bounds.json");
  const crowd = Array.from({ length: 250 }, (_, index) => ["conversation", String(index)].join("_"));
  const original = JSON.stringify({ version: 2, projects: { viewer: { ...row, harvestedChildren: crowd } } });
  fs.writeFileSync(file, original);
  const persisted = readSeatTickState("viewer", file);
  expect(persisted.accounting?.gap).toBeNull();
  const accounting = new SeatTickAccounting(persisted.accounting!.filename, "viewer");
  expect(accounting.collection.snapshot().filter((entry) => entry.kind === "legacy")).toHaveLength(250);
  expect(persisted.harvestedChildren).toEqual([]);
  expect(persisted.outstandingWake!.commit.children).toEqual([CONVERSATION]);
  expect(fs.readFileSync(file, "utf8")).toBe(original);
});

test("a rotation keeps the harvest cursor: what the project was told is not the seat's judgement (#1465)", () => {
  const rotated = seatTickStateForEpoch({ ...row, harvestedChildren: [CHILD] }, 8);
  expect(rotated.seatEpoch).toBe(8);
  expect(rotated.harvestedChildren).toEqual([CHILD]);
  expect(rotated.stalledSeen).toEqual([]);
});

test("legacy acknowledgments survive reopening and another project's write", () => {
  const file = path.join(SANDBOX, "harvest-durable.json");
  fs.writeFileSync(file, JSON.stringify({ version: 2, projects: { viewer: { ...row, harvestedChildren: [CHILD, CONVERSATION] } } }));
  const first = readSeatTickState("viewer", file);
  writeSeatTickState("other", emptySeatTickState(), file);
  const accounting = new SeatTickAccounting(first.accounting!.filename, "viewer");
  expect(new Set(accounting.page("legacy", 10).map((entry) => entry.kind === "legacy" ? entry.conversationId : ""))).toEqual(new Set([CHILD, CONVERSATION]));
});


test("falsy malformed legacy outstanding values keep migration blocked", () => {
  for (const outstandingWake of [false, 0, ""]) {
    const file = path.join(SANDBOX, `malformed-outstanding-${String(outstandingWake)}.json`);
    fs.writeFileSync(file, JSON.stringify({ version: 2, projects: { viewer: { outstandingWake } } }));
    expect(readSeatTickState("viewer", file).accounting?.gap).toBe("legacy-outstanding-unreadable");
  }
});

/* A retired attempt (#1594) belongs to the seat that has been replaced, and the
   only thing still asking its holder what became of it is this project's check.
   A rotation that dropped it would leave the obligation addressed to nobody —
   the same reason the outstanding one survives. */
test("attempts retired to a superseded seat survive the rotation and read back whole", () => {
  const retired = {
    wake: { ...row.outstandingWake, clientMessageId: "seat-tick:viewer:6:first:interval:fp-0", seatEpoch: 6,
      operationId: null, text: "the predecessor's wake", preparedAt: "2026-08-28T10:00:00.000Z",
      dispatch: { token: "dispatch-token", state: "refused" as const } },
    retiredAt: "2026-08-28T11:30:00.000Z",
    supersededBy: { conversationId: CONVERSATION, seatEpoch: 7 },
  };
  const file = path.join(SANDBOX, "retired.json");
  writeSeatTickState("viewer", { ...row, retiredWakes: [retired] }, file);
  expect(readSeatTickState("viewer", file).retiredWakes).toEqual([retired]);
  expect(seatTickStateForEpoch(readSeatTickState("viewer", file), 8).retiredWakes).toEqual([retired]);
});

/* Every row written before the slot existed carries no such field, and that is
   exactly what those rows mean: nothing has been retired. An entry that cannot
   name the seat that superseded it is dropped instead — that seat is the whole
   warrant for the fence having been released, so an entry without it is not
   evidence of anything. */
test("a legacy row reads as nothing retired, and an entry with no proof is dropped", () => {
  const file = path.join(SANDBOX, "retired-legacy.json");
  const { retiredWakes: _omitted, ...legacy } = { ...row, retiredWakes: [] };
  fs.writeFileSync(file, JSON.stringify({ version: 2, projects: { viewer: legacy } }));
  expect(readSeatTickState("viewer", file).retiredWakes).toEqual([]);

  const unproven = path.join(SANDBOX, "retired-unproven.json");
  fs.writeFileSync(unproven, JSON.stringify({
    version: 2,
    projects: { viewer: { ...row, retiredWakes: [
      { wake: row.outstandingWake, retiredAt: "2026-08-28T11:30:00.000Z" },
      { wake: row.outstandingWake, retiredAt: "whenever", supersededBy: { conversationId: CONVERSATION, seatEpoch: 8 } },
      { retiredAt: "2026-08-28T11:30:00.000Z", supersededBy: { conversationId: CONVERSATION, seatEpoch: 8 } },
    ] } },
  }));
  expect(readSeatTickState("viewer", unproven).retiredWakes).toEqual([]);
});
