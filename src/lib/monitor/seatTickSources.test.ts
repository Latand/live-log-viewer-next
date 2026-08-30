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
const { defaultSeatTickSettings } = await import("./seatTickSettings");
import type { AgentLivenessRecord } from "@/lib/lifecycle/liveness";
import type { OpenPullRequest, OpenPullRequestsUnavailable } from "./githubEvidence";
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
  settings?: ReturnType<SeatTickSources["settings"]>;
  livenessCalls?: { project?: string; conversationId?: string; stallAfterMs: number }[];
  openPullRequests?: OpenPullRequest[];
  pullRequestCalls?: { cwd: string; limit: number }[];
  pullRequestsThrow?: boolean;
  pullRequestsUnavailable?: OpenPullRequestsUnavailable;
  archivedPipelines?: Record<string, unknown>[];
  archiveCalls?: number[];
  archiveThrows?: boolean;
  noSeat?: boolean;
}): SeatTickSources {
  return {
    seatFor: () => ({
      active: over.noSeat ? null : { conversationId: CONVERSATION, seatEpoch: 7, path: null } as never,
      pending: null,
      history: [],
    }),
    activeSeats: () => [PROJECT],
    pipelines: () => (over.pipelines ?? [lane()]) as never,
    archivedPipelines: () => {
      over.archiveCalls?.push(1);
      if (over.archiveThrows) throw new Error("the archive is unreadable");
      return (over.archivedPipelines ?? []) as never;
    },
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
    settings: () => over.settings ?? defaultSeatTickSettings(PROJECT),
    openPullRequests: async (options) => {
      over.pullRequestCalls?.push(options);
      if (over.pullRequestsThrow) throw new Error("gh is not authenticated");
      if (over.pullRequestsUnavailable) return { ok: false, unavailable: over.pullRequestsUnavailable };
      return { ok: true, pullRequests: over.openPullRequests ?? [] };
    },
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

test("the check carries the project's own tick settings, expiry already applied (#1275)", async () => {
  const unconfigured = await gather({});
  expect(unconfigured.settings).toMatchObject({ enabled: true, isDefault: true, configured: false });

  const off = await gather({
    settings: {
      ...defaultSeatTickSettings(PROJECT),
      enabled: false,
      reason: "nothing here for me",
      updatedAt: "2026-08-28T11:00:00.000Z",
    },
  });
  expect(off.settings).toMatchObject({ enabled: false, isDefault: false, configured: true, reason: "nothing here for me" });

  const expired = await gather({
    settings: {
      ...defaultSeatTickSettings(PROJECT),
      enabled: false,
      reason: "quiet while the release runs",
      until: new Date(NOW - 60_000).toISOString(),
      updatedAt: "2026-08-28T10:00:00.000Z",
    },
  });
  expect(expired.settings).toMatchObject({ enabled: true, isDefault: true, lapsed: true });
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
  expect(input.events.some((entry) => entry.type === "review_verdict")).toBe(true);
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

/* ------------------------------------------------------------------------- *
 * #1285: an event whose lane is over, and a backlog of them.
 * ------------------------------------------------------------------------- */

/** A lane that ran and reached the end, which is what the tick's own store no
    longer lists as open. */
function finishedLane(over: Record<string, unknown> = {}): Record<string, unknown> {
  return lane({
    id: "pipeline_z9",
    task: "publish the merge queue",
    branch: "topic-merge-queue",
    state: "completed",
    cursor: null,
    runs: [],
    closedAt: new Date(NOW - 14 * 60 * 60_000).toISOString(),
    ...over,
  });
}

test("an event is marked history exactly when its own lane is no longer open", async () => {
  const input = await gather({
    pipelines: [lane(), finishedLane()],
    events: [
      event(10, { type: "stage_completed", pipelineId: "pipeline_a1", summary: "the builder finished" }),
      event(11, { type: "stage_completed", pipelineId: "pipeline_z9", summary: "the builder finished" }),
      /* Archived out of the hot store, which only ever takes settled records. */
      event(12, { type: "review_verdict", pipelineId: "pipeline_gone", summary: "the round passed" }),
      /* A deploy outcome names no pipeline, and nothing about it has finished. */
      event(13, { type: "deploy_failed", pipelineId: null, summary: "the release rolled back" }),
    ],
  }, withCursor(9));
  expect(input.events.map((entry) => entry.pipelineTerminal)).toEqual([false, true, true, false]);
});

/* The report, end to end: a wake whose every item named a pipeline that had
   reached a terminal state the day before, and whose entire cost was
   establishing that nothing was owed on any of them. */
test("a project whose only pending events belong to finished lanes is quiet, and the look discharges them", async () => {
  const history = Array.from({ length: 50 }, (_, index) => event(9900 + index, {
    type: "stage_completed",
    pipelineId: "pipeline_z9",
    summary: "the builder finished",
  }));
  const input = await gather(
    { pipelines: [finishedLane()], tasks: [boardCard({ status: "inbox" })], events: history },
    withCursor(9899, OVERDUE),
  );
  expect(input.events).toHaveLength(50);

  const decision = seatTickDecision(input);
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "nothing owed" });
  /* And no second wake is owed for the same backlog: the cursor is past all
     fifty on the strength of the one look that read them. */
  expect(decision.state.eventsThrough).toBe(9949);
});

/* ------------------------------------------------------------------------- *
 * #1289: a lane that finished and left its pull request open.
 * ------------------------------------------------------------------------- */

function openPullRequest(over: Partial<OpenPullRequest> = {}): OpenPullRequest {
  return {
    number: 1289,
    title: "wake on a merge that is waiting",
    headRefName: "topic-merge-queue",
    updatedAt: new Date(NOW - 30 * 60_000).toISOString(),
    ...over,
  };
}

test("a finished lane whose branch still has an open pull request is carried, named by its lane", async () => {
  const input = await gather(
    { pipelines: [finishedLane()], openPullRequests: [openPullRequest()] },
    withCursor(0, OVERDUE),
  );
  expect(input.pullRequests).toEqual([{
    number: 1289,
    title: "wake on a merge that is waiting",
    pipelineId: "pipeline_z9",
    pipelineTitle: "publish the merge queue",
    updatedAt: new Date(NOW - 30 * 60_000).toISOString(),
  }]);
  expect(reasonsOf(seatTickDecision(input))).toEqual(["unmerged-pr"]);
});

test("a pull request no finished lane produced is not this seat's obligation", async () => {
  const input = await gather(
    { pipelines: [finishedLane()], openPullRequests: [openPullRequest({ headRefName: "someone-elses-branch" })] },
    withCursor(0, OVERDUE),
  );
  expect(input.pullRequests).toEqual([]);
});

/* An open lane's pull request is the lane's business; the lane is already open
   work and the tick already carries it. The reason is about FINISHING. */
test("an open lane's pull request raises nothing", async () => {
  const input = await gather(
    { pipelines: [lane({ branch: "topic-merge-queue" })], openPullRequests: [openPullRequest()] },
    withCursor(0, OVERDUE),
  );
  expect(input.pullRequests).toEqual([]);
});

/* A discarded draft never ran, so it published nothing and left nothing behind
   (#1274 draws the same line for open lanes). */
test("a hidden lane leaves no pull request behind it", async () => {
  const calls: { cwd: string; limit: number }[] = [];
  const input = await gather(
    {
      pipelines: [finishedLane({ hiddenAt: new Date(NOW - 60_000).toISOString(), state: "closed" })],
      openPullRequests: [openPullRequest()],
      pullRequestCalls: calls,
    },
    withCursor(0, OVERDUE),
  );
  expect(input.pullRequests).toEqual([]);
  expect(calls).toEqual([]);
});

/* The read is a subprocess, so it happens only where a wake could come of it. */
test("the pull request read is skipped entirely until the wake interval has elapsed", async () => {
  const calls: { cwd: string; limit: number }[] = [];
  const early = await gather(
    { pipelines: [finishedLane()], openPullRequests: [openPullRequest()], pullRequestCalls: calls },
    withCursor(0, { lastWakeAt: new Date(NOW - 60_000).toISOString() }),
  );
  expect(calls).toEqual([]);
  expect(early.pullRequests).toEqual([]);

  await gather(
    { pipelines: [finishedLane()], openPullRequests: [openPullRequest()], pullRequestCalls: calls },
    withCursor(0, OVERDUE),
  );
  expect(calls).toEqual([{ cwd: "/srv/repo", limit: 60 }]);
});

/* The same rule as the clause above, applied to the other two ways a check
   ends before any wake reason is composed. A seat mid-turn is the expensive
   one: a turn that runs for hours would otherwise pay a subprocess at every
   five-minute check for its whole length. */
test("a check whose seat is already mid-turn asks GitHub nothing", async () => {
  const calls: { cwd: string; limit: number }[] = [];
  const input = await gather(
    {
      pipelines: [finishedLane()],
      openPullRequests: [openPullRequest()],
      pullRequestCalls: calls,
      seatTurn: "busy",
      seatRows: [livenessRow({ lifecycle: "running", reason: "host_alive_turn_active" })],
    },
    withCursor(0, OVERDUE),
  );
  expect(calls).toEqual([]);
  expect(input.pullRequests).toEqual([]);
});

test("a project with no seat to wake asks GitHub nothing", async () => {
  const calls: { cwd: string; limit: number }[] = [];
  const input = await gather(
    { pipelines: [finishedLane()], openPullRequests: [openPullRequest()], pullRequestCalls: calls, noSeat: true },
    withCursor(0, OVERDUE),
  );
  expect(calls).toEqual([]);
  expect(input.pullRequests).toEqual([]);
});

test("a project whose tick is off asks GitHub nothing", async () => {
  const calls: { cwd: string; limit: number }[] = [];
  const input = await gather(
    {
      pipelines: [finishedLane()],
      openPullRequests: [openPullRequest()],
      pullRequestCalls: calls,
      settings: { ...defaultSeatTickSettings(PROJECT), enabled: false, configured: true } as never,
    },
    withCursor(0, OVERDUE),
  );
  expect(calls).toEqual([]);
  expect(input.pullRequests).toEqual([]);
});

/* ------------------------------------------------------------------------- *
 * The obligation outlives the lane's residence in the hot store.
 *
 * Settled lanes are archived after three days. Reading only the hot store put
 * the reason on a timer nothing about the pull request knows: a tick switched
 * off, a seat busy for days, or a `gh` unreachable until archival all reach
 * their first eligible check with no lane to attribute anything to, and go
 * quiet over a pull request still sitting open.
 * ------------------------------------------------------------------------- */

/** The same lane, three days later: out of the hot store, into cold storage,
    and its pull request still unmerged. */
function archivedLane(over: Record<string, unknown> = {}): Record<string, unknown> {
  return finishedLane({ closedAt: new Date(NOW - 5 * DAY_MS).toISOString(), ...over });
}

test("a lane that has been archived still owes its open pull request", async () => {
  const input = await gather(
    { pipelines: [], archivedPipelines: [archivedLane()], openPullRequests: [openPullRequest()] },
    withCursor(0, OVERDUE),
  );
  expect(input.pullRequests).toEqual([{
    number: 1289,
    title: "wake on a merge that is waiting",
    pipelineId: "pipeline_z9",
    pipelineTitle: "publish the merge queue",
    updatedAt: new Date(NOW - 30 * 60_000).toISOString(),
  }]);
  expect(reasonsOf(seatTickDecision(input))).toEqual(["unmerged-pr"]);
});

/* The repository is asked for in the archived record too, because a project
   whose every lane has settled out still has one — and a `gh` never run is the
   same silence read off a different shelf. */
test("an archived lane names the repository the pull requests are read from", async () => {
  const calls: { cwd: string; limit: number }[] = [];
  await gather(
    { pipelines: [], archivedPipelines: [archivedLane()], openPullRequests: [openPullRequest()], pullRequestCalls: calls },
    withCursor(0, OVERDUE),
  );
  expect(calls).toEqual([{ cwd: "/srv/repo", limit: 60 }]);
});

/* And it discharges itself the same way a hot lane's does: the source reads
   OPEN pull requests, so a merge or a close simply stops returning the row. */
test("once that pull request merges the same project is quiet again", async () => {
  const input = await gather(
    { pipelines: [], archivedPipelines: [archivedLane()], openPullRequests: [] },
    withCursor(0, { ...OVERDUE, lastProposalAt: new Date(NOW - 60_000).toISOString() }),
  );
  expect(input.pullRequests).toEqual([]);
  expect(input.pullRequestsUnavailable).toBeNull();
  expect(seatTickDecision(input).verdict).toEqual({
    kind: "quiet",
    detail: "the board is done and the proposal slot is not due",
  });
});

/* Cold storage is read only where the check has already committed to a
   subprocess, so the gates that skip `gh` skip the archive with it. */
test("the archive is not read by a check that could raise no wake from it", async () => {
  const early: number[] = [];
  await gather(
    { pipelines: [finishedLane()], archiveCalls: early },
    withCursor(0, { lastWakeAt: new Date(NOW - 60_000).toISOString() }),
  );
  expect(early).toEqual([]);

  const seated: number[] = [];
  await gather({ pipelines: [finishedLane()], archiveCalls: seated, noSeat: true }, withCursor(0, OVERDUE));
  expect(seated).toEqual([]);

  const off: number[] = [];
  await gather(
    {
      pipelines: [finishedLane()],
      archiveCalls: off,
      settings: { ...defaultSeatTickSettings(PROJECT), enabled: false, configured: true } as never,
    },
    withCursor(0, OVERDUE),
  );
  expect(off).toEqual([]);

  const due: number[] = [];
  await gather({ pipelines: [finishedLane()], archiveCalls: due }, withCursor(0, OVERDUE));
  expect(due).toEqual([1]);
});

/* ------------------------------------------------------------------------- *
 * A read that failed is not a pull request that merged.
 *
 * Every failure below used to arrive as an empty list, which the decision then
 * read as "nothing open" — `quiet — nothing owed` published on the strength of
 * a `gh` nobody could run. The gap travels out of the gather instead.
 * ------------------------------------------------------------------------- */

test("a gh that throws is carried out of the gather as a gap, not as no pull requests", async () => {
  const input = await gather(
    { pipelines: [finishedLane()], pullRequestsThrow: true },
    withCursor(0, OVERDUE),
  );
  expect(input.pullRequests).toEqual([]);
  expect(input.pullRequestsUnavailable).toBe("command-failed");
  /* The rest of the check is untouched: one unreadable evidence source is not
     a failed check. */
  expect(input.tasks).toEqual([]);
});

test("each way gh can fail keeps its own name", async () => {
  for (const unavailable of ["command-failed", "timed-out", "malformed-output"] as const) {
    const input = await gather(
      { pipelines: [finishedLane()], pullRequestsUnavailable: unavailable },
      withCursor(0, OVERDUE),
    );
    expect(input.pullRequestsUnavailable).toBe(unavailable);
    expect(input.pullRequests).toEqual([]);
  }
});

/* The lanes are half of the correlation, so lanes that cannot be read leave
   the same question unanswered — and asking `gh` about lanes nobody could
   enumerate would answer it wrongly rather than not at all. */
test("lanes that cannot be read are a gap of their own, and gh is not asked", async () => {
  const calls: { cwd: string; limit: number }[] = [];
  const input = await gather(
    { pipelines: [finishedLane()], archiveThrows: true, openPullRequests: [openPullRequest()], pullRequestCalls: calls },
    withCursor(0, OVERDUE),
  );
  expect(input.pullRequestsUnavailable).toBe("lanes-unreadable");
  expect(input.pullRequests).toEqual([]);
  expect(calls).toEqual([]);
});

/* The successful empty answer is what a gap must stay distinguishable from:
   here GitHub was asked and said nothing is open, and quiet is earned. */
test("a successful empty answer leaves no gap behind it", async () => {
  const input = await gather(
    { pipelines: [finishedLane()], openPullRequests: [] },
    withCursor(0, OVERDUE),
  );
  expect(input.pullRequests).toEqual([]);
  expect(input.pullRequestsUnavailable).toBeNull();
});

/* A check that was never going to ask has no gap either — it reports nothing
   because nothing was owed from this reason, not because something failed. */
test("a check that asks GitHub nothing reports no gap", async () => {
  const input = await gather(
    { pipelines: [finishedLane()], pullRequestsThrow: true },
    withCursor(0, { lastWakeAt: new Date(NOW - 60_000).toISOString() }),
  );
  expect(input.pullRequestsUnavailable).toBeNull();
});

/* ------------------------------------------------------------------------- *
 * The run of failures the row remembers (#1298).
 *
 * A source that has been unreadable since the feature shipped is a different
 * fact from one that just missed a call, and the check could not tell them
 * apart: it reported the same journal line every five minutes for four hours
 * and put nothing anywhere an operator reads.
 * ------------------------------------------------------------------------- */

test("a failed read starts a run of failures on the row", async () => {
  const input = await gather(
    { pipelines: [finishedLane()], pullRequestsUnavailable: "command-failed" },
    withCursor(0, OVERDUE),
  );
  expect(input.state.pullRequestGap).toEqual({
    gap: "command-failed",
    since: new Date(NOW).toISOString(),
    lastAttemptAt: new Date(NOW).toISOString(),
    attempts: 1,
    reported: false,
  });
});

/* Inside the first interval the source is asked at every check: a transient
   failure has to recover at the check interval, not an hour later. */
test("a run younger than the wake interval is asked again at every check", async () => {
  const calls: { cwd: string; limit: number }[] = [];
  const young = {
    gap: "command-failed" as const,
    since: new Date(NOW - 10 * 60_000).toISOString(),
    lastAttemptAt: new Date(NOW - 5 * 60_000).toISOString(),
    attempts: 2,
    reported: false,
  };
  const input = await gather(
    { pipelines: [finishedLane()], pullRequestsUnavailable: "timed-out", pullRequestCalls: calls },
    withCursor(0, { ...OVERDUE, pullRequestGap: young }),
  );
  expect(calls).toHaveLength(1);
  /* The run keeps its own beginning, so "how long has this been broken" is not
     reset by every failure inside it. */
  expect(input.state.pullRequestGap).toMatchObject({ gap: "timed-out", since: young.since, attempts: 3 });
});

/* Past that point the subprocess is paid for once per wake interval — and the
   gap it already established is replayed, so the check in between still
   refuses to call this quiet. Slowing the read may never buy a silence. */
test("a standing run is asked once per wake interval, and the gap is replayed in between", async () => {
  const calls: { cwd: string; limit: number }[] = [];
  const standing = {
    gap: "command-failed" as const,
    since: new Date(NOW - 4 * 60 * 60_000).toISOString(),
    lastAttemptAt: new Date(NOW - 10 * 60_000).toISOString(),
    attempts: 23,
    reported: true,
  };
  const input = await gather(
    { pipelines: [finishedLane()], pullRequestsUnavailable: "command-failed", pullRequestCalls: calls },
    withCursor(0, { ...OVERDUE, pullRequestGap: standing }),
  );
  expect(calls).toEqual([]);
  expect(input.pullRequestsUnavailable).toBe("command-failed");
  expect(input.state.pullRequestGap).toEqual(standing);
  /* And the decision it feeds is the decision a fresh failed read would have
     produced: no wake from the unreadable source, and no quiet either. */
  expect(seatTickDecision(input).verdict.kind).toBe("error");

  const due: { cwd: string; limit: number }[] = [];
  const asked = await gather(
    { pipelines: [finishedLane()], pullRequestsUnavailable: "command-failed", pullRequestCalls: due },
    withCursor(0, { ...OVERDUE, pullRequestGap: { ...standing, lastAttemptAt: new Date(NOW - 61 * 60_000).toISOString() } }),
  );
  expect(due).toHaveLength(1);
  expect(asked.state.pullRequestGap).toMatchObject({ attempts: 24, reported: true });
});

/* An answer ends the run, whatever it says — which is what makes the next
   outage a fresh run with a report of its own. */
test("an answer clears the run of failures", async () => {
  const input = await gather(
    { pipelines: [finishedLane()], openPullRequests: [] },
    withCursor(0, {
      ...OVERDUE,
      pullRequestGap: {
        gap: "command-failed",
        since: new Date(NOW - 4 * 60 * 60_000).toISOString(),
        lastAttemptAt: new Date(NOW - 61 * 60_000).toISOString(),
        attempts: 23,
        reported: true,
      },
    }),
  );
  expect(input.pullRequestsUnavailable).toBeNull();
  expect(input.state.pullRequestGap).toBeNull();
});

/* A gate says nothing about whether the source can be read, so it leaves the
   run exactly as it stands — and reports no gap of its own, because this check
   asked nothing. */
test("a check that asks GitHub nothing leaves the run untouched", async () => {
  const standing = {
    gap: "command-failed" as const,
    since: new Date(NOW - 4 * 60 * 60_000).toISOString(),
    lastAttemptAt: new Date(NOW - 61 * 60_000).toISOString(),
    attempts: 23,
    reported: true,
  };
  const input = await gather(
    { pipelines: [finishedLane()], pullRequestsThrow: true },
    withCursor(0, { lastWakeAt: new Date(NOW - 60_000).toISOString(), pullRequestGap: standing }),
  );
  expect(input.pullRequestsUnavailable).toBeNull();
  expect(input.state.pullRequestGap).toEqual(standing);
});

/* The guard half, the same shape #1262 established for a card's movement: the
   fingerprint has to carry what the reason is decided from, or a guard keyed on
   it goes on suppressing the reason while a second pull request piles up. */
test("a second unmerged pull request moves the fingerprint", async () => {
  const one = await gather(
    { pipelines: [finishedLane()], openPullRequests: [openPullRequest()] },
    withCursor(0, OVERDUE),
  );
  const two = await gather(
    {
      pipelines: [finishedLane()],
      openPullRequests: [openPullRequest(), openPullRequest({ number: 1290, headRefName: "topic-merge-queue" })],
    },
    withCursor(0, OVERDUE),
  );
  expect(two.changeFingerprint).not.toBe(one.changeFingerprint);
});

test("another project's events are not this project's", async () => {
  const input = await gather({ events: [event(10, { project: "other", type: "review_verdict" })] }, withCursor(0));
  expect(input.events).toEqual([]);
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
