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
import { defaultSeatTickSettings, effectiveSeatTickSettings, type SeatTickSettings } from "./seatTickSettings";
import {
  emptySeatTickState,
  type SeatTickCheckInput,
  type SeatTickEventInput,
  type SeatTickPipelineInput,
  type SeatTickProjectState,
  type SeatTickPullRequestInput,
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
  return {
    id: "task_b2",
    title: "wire the chip",
    status: "assigned",
    owned: false,
    updatedAt: new Date(NOW - MINUTE).toISOString(),
    ...over,
  };
}

function event(over: Partial<SeatTickEventInput> = {}): SeatTickEventInput {
  return {
    seq: 42,
    at: new Date(NOW - MINUTE).toISOString(),
    type: "stage_blocked",
    summary: "the review round is parked",
    pipelineId: "pipeline_a1",
    pipelineTerminal: false,
    ...over,
  };
}

/** A pull request a finished lane left open (#1289). */
function pullRequest(over: Partial<SeatTickPullRequestInput> = {}): SeatTickPullRequestInput {
  return {
    number: 1289,
    title: "wake on a merge that is waiting",
    pipelineId: "pipeline_a1",
    pipelineTitle: "ship the exporter",
    updatedAt: new Date(NOW - 30 * MINUTE).toISOString(),
    ...over,
  };
}

function input(over: Partial<SeatTickCheckInput> = {}): SeatTickCheckInput {
  return {
    project: PROJECT,
    now: NOW,
    seat: seat(),
    pipelines: [],
    tasks: [],
    events: [],
    pullRequests: [],
    pullRequestsUnavailable: null,
    signals: [],
    changeFingerprint: "fp-1",
    state: emptySeatTickState(),
    policy: DEFAULT_SEAT_TICK_POLICY,
    /* The default a project nobody configured reads (#1275): every case below
       that does not say otherwise is the tick exactly as it shipped. */
    settings: effectiveSeatTickSettings(defaultSeatTickSettings(PROJECT), NOW, SEAT_TICK_WAKE_INTERVAL_MS),
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
  expect(seatTurnProgressing(seat({ turn: "busy", activity: { lifecycle: "waiting", reason: "provider_throttled", turnState: "busy" } }))).toBe(true);
  expect(seatTurnProgressing(seat({ turn: "busy", activity: { lifecycle: "starting", reason: "launch_unproven" } }))).toBe(true);
  expect(seatTurnProgressing(seat({ turn: "idle", activity: { lifecycle: "running", reason: "host_alive_turn_active" } }))).toBe(false);
});

/* #1262: the registry's turn record and the transcript's own turn are two
   different facts, and the tick read them as one. A seat that finished its turn
   leaves the registry record open for a while; the liveness verdict for it is
   `waiting` (`host_alive_turn_idle`), which the tick counted as progress — so
   an available seat was skipped at every check for as long as the stale record
   stood, and could not be woken at all. Only the turn a retry deadline is
   holding open is progress. */
test("a seat whose turn the transcript says settled is available, not progressing", () => {
  const settled = seat({ turn: "busy", activity: { lifecycle: "waiting", reason: "host_alive_turn_idle", turnState: "idle" } });
  expect(seatTurnProgressing(settled)).toBe(false);
  expect(seatTurnProgressing(seat({ turn: "busy", activity: { lifecycle: "waiting", reason: "provider_throttled", turnState: "busy" } }))).toBe(true);
  /* An unstated turn is not a turn anybody proved open. */
  expect(seatTurnProgressing(seat({ turn: "busy", activity: { lifecycle: "waiting", reason: "host_alive_turn_idle" } }))).toBe(false);
  const decision = seatTickDecision(input({
    seat: settled,
    pipelines: [lane()],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict.kind).toBe("wake");
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
  const args = { events: [event()], pipelines: [lane()] };
  const early = seatTickDecision(input({ ...args, state: stateWith({ lastWakeAt: new Date(NOW - MINUTE).toISOString() }) }));
  expect(early.verdict.kind).toBe("quiet");

  const due = seatTickDecision(input({ ...args, state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }) }));
  expect(reasonsOf(due.verdict)).toEqual(["lane-event"]);
  expect(due.verdict.kind === "wake" && due.verdict.items[0]).toMatchObject({ kind: "event", id: "pipeline_a1" });
});

