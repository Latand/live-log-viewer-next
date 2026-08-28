import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-tick-controller-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const { reconcileSeatTick, runSeatTickCheck, startSeatTick, stopSeatTick, wakeReached } = await import("./seatTickController");
const { DEFAULT_SEAT_TICK_POLICY } = await import("./seatTick");
import type { SeatTickControllerDependencies } from "./seatTickController";
import type { SeatTickPendingDelivery } from "./seatTickSources";
import { emptySeatTickState, type SeatTickCard, type SeatTickProjectState, type SeatTickRunRecord } from "./types";
import type { AgentLivenessRecord } from "@/lib/lifecycle/liveness";
import type { LifecycleEvent } from "@/lib/lifecycle/journal";
import type { ConversationMessage, DeliveryOutcome } from "@/lib/delivery";

const PROJECT = "viewer";
const CONVERSATION = ["conversation", "0f4c21b7729fbc9e"].join("_");
const SUCCESSOR = ["conversation", "5b7729fbc9e0f4c2"].join("_");
const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const MINUTE = 60_000;

afterEach(() => stopSeatTick());
afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface Harness {
  deps: SeatTickControllerDependencies;
  sent: ConversationMessage[];
  journal: SeatTickRunRecord[];
  cards: { project: string; card: SeatTickCard }[];
  written: SeatTickProjectState[];
  revoked: { id: string; reason: string }[];
  seat: { conversationId: string; seatEpoch: number; path: string | null } | null;
}

function harness(options: {
  seat?: { conversationId: string; seatEpoch: number; path: string | null } | null;
  turn?: "busy" | "idle";
  seatActivity?: Partial<AgentLivenessRecord> | null;
  pipelines?: { id: string; state: string; createdAt: string; movedAt: string | null }[];
  tasks?: { id: string; status: "inbox" | "assigned" | "blocked" | "done" }[];
  events?: LifecycleEvent[];
  state?: Partial<SeatTickProjectState>;
  delivery?: DeliveryOutcome;
  deliveryThrows?: boolean;
  /** Swaps the seat after the decision, the way a rotation lands mid-check. */
  rotateBeforeSend?: { conversationId: string; seatEpoch: number; path: string | null } | null;
  /** What the runtime is still holding for the seat's conversation. */
  pending?: SeatTickPendingDelivery[];
  pendingThrows?: boolean;
}): Harness {
  const sent: ConversationMessage[] = [];
  const journal: SeatTickRunRecord[] = [];
  const cards: { project: string; card: SeatTickCard }[] = [];
  const written: SeatTickProjectState[] = [];
  const revoked: { id: string; reason: string }[] = [];
  const result: Harness = { deps: {}, sent, journal, cards, written, revoked, seat: options.seat === undefined ? { conversationId: CONVERSATION, seatEpoch: 7, path: null } : options.seat };
  let gathered = false;

  const pipelines = (options.pipelines ?? []).map((entry) => ({
    id: entry.id,
    task: `lane ${entry.id}`,
    taskIds: [],
    project: PROJECT,
    repoDir: "/srv/repo",
    worktreeDir: "/srv/worktree",
    branch: "topic",
    baseBranch: "main",
    baseRef: "main",
    lastPassedCommit: "",
    stages: [],
    runs: entry.movedAt ? [{ stageId: "build", attempts: [{ n: 1, state: "passed", startedAt: entry.movedAt, completedAt: entry.movedAt }] }] : [],
    cursor: null,
    state: entry.state,
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: entry.createdAt,
    closedAt: null,
  }));

  const tasks = (options.tasks ?? []).map((entry) => ({
    id: entry.id,
    project: PROJECT,
    status: entry.status,
    text: `card ${entry.id}`,
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-08-28T10:00:00.000Z",
    updatedAt: "2026-08-28T10:00:00.000Z",
  }));

  result.deps = {
    policy: DEFAULT_SEAT_TICK_POLICY,
    readState: () => ({ ...emptySeatTickState(), seatEpoch: result.seat?.seatEpoch ?? null, ...options.state }),
    writeState: (_project, row) => { written.push(row); },
    appendRecord: (record) => { journal.push(record); },
    ensureCard: (project, card) => { cards.push({ project, card }); },
    deliver: async (message) => {
      sent.push(message);
      if (options.deliveryThrows) throw new Error("the delivery layer is unavailable");
      return options.delivery ?? { ok: true, target: "structured", outcome: "delivered", structured: true };
    },
    proposalIssues: async () => [{ number: 1245, title: "the native seat tick", labels: ["design"], updatedAt: null }],
    sources: {
      seatFor: () => {
        /* The first read is the gather; every read after it is the re-check the
           send takes, which is where a rotation must be caught. */
        const seat = gathered && options.rotateBeforeSend !== undefined ? options.rotateBeforeSend : result.seat;
        gathered = true;
        return { active: seat as never, pending: null, history: [] };
      },
      activeSeats: () => [PROJECT],
      pipelines: () => pipelines as never,
      tasks: () => tasks as never,
      registry: () => ({
        conversation: () => ({ turn: { state: options.turn ?? "idle" } }),
        conversationForPath: () => null,
      }) as never,
      liveness: async (request) => (request.conversationId && options.seatActivity
        ? [{ lifecycle: "running", reason: "host_alive_turn_active", ...options.seatActivity } as AgentLivenessRecord]
        : []),
      lifecycleJournal: () => ({ version: 1, lastSeq: options.events?.at(-1)?.seq ?? 0, events: options.events ?? [], retired: [] }),
      deployments: () => ({ state: "unreadable", error: "no ledger" }) as never,
      retirementReport: () => null,
      pendingDeliveries: () => {
        if (options.pendingThrows) throw new Error("the registry cannot be read");
        return options.pending ?? [];
      },
      revokeDelivery: (id, reason) => { revoked.push({ id, reason }); },
      now: () => NOW,
    },
  };
  return result;
}

