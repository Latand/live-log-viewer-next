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

const { gatherSeatTickInput, repoDirForProject, seatTickProjects } = await import("./seatTickSources");
import type { SeatTickSources } from "./seatTickSources";
const { DEFAULT_SEAT_TICK_POLICY } = await import("./seatTick");
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
    deployments: () => ({ state: "unreadable", error: "no ledger" }) as never,
    retirementReport: () => null,
    now: () => NOW,
  };
}

function gather(over: Parameters<typeof sources>[0], state: SeatTickProjectState = emptySeatTickState()) {
  return gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, sources(over));
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
  expect(input.pipelines[0]!.stageActivity).toEqual({ lifecycle: "stalled", reason: "host_alive_transcript_silent" });
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

test("a closed lane is not gathered at all, so it can neither stall nor fill a wake", async () => {
  const input = await gather({ pipelines: [lane({ state: "completed", closedAt: "2026-08-28T11:30:00.000Z" })] });
  expect(input.pipelines).toEqual([]);
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
  const input = await gather({ events }, { ...emptySeatTickState(), eventsThrough: 10 });
  expect(input.events.map((entry) => entry.seq)).toEqual([11, 12]);
  expect(input.terminalPending).toBe(true);
  /* Same cursor, same answer: a second read of the same state re-offers them. */
  const again = await gather({ events }, { ...emptySeatTickState(), eventsThrough: 10 });
  expect(again.events.map((entry) => entry.seq)).toEqual([11, 12]);
});

test("only terminal high-signal events count as pending; routine progress does not", async () => {
  const input = await gather({ events: [event(10), event(11)] });
  expect(input.events).toHaveLength(2);
  expect(input.terminalPending).toBe(false);
});

test("another project's events are not this project's", async () => {
  const input = await gather({ events: [event(10, { project: "other", type: "review_verdict" })] });
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
