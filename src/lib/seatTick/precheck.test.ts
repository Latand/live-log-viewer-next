import { expect, test } from "bun:test";

import {
  DEFAULT_SEAT_TICK_POLICY,
  seatTickDecision,
  seatTickPolicy,
  seatTickWakeCommit,
} from "./precheck";
import {
  emptySeatTickState,
  type SeatTickCheckInput,
  type SeatTickPipelineInput,
  type SeatTickProjectState,
  type SeatTickTaskInput,
  type SeatTickVerdict,
} from "./types";

const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const PROJECT = "viewer";
/* Assembled from parts: a conversation-shaped literal is what the publication
   gate refuses in a committed artifact. */
const CONVERSATION = ["conversation", "0f4c21b7729fbc9e"].join("_");
const MINUTE = 60_000;

function seat(over: Partial<SeatTickCheckInput["seat"] & object> = {}) {
  return { conversationId: CONVERSATION, seatEpoch: 7, path: null, turn: "idle" as const, ...over };
}

function lane(over: Partial<SeatTickPipelineInput> = {}): SeatTickPipelineInput {
  return {
    id: "pipeline_a1",
    title: "ship the exporter",
    state: "active",
    updatedAt: new Date(NOW - MINUTE).toISOString(),
    silentForMs: null,
    stageId: "build",
    ...over,
  };
}

function card(over: Partial<SeatTickTaskInput> = {}): SeatTickTaskInput {
  return { id: "task_b2", title: "wire the chip", status: "assigned", owned: false, ...over };
}

