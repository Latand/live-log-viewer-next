import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-tick-sources-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const { gatherSeatTickInput, repoDirForProject, runtimeWakeState, seatTickProjects, withdrawRuntimeWake } = await import("./seatTickSources");
import type { SeatTickSources } from "./seatTickSources";
const { DEFAULT_SEAT_TICK_POLICY, seatTickDecision } = await import("./seatTick");
import type { AgentLivenessRecord } from "@/lib/lifecycle/liveness";
import type { LifecycleEvent, LifecycleJournalFile } from "@/lib/lifecycle/journal";
import { emptySeatTickState, type SeatTickProjectState } from "./types";

/**
 * The gathering half of the tick (#1245): the projection the pure pre-check
 * decides over.
 *
 * Its two pieces of judgement are the ones the whole verdict rests on — where
 * a stall comes from (the registry's activity verdict, never a subtraction over
 * attempt timestamps) and what counts as unread (the tick's own cursor, which
 * only a delivered wake advances).
 */

const PROJECT = "viewer";
const CONVERSATION = ["conversation", "0f4c21b7729fbc9e"].join("_");
const STAGE_CONVERSATION = ["conversation", "3d81ac55e0b1742f"].join("_");
const TRANSCRIPT = "/srv/agents/build.jsonl";
const NOW = Date.parse("2026-08-28T12:00:00.000Z");

function lane(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "pipeline_a1",
    task: "ship the exporter",
    taskIds: [],
    project: PROJECT,
    repoDir: "/srv/repo",
    worktreeDir: "/srv/worktree",
    branch: "topic",
    baseBranch: "main",
    baseRef: "main",
    lastPassedCommit: "",
    stages: [],
    runs: [{ stageId: "build", attempts: [{ n: 1, state: "running", conversationId: STAGE_CONVERSATION, agentPath: TRANSCRIPT, startedAt: "2026-08-28T11:00:00.000Z" }] }],
    cursor: { stageId: "build", state: "running", input: null, activatedBy: null },
    state: "running",
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: "2026-08-28T09:00:00.000Z",
    closedAt: null,
    ...over,
  };
}

const DAY_MS = 24 * 60 * 60_000;

/** A board card as the store holds one. `updatedAt` is the field the backlog
    bound reads and the change fingerprint carries, so every case below sets it
    deliberately. */
function boardCard(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task_b2",
    project: PROJECT,
    status: "assigned",
    text: "wire the chip",
    placement: "unplaced",
    assignments: [],
    createdAt: new Date(NOW - 90 * DAY_MS).toISOString(),
    updatedAt: new Date(NOW - 30 * 60_000).toISOString(),
    ...over,
  };
}

function livenessRow(over: Partial<AgentLivenessRecord> = {}): AgentLivenessRecord {
  return {
    conversationId: STAGE_CONVERSATION,
    transcriptPath: TRANSCRIPT,
    project: PROJECT,
    engine: "claude",
    title: "build",
    lastRecordAt: null,
    turnState: "busy",
    host: { state: "alive", kind: "structured", pid: null },
    lifecycle: "stalled",
    reason: "host_alive_transcript_silent",
    silentForMs: 45 * 60_000,
    stalledForMs: 45 * 60_000,
    pipeline: { pipelineId: "pipeline_a1", stageId: "build", attempt: 1, reportedState: "running", reportedPipelineState: "running", paneId: null },
    evidenceSource: "transcript",
    ...over,
  } as AgentLivenessRecord;
}

function event(seq: number, over: Partial<LifecycleEvent> = {}): LifecycleEvent {
  return {
    id: `event-${seq}`,
    seq,
    at: new Date(NOW - 60_000).toISOString(),
    type: "stage_started",
    state: "running",
    project: PROJECT,
    pipelineId: "pipeline_a1",
    stageId: "build",
    attempt: 1,
    conversationId: null,
    role: "builder",
    summary: "builder started",
    ...over,
  };
}

function journal(events: LifecycleEvent[]): LifecycleJournalFile {
  return { version: 1, lastSeq: events.at(-1)?.seq ?? 0, events, retired: [] };
}

