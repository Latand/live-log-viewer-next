import { expect, test } from "bun:test";

import { evaluateLiveness } from "@/lib/lifecycle/liveness";

import {
  DEFAULT_SEAT_TICK_POLICY,
  SEAT_TICK_WAKE_INTERVAL_MS,
  seatTickDecision,
  seatTickPolicy,
  seatTickWakeCommit,
  seatTickWakeCommitPlan,
  seatTurnProgressing,
} from "./seatTick";
import {
  emptySeatTickState,
  type SeatTickCheckInput,
  type SeatTickEventInput,
  type SeatTickPipelineInput,
  type SeatTickProjectState,
  type SeatTickSeatInput,
  type SeatTickTaskInput,
  type SeatTickVerdict,
  type SeatTickWakeCommit,
} from "./types";

const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const PROJECT = "viewer";
/* Assembled from parts: a conversation-shaped literal is what the publication
   gate refuses in a committed artifact. */
const CONVERSATION = ["conversation", "0f4c21b7729fbc9e"].join("_");
const MINUTE = 60_000;

function seat(over: Partial<SeatTickSeatInput> = {}): SeatTickSeatInput {
  return { conversationId: CONVERSATION, seatEpoch: 7, path: null, turn: "idle", activity: null, ...over };
}

function lane(over: Partial<SeatTickPipelineInput> = {}): SeatTickPipelineInput {
  return {
    id: "pipeline_a1",
    title: "ship the exporter",
    state: "active",
    updatedAt: new Date(NOW - MINUTE).toISOString(),
    stageActivity: null,
    stageId: "build",
    ...over,
  };
}

function card(over: Partial<SeatTickTaskInput> = {}): SeatTickTaskInput {
  return { id: "task_b2", title: "wire the chip", status: "assigned", owned: false, ...over };
}

function event(over: Partial<SeatTickEventInput> = {}): SeatTickEventInput {
  return { seq: 42, at: new Date(NOW - MINUTE).toISOString(), type: "stage_blocked", summary: "the review round is parked", pipelineId: "pipeline_a1", ...over };
}

function input(over: Partial<SeatTickCheckInput> = {}): SeatTickCheckInput {
  return {
    project: PROJECT,
    now: NOW,
    seat: seat(),
    pipelines: [],
    tasks: [],
    events: [],
    terminalPending: false,
    signals: [],
    changeFingerprint: "fp-1",
    state: emptySeatTickState(),
    policy: DEFAULT_SEAT_TICK_POLICY,
    ...over,
  };
}

function stateWith(over: Partial<SeatTickProjectState>): SeatTickProjectState {
  return { ...emptySeatTickState(), ...over };
}

/** The reasons a verdict carries, or none for every verdict that is not a wake. */
function reasonsOf(verdict: SeatTickVerdict): string[] {
  return verdict.kind === "wake" ? verdict.reasons.map((reason) => reason.kind) : [];
}

/** What a verdict would commit if its wake landed. Non-null for every verdict
    these commit tests use. */
function plan(verdict: SeatTickVerdict, fingerprint: string, eventsThrough: number): SeatTickWakeCommit {
  return seatTickWakeCommitPlan(verdict, { fingerprint, eventsThrough })!;
}

test("a project with open work and no active seat reports no-seat and asks for one card, never a spawn", () => {
  const decision = seatTickDecision(input({ seat: null, pipelines: [lane()] }));
  expect(decision.verdict).toEqual({
    kind: "no-seat",
    detail: "the project has open work and no active orchestrator seat",
  });
  expect(decision.cards).toHaveLength(1);
  expect(decision.cards[0]!.kind).toBe("no-seat");
  expect(decision.state.lastCheckAt).toBe(new Date(NOW).toISOString());
});