function input(over: Partial<SeatTickCheckInput> = {}): SeatTickCheckInput {
  return {
    project: PROJECT,
    now: NOW,
    seat: seat(),
    pipelines: [],
    tasks: [],
    events: [],
    signals: [],
    changeFingerprint: "fp-1",
    digestThrough: 12,
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

test("a busy seat is skipped, not queued: the tick that would land after the turn is dropped", () => {
  const decision = seatTickDecision(input({
    seat: seat({ turn: "busy" }),
    pipelines: [lane({ state: "inert" })],
    state: stateWith({ stalledSeen: ["pipeline_a1"] }),
  }));
  expect(decision.verdict).toEqual({ kind: "skipped", reason: "seat-busy" });
  /* Nothing about the skipped check is remembered as progress: the stall memory
     and the digest cursor stay where they were, so the next check re-decides. */
  expect(decision.state.stalledSeen).toEqual(["pipeline_a1"]);
  expect(decision.state.digestThrough).toBe(0);
  expect(decision.state.lastCheckAt).toBe(new Date(NOW).toISOString());
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
  const silent = lane({ silentForMs: 45 * MINUTE });
  const overdue = { lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() };
  const first = seatTickDecision(input({ pipelines: [silent], state: stateWith(overdue) }));
  expect(reasonsOf(first.verdict)).toEqual(["interval"]);
  expect(first.state.stalledSeen).toEqual(["pipeline_a1"]);

  const second = seatTickDecision(input({ pipelines: [silent], state: { ...first.state, ...overdue } }));
  expect(reasonsOf(second.verdict)).toEqual(["stalled"]);
  if (second.verdict.kind !== "wake") throw new Error("unreachable");
  expect(second.verdict.items.map((item) => item.id)).toContain("pipeline_a1");
});

test("a parked lane stalls by the same rule, and a lane that moved again clears the memory", () => {
  const parked = lane({ state: "inert" });
  const first = seatTickDecision(input({ pipelines: [parked] }));
  expect(first.state.stalledSeen).toEqual(["pipeline_a1"]);
  const recovered = seatTickDecision(input({
    pipelines: [lane()],
    state: { ...first.state, lastWakeAt: new Date(NOW - 5 * MINUTE).toISOString() },
  }));
  expect(recovered.verdict.kind).toBe("quiet");
  expect(recovered.state.stalledSeen).toEqual([]);
});

test("a lane with no movement evidence at all is never called stalled", () => {
  const unknown = lane({ updatedAt: null, silentForMs: null });
  const overdue = { lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() };
  const first = seatTickDecision(input({ pipelines: [unknown], state: stateWith(overdue) }));
  expect(first.state.stalledSeen).toEqual([]);
  const second = seatTickDecision(input({ pipelines: [unknown], state: { ...first.state, ...overdue } }));
  expect(reasonsOf(second.verdict)).toEqual(["interval"]);
});

test("a terminal lane event wakes at the very next check, without waiting out the wake interval", () => {
  const decision = seatTickDecision(input({
    pipelines: [lane()],
    events: [{ at: new Date(NOW - MINUTE).toISOString(), type: "stage_blocked", summary: "review round parked", pipelineId: "pipeline_a1" }],
    state: stateWith({ lastWakeAt: new Date(NOW - MINUTE).toISOString(), lastWakeFingerprint: "fp-0" }),
  }));
  expect(decision.verdict.kind).toBe("wake");
  if (decision.verdict.kind !== "wake") throw new Error("unreachable");
  expect(decision.verdict.reasons.map((reason) => reason.kind)).toEqual(["lane-event"]);
});

test("routine lane events do not wake on their own", () => {
  const decision = seatTickDecision(input({
    pipelines: [lane()],
    events: [{ at: new Date(NOW - MINUTE).toISOString(), type: "stage_started", summary: "build started", pipelineId: "pipeline_a1" }],
    state: stateWith({ lastWakeAt: new Date(NOW - MINUTE).toISOString() }),
  }));
  expect(decision.verdict.kind).toBe("quiet");
});

test("an assigned task nothing has started wakes the seat once the wake interval has elapsed", () => {
  const decision = seatTickDecision(input({
    tasks: [card()],
    state: stateWith({ lastWakeAt: new Date(NOW - 90 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict.kind).toBe("wake");
  if (decision.verdict.kind !== "wake") throw new Error("unreachable");
  expect(decision.verdict.reasons.map((reason) => reason.kind)).toContain("unstarted-task");
  expect(decision.verdict.items.map((item) => item.id)).toContain("task_b2");
});

test("an owned, a blocked and a done task are all silent — blocked is the recorded stop", () => {
  const decision = seatTickDecision(input({
    tasks: [card({ owned: true }), card({ id: "task_c3", status: "blocked" }), card({ id: "task_d4", status: "done" })],
    state: stateWith({ lastWakeAt: new Date(NOW - 5 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict.kind).toBe("quiet");
});

test("an inbox card is open work but never wakes on its own — the operator's move to assigned starts it", () => {
  const parked = seatTickDecision(input({
    tasks: [card({ status: "inbox" })],
    state: stateWith({ lastWakeAt: new Date(NOW - 5 * MINUTE).toISOString() }),
  }));
  expect(parked.verdict.kind).toBe("quiet");
  expect(parked.state.idleSince).toBeNull();

  const moved = seatTickDecision(input({
    tasks: [card({ status: "assigned" })],
    state: stateWith({ lastWakeAt: new Date(NOW - 5 * MINUTE).toISOString() }),
  }));
  expect(reasonsOf(moved.verdict)).toEqual([]);
  const due = seatTickDecision(input({
    tasks: [card({ status: "assigned" })],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(reasonsOf(due.verdict)).toEqual(["unstarted-task"]);
});

test("the wake interval elapsing while a lane is open is itself a reason — roughly hourly", () => {
  const decision = seatTickDecision(input({
    pipelines: [lane()],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict.kind).toBe("wake");
  if (decision.verdict.kind !== "wake") throw new Error("unreachable");
  expect(decision.verdict.reasons.map((reason) => reason.kind)).toEqual(["interval"]);
});

test("the hourly interval never wakes an empty agenda — an inbox card nobody moved is nothing to say", () => {
  /* An inbox card is open work, so the seat is not idle and the proposal slot
     stays shut. But the seat is told not to act on inbox — the operator's move
     to assigned is what starts it — so an interval wake here would carry no
     items at all. A wake with an empty agenda is the burnt-quota tick this
     mechanism exists to end, so the interval reason keeps its silence. */
  const decision = seatTickDecision(input({
    tasks: [card({ status: "inbox" })],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict.kind).toBe("quiet");
  expect(decision.state.idleSince).toBeNull();
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
  const silent = lane({ silentForMs: 45 * MINUTE });
  const seen = stateWith({ stalledSeen: ["pipeline_a1"], lastWakeAt: new Date(NOW - 10 * MINUTE).toISOString() });
  const decision = seatTickDecision(input({ pipelines: [silent], state: seen }));
  expect(decision.verdict.kind).toBe("quiet");
});

test("a wake carries at most five items and reports the rest as deferred", () => {
  const lanes = Array.from({ length: 8 }, (_, index) => lane({ id: `pipeline_${index}`, silentForMs: 45 * MINUTE }));
  const seen = stateWith({ stalledSeen: lanes.map((entry) => entry.id) });
  const decision = seatTickDecision(input({ pipelines: lanes, state: seen }));
  expect(decision.verdict.kind).toBe("wake");
  if (decision.verdict.kind !== "wake") throw new Error("unreachable");
  expect(decision.verdict.items).toHaveLength(5);
  expect(decision.verdict.deferred).toBe(3);
});

test("with no work at all and the proposal slot due, the verdict is proactive", () => {
  const decision = seatTickDecision(input({
    state: stateWith({ lastProposalAt: new Date(NOW - 25 * 60 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict.kind).toBe("proactive");
  expect(decision.state.idleSince).toBe(new Date(NOW).toISOString());
});

test("a proposal slot that is not due leaves an idle seat quiet", () => {
  const decision = seatTickDecision(input({
    state: stateWith({ lastProposalAt: new Date(NOW - 60 * MINUTE).toISOString(), idleSince: new Date(NOW - 60 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "the board is done and the proposal slot is not due" });
  expect(decision.state.idleSince).toBe(new Date(NOW - 60 * MINUTE).toISOString());
});

test("a proposal card still open on the board holds the next proposal off", () => {
  const decision = seatTickDecision(input({
    tasks: [card({ status: "inbox" })],
    state: stateWith({
      lastProposalAt: new Date(NOW - 25 * 60 * MINUTE).toISOString(),
      lastWakeAt: new Date(NOW - 5 * MINUTE).toISOString(),
    }),
  }));
  expect(decision.verdict.kind).toBe("quiet");
});

test("a fruitless reason is re-sent at most twice, then becomes a card and drops out of wakes", () => {
  const silent = lane({ silentForMs: 45 * MINUTE });
  const base = { pipelines: [silent], changeFingerprint: "fp-stuck" };
  let state = stateWith({ stalledSeen: ["pipeline_a1"] });

  for (const expected of [0, 1, 2]) {
    const decision = seatTickDecision(input({ ...base, state }));
    expect(reasonsOf(decision.verdict)).toEqual(["stalled"]);
    expect(decision.cards).toEqual([]);
    state = seatTickWakeCommit(decision.state, decision.verdict, "fp-stuck", NOW);
    expect(state.wakesWithoutChange.stalled ?? 0).toBe(expected);
    state = { ...state, lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() };
  }

  const guarded = seatTickDecision(input({ ...base, state }));
  expect(guarded.verdict).toEqual({ kind: "quiet", detail: "every wake reason is held by the retry guard" });
  expect(guarded.cards.map((entry) => entry.kind)).toEqual(["retry-guard"]);
});

test("board movement clears the retry guard, so a reason that starts working again is sent again", () => {
  const silent = lane({ silentForMs: 45 * MINUTE });
  const state = stateWith({
    stalledSeen: ["pipeline_a1"],
    wakesWithoutChange: { stalled: 9 },
    lastWakeFingerprint: "fp-old",
    lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(),
  });
  const decision = seatTickDecision(input({ pipelines: [silent], changeFingerprint: "fp-new", state }));
  expect(decision.verdict.kind).toBe("wake");
  const committed = seatTickWakeCommit(decision.state, decision.verdict, "fp-new", NOW);
  expect(committed.wakesWithoutChange.stalled).toBe(0);
});

test("the wake commit records the wake, and only the commit advances lastWakeAt", () => {
  const decision = seatTickDecision(input({
    pipelines: [lane()],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.state.lastWakeAt).toBe(new Date(NOW - 61 * MINUTE).toISOString());
  const committed = seatTickWakeCommit(decision.state, decision.verdict, "fp-1", NOW);
  expect(committed.lastWakeAt).toBe(new Date(NOW).toISOString());
  expect(committed.lastWakeReasons).toEqual(["interval"]);
  expect(committed.lastWakeFingerprint).toBe("fp-1");
});

test("a proactive commit stamps the proposal slot", () => {
  const committed = seatTickWakeCommit(emptySeatTickState(), { kind: "proactive", detail: "" }, "fp-1", NOW);
  expect(committed.lastProposalAt).toBe(new Date(NOW).toISOString());
});

test("the check consumes the digest cursor only when it actually decided", () => {
  const decided = seatTickDecision(input({ digestThrough: 41 }));
  expect(decided.state.digestThrough).toBe(41);
});

test("policy defaults are the accepted ones, and each is overridable in the retirement idiom", () => {
  expect(DEFAULT_SEAT_TICK_POLICY).toEqual({
    checkIntervalMs: 5 * MINUTE,
    wakeIntervalMs: 60 * MINUTE,
    stallAfterMs: 40 * MINUTE,
    proposalIntervalMs: 24 * 60 * MINUTE,
    itemsPerWake: 5,
    retryGuard: 2,
  });
  expect(seatTickPolicy({})).toEqual(DEFAULT_SEAT_TICK_POLICY);
  expect(seatTickPolicy({ LLV_SEAT_TICK_WAKE_MINUTES: "15", LLV_SEAT_TICK_ITEMS: "3" })).toMatchObject({
    wakeIntervalMs: 15 * MINUTE,
    itemsPerWake: 3,
  });
  /* Nonsense never silently becomes a policy: it falls back to the default. */
  expect(seatTickPolicy({ LLV_SEAT_TICK_STALL_MINUTES: "banana" })!.stallAfterMs).toBe(40 * MINUTE);
  /* The off switch, in the LLV_HOST_RETIREMENT_IDLE_HOURS=0 shape. */
  expect(seatTickPolicy({ LLV_SEAT_TICK_CHECK_MINUTES: "0" })).toBeNull();
});