function sources(over: {
  pipelines?: Record<string, unknown>[];
  tasks?: Record<string, unknown>[];
  seatTurn?: string;
  laneRows?: AgentLivenessRecord[];
  seatRows?: AgentLivenessRecord[];
  livenessThrows?: boolean;
  events?: LifecycleEvent[];
  latestDeployment?: ReturnType<SeatTickSources["latestDeployment"]>;
  livenessCalls?: { project?: string; conversationId?: string; stallAfterMs: number }[];
}): SeatTickSources {
  return {
    seatFor: () => ({ active: { conversationId: CONVERSATION, seatEpoch: 7, path: null } as never, pending: null, history: [] }),
    activeSeats: () => [PROJECT],
    pipelines: () => (over.pipelines ?? [lane()]) as never,
    tasks: () => (over.tasks ?? []) as never,
    registry: () => ({
      conversation: () => ({ turn: { state: over.seatTurn ?? "idle" } }),
      conversationForPath: () => null,
    }) as never,
    liveness: async (request) => {
      over.livenessCalls?.push({
        ...(request.project ? { project: request.project } : {}),
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        stallAfterMs: request.stallAfterMs,
      });
      if (over.livenessThrows) throw new Error("the liveness plane is unavailable");
      return request.conversationId ? over.seatRows ?? [] : over.laneRows ?? [];
    },
    lifecycleJournal: () => journal(over.events ?? []),
    latestDeployment: () => over.latestDeployment ?? ({ state: "unreadable", error: "no ledger" }) as never,
    retirementReport: () => null,
    wakeState: async () => "retained",
    withdrawWake: async () => "withdrawn",
    now: () => NOW,
  };
}

function gather(over: Parameters<typeof sources>[0], state: SeatTickProjectState = emptySeatTickState()) {
  return gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, sources(over));
}

/** A row whose cursor was established at some earlier check. Distinct from the
    empty row, whose cursor is null because nothing has established one yet. */
function withCursor(eventsThrough: number, over: Partial<SeatTickProjectState> = {}): SeatTickProjectState {
  return { ...emptySeatTickState(), eventsThrough, ...over };
}

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("a lane carries the registry's own verdict for the turn its stage is holding", async () => {
  const input = await gather({ laneRows: [livenessRow()] });
  expect(input.pipelines[0]!.stageActivity).toEqual({ lifecycle: "stalled", reason: "host_alive_transcript_silent", turnState: "busy" });
});

/* The tick asks `agent_activity` at its own threshold rather than re-deriving
   one: the 40-minute silence the accepted defaults name travels into the read. */
test("the tick's stall threshold is what the liveness read is asked for", async () => {
  const calls: { project?: string; conversationId?: string; stallAfterMs: number }[] = [];
  await gather({ seatTurn: "busy", laneRows: [livenessRow()], livenessCalls: calls });
  expect(calls).toEqual([
    { conversationId: CONVERSATION, stallAfterMs: DEFAULT_SEAT_TICK_POLICY.stallAfterMs },
    { project: PROJECT, stallAfterMs: DEFAULT_SEAT_TICK_POLICY.stallAfterMs },
  ]);
});

/* A settled turn is never skipped and never signalled, so nothing reads its
   verdict — and a transcript tail per project per five minutes is not a read
   worth taking for an answer nobody consults. */
test("a seat whose turn has settled is not asked for a verdict at all", async () => {
  const calls: { project?: string; conversationId?: string; stallAfterMs: number }[] = [];
  const input = await gather({ laneRows: [livenessRow()], livenessCalls: calls });
  expect(calls.some((call) => call.conversationId)).toBe(false);
  expect(input.seat!.activity).toBeNull();
});

test("a lane the liveness plane says nothing about carries no verdict, and is therefore never stalled", async () => {
  const input = await gather({ laneRows: [] });
  expect(input.pipelines[0]!.stageActivity).toBeNull();
});

test("a liveness read that throws leaves every lane unjudged rather than failing the check", async () => {
  const input = await gather({ seatTurn: "busy", livenessThrows: true });
  expect(input.pipelines[0]!.stageActivity).toBeNull();
  expect(input.seat!.activity).toBeNull();
});

test("the seat carries its own turn verdict, read targeted by conversation id", async () => {
  const input = await gather({
    seatTurn: "busy",
    seatRows: [livenessRow({ conversationId: CONVERSATION, lifecycle: "stalled", reason: "host_gone_turn_open", pipeline: null })],
  });
  expect(input.seat).toMatchObject({ turn: "busy", activity: { lifecycle: "stalled", reason: "host_gone_turn_open" } });
  /* And the same fact becomes a signal, which is agenda enough for the hourly
     interval to carry a wake that resumes the host. */
  expect(input.signals.map((signal) => signal.id)).toContain("seat-host");
});