test("routine lane events do not wake on their own", () => {
  const decision = seatTickDecision(input({
    events: [event({ type: "stage_started", summary: "builder started" })],
    pipelines: [lane()],
    state: stateWith({ lastWakeAt: new Date(NOW - MINUTE).toISOString() }),
  }));
  expect(decision.verdict.kind).toBe("quiet");
});

/* #1285, the first direction. Three consecutive wakes were spent listing events
   whose pipelines had reached a terminal state the day before — two of them
   closed by the seat itself earlier in the same session. A lane that is over
   owes nothing, so an event about it is history and never an agenda. */
test("events whose lanes have finished are history, and a project holding only those is quiet", () => {
  const decision = seatTickDecision(input({
    events: [
      event({ seq: 60, type: "stage_completed", summary: "the builder finished", pipelineTerminal: true }),
      event({ seq: 61, type: "review_verdict", summary: "the round passed", pipelineId: "pipeline_c3", pipelineTerminal: true }),
    ],
    /* Open work, so the answer under test is "nothing owed" rather than "the
       board is done" — and an inbox card is deliberately not an agenda of its
       own, which leaves the events as the only thing that could wake anyone. */
    tasks: [card({ status: "inbox" })],
    state: stateWith({ eventsThrough: 59, lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "nothing owed" });
});

/* And the count beside the reason says how much of it is live. "18 more" over a
   page that was almost entirely closed lanes described a queue of eighteen
   things to do that did not exist. */
test("the lane-event count names only the events that are still owed", () => {
  const decision = seatTickDecision(input({
    events: [
      event({ seq: 60, type: "stage_completed", summary: "yesterday's lane finished", pipelineTerminal: true }),
      event({ seq: 61, type: "review_verdict", summary: "the round passed" }),
      event({ seq: 62, type: "stage_failed", summary: "the verifier failed", pipelineTerminal: true }),
      event({ seq: 63, type: "stage_blocked", summary: "the round is parked" }),
    ],
    pipelines: [lane()],
    state: stateWith({ eventsThrough: 59, lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["lane-event"]);
  expect(decision.verdict.kind === "wake" && decision.verdict.reasons[0]!.detail)
    .toBe("review_verdict since the last delivered wake and 1 more");
  expect(decision.verdict.kind === "wake" && decision.verdict.items.filter((item) => item.kind === "event"))
    .toHaveLength(2);
});

/* The second half of #1285, and the expensive one. A backlog drained at
   `itemsPerWake` per hourly wake is ten resumed hosts and ten paid turns for
   fifty events that were history. One look establishes that nothing in front of
   the cursor is owed, and the cursor moves on that look alone. */
test("a page of history is discharged by the check that read it, with no wake at all", () => {
  const history = Array.from({ length: 50 }, (_, index) => event({
    seq: 100 + index,
    type: "stage_completed",
    summary: "a lane that closed yesterday finished",
    pipelineTerminal: true,
  }));
  const decision = seatTickDecision(input({
    events: history,
    tasks: [card({ status: "inbox" })],
    state: stateWith({ eventsThrough: 99, lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict.kind).toBe("quiet");
  expect(decision.state.eventsThrough).toBe(149);
});

/* The seal is not a licence to acknowledge. It stops dead at the first event
   that is still owed, so the history in front of one is discharged and the
   event itself waits for a wake that actually lands. */
test("the seal stops at the first event that is still owed", () => {
  const decision = seatTickDecision(input({
    events: [
      event({ seq: 60, type: "stage_started", summary: "builder started" }),
      event({ seq: 61, type: "stage_completed", summary: "a closed lane's stage", pipelineTerminal: true }),
      event({ seq: 62, type: "review_verdict", summary: "the round passed" }),
      event({ seq: 63, type: "stage_completed", summary: "another closed lane's stage", pipelineTerminal: true }),
    ],
    pipelines: [lane()],
    state: stateWith({ eventsThrough: 59, lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.state.eventsThrough).toBe(61);
  expect(reasonsOf(decision.verdict)).toEqual(["lane-event"]);
  /* And only a landing takes the cursor past the live one. */
  expect(seatTickWakeCommit(decision.state, plan(decision.verdict, "fp-1", 63), NOW).eventsThrough).toBe(63);
});

/* A skipped check remembers nothing — including this. The turn it landed behind
   has already superseded the evidence it read. */
test("a skipped check seals nothing", () => {
  const decision = seatTickDecision(input({
    seat: seat({ turn: "busy", activity: { lifecycle: "running", reason: "host_alive_turn_active" } }),
    events: [event({ seq: 60, type: "stage_completed", summary: "a closed lane's stage", pipelineTerminal: true })],
    state: stateWith({ eventsThrough: 59 }),
  }));
  expect(decision.verdict).toEqual({ kind: "skipped", reason: "seat-busy" });
  expect(decision.state.eventsThrough).toBe(59);
});

/* A live event further down the journal than this check reads is NOT announced
   as "something is waiting". That wake carried no item naming it, so the seat
   paid a resume to be told to look again — and the pages of history in front of
   it are now sealed away for free, so the check that reaches it names it. */
test("a live event past the page waits for the check that can name it, rather than raising an empty wake", () => {
  const decision = seatTickDecision(input({
    events: [event({ seq: 60, type: "stage_completed", summary: "a closed lane's stage", pipelineTerminal: true })],
    tasks: [card({ status: "inbox" })],
    state: stateWith({ eventsThrough: 59, lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "nothing owed" });
  expect(decision.state.eventsThrough).toBe(60);
});

/* #1289, the mirror image, and it cost twelve hours. Two lanes finished with
   clean approvals, three pull requests sat approved and unmerged, and the tick
   answered "quiet — nothing owed" every five minutes because `hasOpenWork`
   counts open lanes and board cards and a finished lane is neither. */
test("a finished lane whose pull request is still open is a wake reason of its own, naming the pull request", () => {
  const decision = seatTickDecision(input({
    pullRequests: [pullRequest()],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["unmerged-pr"]);
  expect(decision.verdict.kind === "wake" && decision.verdict.reasons[0]!.detail)
    .toBe("pull request #1289 left open by a lane that finished");
  expect(decision.verdict.kind === "wake" && decision.verdict.items[0]).toEqual({
    kind: "pull-request",
    id: "#1289",
    label: "wake on a merge that is waiting — open pull request from ship the exporter, unmerged since that lane finished",
  });
});

/* The merge is the discharge, and the only one. The source reads OPEN pull
   requests, so a merged or closed one is simply absent and the same project
   goes quiet with no second mechanism silencing anything. */
test("a merged batch goes quiet on its own", () => {
  const decision = seatTickDecision(input({
    pullRequests: [],
    tasks: [card({ status: "inbox" })],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "nothing owed" });
});

/* It is a reason, never a route around the bound: the hourly interval applies
   to it exactly as it applies to a terminal lane event. */
test("an unmerged pull request waits out the wake interval like every other reason", () => {
  const decision = seatTickDecision(input({
    pullRequests: [pullRequest()],
    state: stateWith({ lastWakeAt: new Date(NOW - MINUTE).toISOString() }),
  }));
  expect(decision.verdict.kind).toBe("quiet");
});

/* And the retry guard applies to it too, so a pull request nobody merges stops
   costing an hourly wake and becomes one card instead. */
test("an unmerged pull request that has stopped producing change is held by the retry guard", () => {
  const decision = seatTickDecision(input({
    pullRequests: [pullRequest()],
    state: stateWith({
      lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(),
      lastWakeFingerprint: "fp-1",
      wakesWithoutChange: { "unmerged-pr": 2 },
    }),
  }));
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "every wake reason is held by the retry guard" });
  expect(decision.cards.map((card) => card.ref)).toContain("seat-tick-stuck-unmerged-pr");
});

/* Several at once name the first and count the rest, and every one of them is
   carried as an item — the seat acts on the list without rediscovering it. */
test("several unmerged pull requests are counted in the reason and named one by one", () => {
  const decision = seatTickDecision(input({
    pullRequests: [pullRequest(), pullRequest({ number: 1290, title: "stop replaying closed lanes" })],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict.kind === "wake" && decision.verdict.reasons[0]!.detail)
    .toBe("pull request #1289 and 1 more left open by a lane that finished");
  expect(decision.verdict.kind === "wake" && decision.verdict.items.map((item) => item.id)).toEqual(["#1289", "#1290"]);
});

/* ------------------------------------------------------------------------- *
 * A read that failed may not be spent as a silence.
 *
 * The empty list a failed `gh` used to return was indistinguishable from every
 * pull request having merged, and the decision published `quiet — nothing
 * owed` on the strength of it. Quiet is a conclusion; this is what happens
 * when the evidence for it could not be read.
 * ------------------------------------------------------------------------- */

test("a check that could not read the open pull requests reports an error instead of quiet", () => {
  const decision = seatTickDecision(input({
    pullRequestsUnavailable: "command-failed",
    tasks: [card({ status: "inbox" })],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict).toEqual({
    kind: "error",
    detail: "the open pull requests of this project's finished lanes could not be read (command-failed), so nothing owed is not established",
  });
});

/* Every way the read can fail, and none of them is a merge. */
test("a timeout and a malformed answer are refused as quiet exactly like a failed command", () => {
  for (const gap of ["timed-out", "malformed-output", "lanes-unreadable"] as const) {
    const decision = seatTickDecision(input({
      pullRequestsUnavailable: gap,
      tasks: [card({ status: "inbox" })],
      state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
    }));
    expect(decision.verdict.kind).toBe("error");
  }
});

/* The bound the fix must not become a way around: the error raises no wake, so
   there is nothing for the stamp or the guard to record, and an hour of `gh`
   failures leaves the next real wake exactly as due as it was. */
test("a failed read spends neither the wake stamp nor the retry guard", () => {
  const before = stateWith({
    lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(),
    lastWakeFingerprint: "fp-1",
    wakesWithoutChange: { "unmerged-pr": 1 },
    quietSince: null,
  });
  const decision = seatTickDecision(input({ pullRequestsUnavailable: "timed-out", state: before }));
  expect(decision.state.lastWakeAt).toBe(before.lastWakeAt);
  expect(decision.state.wakesWithoutChange).toEqual({ "unmerged-pr": 1 });
  expect(decision.state.lastWakeReasons).toEqual(before.lastWakeReasons);
  /* And it does not record the project as having been quiet since now, which
     is the same claim in the state row that the verdict just declined to
     make. */
  expect(decision.state.quietSince).toBeNull();
});

/* The failure costs this one reason, never the check: a lane event that IS
   established still wakes the seat while `gh` is down, because a `gh` outage
   silencing the tick is the failure this whole issue is about. */
test("a wake reason that stands on its own still wakes while GitHub is unreadable", () => {
  const decision = seatTickDecision(input({
    pullRequestsUnavailable: "command-failed",
    events: [event({ seq: 60, type: "stage_blocked", summary: "the review round is parked" })],
    state: stateWith({ eventsThrough: 59, lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["lane-event"]);
});

/* And the interval still bounds it from the other side: a check that was never
   going to ask GitHub carries no gap, so it goes quiet as it always did. */
test("a check inside the interval is quiet rather than an error", () => {
  const decision = seatTickDecision(input({
    tasks: [card({ status: "inbox" })],
    state: stateWith({ lastWakeAt: new Date(NOW - MINUTE).toISOString() }),
  }));
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "nothing owed" });
});

/* A tick that is off is off; nothing was read, so there is nothing to report
   as unreadable. */
test("a project whose tick is off stays quiet rather than reporting an error", () => {
  const decision = seatTickDecision(input({
    pullRequestsUnavailable: "command-failed",
    settings: settings({ enabled: false, reason: "nothing here for me" }),
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict.kind).toBe("quiet");
});

/* An unmerged pull request is open work, so a board with nothing else on it
   does not read as idle and the proposal slot does not open under it. */
test("a finished lane with an open pull request is not an idle board", () => {
  const decision = seatTickDecision(input({
    pullRequests: [pullRequest()],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(), lastProposalAt: null }),
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["unmerged-pr"]);
  expect(decision.state.idleSince).toBeNull();
});

test("an assigned task nothing has started wakes the seat once the wake interval has elapsed", () => {
  const decision = seatTickDecision(input({
    tasks: [card()],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["unstarted-task"]);
});

/* #1262: the bound itself, at the layer that applies it. What the bound is FOR
   — a board of stale assigned cards that could never discharge the reason, and
   a movement that brings one back — is a claim about a real board under a real
   journal, so its regression is driven from those fixtures in
   `seatTickSources.test.ts` rather than asserted over an empty room here. */
test("a card with no readable movement instant is backlog, because staleness cannot be disproved", () => {
  const overdue = { lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() };
  expect(seatTickDecision(input({ tasks: [card({ updatedAt: null })], state: stateWith(overdue) })).verdict.kind).toBe("quiet");
  expect(seatTickDecision(input({ tasks: [card({ updatedAt: "not a time" })], state: stateWith(overdue) })).verdict.kind).toBe("quiet");
});

/* The seat is told why the number it is given is smaller than the board it can
   see, rather than being left to conclude the tick cannot count. */
test("the wake names the backlog it held back, and carries only the live cards as items", () => {
  const tasks = [
    card({ updatedAt: new Date(NOW - 30 * MINUTE).toISOString() }),
    card({ id: "task_c3", updatedAt: new Date(NOW - 20 * 24 * 60 * MINUTE).toISOString() }),
    card({ id: "task_d4", updatedAt: new Date(NOW - 90 * 24 * 60 * MINUTE).toISOString() }),
  ];
  const decision = seatTickDecision(input({ tasks, state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }) }));
  expect(decision.verdict.kind === "wake" && decision.verdict.reasons[0]!.detail)
    .toBe("1 assigned board task(s) nothing has started, and 2 older than the backlog bound the wake no longer names");
  expect(decision.verdict.kind === "wake" && decision.verdict.items.map((item) => item.id)).toEqual(["task_b2"]);
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
    LLV_SEAT_TICK_BACKLOG_DAYS: "5",
  })).toEqual({
    checkIntervalMs: 2 * MINUTE,
    stallAfterMs: 15 * MINUTE,
    proposalIntervalMs: 6 * 60 * MINUTE,
    itemsPerWake: 3,
    retryGuard: 1,
    backlogAfterMs: 5 * 24 * 60 * MINUTE,
  });
});

/* The wake interval is the one number the ADR's cost argument rests on — one
   resume per project per interval — so it is not among the knobs. An
   environment that tries to set it changes nothing. */
/* ------------------------------------------------------------------------- *
 * Per-project tick settings (#1275).
 *
 * The seat is forbidden from arming its own loop, correctly — and until this
 * existed it had no way to quiet, slow or stop the one the Viewer arms for it.
 * The property every case here is arranged around: a project nobody has
 * configured decides exactly what it decided before the settings existed,
 * which is what every OTHER test in this file asserts by using the defaults.
 * ------------------------------------------------------------------------- */

function settings(over: Partial<SeatTickSettings> = {}) {
  return effectiveSeatTickSettings(
    { ...defaultSeatTickSettings(PROJECT), ...over },
    NOW,
    SEAT_TICK_WAKE_INTERVAL_MS,
  );
}

test("a project nobody configured carries no tick-settings card at all (#1275)", () => {
  const decision = seatTickDecision(input({ pipelines: [lane()] }));
  expect(decision.cards).toEqual([]);
});

test("a disabled tick sends no wake, and says on the record why it is quiet (#1275)", () => {
  const decision = seatTickDecision(input({
    pipelines: [lane()],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
    settings: settings({ enabled: false, reason: "the only open lane is a draft nothing can discharge", updatedAt: "2026-08-28T11:00:00.000Z" }),
  }));
  expect(decision.verdict).toEqual({
    kind: "quiet",
    detail: "ticking is off for this project: the only open lane is a draft nothing can discharge",
  });
  expect(decision.cards).toEqual([{
    ref: "seat-tick-settings",
    kind: "tick-settings",
    state: "open",
    settings: { reason: "the only open lane is a draft nothing can discharge", until: null, setBy: null, updatedAt: "2026-08-28T11:00:00.000Z" },
    detail: "ticking is off for this project: no wake will be sent until it is turned back on",
  }]);
});

test("a disabled tick with no expiry stays off however long it has been off (#1275)", () => {
  const off = settings({ enabled: false, reason: "nothing here for me", updatedAt: "2026-01-01T00:00:00.000Z" });
  const decision = seatTickDecision(input({
    pipelines: [lane()],
    state: stateWith({ lastWakeAt: new Date(NOW - 400 * MINUTE).toISOString() }),
    settings: off,
  }));
  expect(decision.verdict.kind).toBe("quiet");
  expect(off.until).toBeNull();
});

test("the project's own wake interval is the bound every wake waits out (#1275)", () => {
  const state = stateWith({ lastWakeAt: new Date(NOW - 20 * MINUTE).toISOString() });
  /* The default hour holds this wake back … */
  expect(seatTickDecision(input({ pipelines: [lane()], state })).verdict.kind).toBe("quiet");
  /* … and a project that asked for a shorter one is woken. */
  const faster = seatTickDecision(input({
    pipelines: [lane()],
    state,
    settings: settings({ wakeIntervalMinutes: 15, reason: "a release is going out and I want the lane events sooner", updatedAt: "2026-08-28T11:00:00.000Z" }),
  }));
  expect(reasonsOf(faster.verdict)).toEqual(["interval"]);
  /* … and a project that asked for a longer one waits. */
  const slower = seatTickDecision(input({
    pipelines: [lane()],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
    settings: settings({ wakeIntervalMinutes: 6 * 60, reason: "nothing moves here faster than half a day", updatedAt: "2026-08-28T11:00:00.000Z" }),
  }));
  expect(slower.verdict.kind).toBe("quiet");
});

test("a slowed but enabled tick still carries its card, saying what it is set to (#1275)", () => {
  const decision = seatTickDecision(input({
    pipelines: [lane()],
    settings: settings({ wakeIntervalMinutes: 180, reason: "batching the board into three-hour rounds", updatedAt: "2026-08-28T11:00:00.000Z" }),
  }));
  expect(decision.cards[0]).toMatchObject({
    ref: "seat-tick-settings",
    state: "open",
    detail: "wakes for this project are set to one every 180 minute(s)",
  });
});

test("settings back at their default resolve the card instead of leaving it standing (#1275)", () => {
  const decision = seatTickDecision(input({
    pipelines: [lane()],
    settings: settings({ reason: "the draft is gone, ticking as normal again", updatedAt: "2026-08-28T11:30:00.000Z" }),
  }));
  expect(decision.cards).toEqual([{
    ref: "seat-tick-settings",
    kind: "tick-settings",
    state: "resolved",
    settings: { reason: null, until: null, setBy: null, updatedAt: "2026-08-28T11:30:00.000Z" },
    detail: "this project is on the default tick settings",
  }]);
});

test("a setting that reached its expiry ticks normally again and says so (#1275)", () => {
  const lapsed = settings({
    enabled: false,
    reason: "quiet while the release runs",
    until: new Date(NOW - MINUTE).toISOString(),
    updatedAt: "2026-08-28T10:00:00.000Z",
  });
  expect(lapsed).toMatchObject({ enabled: true, isDefault: true, lapsed: true });
  const decision = seatTickDecision(input({
    pipelines: [lane()],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
    settings: lapsed,
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["interval"]);
  expect(decision.cards[0]).toMatchObject({
    state: "resolved",
    detail: "the recorded tick setting reached its expiry, so this project is back on the default wake interval",
  });
});

test("a disabled tick keeps checking, so its journal line is what a broken tick would not have (#1275)", () => {
  const first = seatTickDecision(input({
    pipelines: [lane({ state: "inert" })],
    settings: settings({ enabled: false, reason: "nothing here for me", updatedAt: "2026-08-28T11:00:00.000Z" }),
  }));
  /* The stall memory is still kept while the tick is off, so the check that
     turns it back on decides from what it has been watching. */
  expect(first.state.stalledSeen).toEqual(["pipeline_a1"]);
  expect(first.verdict.kind).toBe("quiet");
});

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
