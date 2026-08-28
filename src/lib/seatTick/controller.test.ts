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

const { runSeatTickCheck, startSeatTick, stopSeatTick } = await import("./controller");
const { DEFAULT_SEAT_TICK_POLICY } = await import("./precheck");
import type { SeatTickControllerDependencies } from "./controller";
import type { SeatTickRunRecord } from "./journal";
import { emptySeatTickState, type SeatTickCard, type SeatTickProjectState } from "./types";
import type { DeliveryOutcome } from "@/lib/delivery";
import type { ConversationMessage } from "@/lib/delivery";

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
  seat: { conversationId: string; seatEpoch: number; path: string | null } | null;
}

function harness(options: {
  seat?: { conversationId: string; seatEpoch: number; path: string | null } | null;
  turn?: "busy" | "idle";
  pipelines?: { id: string; state: string; createdAt: string; movedAt: string | null }[];
  tasks?: { id: string; status: "inbox" | "assigned" | "blocked" | "done" }[];
  state?: Partial<SeatTickProjectState>;
  delivery?: DeliveryOutcome;
  /** Swaps the seat after the decision, the way a rotation lands mid-check. */
  rotateBeforeSend?: { conversationId: string; seatEpoch: number; path: string | null } | null;
}): Harness {
  const sent: ConversationMessage[] = [];
  const journal: SeatTickRunRecord[] = [];
  const cards: { project: string; card: SeatTickCard }[] = [];
  const written: SeatTickProjectState[] = [];
  const result: Harness = { deps: {}, sent, journal, cards, written, seat: options.seat === undefined ? { conversationId: CONVERSATION, seatEpoch: 7, path: null } : options.seat };
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
      hostStatus: () => null,
      digest: () => ({ subscriberId: "", relay: null, cursor: 41, pending: 0, heldUntil: null }),
      transcriptMtimeMs: () => null,
      deployments: () => ({ state: "unreadable", error: "no ledger" }),
      retirementReport: () => null,
      now: () => NOW,
    },
  };
  return result;
}

test("a quiet check writes one journal line, sends nothing, and raises no card", async () => {
  const rig = harness({
    pipelines: [{ id: "pipeline_a1", state: "running", createdAt: "2026-08-28T11:00:00.000Z", movedAt: "2026-08-28T11:58:00.000Z" }],
    state: { lastWakeAt: new Date(NOW - 5 * MINUTE).toISOString() },
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "quiet", delivery: null, items: 0 });
  expect(rig.journal).toHaveLength(1);
  expect(rig.sent).toEqual([]);
  expect(rig.cards).toEqual([]);
});

test("a wake is delivered by durable conversation id, with an idempotent client message id", async () => {
  const rig = harness({
    pipelines: [{ id: "pipeline_a1", state: "running", createdAt: "2026-08-28T09:00:00.000Z", movedAt: "2026-08-28T11:58:00.000Z" }],
    state: { lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() },
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["interval"] });
  expect(rig.sent).toHaveLength(1);
  expect(rig.sent[0]).toMatchObject({ pid: null, conversationId: CONVERSATION, images: [] });
  expect(rig.sent[0]!.clientMessageId).toBe(`seat-tick:${PROJECT}:7:${Math.floor(NOW / DEFAULT_SEAT_TICK_POLICY.checkIntervalMs)}`);
  expect(rig.sent[0]!.text).toContain("Seat tick");
  expect(rig.sent[0]!.text).toContain("Do not schedule yourself");
  expect(record!.delivery).toEqual({ clientMessageId: rig.sent[0]!.clientMessageId!, outcome: "delivered" });
  /* Only a delivered wake advances the stamp. */
  expect(rig.written[0]!.lastWakeAt).toBe(new Date(NOW).toISOString());
});