test("a seat whose turn is moving raises no seat-host signal", async () => {
  const input = await gather({
    seatTurn: "busy",
    seatRows: [livenessRow({ conversationId: CONVERSATION, lifecycle: "running", reason: "host_alive_turn_active", pipeline: null })],
  });
  expect(input.signals).toEqual([]);
});

/* #1262: the two readings of "the seat's turn", and which one the signal is
   entitled to. The registry's record says a turn is open; the transcript says
   whether one actually is. The silence threshold measures silence alone, so a
   seat that ended its turn cleanly and sat quiet past forty minutes is reported
   `stalled` — and the wake told the seat its own turn had stalled while it had
   simply finished. The verdict travels with the turn it was computed from. */
test("a seat that finished its turn and went quiet is not a stalled seat", async () => {
  const settled = await gather({
    seatTurn: "busy",
    seatRows: [livenessRow({
      conversationId: CONVERSATION,
      lifecycle: "stalled",
      reason: "host_alive_transcript_silent",
      turnState: "idle",
      pipeline: null,
      silentForMs: 41 * 60_000,
    })],
  });
  expect(settled.signals).toEqual([]);
  expect(settled.seat!.activity).toEqual({ lifecycle: "stalled", reason: "host_alive_transcript_silent", turnState: "idle" });

  /* The stall that is real — an open turn nothing has advanced for forty
     minutes — still says so, because that is the seat the wake exists to
     resume. */
  const stuck = await gather({
    seatTurn: "busy",
    seatRows: [livenessRow({
      conversationId: CONVERSATION,
      lifecycle: "stalled",
      reason: "host_alive_transcript_silent",
      turnState: "busy",
      pipeline: null,
      silentForMs: 41 * 60_000,
    })],
  });
  expect(stuck.signals.map((signal) => signal.id)).toEqual(["seat-host"]);
});

/* A dead host is a dead host whatever its turn was doing, and a wake resuming
   it is the reversal this mechanism's ADR records. */
test("a seat whose host is gone raises the signal even with a settled turn", async () => {
  const input = await gather({
    seatTurn: "busy",
    seatRows: [livenessRow({ conversationId: CONVERSATION, lifecycle: "gone", reason: "host_gone_turn_settled", turnState: "idle", pipeline: null })],
  });
  expect(input.signals.map((signal) => signal.id)).toEqual(["seat-host"]);
});

test("a closed lane is not gathered at all, so it can neither stall nor fill a wake", async () => {
  const input = await gather({ pipelines: [lane({ state: "completed", closedAt: "2026-08-28T11:30:00.000Z" })] });
  expect(input.pipelines).toEqual([]);
});

/* #1274. The record as it was found on disk: discarded, so `hiddenAt` is set,
   but written before a discard settled anything — `state` still `draft` and
   `closedAt` still null. Read as an open lane it was parked by the stall rule
   at every check, and the wake it produced named the one verb the operator had
   refused to press. */
test("a hidden lane is not gathered, whatever its state says (#1274)", async () => {
  const discarded = lane({ id: "pipeline_hidden", state: "draft", closedAt: null, hiddenAt: "2026-08-28T15:01:15.000Z", cursor: null, runs: [] });
  const input = await gather({ pipelines: [discarded] });
  expect(input.pipelines).toEqual([]);
  const decision = seatTickDecision(input);
  expect(decision.verdict.kind).not.toBe("wake");
});

test("a project whose only lane is hidden is not a project the tick checks (#1274)", () => {
  const projects = seatTickProjects({
    ...sources({}),
    activeSeats: () => [],
    pipelines: () => [lane({ project: "discarded-draft-only", state: "draft", closedAt: null, hiddenAt: "2026-08-28T15:01:15.000Z" })] as never,
    tasks: () => [] as never,
  });
  expect(projects).toEqual([]);
});

test("the fingerprint moves when a lane or a card moves, and only then", async () => {
  const base = await gather({});
  const same = await gather({});
  const moved = await gather({ pipelines: [lane({ state: "paused" })] });
  expect(same.changeFingerprint).toBe(base.changeFingerprint);
  expect(moved.changeFingerprint).not.toBe(base.changeFingerprint);
});

