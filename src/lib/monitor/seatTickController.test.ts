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
import type { SeatTickWakeState, SeatTickWithdrawal } from "./seatTickSources";
import {
  emptySeatTickState,
  type SeatTickCard,
  type SeatTickOutstandingWake,
  type SeatTickProjectState,
  type SeatTickRunRecord,
} from "./types";
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
  withdrawn: { wake: SeatTickOutstandingWake; reason: string }[];
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
  /** What the layer holding a retained wake says has become of it. */
  wakeState?: SeatTickWakeState;
  /** What taking that wake back out of the holder's queue achieves. */
  withdrawal?: SeatTickWithdrawal;
  /** The holder cannot be reached at all, for either question. */
  holderThrows?: boolean;
}): Harness {
  const sent: ConversationMessage[] = [];
  const journal: SeatTickRunRecord[] = [];
  const cards: { project: string; card: SeatTickCard }[] = [];
  const written: SeatTickProjectState[] = [];
  const withdrawn: { wake: SeatTickOutstandingWake; reason: string }[] = [];
  const result: Harness = { deps: {}, sent, journal, cards, written, withdrawn, seat: options.seat === undefined ? { conversationId: CONVERSATION, seatEpoch: 7, path: null } : options.seat };
  let reads = 0;

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
        reads += 1;
        /* Reads one and two are the opening reconcile and the gather; every
           read after them is the re-check the send takes, which is where a
           rotation must be caught. */
        const seat = reads > 2 && options.rotateBeforeSend !== undefined ? options.rotateBeforeSend : result.seat;
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
      wakeState: async () => {
        if (options.holderThrows) throw new Error("the layer holding the wake cannot be read");
        return options.wakeState ?? "retained";
      },
      withdrawWake: async (wake, reason) => {
        if (options.holderThrows) throw new Error("the layer holding the wake cannot be read");
        withdrawn.push({ wake, reason });
        return options.withdrawal ?? "withdrawn";
      },
      now: () => NOW,
    },
  };
  return result;
}

const OVERDUE = { lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() };
const RECENT = { lastWakeAt: new Date(NOW - 5 * MINUTE).toISOString() };

/** A wake the layer accepted and kept, as the row remembers it: which layer is
    holding it, and what its landing would stamp. */
function outstandingWake(over: Partial<SeatTickOutstandingWake> = {}): SeatTickOutstandingWake {
  return {
    clientMessageId: "seat-tick:viewer:7:first:interval:fp-1",
    conversationId: CONVERSATION,
    seatEpoch: 7,
    operationId: "op-wake-1",
    commit: { proposal: false, reasons: ["interval"], fingerprint: "fp-1", eventsThrough: 44 },
    ...over,
  };
}
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
   this whole mechanism exists to end. The record names WHICH layer kept it,
   because a revocation aimed at the wrong one changes nothing. */
test("a wake the runtime host queued is written down against that operation", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    events: [terminalEvent(44)],
    state: { ...OVERDUE, eventsThrough: 12 },
    delivery: { ok: true, target: null, outcome: "queued", operationId: "op-wake-1", receipt: {} as never, structured: true },
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.written[0]!.outstandingWake).toEqual({
    clientMessageId: record!.delivery!.clientMessageId,
    conversationId: CONVERSATION,
    seatEpoch: 7,
    operationId: "op-wake-1",
    commit: { proposal: false, reasons: ["lane-event"], fingerprint: record!.delivery!.clientMessageId.split(":").at(-1)!, eventsThrough: 44 },
  });
});

/* And the hold that never reached a host: there is no runtime operation, so the
   Viewer registry's own reservation IS the retention and the record says so by
   carrying no operation id. */
test("a wake an account migration held names no operation, because no host has it", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: OVERDUE,
    delivery: { ok: true, target: null, outcome: "held" },
  });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.written[0]!.outstandingWake).toMatchObject({ operationId: null, seatEpoch: 7 });
});

test("the next check takes that wake back out of the queue holding it, the moment the epoch moves", async () => {
  const rig = harness({
    seat: { conversationId: SUCCESSOR, seatEpoch: 8, path: null },
    pipelines: OPEN_LANE,
    /* The row the predecessor left: its epoch, and its unlanded wake. */
    state: { ...OVERDUE, seatEpoch: 7, outstandingWake: outstandingWake() },
  });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.withdrawn).toHaveLength(1);
  expect(rig.withdrawn[0]!.wake.operationId).toBe("op-wake-1");
  expect(rig.withdrawn[0]!.reason).toContain("has since been replaced");
  const revocation = rig.journal.find((line) => line.verdict === "revoked");
  expect(revocation).toMatchObject({ seatEpoch: 7, delivery: { outcome: "withdrawn" } });
  expect(rig.written[0]!.outstandingWake).toBeNull();
});

/* The answer this mechanism has to be able to give. A holder that has already
   let the payload go cannot be made to take it back, and reporting that as a
   revocation would be the silent version of the very defect being prevented. */