test("a seat that rotated between the decision and the send is never woken", async () => {
  const rig = harness({
    pipelines: [{ id: "pipeline_a1", state: "running", createdAt: "2026-08-28T09:00:00.000Z", movedAt: "2026-08-28T11:58:00.000Z" }],
    state: { lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() },
    rotateBeforeSend: { conversationId: SUCCESSOR, seatEpoch: 8, path: null },
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toEqual([]);
  expect(record!.delivery).toMatchObject({ outcome: "seat-rotated" });
  /* The refusal is journaled, and nothing records a wake the successor never got. */
  expect(rig.written[0]!.lastWakeAt).toBe(new Date(NOW - 61 * MINUTE).toISOString());
});

test("a seat revoked with no successor is likewise refused at the send", async () => {
  const rig = harness({
    pipelines: [{ id: "pipeline_a1", state: "running", createdAt: "2026-08-28T09:00:00.000Z", movedAt: "2026-08-28T11:58:00.000Z" }],
    state: { lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() },
    rotateBeforeSend: null,
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toEqual([]);
  expect(record!.delivery).toMatchObject({ outcome: "seat-rotated" });
});

test("a failed delivery leaves the wake stamp where it was, so the next check retries", async () => {
  const rig = harness({
    pipelines: [{ id: "pipeline_a1", state: "running", createdAt: "2026-08-28T09:00:00.000Z", movedAt: "2026-08-28T11:58:00.000Z" }],
    state: { lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() },
    delivery: { ok: false, outcome: "failed", error: "structured delivery ownership is unavailable", status: 503 },
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record!.delivery).toMatchObject({ outcome: "failed" });
  expect(rig.written[0]!.lastWakeAt).toBe(new Date(NOW - 61 * MINUTE).toISOString());
});

test("a busy seat is skipped without a send and without consuming the digest cursor", async () => {
  const rig = harness({
    turn: "busy",
    pipelines: [{ id: "pipeline_a1", state: "paused", createdAt: "2026-08-28T09:00:00.000Z", movedAt: null }],
    state: { lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(), digestThrough: 12 },
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "skipped", delivery: null, digestThrough: 12 });
  expect(rig.sent).toEqual([]);
});

test("open work with nobody seated raises the orchestrator card and wakes nothing", async () => {
  const rig = harness({
    seat: null,
    pipelines: [{ id: "pipeline_a1", state: "running", createdAt: "2026-08-28T09:00:00.000Z", movedAt: "2026-08-28T11:58:00.000Z" }],
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "no-seat", seatEpoch: null, delivery: null });
  expect(rig.cards).toHaveLength(1);
  expect(rig.cards[0]).toMatchObject({ project: PROJECT, card: { kind: "no-seat", ref: "orchestrator-unresolved" } });
  expect(rig.sent).toEqual([]);
});

test("the proactive slot delivers a proposal brief built from open issues", async () => {
  const rig = harness({ state: { lastProposalAt: new Date(NOW - 25 * 60 * MINUTE).toISOString() } });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "proactive" });
  expect(rig.sent).toHaveLength(1);
  expect(rig.sent[0]!.text).toContain("#1245 the native seat tick");
  expect(rig.sent[0]!.text).toContain("ONE ranked list of at most 5 actions");
  expect(rig.written[0]!.lastProposalAt).toBe(new Date(NOW).toISOString());
});

test("the tick is one clock in one process: a second start is refused out loud", () => {
  const lines: string[] = [];
  const timers: (() => void)[] = [];
  const schedule = (callback: () => void) => { timers.push(callback); return { unref() {} } as never; };
  expect(startSeatTick({ scheduleInterval: schedule, sweep: async () => {}, policy: DEFAULT_SEAT_TICK_POLICY, log: (line) => lines.push(line) })).toBe(true);
  expect(startSeatTick({ scheduleInterval: schedule, sweep: async () => {}, policy: DEFAULT_SEAT_TICK_POLICY, log: (line) => lines.push(line) })).toBe(false);
  expect(timers).toHaveLength(1);
  expect(lines.join("\n")).toContain("exactly one ticker per seat");
});

test("the off switch keeps the clock unstarted and says so", () => {
  const lines: string[] = [];
  expect(startSeatTick({ policy: null, log: (line) => lines.push(line) })).toBe(false);
  expect(lines.join("\n")).toContain("LLV_SEAT_TICK_CHECK_MINUTES=0");
});

test("a check that outran its interval drops the next tick rather than queueing it", async () => {
  const fires: (() => void)[] = [];
  let started = 0;
  let release: (() => void) | null = null;
  const sweep = () => new Promise<void>((resolve) => { started += 1; release = resolve; });
  startSeatTick({
    scheduleInterval: (callback) => { fires.push(callback); return { unref() {} } as never; },
    sweep,
    policy: DEFAULT_SEAT_TICK_POLICY,
    log: () => {},
  });
  fires[0]!();
  fires[0]!();
  expect(started).toBe(1);
  release!();
  await Promise.resolve();
  await Promise.resolve();
  fires[0]!();
  expect(started).toBe(2);
});