/* The tick keeps its own cursor because the digest's advances when the relay is
   READ, and an acknowledged event is never offered again. Reading here must
   therefore acknowledge nothing at all. */
test("events are read past the tick's own cursor, and reading acknowledges nothing", async () => {
  const events = [event(10), event(11, { type: "review_verdict", summary: "the round passed" }), event(12)];
  const input = await gather({ events }, withCursor(10));
  expect(input.events.map((entry) => entry.seq)).toEqual([11, 12]);
  expect(input.terminalPending).toBe(true);
  /* Same cursor, same answer: a second read of the same state re-offers them. */
  const again = await gather({ events }, withCursor(10));
  expect(again.events.map((entry) => entry.seq)).toEqual([11, 12]);
});

/* ------------------------------------------------------------------------- *
 * #1262: where the cursor starts.
 *
 * Every case below is driven from a journal that already HOLDS history — a
 * terminal verdict, a merged pull request, four days of lane events. An empty
 * journal agrees with any cursor at all and would have caught none of this.
 * ------------------------------------------------------------------------- */

/* The report: a first wake claiming "since the last delivered wake" while
   naming pull requests merged four days earlier, with ninety-three more items
   behind them. There had never been a delivered wake; the cursor started at
   zero and read the whole journal as unread. */
test("a seat with no cursor yet starts at the present, so its first check carries no history", async () => {
  const history = [
    event(9848, { type: "review_verdict", summary: "the round passed" }),
    event(9850, { type: "stage_completed", summary: "the builder finished" }),
    event(9853, { type: "stage_completed", summary: "the reviewer finished" }),
  ];
  const input = await gather({ events: history });
  expect(input.events).toEqual([]);
  expect(input.terminalPending).toBe(false);
  /* And the seal is written down, so the next check pages from it rather than
     re-deciding where the present was. */
  expect(input.state.eventsThrough).toBe(9853);
});

test("the seal is the journal head, so everything after the tick began is still delivered", async () => {
  const history = [event(9848, { type: "review_verdict", summary: "the round passed" })];
  const first = await gather({ events: history });
  const later = [...history, event(9849, { type: "stage_blocked", summary: "the review round is parked" })];
  const second = await gather({ events: later }, first.state);
  expect(second.events.map((entry) => entry.seq)).toEqual([9849]);
  expect(second.terminalPending).toBe(true);
});

/* The over-correction the fix must not make. A cursor a previous wake earned is
   a fact about what the seat was told, and jumping it to the head would drop
   exactly the events nobody has been told about yet. */
test("a seat that already has a cursor keeps reading from it, never from the present", async () => {
  const history = [
    event(40, { type: "stage_completed", summary: "the builder finished" }),
    event(41, { type: "review_verdict", summary: "the round passed" }),
    event(42, { type: "stage_completed", summary: "the reviewer finished" }),
  ];
  const input = await gather({ events: history }, withCursor(40, { lastWakeAt: "2026-08-28T11:00:00.000Z" }));
  expect(input.events.map((entry) => entry.seq)).toEqual([41, 42]);
  expect(input.state.eventsThrough).toBe(40);
});

/* ------------------------------------------------------------------------- *
 * #1262: the wake reason that could never be discharged.
 *
 * Driven from the condition that produced it rather than from an empty room:
 * a journal already holding four days of terminal lane events the seat has
 * been told about, and a board of assigned cards nobody will ever start. The
 * reported wake said `9 assigned board task(s) nothing has started` on every
 * interval for ever, because "assigned and unowned" is permanently true of a
 * card that is really a status note from two months ago.
 * ------------------------------------------------------------------------- */

/** Terminal lane events the seat has already been woken for. Every check below
    reads them and must carry none of them forward: they are history, and the
    cursor is what says so. */
const SETTLED_HISTORY = [
  event(9840, { type: "stage_completed", summary: "the builder finished" }),
  event(9845, { type: "review_verdict", summary: "the round passed" }),
  event(9850, { type: "stage_completed", summary: "the reviewer finished" }),
  event(9853, { type: "review_verdict", summary: "the round passed" }),
];
const OVERDUE = { lastWakeAt: new Date(NOW - 61 * 60_000).toISOString() };

/** The reason kinds a verdict carries, and none for a verdict that is not a
    wake. */
function reasonsOf(decision: ReturnType<typeof seatTickDecision>): string[] {
  return decision.verdict.kind === "wake" ? decision.verdict.reasons.map((reason) => reason.kind) : [];
}