const OVERDUE = { lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() };
const OPEN_LANE = [{ id: "pipeline_a1", state: "running", createdAt: "2026-08-28T11:00:00.000Z", movedAt: "2026-08-28T11:58:00.000Z" }];

function terminalEvent(seq: number): LifecycleEvent {
  return {
    id: `event-${seq}`,
    seq,
    at: new Date(NOW - MINUTE).toISOString(),
    type: "review_verdict",
    state: "completed",
    project: PROJECT,
    pipelineId: "pipeline_a1",
    stageId: "review",
    attempt: 1,
    conversationId: null,
    role: "reviewer",
    summary: "the round passed",
  };
}

test("a quiet check writes one journal line, sends nothing, and raises no card", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: { lastWakeAt: new Date(NOW - 5 * MINUTE).toISOString() } });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "quiet", delivery: null, items: 0 });
  expect(rig.journal).toHaveLength(1);
  expect(rig.sent).toEqual([]);
  expect(rig.cards).toEqual([]);
});

test("a wake is delivered by durable conversation id, with an idempotent client message id", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toHaveLength(1);
  expect(rig.sent[0]).toMatchObject({ conversationId: CONVERSATION, pid: null, images: [] });
  expect(rig.sent[0]!.clientMessageId).toBe(record!.delivery!.clientMessageId);
  expect(record!.delivery!.clientMessageId.startsWith(`seat-tick:${PROJECT}:7:${OVERDUE.lastWakeAt}:interval:`)).toBe(true);
  expect(rig.written[0]!.lastWakeAt).toBe(new Date(NOW).toISOString());
});

/* Two checks that found the same thing raise the same wake, so a re-send after
   a send that never landed is the replay the delivery layer treats it as —
   rather than a second copy of a message the seat may yet receive. */
