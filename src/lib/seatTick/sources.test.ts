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

const { gatherSeatTickInput, repoDirForProject, seatTickProjects } = await import("./sources");
import type { SeatTickSources } from "./sources";
const { DEFAULT_SEAT_TICK_POLICY } = await import("./precheck");
import { emptySeatTickState } from "./types";

/**
 * The gathering half of the tick (#1245): the projection the pure pre-check
 * decides over. Its one piece of judgement is `silentForMs` — the registry's
 * `stalled` shape read at the tick's threshold — and every stall verdict rests
 * on it, so the cases that must NOT read as silence are the point of this file.
 */

const PROJECT = "viewer";
const CONVERSATION = ["conversation", "0f4c21b7729fbc9e"].join("_");
const STAGE_CONVERSATION = ["conversation", "3d81ac55e0b1742f"].join("_");
const TRANSCRIPT = "/srv/agents/build.jsonl";
const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const MINUTE = 60_000;

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

function sources(over: {
  pipelines?: Record<string, unknown>[];
  tasks?: Record<string, unknown>[];
  stageTurn?: string | null;
  mtimeMs?: number | null;
}): SeatTickSources {
  return {
    seatFor: () => ({ active: { conversationId: CONVERSATION, seatEpoch: 7, path: null } as never, pending: null, history: [] }),
    activeSeats: () => [PROJECT],
    pipelines: () => (over.pipelines ?? [lane()]) as never,
    tasks: () => (over.tasks ?? []) as never,
    registry: () => ({
      conversation: (id: string) => (id === CONVERSATION
        ? { turn: { state: "idle" } }
        : over.stageTurn === null ? null : { turn: { state: over.stageTurn ?? "busy" } }),
      conversationForPath: () => (over.stageTurn === null ? null : { turn: { state: over.stageTurn ?? "busy" } }),
    }) as never,
    hostStatus: () => null,
    digest: () => ({ subscriberId: "", relay: null, cursor: 41, pending: 0, heldUntil: null }),
    transcriptMtimeMs: () => (over.mtimeMs === undefined ? NOW - 45 * MINUTE : over.mtimeMs),
    deployments: () => ({ state: "unreadable", error: "no ledger" }) as never,
    retirementReport: () => null,
    now: () => NOW,
  };
}

function gather(over: Parameters<typeof sources>[0]) {
  return gatherSeatTickInput(PROJECT, emptySeatTickState(), DEFAULT_SEAT_TICK_POLICY, sources(over));
}

test("a running stage whose transcript stopped growing under an open turn reads as silence", () => {
  const input = gather({});
  expect(input.pipelines[0]).toMatchObject({ id: "pipeline_a1", state: "active", silentForMs: 45 * MINUTE, stageId: "build" });
});

test("a settled turn is not a stall, however old the transcript is", () => {
  expect(gather({ stageTurn: "idle" }).pipelines[0]!.silentForMs).toBeNull();
});

test("a transcript that cannot be read is not a silent one", () => {
  expect(gather({ mtimeMs: null }).pipelines[0]!.silentForMs).toBeNull();
});

test("a stage with no running attempt has nothing to be silent about", () => {
  const settled = lane({ runs: [{ stageId: "build", attempts: [{ n: 1, state: "passed", conversationId: STAGE_CONVERSATION, agentPath: TRANSCRIPT, completedAt: "2026-08-28T11:00:00.000Z" }] }] });
  expect(gather({ pipelines: [settled] }).pipelines[0]!.silentForMs).toBe(null);
});

test("a running attempt the registry knows nothing about still falls to the transcript — the host the engine has not noticed", () => {
  expect(gather({ stageTurn: null }).pipelines[0]!.silentForMs).toBe(45 * MINUTE);
});

test("a closed lane is not gathered at all, so it can neither stall nor fill a wake", () => {
  const closed = lane({ id: "pipeline_b2", state: "completed", closedAt: "2026-08-28T11:30:00.000Z" });
  expect(gather({ pipelines: [lane(), closed] }).pipelines.map((entry) => entry.id)).toEqual(["pipeline_a1"]);
});

test("the fingerprint moves when a lane or a card moves, and only then", () => {
  const first = gather({}).changeFingerprint;
  expect(gather({}).changeFingerprint).toBe(first);
  expect(gather({ pipelines: [lane({ state: "paused" })] }).changeFingerprint).not.toBe(first);
});

test("the digest is consumed only by a check that will decide — a busy seat leaves the cursor alone", () => {
  const base = sources({});
  const busy: SeatTickSources = {
    ...base,
    registry: () => ({ conversation: () => ({ turn: { state: "busy" } }), conversationForPath: () => null }) as never,
  };
  const state = { ...emptySeatTickState(), digestThrough: 12 };
  expect(gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, busy).digestThrough).toBe(12);
  expect(gatherSeatTickInput(PROJECT, state, DEFAULT_SEAT_TICK_POLICY, base).digestThrough).toBe(41);
});

test("the projects worth checking are the seated ones plus anything with work and nobody on it", () => {
  const orphan = lane({ id: "pipeline_c3", project: "other" });
  const carded = { id: "task_d4", project: "third", status: "assigned", text: "card", placement: "unplaced", assignments: [], createdAt: "2026-08-28T10:00:00.000Z", updatedAt: "2026-08-28T10:00:00.000Z" };
  expect(seatTickProjects(sources({ pipelines: [lane(), orphan], tasks: [carded] }))).toEqual(["other", "third", PROJECT]);
});

test("a done board and a closed lane leave a project the tick has no opinion about", () => {
  const closed = lane({ id: "pipeline_e5", project: "other", state: "closed", closedAt: "2026-08-28T11:00:00.000Z" });
  const done = { id: "task_f6", project: "other", status: "done", text: "card", placement: "unplaced", assignments: [], createdAt: "2026-08-28T10:00:00.000Z", updatedAt: "2026-08-28T10:00:00.000Z" };
  expect(seatTickProjects(sources({ pipelines: [closed], tasks: [done] }))).toEqual([PROJECT]);
});

test("gh reads run in the repository the newest lane named, and nowhere when none did", () => {
  const older = lane({ id: "pipeline_g7", repoDir: "/srv/old", createdAt: "2026-08-01T09:00:00.000Z" });
  expect(repoDirForProject(PROJECT, sources({ pipelines: [older, lane()] }))).toBe("/srv/repo");
  expect(repoDirForProject(PROJECT, sources({ pipelines: [lane({ repoDir: null })] }))).toBeNull();
});

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