test("under a journal the cursor has already passed, only a card that recently moved wakes the seat", async () => {
  const board = [
    boardCard({ id: "task_b2", updatedAt: new Date(NOW - 30 * 60_000).toISOString() }),
    boardCard({ id: "task_c3", updatedAt: new Date(NOW - 20 * DAY_MS).toISOString() }),
    boardCard({ id: "task_d4", updatedAt: new Date(NOW - 90 * DAY_MS).toISOString() }),
  ];
  const input = await gather({ pipelines: [], tasks: board, events: SETTLED_HISTORY }, withCursor(9853, OVERDUE));
  /* The journal is full and the check carries none of it, which is the whole
     point of the fixture: what wakes the seat here can only be the board. */
  expect(input.events).toEqual([]);
  expect(input.terminalPending).toBe(false);

  const decision = seatTickDecision(input);
  expect(reasonsOf(decision)).toEqual(["unstarted-task"]);
  expect(decision.verdict.kind === "wake" && decision.verdict.reasons[0]!.detail)
    .toBe("1 assigned board task(s) nothing has started, and 2 older than the backlog bound the wake no longer names");
  expect(decision.verdict.kind === "wake" && decision.verdict.items.map((item) => item.id)).toEqual(["task_b2"]);
});

/* The permanently-true reason, gone: a board of nothing but stale assigned
   cards owes the seat nothing, however much the journal behind it holds. */
test("a board whose assigned cards are all past the backlog bound wakes nobody", async () => {
  const board = [
    boardCard({ id: "task_c3", updatedAt: new Date(NOW - 20 * DAY_MS).toISOString() }),
    boardCard({ id: "task_d4", updatedAt: new Date(NOW - 90 * DAY_MS).toISOString() }),
  ];
  const input = await gather({ pipelines: [], tasks: board, events: SETTLED_HISTORY }, withCursor(9853, OVERDUE));
  expect(seatTickDecision(input).verdict.kind).toBe("quiet");
});

/* The guard half of the same defect. `updatedAt` decides whether a card is an
   unstarted task or backlog, so moving the card IS the discharge — and while
   that field was missing from the change fingerprint, the guard entry keyed on
   the fingerprint could not see the movement and went on suppressing the reason
   past the condition it was guarding. */
test("moving a stale card moves the fingerprint, so the retry guard cannot outlive the staleness it guarded", async () => {
  const stale = await gather(
    { pipelines: [], tasks: [boardCard({ updatedAt: new Date(NOW - 40 * DAY_MS).toISOString() })], events: SETTLED_HISTORY },
    withCursor(9853, OVERDUE),
  );
  const moved = await gather(
    { pipelines: [], tasks: [boardCard({ updatedAt: new Date(NOW - 2 * 60 * 60_000).toISOString() })], events: SETTLED_HISTORY },
    withCursor(9853, OVERDUE),
  );
  expect(moved.changeFingerprint).not.toBe(stale.changeFingerprint);

  /* A guard that has run out of patience on the state the card was in before
     the operator touched it. */
  const spent = { wakesWithoutChange: { "unstarted-task": DEFAULT_SEAT_TICK_POLICY.retryGuard } };
  const released = seatTickDecision({ ...moved, state: { ...moved.state, ...spent, lastWakeFingerprint: stale.changeFingerprint } });
  expect(reasonsOf(released)).toEqual(["unstarted-task"]);
  expect(released.cards).toEqual([]);

  /* And it is the movement that released it, not the guard having lapsed: the
     same guard against the state this check actually read still holds. */
  const held = seatTickDecision({ ...moved, state: { ...moved.state, ...spent, lastWakeFingerprint: moved.changeFingerprint } });
  expect(reasonsOf(held)).toEqual([]);
  expect(held.cards.map((card) => card.kind)).toEqual(["retry-guard"]);
});

/* ------------------------------------------------------------------------- *
 * #1262: which deployment the signal is about.
 * ------------------------------------------------------------------------- */

function deployment(over: { phase: string; terminal?: boolean }): ReturnType<SeatTickSources["latestDeployment"]> {
  return { state: "ok", value: { phase: over.phase, terminal: over.terminal ?? true } } as never;
}