test("the wake's identity comes from what it says, so an unlanded wake re-sends as a replay", async () => {
  const held = { ok: true as const, target: null, outcome: "held" as const };
  const first = harness({ pipelines: OPEN_LANE, state: OVERDUE, delivery: held });
  await runSeatTickCheck(PROJECT, first.deps);
  const second = harness({ pipelines: OPEN_LANE, state: OVERDUE, delivery: held });
  await runSeatTickCheck(PROJECT, second.deps);
  expect(second.sent[0]!.clientMessageId).toBe(first.sent[0]!.clientMessageId);
});

/* The other half of the same key. An hourly wake on a board that has not moved
   carries the same reasons and the same fingerprint as the last one, so without
   the delivered-wake stamp in the key the delivery layer would swallow it as a
   replay — silence the seat cannot tell from a healthy board. */
test("the wake after a delivered one is a new message, not a replay of it", async () => {
  const first = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const before = await runSeatTickCheck(PROJECT, first.deps);
  const next = harness({
    pipelines: OPEN_LANE,
    state: { lastWakeAt: first.written[0]!.lastWakeAt, lastWakeFingerprint: first.written[0]!.lastWakeFingerprint },
  });
  /* An hour on, with the board in exactly the state it was left in. */
  next.deps.sources!.now = () => NOW + 61 * MINUTE;
  const after = await runSeatTickCheck(PROJECT, next.deps);
  expect(after!.verdict).toBe("wake");
  expect(after!.delivery!.clientMessageId).not.toBe(before!.delivery!.clientMessageId);
});

test("a seat that rotated between the decision and the send is never woken", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: OVERDUE,
    rotateBeforeSend: { conversationId: SUCCESSOR, seatEpoch: 8, path: null },
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toEqual([]);
  expect(record!.delivery).toMatchObject({ outcome: "seat-rotated" });
  expect(rig.written[0]!.lastWakeAt).toBe(OVERDUE.lastWakeAt);
});

test("a seat revoked with no successor is likewise refused at the send", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE, rotateBeforeSend: null });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toEqual([]);
  expect(record!.delivery).toMatchObject({ outcome: "seat-rotated" });
});

/* The finding this rule exists for: a delivery the layer accepted is not a
   delivery the seat has. A held or queued message would otherwise start the
   hourly clock and — worse — acknowledge the lane events that raised it. */
test("a held, queued, delivering or pending send is not a delivered wake", async () => {
  expect(wakeReached({ ok: true, target: null, outcome: "held" })).toBe(false);
  expect(wakeReached({ ok: true, target: null, outcome: "queued", operationId: "op", receipt: {} as never, structured: true })).toBe(false);
  expect(wakeReached({ ok: true, target: null, outcome: "delivering", operationId: "op", receipt: {} as never, structured: true })).toBe(false);
  expect(wakeReached({ ok: true, target: null, outcome: "pending" })).toBe(false);
  expect(wakeReached({ ok: true, target: "pane", outcome: "delivered-to-live" })).toBe(true);
  expect(wakeReached({ ok: true, target: null, outcome: "resumed" })).toBe(true);
  expect(wakeReached({ ok: true, target: "pane" })).toBe(true);
  expect(wakeReached({ ok: false, outcome: "failed", error: "gone", status: 409 })).toBe(false);
});

test("a held wake leaves the wake stamp and the event cursor exactly where they were", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    events: [terminalEvent(44)],
    state: { ...OVERDUE, eventsThrough: 12 },
    delivery: { ok: true, target: null, outcome: "held" },
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record!.delivery).toMatchObject({ outcome: "held" });
  expect(rig.written[0]!.lastWakeAt).toBe(OVERDUE.lastWakeAt);
  expect(rig.written[0]!.eventsThrough).toBe(12);
  expect(record!.eventsThrough).toBe(12);
});