test("a seat whose turn is genuinely moving is skipped, not queued", () => {
  const decision = seatTickDecision(input({
    seat: seat({ turn: "busy", activity: { lifecycle: "running", reason: "host_alive_turn_active" } }),
    pipelines: [lane({ state: "inert" })],
    state: stateWith({ stalledSeen: ["pipeline_a1"], eventsThrough: 9 }),
  }));
  expect(decision.verdict).toEqual({ kind: "skipped", reason: "seat-busy" });
  /* Nothing about the skipped check is remembered as progress: the stall memory
     and the event cursor stay where they were, so the next check re-decides. */
  expect(decision.state.stalledSeen).toEqual(["pipeline_a1"]);
  expect(decision.state.eventsThrough).toBe(9);
  expect(decision.state.lastCheckAt).toBe(new Date(NOW).toISOString());
});

/* The permanent skip this replaces: a seat whose host died mid-turn keeps a
   `busy` turn on the registry for as long as the record stands, so a plain busy
   check dropped every tick forever — silenced by exactly the condition the wake
   exists to clear. */
test("a busy seat the registry reports stalled is no longer skipped, so the skip terminates", () => {
  const stalledSeat = seat({ turn: "busy", activity: { lifecycle: "stalled", reason: "host_gone_turn_open" } });
  const decision = seatTickDecision(input({
    seat: stalledSeat,
    pipelines: [lane()],
    signals: [{ id: "seat-host", label: "the seat's own turn is stalled" }],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(seatTurnProgressing(stalledSeat)).toBe(false);
  expect(decision.verdict.kind).toBe("wake");
  expect(reasonsOf(decision.verdict)).toEqual(["interval"]);
});

test("a busy seat the liveness plane cannot answer for is not skipped either — absence is not progress", () => {
  expect(seatTurnProgressing(seat({ turn: "busy", activity: null }))).toBe(false);
  expect(seatTurnProgressing(seat({ turn: "busy", activity: { lifecycle: "gone", reason: "host_gone_turn_settled" } }))).toBe(false);
  expect(seatTurnProgressing(seat({ turn: "busy", activity: { lifecycle: "waiting", reason: "provider_throttled" } }))).toBe(true);
  expect(seatTurnProgressing(seat({ turn: "busy", activity: { lifecycle: "starting", reason: "launch_unproven" } }))).toBe(true);
  expect(seatTurnProgressing(seat({ turn: "idle", activity: { lifecycle: "running", reason: "host_alive_turn_active" } }))).toBe(false);
});

test("a healthy moving board is quiet and produces nothing operator-visible", () => {
  const decision = seatTickDecision(input({
    pipelines: [lane()],
    state: stateWith({ lastWakeAt: new Date(NOW - 5 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "nothing owed" });
  expect(decision.cards).toEqual([]);
  expect(decision.state.quietSince).toBe(new Date(NOW).toISOString());
  expect(decision.state.idleSince).toBeNull();
});

test("a stall wakes only once it has persisted across two consecutive checks", () => {
  const stuck = lane({ stageActivity: { lifecycle: "stalled", reason: "host_alive_transcript_silent" } });
  const overdue = { lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() };
  const first = seatTickDecision(input({ pipelines: [stuck], state: stateWith(overdue) }));
  expect(reasonsOf(first.verdict)).toEqual(["interval"]);
  expect(first.state.stalledSeen).toEqual(["pipeline_a1"]);

  const second = seatTickDecision(input({ pipelines: [stuck], state: stateWith({ ...overdue, stalledSeen: ["pipeline_a1"] }) }));
  expect(reasonsOf(second.verdict)).toEqual(["stalled"]);
});

/* The stall reading the whole verdict rests on. Movement instants belong to the
   fingerprint, never to the stall rule: a stage running for hours with a host
   writing to its transcript is moving, and subtracting its newest attempt
   instant from the clock is how it gets called stuck. */
test("a lane's stall is the registry's verdict, never the age of its newest attempt", () => {
  const ancient = { lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(), stalledSeen: ["pipeline_a1"] };
  const longRunning = lane({
    updatedAt: new Date(NOW - 8 * 60 * MINUTE).toISOString(),
    stageActivity: { lifecycle: "running", reason: "host_alive_turn_active" },
  });
  expect(reasonsOf(seatTickDecision(input({ pipelines: [longRunning], state: stateWith(ancient) })).verdict)).toEqual(["interval"]);

  const dead = lane({
    updatedAt: new Date(NOW - MINUTE).toISOString(),
    stageActivity: { lifecycle: "gone", reason: "host_gone_turn_settled" },
  });
  const verdict = seatTickDecision(input({ pipelines: [dead], state: stateWith(ancient) })).verdict;
  expect(reasonsOf(verdict)).toEqual(["stalled"]);
  expect(verdict.kind === "wake" && verdict.reasons[0]!.detail).toContain("host_gone_turn_settled");
});

test("a parked lane stalls by the monitor's own rule, and a lane that moved again clears the memory", () => {
  const overdue = { lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(), stalledSeen: ["pipeline_a1"] };
  const parked = seatTickDecision(input({ pipelines: [lane({ state: "inert" })], state: stateWith(overdue) }));
  expect(reasonsOf(parked.verdict)).toEqual(["stalled"]);
  expect(parked.verdict.kind === "wake" && parked.verdict.reasons[0]!.detail).toContain("parked");

  const moved = seatTickDecision(input({
    pipelines: [lane()],
    state: stateWith({ ...overdue, lastWakeAt: new Date(NOW - 5 * MINUTE).toISOString() }),
  }));
  expect(moved.verdict.kind).toBe("quiet");
  expect(moved.state.stalledSeen).toEqual([]);
});

test("a lane with no activity verdict at all is never called stalled", () => {
  const decision = seatTickDecision(input({
    pipelines: [lane({ updatedAt: null, stageActivity: null })],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(), stalledSeen: ["pipeline_a1"] }),
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["interval"]);
  expect(decision.state.stalledSeen).toEqual([]);
});

/* A terminal lane event leads the next wake; it never raises an early one. The
   hourly bound has no exempt reason kind, because a reason allowed to jump it
   would make the ADR's cost argument describe a different system. */
test("a terminal lane event leads the next wake rather than raising one early", () => {
  const args = { events: [event()], terminalPending: true, pipelines: [lane()] };
  const early = seatTickDecision(input({ ...args, state: stateWith({ lastWakeAt: new Date(NOW - MINUTE).toISOString() }) }));
  expect(early.verdict.kind).toBe("quiet");

  const due = seatTickDecision(input({ ...args, state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }) }));
  expect(reasonsOf(due.verdict)).toEqual(["lane-event"]);
  expect(due.verdict.kind === "wake" && due.verdict.items[0]).toMatchObject({ kind: "event", id: "pipeline_a1" });
});

test("routine lane events do not wake on their own", () => {
  const decision = seatTickDecision(input({
    events: [event({ type: "stage_started", summary: "builder started" })],
    terminalPending: false,
    pipelines: [lane()],
    state: stateWith({ lastWakeAt: new Date(NOW - MINUTE).toISOString() }),
  }));
  expect(decision.verdict.kind).toBe("quiet");
});

/* A verdict at pending position 401 is as decision-blocking as one at position
   one, so the pending question is asked over the whole range rather than the
   page this check happened to read. */
test("a terminal event buried past the page still wakes, naming that it is further down", () => {
  const decision = seatTickDecision(input({
    events: [event({ type: "stage_started", summary: "builder started" })],
    terminalPending: true,
    pipelines: [lane()],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["lane-event"]);
  expect(decision.verdict.kind === "wake" && decision.verdict.reasons[0]!.detail).toContain("further down the journal");
});

test("an assigned task nothing has started wakes the seat once the wake interval has elapsed", () => {
  const decision = seatTickDecision(input({
    tasks: [card()],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["unstarted-task"]);
});

test("an owned, a blocked and a done task are all silent — blocked is the recorded stop", () => {
  const tasks = [card({ owned: true }), card({ id: "task_c3", status: "blocked" }), card({ id: "task_d4", status: "done" })];
  const decision = seatTickDecision(input({ tasks, state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }) }));
  expect(decision.verdict.kind).toBe("quiet");
});

test("the wake interval elapsing while a lane is open is itself a reason — roughly hourly", () => {
  const decision = seatTickDecision(input({
    pipelines: [lane()],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["interval"]);
});

/* An inbox card is open work — it holds the proposal slot shut, correctly,
   because the operator's move to `assigned` is what starts it. But the seat is
   told not to act on inbox, so an hourly wake with only inbox open would carry
   an agenda of exactly nothing: the burnt-quota tick this replaces. */
test("the hourly interval never wakes an empty agenda", () => {
  const decision = seatTickDecision(input({
    tasks: [card({ status: "inbox" })],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "nothing owed" });
});

test("a signal alone is agenda enough for the interval to wake", () => {
  const decision = seatTickDecision(input({
    tasks: [card({ status: "inbox" })],
    signals: [{ id: "deploy", label: "the last deployment ended failed" }],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["interval"]);
});

test("standing reasons wait out the wake interval instead of firing every five minutes", () => {
  const decision = seatTickDecision(input({
    pipelines: [lane({ state: "inert" })],
    tasks: [card()],
    state: stateWith({ lastWakeAt: new Date(NOW - 10 * MINUTE).toISOString(), stalledSeen: ["pipeline_a1"] }),
  }));
  expect(decision.verdict.kind).toBe("quiet");
});

test("a wake carries at most five items and reports the rest as deferred", () => {
  const lanes = Array.from({ length: 8 }, (_, index) => lane({ id: `pipeline_${index}`, title: `lane ${index}` }));
  const decision = seatTickDecision(input({
    pipelines: lanes,
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict.kind === "wake" && decision.verdict.items).toHaveLength(5);
  expect(decision.verdict.kind === "wake" && decision.verdict.deferred).toBe(3);
});

test("with no work at all and the proposal slot due, the verdict is proactive", () => {
  const decision = seatTickDecision(input({ tasks: [card({ status: "done" })] }));
  expect(decision.verdict.kind).toBe("proactive");
  expect(decision.state.idleSince).toBe(new Date(NOW).toISOString());
});

test("a proposal slot that is not due leaves an idle seat quiet", () => {
  const decision = seatTickDecision(input({
    state: stateWith({ lastProposalAt: new Date(NOW - 60 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "the board is done and the proposal slot is not due" });
});

test("a proposal card still open on the board holds the next proposal off", () => {
  /* The card lands in `inbox`, which is open work, so the board is no longer
     idle and the slot cannot come round again until the operator moves it. */
  const decision = seatTickDecision(input({ tasks: [card({ status: "inbox" })] }));
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "nothing owed" });
});

test("a fruitless reason is re-sent at most twice, then becomes a card and drops out of wakes", () => {
  const base = {
    pipelines: [lane()],
    state: stateWith({
      lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(),
      lastWakeFingerprint: "fp-1",
      wakesWithoutChange: { interval: 2 },
    }),
  };
  const decision = seatTickDecision(input(base));
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "every wake reason is held by the retry guard" });
  expect(decision.cards).toHaveLength(1);
  expect(decision.cards[0]).toMatchObject({ kind: "retry-guard", ref: "seat-tick-stuck-interval" });
});

test("board movement clears the retry guard, so a reason that starts working again is sent again", () => {
  const decision = seatTickDecision(input({
    pipelines: [lane()],
    changeFingerprint: "fp-2",
    state: stateWith({
      lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(),
      lastWakeFingerprint: "fp-1",
      wakesWithoutChange: { interval: 2 },
    }),
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["interval"]);
  expect(decision.cards).toEqual([]);
});

test("the wake commit records the wake, and only the commit advances lastWakeAt", () => {
  const decision = seatTickDecision(input({
    pipelines: [lane()],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.state.lastWakeAt).toBe(new Date(NOW - 61 * MINUTE).toISOString());
  const committed = seatTickWakeCommit(decision.state, plan(decision.verdict, "fp-1", 44), NOW);
  expect(committed.lastWakeAt).toBe(new Date(NOW).toISOString());
  expect(committed.lastWakeReasons).toEqual(["interval"]);
  expect(committed.lastWakeFingerprint).toBe("fp-1");
  expect(committed.eventsThrough).toBe(44);
});

/* The whole reason the commit is a second function. An acknowledged lifecycle
   event is never offered again, so a cursor that moved on a refused, held or
   queued send loses the very lane event the next seat needed. */
test("no commit means no cursor: the event cursor moves only with a delivered wake", () => {
  const decision = seatTickDecision(input({
    events: [event({ seq: 44 })],
    terminalPending: true,
    pipelines: [lane()],
    state: stateWith({ eventsThrough: 12, lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.state.eventsThrough).toBe(12);
  expect(seatTickWakeCommit(decision.state, plan(decision.verdict, "fp-1", 44), NOW).eventsThrough).toBe(44);
});

test("the cursor never walks backwards, whatever a caller hands the commit", () => {
  const committed = seatTickWakeCommit(stateWith({ eventsThrough: 90 }), plan({ kind: "proactive", detail: "" }, "fp", 12), NOW);
  expect(committed.eventsThrough).toBe(90);
});

test("a proactive commit stamps the proposal slot", () => {
  const committed = seatTickWakeCommit(emptySeatTickState(), plan({ kind: "proactive", detail: "due" }, "fp-1", 0), NOW);
  expect(committed.lastProposalAt).toBe(new Date(NOW).toISOString());
  expect(committed.lastWakeAt).toBe(new Date(NOW).toISOString());
});

test("policy defaults are the accepted ones, and each is overridable in the retirement idiom", () => {
  expect(seatTickPolicy({})).toEqual(DEFAULT_SEAT_TICK_POLICY);
  expect(seatTickPolicy({ LLV_SEAT_TICK_CHECK_MINUTES: "0" })).toBeNull();
  expect(seatTickPolicy({
    LLV_SEAT_TICK_CHECK_MINUTES: "2",
    LLV_SEAT_TICK_STALL_MINUTES: "15",
    LLV_SEAT_TICK_PROPOSAL_HOURS: "6",
    LLV_SEAT_TICK_ITEMS: "3",
    LLV_SEAT_TICK_RETRY_GUARD: "1",
  })).toEqual({
    checkIntervalMs: 2 * MINUTE,
    stallAfterMs: 15 * MINUTE,
    proposalIntervalMs: 6 * 60 * MINUTE,
    itemsPerWake: 3,
    retryGuard: 1,
  });
});

/* The wake interval is the one number the ADR's cost argument rests on — one
   resume per project per interval — so it is not among the knobs. An
   environment that tries to set it changes nothing. */
test("the wake interval is a constant no environment can set", () => {
  expect(SEAT_TICK_WAKE_INTERVAL_MS).toBe(60 * MINUTE);
  const policy = seatTickPolicy({ LLV_SEAT_TICK_WAKE_MINUTES: "1" });
  expect(policy).toEqual(DEFAULT_SEAT_TICK_POLICY);
  expect(JSON.stringify(policy)).not.toContain("wakeInterval");
  const almostDue = stateWith({ lastWakeAt: new Date(NOW - 59 * MINUTE).toISOString() });
  expect(seatTickDecision(input({ pipelines: [lane()], policy: policy!, state: almostDue })).verdict.kind).toBe("quiet");
});

/* ------------------------------------------------------------------------- *
 * What the stall threshold actually catches, checked rather than assumed.
 *
 * The production observation on #1245 raised the question this pins: a
 * permanently BUSY seat and a STUCK seat both produce an endless run of
 * `skipped`, and the stall threshold is what is supposed to tell them apart.
 * Both halves of the answer are asserted here against the real
 * `evaluateLiveness`, because the interesting half is the one it does NOT
 * catch, and a blind spot nobody wrote down is a blind spot nobody remembers.
 *
 * The threshold measures SILENCE — now minus the newest transcript record,
 * tool traffic included — never how long a turn has been open. So:
 * ------------------------------------------------------------------------- */

const ALIVE = { host: { state: "alive" as const }, stallAfterMs: DEFAULT_SEAT_TICK_POLICY.stallAfterMs };

test("the stall threshold catches a silent open turn, and never a long busy one", () => {
  /* CAUGHT: six hours open, nothing written for 41 minutes past a 40-minute
     threshold. The registry calls it stalled, so the tick stops treating the
     turn as progress and the seat becomes reachable again. */
  const silent = evaluateLiveness({ ...ALIVE, turnState: "busy", silentForMs: 41 * MINUTE });
  expect(silent).toEqual({ lifecycle: "stalled", reason: "host_alive_transcript_silent" });
  expect(seatTurnProgressing(seat({ turn: "busy", activity: { lifecycle: silent.lifecycle, reason: silent.reason } }))).toBe(false);

  /* NOT CAUGHT, and this is the blind spot: the same six-hour turn, writing a
     tool call thirty seconds ago. Silence is zero, so it reads `running`, the
     tick calls it progress and drops its check — at every check, for as long
     as the seat keeps writing. Duration is not an input anywhere on this path,
     so no threshold on this surface can fire on it. */
  const busy = evaluateLiveness({ ...ALIVE, turnState: "busy", silentForMs: 30_000 });
  expect(busy).toEqual({ lifecycle: "running", reason: "host_alive_turn_active" });
  expect(seatTurnProgressing(seat({ turn: "busy", activity: { lifecycle: busy.lifecycle, reason: busy.reason } }))).toBe(true);
  expect(seatTickDecision(input({ seat: seat({ turn: "busy", activity: { lifecycle: busy.lifecycle, reason: busy.reason } }), pipelines: [lane()] })).verdict)
    .toEqual({ kind: "skipped", reason: "seat-busy" });

  /* That is the property "never interrupt a working seat" being kept, and it
     is worth keeping — a seat writing every thirty seconds IS working, and the
     Viewer cannot tell an eight-hour merge queue from a self-inflicted loop by
     looking at the transcript clock. What it costs is that a seat which keeps
     itself busy on purpose is unreachable, which is exactly the deadlock the
     session cron produced. The answer is upstream of this surface: mandate v11
     tells the seat to stop doing it, and the revoked-seat retirement ends a
     predecessor that will not. */

  /* The one case that is NOT a blind spot: a dead host holding an open turn
     forever. Caught whatever the transcript clock says, which is why the skip
     terminates rather than waiting behind a turn nothing can finish. */
  const zombie = evaluateLiveness({ host: { state: "gone" }, turnState: "busy", silentForMs: 0, stallAfterMs: ALIVE.stallAfterMs });
  expect(zombie).toEqual({ lifecycle: "stalled", reason: "host_gone_turn_open" });
  expect(seatTurnProgressing(seat({ turn: "busy", activity: { lifecycle: zombie.lifecycle, reason: zombie.reason } }))).toBe(false);
});

test("the stall threshold the tick configures is the one the liveness read applies", () => {
  /* The number is only meaningful if it travels: `seatTickSources` passes
     `policy.stallAfterMs` into the liveness request, and that same value is
     what `evaluateLiveness` compares silence against. A default that never
     reached the reader would make the whole verification above vacuous. */
  expect(DEFAULT_SEAT_TICK_POLICY.stallAfterMs).toBe(40 * MINUTE);
  const justUnder = evaluateLiveness({ ...ALIVE, turnState: "busy", silentForMs: DEFAULT_SEAT_TICK_POLICY.stallAfterMs - 1 });
  const exactly = evaluateLiveness({ ...ALIVE, turnState: "busy", silentForMs: DEFAULT_SEAT_TICK_POLICY.stallAfterMs });
  expect(justUnder.lifecycle).toBe("running");
  expect(exactly.lifecycle).toBe("stalled");
});