test("the deployment signal reports the latest deployment, and stays silent when it succeeded", async () => {
  const healthy = await gather({ latestDeployment: deployment({ phase: "succeeded" }) });
  expect(healthy.signals).toEqual([]);
  const regressed = await gather({ latestDeployment: deployment({ phase: "rolled-back" }) });
  expect(regressed.signals).toEqual([{ id: "deploy", label: "the last deployment ended rolled-back" }]);
  /* A deployment still running is not an outcome to report at all. */
  const running = await gather({ latestDeployment: deployment({ phase: "promoting", terminal: false }) });
  expect(running.signals).toEqual([]);
});

test("only terminal high-signal events count as pending; routine progress does not", async () => {
  const input = await gather({ events: [event(10), event(11)] }, withCursor(0));
  expect(input.events).toHaveLength(2);
  expect(input.terminalPending).toBe(false);
});

test("another project's events are not this project's", async () => {
  const input = await gather({ events: [event(10, { project: "other", type: "review_verdict" })] }, withCursor(0));
  expect(input.events).toEqual([]);
  expect(input.terminalPending).toBe(false);
});

test("the projects worth checking are the seated ones plus anything with work and nobody on it", async () => {
  const projects = seatTickProjects(sources({
    pipelines: [lane({ project: "abandoned" })],
    tasks: [{ id: "task_b2", project: "unstarted", status: "assigned", text: "card", placement: "unplaced", assignments: [], createdAt: "", updatedAt: "" }],
  }));
  expect(projects).toEqual(["abandoned", "unstarted", PROJECT]);
});

test("a done board and a closed lane leave a project the tick has no opinion about", () => {
  const projects = seatTickProjects({
    ...sources({}),
    activeSeats: () => [],
    pipelines: () => [lane({ state: "completed", closedAt: "2026-08-28T11:30:00.000Z" })] as never,
    tasks: () => [{ id: "task_b2", project: "quiet", status: "done", text: "card", placement: "unplaced", assignments: [], createdAt: "", updatedAt: "" }] as never,
  });
  expect(projects).toEqual([]);
});

test("gh reads run in the repository the newest lane named, and nowhere when none did", () => {
  expect(repoDirForProject(PROJECT, sources({}))).toBe("/srv/repo");
  expect(repoDirForProject(PROJECT, sources({ pipelines: [lane({ repoDir: null })] }))).toBeNull();
});


/* ------------------------------------------------------------------------- *
 * The layer rule: which runtime receipt status means what to the tick, and
 * what a withdrawal aimed at that layer can honestly claim.
 *
 * This is where the two halves of the mechanism meet the runtime host. A send
 * it queued is ITS payload — the Viewer registry row beside it is a mirror, and
 * settling a mirror leaves the host's drain free to deliver the wake to a seat
 * that has since been replaced.
 * ------------------------------------------------------------------------- */

type FakeClient = Parameters<typeof withdrawRuntimeWake>[2];

function runtimeClient(over: {
  statuses?: string[];
  transition?: (status: string) => { status: string };
  transitions?: { operationId: string; status: string; reason: string | null }[];
  leafOperationId?: string;
}): FakeClient {
  const statuses = [...(over.statuses ?? [])];
  return {
    operationStatus: async (operationId: string) => {
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
      return status === undefined
        ? null
        : { operationId: over.leafOperationId ?? operationId, receipt: { status }, replayed: false };
    },
    transitionOperation: async (operationId: string, status: string, details?: { reason?: string | null }) => {
      over.transitions?.push({ operationId, status, reason: details?.reason ?? null });
      const settled = over.transition ? over.transition(status) : { status };
      return { operationId, receipt: settled, replayed: false };
    },
  } as unknown as FakeClient;
}

const WAKE = {
  clientMessageId: "seat-tick:viewer:7:first:interval:fp-1",
  conversationId: CONVERSATION,
  seatEpoch: 7,
  operationId: "op-wake-1",
  commit: { proposal: false, reasons: ["interval" as const], fingerprint: "fp-1", eventsThrough: 44 },
};

/* `queued` is what a structured host answers for EVERY admitted send, idle host
   or busy, so it is the status the whole accounting turns on: still the host's,
   never yet the seat's. */