/* The half of the epoch check the re-read before the send cannot do. The layer
   keeps a held or queued payload durably, so the seat can rotate while it
   waits — and it would then arrive at the predecessor, which is the failure
   this whole mechanism exists to end. */
test("a wake the layer kept is written down against the epoch it was raised for", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: OVERDUE,
    delivery: { ok: true, target: null, outcome: "held" },
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.written[0]!.outstandingWake).toEqual({
    clientMessageId: record!.delivery!.clientMessageId,
    conversationId: CONVERSATION,
    seatEpoch: 7,
  });
});

test("the next check takes that wake back the moment the epoch under it moves", async () => {
  const outstanding = { clientMessageId: "seat-tick:viewer:7:first:interval:fp-1", conversationId: CONVERSATION, seatEpoch: 7 };
  const rig = harness({
    seat: { conversationId: SUCCESSOR, seatEpoch: 8, path: null },
    pipelines: OPEN_LANE,
    /* The row the predecessor left: its epoch, and its unlanded wake. */
    state: { ...OVERDUE, seatEpoch: 7, outstandingWake: outstanding },
    pending: [
      { id: "delivery_kept", clientMessageId: outstanding.clientMessageId, state: "held" },
      { id: "delivery_other", clientMessageId: "someone-else", state: "held" },
    ],
  });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.revoked.map((entry) => entry.id)).toEqual(["delivery_kept"]);
  expect(rig.revoked[0]!.reason).toContain("has since been replaced");
  const revocation = rig.journal.find((line) => line.verdict === "revoked");
  expect(revocation).toMatchObject({ seatEpoch: 7, delivery: { outcome: "revoked" } });
  expect(rig.written[0]!.outstandingWake).toBeNull();
});

/* The same seat is not a replacement, so its unlanded wake stays outstanding —
   that one is the replay the next check re-raises under the same key. */
test("a seat that is still the same seat keeps its outstanding wake", async () => {
  const outstanding = { clientMessageId: "seat-tick:viewer:7:first:interval:fp-1", conversationId: CONVERSATION, seatEpoch: 7 };
  const rig = harness({
    pipelines: OPEN_LANE,
    state: { lastWakeAt: new Date(NOW - 5 * MINUTE).toISOString(), outstandingWake: outstanding },
    pending: [{ id: "delivery_kept", clientMessageId: outstanding.clientMessageId, state: "held" }],
  });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.revoked).toEqual([]);
  expect(rig.journal.some((line) => line.verdict === "revoked")).toBe(false);
  expect(rig.written[0]!.outstandingWake).toEqual(outstanding);
});

/* A rotation that lands while the send is in flight is the one the row cannot
   carry to a later check, because there may not be one before the payload
   flushes. So a retained send is re-checked at once. */
test("a rotation during the send is caught by the same check that made the wake", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: OVERDUE,
    delivery: { ok: true, target: null, outcome: "queued", operationId: "op", receipt: {} as never, structured: true },
  });
  let sends = 0;
  const seatFor = rig.deps.sources!.seatFor;
  rig.deps.sources!.seatFor = ((project: string) => {
    sends += 1;
    /* The gather and the pre-send re-check see the incumbent; the read after
       the send sees the successor that landed meanwhile. */
    return sends > 2
      ? { active: { conversationId: SUCCESSOR, seatEpoch: 8, path: null } as never, pending: null, history: [] }
      : seatFor(project);
  }) as typeof seatFor;
  rig.deps.sources!.pendingDeliveries = () => [{ id: "delivery_queued", clientMessageId: rig.sent[0]!.clientMessageId ?? null, state: "assigned" }];
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.revoked.map((entry) => entry.id)).toEqual(["delivery_queued"]);
  expect(rig.written[0]!.outstandingWake).toBeNull();
});

/* A registry that cannot answer must not take the check down with it: the
   refusal is recorded, and the check goes on to its own verdict. */