test("a withdrawal the holder was already past is recorded as too late, never as a revocation", async () => {
  const rig = harness({
    seat: { conversationId: SUCCESSOR, seatEpoch: 8, path: null },
    pipelines: OPEN_LANE,
    state: { ...OVERDUE, seatEpoch: 7, outstandingWake: outstandingWake() },
    withdrawal: "too-late",
  });
  await runSeatTickCheck(PROJECT, rig.deps);
  const revocation = rig.journal.find((line) => line.verdict === "revoked")!;
  expect(revocation.delivery).toMatchObject({ outcome: "too-late" });
  expect(revocation.detail).toContain("may have received it");
});

/* The same seat is not a replacement, so a wake the holder still has stays
   outstanding — that one is the replay the next check re-raises under the same
   key. */
test("a seat that is still the same seat keeps a wake its holder is still holding", async () => {
  const outstanding = outstandingWake();
  const rig = harness({
    pipelines: OPEN_LANE,
    state: { ...RECENT, outstandingWake: outstanding },
    wakeState: "retained",
  });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.withdrawn).toEqual([]);
  expect(rig.journal.some((line) => line.verdict === "revoked")).toBe(false);
  expect(rig.written[0]!.outstandingWake).toEqual(outstanding);
});

/* The other half of the same question, and the reason `queued` may be believed
   at all. A structured host admits every send as queued whether it is idle or
   mid-turn, so "did the seat get it?" is only ever answered by the layer that
   took it — and that answer has to apply the stamp and the cursor the raising
   check wrote down. Without it the hourly bound the ADR rests on is bypassed by
   a wake that was delivered and never recorded. */
test("a wake the holder delivered after the send is credited with the plan that raised it", async () => {
  const outstanding = outstandingWake();
  const rig = harness({
    pipelines: OPEN_LANE,
    state: { ...RECENT, eventsThrough: 12, outstandingWake: outstanding },
    wakeState: "landed",
  });
  await runSeatTickCheck(PROJECT, rig.deps);
  const landing = rig.journal.find((line) => line.verdict === "landed")!;
  expect(landing.delivery).toEqual({ clientMessageId: outstanding.clientMessageId, outcome: "landed" });
  expect(rig.written[0]!.lastWakeAt).toBe(new Date(NOW).toISOString());
  expect(rig.written[0]!.lastWakeReasons).toEqual(["interval"]);
  expect(rig.written[0]!.eventsThrough).toBe(44);
  expect(rig.written[0]!.outstandingWake).toBeNull();
});

/* And the bound that landing restores: an hour has to pass from the delivery
   the holder made, not from a delivery the tick happened to observe. */
test("crediting the landing starts the hourly bound, so the same check does not wake again", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: { ...OVERDUE, outstandingWake: outstandingWake() },
    wakeState: "landed",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toEqual([]);
  expect(record!.verdict).toBe("quiet");
});

/* A holder that settled the payload without delivering it woke nobody, so no
   stamp moves and the wake is owed again. */
test("a wake the holder settled unsent moves no stamp, and the same check raises it again", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: { ...OVERDUE, eventsThrough: 12, outstandingWake: outstandingWake() },
    wakeState: "dropped",
  });
  await runSeatTickCheck(PROJECT, rig.deps);
  const dropped = rig.journal.find((line) => line.verdict === "dropped")!;
  expect(dropped.delivery).toMatchObject({ outcome: "dropped" });
  expect(dropped.eventsThrough).toBe(12);
  expect(rig.sent).toHaveLength(1);
});

/* A rotation that lands while the send is in flight is the one the row cannot
   carry to a later check, because there may not be one before the payload
   flushes. So a retained send is re-checked at once. */
test("a rotation during the send is caught by the same check that made the wake", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: OVERDUE,
    delivery: { ok: true, target: null, outcome: "queued", operationId: "op-inflight", receipt: {} as never, structured: true },
  });
  let reads = 0;
  const seatFor = rig.deps.sources!.seatFor;
  rig.deps.sources!.seatFor = ((project: string) => {
    reads += 1;
    /* The opening reconcile, the gather and the pre-send re-check all see the
       incumbent; the read after the send sees the successor that landed
       meanwhile. */
    return reads > 3
      ? { active: { conversationId: SUCCESSOR, seatEpoch: 8, path: null } as never, pending: null, history: [] }
      : seatFor(project);
  }) as typeof seatFor;
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.withdrawn.map((entry) => entry.wake.operationId)).toEqual(["op-inflight"]);
  expect(rig.written[0]!.outstandingWake).toBeNull();
});

/* A holder that cannot answer must not take the check down with it, and it is
   not evidence either way: the payload is exactly where it was, so the row
   keeps it and the next check asks again. */
test("a holder that cannot be reached is journaled, and leaves the wake outstanding", async () => {
  const outstanding = outstandingWake();
  const rig = harness({
    seat: { conversationId: SUCCESSOR, seatEpoch: 8, path: null },
    pipelines: OPEN_LANE,
    state: { ...RECENT, seatEpoch: 7, outstandingWake: outstanding },
    holderThrows: true,
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record!.verdict).not.toBe("error");
  const revocation = rig.journal.find((line) => line.verdict === "revoked")!;
  expect(revocation.delivery).toMatchObject({ outcome: "unknown" });
  expect(revocation.detail).toContain("could not be revoked");
  expect(rig.written[0]!.outstandingWake).toEqual(outstanding);
});

test("a wake that landed at the send settles the outstanding one, because the seat now has it", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: { ...OVERDUE, outstandingWake: outstandingWake() },
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