test("the runtime host's own status is what says whether the wake reached the seat", async () => {
  expect(await runtimeWakeState("op-wake-1", runtimeClient({ statuses: ["queued"] }))).toBe("retained");
  expect(await runtimeWakeState("op-wake-1", runtimeClient({ statuses: ["pending"] }))).toBe("retained");
  expect(await runtimeWakeState("op-wake-1", runtimeClient({ statuses: ["delivering"] }))).toBe("retained");
  expect(await runtimeWakeState("op-wake-1", runtimeClient({ statuses: ["delivered"] }))).toBe("landed");
  expect(await runtimeWakeState("op-wake-1", runtimeClient({ statuses: ["failed"] }))).toBe("dropped");
  expect(await runtimeWakeState("op-wake-1", runtimeClient({ statuses: ["uncertain"] }))).toBe("dropped");
  /* An operation the host has never heard of is one nothing will deliver. */
  expect(await runtimeWakeState("op-wake-1", runtimeClient({}))).toBe("dropped");
});

/* The finding this round exists for: the revocation has to reach the queue that
   will actually deliver the message. */
test("a queued wake is taken back by failing the runtime operation itself", async () => {
  const transitions: { operationId: string; status: string; reason: string | null }[] = [];
  const withdrawn = await withdrawRuntimeWake("op-wake-1", "the seat was replaced", runtimeClient({ statuses: ["queued"], transitions }));
  expect(withdrawn).toBe("withdrawn");
  expect(transitions).toEqual([{ operationId: "op-wake-1", status: "failed", reason: "the seat was replaced" }]);
});

/* A retried send leaves the parent terminal, so the operation the drain will
   actually deliver is the leaf — and that is the one to take back. */
test("a retried wake is taken back at the operation the drain still holds", async () => {
  const transitions: { operationId: string; status: string; reason: string | null }[] = [];
  await withdrawRuntimeWake("op-wake-1", "the seat was replaced", runtimeClient({ statuses: ["queued"], leafOperationId: "op-wake-1-retry", transitions }));
  expect(transitions.map((entry) => entry.operationId)).toEqual(["op-wake-1-retry"]);
});

/* The honest impossibility. An operation the drain already has, or has already
   delivered, cannot be recalled — and failing a receipt underneath a drain that
   is about to settle it would break that drain for a claim the tick cannot make
   anyway. So nothing is transitioned and the answer says so. */
test("a wake the drain already has is reported too late, and never transitioned", async () => {
  const transitions: { operationId: string; status: string; reason: string | null }[] = [];
  expect(await withdrawRuntimeWake("op-wake-1", "gone", runtimeClient({ statuses: ["delivering"], transitions }))).toBe("too-late");
  expect(await withdrawRuntimeWake("op-wake-1", "gone", runtimeClient({ statuses: ["delivered"], transitions }))).toBe("too-late");
  expect(transitions).toEqual([]);
});

/* The host refuses the transition exactly when the operation left the queue
   between the read and the write. Whether that was a delivery decides between
   an honest "too late" and an honest "unknown"; neither is a revocation. */
test("an operation that left the queue mid-withdrawal is re-read rather than assumed", async () => {
  const raced = runtimeClient({ statuses: ["queued", "delivered"], transition: () => { throw new Error("runtime operation transition is invalid"); } });
  expect(await withdrawRuntimeWake("op-wake-1", "gone", raced)).toBe("too-late");
  const unclear = runtimeClient({ statuses: ["queued", "failed"], transition: () => { throw new Error("runtime operation transition is invalid"); } });
  expect(await withdrawRuntimeWake("op-wake-1", "gone", unclear)).toBe("unknown");
});

test("an operation already settled unsent needs no withdrawal", async () => {
  const transitions: { operationId: string; status: string; reason: string | null }[] = [];
  expect(await withdrawRuntimeWake("op-wake-1", "gone", runtimeClient({ statuses: ["failed"], transitions }))).toBe("withdrawn");
  expect(await withdrawRuntimeWake("op-wake-1", "gone", runtimeClient({ transitions }))).toBe("withdrawn");
  expect(transitions).toEqual([]);
});

/* The wake record is the argument to both questions, so the handle travels with
   it rather than being re-derived at either call site. */
test("both questions are asked of the operation the wake names", async () => {
  const transitions: { operationId: string; status: string; reason: string | null }[] = [];
  expect(await runtimeWakeState(WAKE.operationId, runtimeClient({ statuses: ["queued"] }))).toBe("retained");
  await withdrawRuntimeWake(WAKE.operationId, "the seat was replaced", runtimeClient({ statuses: ["queued"], transitions }));
  expect(transitions.map((entry) => entry.operationId)).toEqual([WAKE.operationId]);
});