test("a revocation the registry cannot serve is journaled rather than thrown", async () => {
  const outstanding = { clientMessageId: "seat-tick:viewer:7:first:interval:fp-1", conversationId: CONVERSATION, seatEpoch: 7 };
  const rig = harness({
    seat: { conversationId: SUCCESSOR, seatEpoch: 8, path: null },
    pipelines: OPEN_LANE,
    state: { ...OVERDUE, seatEpoch: 7, outstandingWake: outstanding },
    pendingThrows: true,
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record!.verdict).not.toBe("error");
  const revocation = rig.journal.find((line) => line.verdict === "revoked");
  expect(revocation!.detail).toContain("could not be revoked");
});

test("a wake that landed settles the outstanding one, because the seat now has it", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: {
      ...OVERDUE,
      outstandingWake: { clientMessageId: "seat-tick:viewer:7:first:interval:fp-1", conversationId: CONVERSATION, seatEpoch: 7 },
    },
  });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.written[0]!.outstandingWake).toBeNull();
});

test("a delivered wake is what moves the event cursor past the events it carried", async () => {
  const rig = harness({ pipelines: OPEN_LANE, events: [terminalEvent(44)], state: { ...OVERDUE, eventsThrough: 12 } });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record!.reasons).toEqual(["lane-event"]);
  expect(rig.written[0]!.eventsThrough).toBe(44);
});

test("a failed delivery leaves the wake stamp where it was, so the next check retries", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: OVERDUE,
    delivery: { ok: false, outcome: "failed", error: "the conversation cannot be resumed", status: 409 },
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record!.delivery).toMatchObject({ outcome: "failed" });
  expect(rig.written[0]!.lastWakeAt).toBe(OVERDUE.lastWakeAt);
});

test("a seat mid-turn is skipped without a send and without consuming the event cursor", async () => {
  const rig = harness({
    turn: "busy",
    seatActivity: { lifecycle: "running", reason: "host_alive_turn_active" },
    pipelines: OPEN_LANE,
    events: [terminalEvent(44)],
    state: { ...OVERDUE, eventsThrough: 12 },
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "skipped", delivery: null, eventsThrough: 12 });
  expect(rig.sent).toEqual([]);
});

/* And the seat whose own host died under an open turn: the registry still says
   `busy`, so the rule this replaces would have dropped every tick forever. */
test("a busy seat the registry reports stalled is woken, which is what resumes its host", async () => {
  const rig = harness({
    turn: "busy",
    seatActivity: { lifecycle: "stalled", reason: "host_gone_turn_open" },
    pipelines: OPEN_LANE,
    state: OVERDUE,
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record!.verdict).toBe("wake");
  expect(rig.sent).toHaveLength(1);
});

test("open work with nobody seated raises the orchestrator card and wakes nothing", async () => {
  const rig = harness({ seat: null, pipelines: OPEN_LANE });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "no-seat", seatEpoch: null });
  expect(rig.cards).toHaveLength(1);
  expect(rig.cards[0]!.card.ref).toBe("orchestrator-unresolved");
  expect(rig.sent).toEqual([]);
});

test("the proactive slot delivers a proposal brief built from open issues", async () => {
  const rig = harness({});
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record!.verdict).toBe("proactive");
  expect(rig.sent[0]!.text).toContain("#1245 the native seat tick");
  expect(rig.sent[0]!.text).toContain("post it as a single board card in inbox");
  expect(rig.written[0]!.lastProposalAt).toBe(new Date(NOW).toISOString());
});

/* An empty log reads exactly like a run that never happened — the ambiguity
   this journal exists to remove — so a check that throws still leaves a line. */
test("a check that throws still leaves one journal line, naming the failure", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE, deliveryThrows: true });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "error", project: PROJECT, delivery: null });
  expect(record!.detail).toContain("the check failed");
  expect(rig.journal).toHaveLength(1);
});

