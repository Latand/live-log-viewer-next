import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RUNNING_PAGE, RUNNING_ROTATE, SeatTickAccounting } from "./seatTickAccounting";
import { emptySeatTickState, SEAT_TICK_RETIRED_WAKE_LIMIT, type SeatTickChildInput } from "./types";

const CONVERSATION = ["conversation", "seat"].join("_");

test("prepared wake survives reopening, rejects concurrent preparation and lands once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-accounting-"));
  try {
    const filename = path.join(dir, "state.sqlite");
    const first = new SeatTickAccounting(filename, "project");
    first.initialize(emptySeatTickState(), null);
    const before = first.readState();
    const wake = { clientMessageId: "original", conversationId: CONVERSATION, seatEpoch: 1,
      operationId: null, text: "frozen payload", preparedAt: "2026-09-05T11:00:00.000Z", commit: { proposal: false, reasons: [], fingerprint: "one", eventsThrough: 0, children: [] } };
    expect(first.prepare(before, wake)).toBe(true);
    const reopened = new SeatTickAccounting(filename, "project");
    expect(reopened.readState().outstandingWake).toEqual(wake);
    expect(reopened.prepare(before, { ...wake, clientMessageId: "replacement" })).toBe(false);
    expect(() => first.writeState(before)).toThrow("stale");
    expect(reopened.settle("wrong-key", reopened.readState(), "landed")).toBe(false);
    expect(reopened.readState().outstandingWake).toEqual(wake);
    expect(reopened.settle("original", { ...reopened.readState(), lastWakeAt: "2026-09-05T12:00:00.000Z" }, "landed")).toBe(true);
    expect(first.settle("original", before, "landed")).toBe(false);
    expect(first.readState().lastWakeAt).toBe("2026-09-05T12:00:00.000Z");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* The two ways an attempt ends (#1465): `unsent` is proven non-delivery and
   moves no stamp; only `landed` stamps and acknowledges. */
test("an attempt ended unsent moves no stamp and acknowledges nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-accounting-endings-"));
  try {
    const filename = path.join(dir, "state.sqlite");
    const accounting = new SeatTickAccounting(filename, "project");
    accounting.initialize({ ...emptySeatTickState(), lastWakeAt: "2026-09-05T10:00:00.000Z", quietSince: "2026-09-05T10:30:00.000Z" }, null);
    const wake = { clientMessageId: "attempt", conversationId: CONVERSATION, seatEpoch: 1, operationId: null,
      commit: { proposal: false, reasons: ["interval" as const], fingerprint: "one", eventsThrough: 9, children: [] } };
    expect(accounting.prepare(accounting.readState(), wake)).toBe(true);
    expect(accounting.settle("attempt", accounting.readState(), "unsent")).toBe(true);
    expect(accounting.readState()).toMatchObject({ outstandingWake: null, lastWakeAt: "2026-09-05T10:00:00.000Z", eventsThrough: null, quietSince: "2026-09-05T10:30:00.000Z" });
    /* The same attempt may be prepared again afterwards. */
    expect(accounting.prepare(accounting.readState(), wake)).toBe(true);
    expect(accounting.readState().outstandingWake).toEqual(wake);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function childInput(id: string, status: SeatTickChildInput["status"] = "running"): SeatTickChildInput {
  return { conversationId: id, title: id, status, outcome: null, terminalAt: null, activity: null };
}

/* Running tickets are a FIFO the check observes eight of and rotates four of,
   so every running child is observed on two consecutive checks once per cycle
   (#1465). The fixed identity-ordered eight this replaces never observed the
   ninth. */
test("running tickets rotate so every running child is observed on two consecutive checks, and one that stops running leaves the queue", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-accounting-running-"));
  try {
    const accounting = new SeatTickAccounting(path.join(dir, "state.sqlite"), "project");
    accounting.initialize(emptySeatTickState(), null);
    const owner = accounting.owner(CONVERSATION, 1);
    const children = Array.from({ length: 12 }, (_, index) => accounting.child(`row-${index}`, CONVERSATION, `launch-${index}`, childInput(`child-${index}`)));
    accounting.discovery(owner, children.map((child) => ({ child })));
    expect(accounting.page("running", 60)).toHaveLength(12);

    const observed: string[][] = [];
    for (let check = 0; check < 6; check++) {
      const page = accounting.page("running", RUNNING_PAGE);
      observed.push(page.map((ticket) => ticket.kind === "running" ? (accounting.get(ticket.target) as { input: SeatTickChildInput }).input.conversationId : ""));
      accounting.rotateRunning(page.slice(0, RUNNING_ROTATE));
    }
    expect(observed[0]).toEqual(children.slice(0, 8).map((child) => child.input.conversationId));
    expect(observed[1]).toEqual([...children.slice(4, 12)].map((child) => child.input.conversationId));
    /* The twelfth child is observed on checks two and three in a row. */
    expect(observed[1]).toContain("child-11");
    expect(observed[2]).toContain("child-11");
    for (const child of children) {
      const seen = observed.map((page, index) => page.includes(child.input.conversationId) ? index : -1).filter((index) => index >= 0);
      expect(seen.some((index, position) => seen[position + 1] === index + 1)).toBe(true);
    }
    /* The queue still holds exactly one ticket per running child. */
    expect(accounting.page("running", 60)).toHaveLength(12);
    const rows = accounting.page("child", 60).flatMap((row) => row.kind === "child" ? [row] : []);
    expect(new Set(rows.map((row) => row.runningKey)).size).toBe(12);

    /* A child that stops running leaves the queue when it is polled; one that
       runs again re-enters at the tail. */
    const polled = accounting.page("poll", 1)[0]!;
    if (polled.kind !== "poll") throw new Error("fixture");
    const target = accounting.get(polled.target)!;
    if (target.kind !== "child") throw new Error("fixture");
    expect(target.pollKey).toBe(polled.key);
    accounting.ingest({ ...target, input: childInput(target.input.conversationId, "terminal") }, null, []);
    expect(accounting.page("running", 60)).toHaveLength(11);
    expect((accounting.get(target.key) as { runningKey: string | null }).runningKey).toBeNull();
    const again = accounting.page("poll", 60).find((ticket) => ticket.kind === "poll" && ticket.target === target.key)!;
    expect((accounting.get(target.key) as typeof target).pollKey).toBe(again.key);
    accounting.ingest({ ...(accounting.get(target.key) as typeof target), input: childInput(target.input.conversationId, "running") }, null, []);
    expect(accounting.page("running", 60)).toHaveLength(12);
    expect(accounting.page("running", 60).at(-1)!.kind === "running" && (accounting.page("running", 60).at(-1) as { target: string }).target).toBe(target.key);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* The legacy tick state is a bounded document written atomically: it is read
   whole and parsed once, so the migration is complete on the first read
   (#1465). No cursor, no window of checks, no partial import. */
test("the legacy JSON row is imported in one read, acknowledgments become rows, and a file that cannot be trusted blocks with its reason", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-accounting-legacy-"));
  try {
    const normalize = (raw: Record<string, unknown>) => ({ ...emptySeatTickState(), lastWakeAt: typeof raw.lastWakeAt === "string" ? raw.lastWakeAt : null });
    const crowd = Array.from({ length: 2_500 }, (_, index) => ["conversation", String(index)].join("_"));
    const legacy = path.join(dir, "seat-tick.json");
    fs.writeFileSync(legacy, JSON.stringify({ version: 2, projects: { viewer: { lastWakeAt: "2026-09-05T10:00:00.000Z", harvestedChildren: crowd }, other: {} } }));
    const viewer = new SeatTickAccounting(path.join(dir, "state.sqlite"), "viewer");
    viewer.migrateLegacy(legacy, normalize);
    expect(viewer.row()).toMatchObject({ migration: "ready", gap: null });
    expect(viewer.readState()).toMatchObject({ lastWakeAt: "2026-09-05T10:00:00.000Z", accounting: { gap: null } });
    expect(viewer.collection.snapshot().filter((row) => row.kind === "legacy")).toHaveLength(2_500);
    /* A project the file never named starts empty and ready. */
    const absent = new SeatTickAccounting(path.join(dir, "state.sqlite"), "unnamed");
    absent.migrateLegacy(legacy, normalize);
    expect(absent.row()).toMatchObject({ migration: "ready", gap: null });
    /* A file that is not a document, one whose projects are not an object and
       one whose acknowledgments are not identities each block with a reason. */
    const cases: [string, string][] = [
      ["{ not json", "legacy-json-malformed"],
      [JSON.stringify({ version: 2, projects: [] }), "legacy-projects-unreadable"],
      [JSON.stringify({ version: 2, projects: { blocked: { harvestedChildren: [42] } } }), "legacy-acknowledgments-unreadable"],
      [JSON.stringify({ version: 2, projects: { blocked: { outstandingWake: false } } }), "legacy-outstanding-unreadable"],
    ];
    for (const [body, gap] of cases) {
      const file = path.join(dir, `${gap}.json`);
      fs.writeFileSync(file, body);
      const blocked = new SeatTickAccounting(path.join(dir, `${gap}.sqlite`), "blocked");
      blocked.migrateLegacy(file, normalize);
      expect(blocked.row()).toMatchObject({ migration: "unknown", gap });
      expect(blocked.readState().accounting?.gap).toBe(gap);
    }
    /* Fixing the file unblocks the next read. */
    const fixable = path.join(dir, "legacy-json-malformed.json");
    fs.writeFileSync(fixable, JSON.stringify({ version: 2, projects: { blocked: {} } }));
    const unblocked = new SeatTickAccounting(path.join(dir, "legacy-json-malformed.sqlite"), "blocked");
    unblocked.migrateLegacy(fixable, normalize);
    expect(unblocked.row()).toMatchObject({ migration: "ready", gap: null });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* The seat file is read whole once per change (#1465): committed revocations
   for the project become predecessor owners, pending history grants nothing,
   and an unchanged file is not read again. */
test("predecessor owners come from the seat file's committed revocations, read once per change", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-accounting-owners-"));
  try {
    const accounting = new SeatTickAccounting(path.join(dir, "state.sqlite"), "viewer");
    accounting.initialize(emptySeatTickState(), null);
    const seats = path.join(dir, "orchestrator-seats.json");
    const predecessor = ["conversation", "predecessor"].join("_");
    const write = (revocations: unknown[], history: unknown[] = []) => fs.writeFileSync(seats, JSON.stringify({ schemaVersion: 1, nextSeatEpoch: 9, seats: {}, pending: {}, revocations, history }));
    write([
      { project: "viewer", conversationId: predecessor, seatEpoch: 6, revokedAt: "2026-09-05T10:00:00.000Z", successorConversationId: null },
      { project: "other", conversationId: ["conversation", "elsewhere"].join("_"), seatEpoch: 3, revokedAt: "2026-09-05T10:00:00.000Z", successorConversationId: null },
      { project: "viewer", conversationId: "not-a-conversation", seatEpoch: 5, revokedAt: "2026-09-05T10:00:00.000Z" },
    ], [{ seat: { project: "viewer", conversationId: ["conversation", "abandoned"].join("_"), seatEpoch: 4, state: "pending" }, reason: "terminal_error" }]);
    expect(accounting.discoverRevokedOwners(seats, (project) => project === "viewer")).toBe(false);
    const owners = accounting.page("owner", 20).flatMap((row) => row.kind === "owner" ? [row] : []);
    expect(owners.map((owner) => [owner.conversationId, owner.epoch])).toEqual([[predecessor, 6]]);
    expect(accounting.page("owner-poll", 20)).toHaveLength(1);
    /* Unchanged: not read again, no new rows. */
    const revision = accounting.row()!.revision;
    expect(accounting.discoverRevokedOwners(seats, (project) => project === "viewer")).toBe(false);
    expect(accounting.row()!.revision).toBe(revision);
    /* A file that cannot be parsed is a gap until it changes; an absent one is not. */
    fs.writeFileSync(seats, "{ torn");
    expect(accounting.discoverRevokedOwners(seats, () => true)).toBe(true);
    expect(accounting.discoverRevokedOwners(seats, () => true)).toBe(true);
    fs.unlinkSync(seats);
    expect(accounting.discoverRevokedOwners(seats, () => true)).toBe(false);
    /* A contradictory owner for a recorded epoch is refused, never overwritten. */
    write([{ project: "viewer", conversationId: ["conversation", "impostor"].join("_"), seatEpoch: 6, revokedAt: "2026-09-05T11:00:00.000Z" }]);
    expect(() => accounting.discoverRevokedOwners(seats, (project) => project === "viewer")).toThrow("contradictory predecessor ownership");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* The poll queue is FIFO by sequence, with a head lane in front of it (#1465):
   a child discovery classifies terminal, a ledger the budget cut, and a
   settled child promoted from the running window are read by the next visit
   rather than after every cold child ahead of them — and every child still
   holds exactly one poll ticket, the one its row points at. */
test("head tickets sort before the tail, a promotion moves a child's one ticket, and a stale ticket is dropped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-accounting-head-"));
  try {
    const accounting = new SeatTickAccounting(path.join(dir, "state.sqlite"), "project");
    accounting.initialize(emptySeatTickState(), null);
    const owner = accounting.owner(CONVERSATION, 1);
    expect(accounting.page("owner-poll", 5).map((ticket) => ticket.kind === "owner-poll" && ticket.target)).toEqual([owner.key]);
    expect(owner.pollKey).toBe(accounting.page("owner-poll", 1)[0]!.key);
    const cold = Array.from({ length: 5 }, (_, index) => accounting.child(`cold-${index}`, CONVERSATION, `launch-cold-${index}`, childInput(`cold-${index}`, "terminal")));
    accounting.discovery(owner, cold.map((child) => ({ child })));
    /* The owner's ticket moved to the tail of its queue and its anchor is the
       one the page returned; the queue holds five tail tickets in order. */
    const advanced = accounting.get(owner.key)!;
    expect(advanced.kind === "owner" && advanced.pollKey).not.toBe(owner.pollKey);
    const order = () => accounting.page("poll", 60).map((ticket) => ticket.kind === "poll" ? (accounting.get(ticket.target) as { input: SeatTickChildInput }).input.conversationId : "");
    expect(order()).toEqual(["cold-0", "cold-1", "cold-2", "cold-3", "cold-4"]);
    /* A later discovery finds one terminal child and one running child: the
       terminal one enters at the head, the running one at the tail. */
    const found = accounting.child("found", CONVERSATION, "launch-found", childInput("found", "terminal"));
    const fresh = accounting.child("fresh", CONVERSATION, "launch-fresh", childInput("fresh"));
    accounting.discovery(accounting.get(owner.key) as typeof owner, [{ child: found, position: "head" }, { child: fresh, position: "tail" }]);
    expect(order()).toEqual(["found", "cold-0", "cold-1", "cold-2", "cold-3", "cold-4", "fresh"]);
    /* A poll re-queued at the head resumes first; one re-queued at the tail waits. */
    const first = accounting.get(found.key) as typeof found;
    accounting.ingest(first, null, [], false, "head");
    expect(order()).toEqual(["found", "cold-0", "cold-1", "cold-2", "cold-3", "cold-4", "fresh"]);
    accounting.ingest(accounting.get(found.key) as typeof found, null, [], false, "tail");
    expect(order()).toEqual(["cold-0", "cold-1", "cold-2", "cold-3", "cold-4", "fresh", "found"]);
    /* A promotion moves the child's one ticket to the head; promoting a
       child already there changes nothing. */
    accounting.promote(accounting.get(fresh.key) as typeof fresh);
    expect(order()).toEqual(["fresh", "cold-0", "cold-1", "cold-2", "cold-3", "cold-4", "found"]);
    const revision = accounting.row()!.revision;
    accounting.promote(accounting.get(fresh.key) as typeof fresh);
    expect(accounting.row()!.revision).toBe(revision);
    expect(accounting.page("poll", 60)).toHaveLength(7);
    /* Two heads keep their own order: the earlier promotion stays first. */
    accounting.promote(accounting.get(cold[4]!.key) as typeof fresh);
    expect(order()).toEqual(["fresh", "cold-4", "cold-0", "cold-1", "cold-2", "cold-3", "found"]);
    /* A ticket its child does not claim is dropped, and the claimed one stays. */
    const stale = accounting.page("poll", 1)[0]!;
    accounting.drop(stale);
    expect(order()).toEqual(["cold-4", "cold-0", "cold-1", "cold-2", "cold-3", "found"]);
    /* An ingest of a child whose ticket another controller already took is a
       no-op: no second ticket, no outcome rows. */
    const claimed = accounting.get(cold[0]!.key) as typeof fresh;
    accounting.ingest({ ...claimed, pollKey: stale.key }, null, [], false, "head");
    expect(order()).toEqual(["cold-4", "cold-0", "cold-1", "cold-2", "cold-3", "found"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("key-sweep accounting migrates lazily without losing cursors, acknowledgments or cold tickets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-accounting-upgrade-"));
  try {
    const filename = path.join(dir, "state.sqlite");
    const accounting = new SeatTickAccounting(filename, "project");
    accounting.initialize(emptySeatTickState(), null);
    const owner = accounting.owner(CONVERSATION, 1);
    const child = accounting.child("child-row", CONVERSATION, "child-launch", childInput("child-row", "terminal"));
    accounting.discovery(owner, [{ child }]);
    const stored = accounting.get(child.key) as typeof child;
    const source = accounting.source(stored, "claude", "generation");
    source.cursor = { ...source.cursor, identity: "1:1", seq: 2, settledThrough: 2, offset: 100, initialSize: 100, atEnd: true };
    accounting.ingest(stored, source, [{ turnId: "turn-one", status: "completed", seq: 2, endOffset: 100 }]);
    const outcome = accounting.ready(1)[0]!;
    const wake = { clientMessageId: "landed", conversationId: CONVERSATION, seatEpoch: 1, operationId: null,
      commit: { proposal: false, reasons: [], fingerprint: "one", eventsThrough: 0, children: [outcome.identity] } };
    expect(accounting.prepare(accounting.readState(), wake)).toBe(true);
    accounting.settle(wake.clientMessageId, { ...accounting.readState(), lastWakeAt: "2026-09-05T12:00:00.000Z" }, "landed");
    const acknowledged = accounting.get(outcome.key);
    const cursor = accounting.get(source.key);
    // Persist exactly the owner/child shapes from the published predecessor.
    accounting.collection.boundedPatch(4, (tx) => {
      const oldOwner = { ...tx.get(owner.key)!, after: "child-z", through: "child-z" } as Record<string, unknown>;
      delete oldOwner.pollKey;
      const oldChild = { ...tx.get(child.key)! } as Record<string, unknown>;
      delete oldChild.pollKey;
      tx.put(oldOwner as never); tx.put(oldChild as never);
    });
    const reopened = new SeatTickAccounting(filename, "project");
    const migrated = reopened.owner(CONVERSATION, 1);
    expect(migrated.after).toBeNull();
    expect(migrated.pollKey).toBeTruthy();
    const poll = reopened.page("poll", 1)[0]!;
    const adopted = reopened.adoptPoll(reopened.get(child.key) as typeof child, poll.key);
    expect(adopted.pollKey).toBe(poll.key);
    reopened.discovery(migrated, [{ child }]);
    expect(reopened.page("child", 20)).toHaveLength(1);
    expect(reopened.page("poll", 20)).toHaveLength(1);
    expect(reopened.get(outcome.key)).toEqual(acknowledged);
    expect(reopened.get(source.key)).toEqual(cursor);
    expect(reopened.ready(20)).toEqual([]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("cold FIFO visits remain reserved beside a full priority backlog", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-accounting-fair-"));
  try {
    const accounting = new SeatTickAccounting(path.join(dir, "state.sqlite"), "project");
    accounting.initialize(emptySeatTickState(), null);
    const owner = accounting.owner(CONVERSATION, 1);
    const cold = Array.from({ length: 20 }, (_, n) => accounting.child(`cold-${n}`, CONVERSATION, `cold-launch-${n}`, childInput(`cold-${n}`, "terminal")));
    const priority = Array.from({ length: 60 }, (_, n) => accounting.child(`hot-${n}`, CONVERSATION, `hot-launch-${n}`, childInput(`hot-${n}`, "terminal")));
    accounting.discovery(owner, [...cold.map((child) => ({ child })), ...priority.map((child) => ({ child, position: "head" as const }))]);
    const seen = new Set<string>();
    for (let tick = 0; tick < 3; tick++) {
      const visits = accounting.pollPage(40);
      expect(visits).toHaveLength(40);
      const visitedCold = visits.filter((ticket) => ticket.kind === "poll" && cold.some((child) => child.key === ticket.target));
      expect(visitedCold.length).toBeGreaterThanOrEqual(8);
      for (const ticket of visits) if (ticket.kind === "poll") {
        const child = accounting.get(ticket.target) as ReturnType<typeof accounting.child>;
        const isCold = child.rowKey.startsWith("cold-");
        if (isCold) seen.add(child.rowKey);
        accounting.ingest(child, null, [], false, isCold ? "tail" : "head");
      }
    }
    expect(seen.size).toBe(20);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* Retirement (#1594) moves an attempt out of the fence and nowhere else. It is
   still the same attempt — key, payload, landing plan, dispatch record — and it
   is now the replaced seat's obligation rather than a hold on the successor's
   wake. */
test("an attempt retired to a superseded seat keeps everything except its fence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-accounting-retire-"));
  try {
    const accounting = new SeatTickAccounting(path.join(dir, "state.sqlite"), "project");
    accounting.initialize(emptySeatTickState(), null);
    const wake = { clientMessageId: "original", conversationId: CONVERSATION, seatEpoch: 140, operationId: null,
      text: "frozen payload", preparedAt: "2026-09-08T05:14:24.000Z",
      commit: { proposal: false, reasons: [], fingerprint: "fp-1", eventsThrough: 7, children: [] } };
    expect(accounting.prepare(accounting.readState(), wake)).toBe(true);
    const token = accounting.beginDispatch(accounting.readState().outstandingWake!)!;
    accounting.returnedDispatch("original", token, true);
    const held = accounting.readState().outstandingWake!;
    expect(held.dispatch).toMatchObject({ state: "refused" });

    const supersededBy = { conversationId: CONVERSATION, seatEpoch: 155 };
    expect(accounting.retire({ ...held, clientMessageId: "another" }, "2026-09-09T15:47:00.000Z", supersededBy)).toBe(false);
    expect(accounting.retire(held, "2026-09-09T15:47:00.000Z", supersededBy)).toBe(true);
    const retired = accounting.readState();
    expect(retired.outstandingWake).toBeNull();
    expect(retired.retiredWakes).toEqual([{ wake: held, retiredAt: "2026-09-09T15:47:00.000Z", supersededBy }]);

    /* The one thing it can never do again is enter transport: the admission
       fence claims the OUTSTANDING attempt, which this is no longer, and
       neither ending that could release one applies to it. */
    expect(accounting.beginDispatch(held)).toBeNull();
    expect(accounting.settleAbsent(held)).toBe(false);
    expect(accounting.settle("original", retired, "unsent")).toBe(false);
    expect(accounting.readState().retiredWakes).toHaveLength(1);

    /* The successor prepares against an empty fence, and its attempt and the
       retired one are accounted for separately. */
    expect(accounting.prepare(accounting.readState(), { ...wake, clientMessageId: "successor", seatEpoch: 155 })).toBe(true);
    expect(accounting.settleRetired("original")).toBe(true);
    expect(accounting.settleRetired("original")).toBe(false);
    expect(accounting.readState().retiredWakes).toEqual([]);
    expect(accounting.readState().outstandingWake).toMatchObject({ clientMessageId: "successor" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* Two bounds on the move. A transport call that was still out when the seat was
   superseded reports back to wherever its attempt now is, or the retired entry
   would claim a call is in flight for as long as the row lives. And a row that
   has reached its retention bound refuses to retire another — keeping the
   fence, which is what the tick did before any of this, rather than discarding
   an obligation to make room. */
test("a transport return follows a retired attempt, and the retention bound refuses the next one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-accounting-retire-bound-"));
  try {
    const accounting = new SeatTickAccounting(path.join(dir, "state.sqlite"), "project");
    accounting.initialize(emptySeatTickState(), null);
    const supersededBy = { conversationId: CONVERSATION, seatEpoch: 999 };
    const attempt = (n: number) => ({ clientMessageId: `attempt-${n}`, conversationId: CONVERSATION, seatEpoch: n, operationId: null,
      text: "frozen payload", preparedAt: "2026-09-08T05:14:24.000Z",
      commit: { proposal: false, reasons: [], fingerprint: `fp-${n}`, eventsThrough: n, children: [] } });

    expect(accounting.prepare(accounting.readState(), attempt(0))).toBe(true);
    const token = accounting.beginDispatch(accounting.readState().outstandingWake!)!;
    expect(accounting.retire(accounting.readState().outstandingWake!, "2026-09-09T15:47:00.000Z", supersededBy)).toBe(true);
    accounting.returnedDispatch("attempt-0", token, true);
    expect(accounting.readState().retiredWakes[0]!.wake.dispatch).toEqual({ token, state: "refused" });

    for (let n = 1; n < SEAT_TICK_RETIRED_WAKE_LIMIT; n++) {
      expect(accounting.prepare(accounting.readState(), attempt(n))).toBe(true);
      expect(accounting.retire(accounting.readState().outstandingWake!, "2026-09-09T15:47:00.000Z", supersededBy)).toBe(true);
    }
    expect(accounting.readState().retiredWakes).toHaveLength(SEAT_TICK_RETIRED_WAKE_LIMIT);

    const overflow = attempt(SEAT_TICK_RETIRED_WAKE_LIMIT);
    expect(accounting.prepare(accounting.readState(), overflow)).toBe(true);
    expect(accounting.retire(accounting.readState().outstandingWake!, "2026-09-09T15:47:00.000Z", supersededBy)).toBe(false);
    expect(accounting.readState().outstandingWake).toMatchObject({ clientMessageId: overflow.clientMessageId });
    expect(accounting.readState().retiredWakes).toHaveLength(SEAT_TICK_RETIRED_WAKE_LIMIT);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