test("the tick is one clock in one process: a second start is refused out loud and on the record", () => {
  const refused: string[] = [];
  const journal: SeatTickRunRecord[] = [];
  const ports = {
    scheduleInterval: () => ({ unref() {} }) as never,
    sweep: async () => undefined,
    policy: DEFAULT_SEAT_TICK_POLICY,
    log: (line: string) => refused.push(line),
    appendRecord: (record: SeatTickRunRecord) => { journal.push(record); },
  };
  expect(startSeatTick(ports)).toBe(true);
  expect(startSeatTick(ports)).toBe(false);
  expect(refused).toHaveLength(1);
  expect(refused[0]).toContain("exactly one ticker per seat");
  expect(journal).toHaveLength(1);
  expect(journal[0]).toMatchObject({ verdict: "refused" });
});

/* The refusal above only covers a second start inside ONE process, and one
   process is not one process for ever: a deploy promotes a successor beside the
   incumbent, and the predecessor keeps its armed timer. Traffic authority is
   the durable fact both of them can read, so the sweep re-asks it. */
test("a release that no longer owns traffic refuses the sweep, records it, and stops its own clock", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  let swept = 0;
  rig.deps.sources!.activeSeats = () => { swept += 1; return [PROJECT]; };
  const ports = {
    scheduleInterval: () => ({ unref() {} }) as never,
    sweep: async () => undefined,
    policy: DEFAULT_SEAT_TICK_POLICY,
    log: () => {},
    appendRecord: () => {},
  };
  expect(startSeatTick(ports)).toBe(true);

  const records = await reconcileSeatTick({ ...rig.deps, ownsTraffic: () => false });
  expect(records).toEqual([]);
  expect(swept).toBe(0);
  expect(rig.sent).toEqual([]);
  expect(rig.journal).toHaveLength(1);
  expect(rig.journal[0]).toMatchObject({ verdict: "refused", project: "", seatEpoch: null, delivery: null });
  expect(rig.journal[0]!.detail).toContain("no longer owns viewer traffic");
  /* The clock is genuinely stopped, not merely quiet: a start is accepted again
     rather than refused as a second one. */
  expect(startSeatTick(ports)).toBe(true);
});

test("the release that does own traffic sweeps every project it has an opinion about", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const records = await reconcileSeatTick({ ...rig.deps, ownsTraffic: () => true });
  expect(records.map((record) => record.project)).toEqual([PROJECT]);
  expect(records[0]!.verdict).toBe("wake");
  expect(rig.sent).toHaveLength(1);
});

/* An unauthorized sweep that crashed on its own journal would be a refusal
   nobody is left with — including the clock, which must still stop. */
test("an unwritable journal does not turn the lost-authority refusal into a crash", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const records = await reconcileSeatTick({
    ...rig.deps,
    ownsTraffic: () => false,
    appendRecord: () => { throw new Error("the journal is unwritable"); },
  });
  expect(records).toEqual([]);
  expect(rig.sent).toEqual([]);
});

test("the off switch keeps the clock unstarted and says so", () => {
  const refused: string[] = [];
  expect(startSeatTick({ policy: null, log: (line) => refused.push(line) })).toBe(false);
  expect(refused[0]).toContain("LLV_SEAT_TICK_CHECK_MINUTES=0");
});

test("a check that outran its interval drops the next tick rather than queueing it", async () => {
  let fire = () => {};
  let sweeps = 0;
  let release = () => {};
  startSeatTick({
    scheduleInterval: (callback) => { fire = callback; return { unref() {} } as never; },
    sweep: () => { sweeps += 1; return new Promise<void>((resolve) => { release = resolve; }); },
    policy: DEFAULT_SEAT_TICK_POLICY,
    log: () => {},
  });
  fire();
  fire();
  expect(sweeps).toBe(1);
  release();
  await Promise.resolve();
  await Promise.resolve();
  fire();
  expect(sweeps).toBe(2);
});
