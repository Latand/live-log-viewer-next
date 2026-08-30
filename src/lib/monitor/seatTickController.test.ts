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
const { defaultSeatTickSettings } = await import("./seatTickSettings");
const { openPullRequestsForRepo } = await import("./githubEvidence");
import type { SeatTickSettings } from "./seatTickSettings";
import type { SeatTickControllerDependencies } from "./seatTickController";
import type { GithubRunner, OpenPullRequest, OpenPullRequestsUnavailable } from "./githubEvidence";
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

type PipelineFixture = { id: string; state: string; createdAt: string; movedAt: string | null; branch?: string; closedAt?: string | null };

function pipelineRecord(entry: PipelineFixture) {
  return {
    id: entry.id,
    task: `lane ${entry.id}`,
    taskIds: [],
    project: PROJECT,
    repoDir: "/srv/repo",
    worktreeDir: "/srv/worktree",
    branch: entry.branch ?? "topic",
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
    closedAt: entry.closedAt ?? null,
  };
}

function harness(options: {
  seat?: { conversationId: string; seatEpoch: number; path: string | null } | null;
  turn?: "busy" | "idle";
  seatActivity?: Partial<AgentLivenessRecord> | null;
  pipelines?: PipelineFixture[];
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
  /** The project's own tick settings (#1275); the default is the tick as it
      shipped. */
  settings?: SeatTickSettings;
  /** What `gh` reports open in the project's repository (#1289). */
  openPullRequests?: OpenPullRequest[];
  /** The `gh` read failing rather than answering (#1289). Distinct from an
      empty answer on purpose: that is what the check may go quiet on. */
  pullRequestsUnavailable?: OpenPullRequestsUnavailable;
  /** The `gh` seam itself, one level below the option above, so a command that
      throws, a child killed at its timeout and output nobody can attribute
      reach the check the way they reach it in production — through the real
      parse — rather than as a verdict the test picked for it. */
  githubRun?: GithubRunner;
  archivedPipelines?: PipelineFixture[];
}): Harness {
  const sent: ConversationMessage[] = [];
  const journal: SeatTickRunRecord[] = [];
  const cards: { project: string; card: SeatTickCard }[] = [];
  const written: SeatTickProjectState[] = [];
  const withdrawn: { wake: SeatTickOutstandingWake; reason: string }[] = [];
  const result: Harness = { deps: {}, sent, journal, cards, written, withdrawn, seat: options.seat === undefined ? { conversationId: CONVERSATION, seatEpoch: 7, path: null } : options.seat };
  let reads = 0;

  const pipelines = (options.pipelines ?? []).map(pipelineRecord);
  /* Lanes the hot store has already let go of: a settled record leaves after
     three days and the pull request it left open does not (#1289). */
  const archived = (options.archivedPipelines ?? []).map(pipelineRecord);

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
      archivedPipelines: () => archived as never,
      tasks: () => tasks as never,
      registry: () => ({
        conversation: () => ({ turn: { state: options.turn ?? "idle" } }),
        conversationForPath: () => null,
      }) as never,
      liveness: async (request) => (request.conversationId && options.seatActivity
        ? [{ lifecycle: "running", reason: "host_alive_turn_active", ...options.seatActivity } as AgentLivenessRecord]
        : []),
      lifecycleJournal: () => ({ version: 1, lastSeq: options.events?.at(-1)?.seq ?? 0, events: options.events ?? [], retired: [] }),
      latestDeployment: () => ({ state: "unreadable", error: "no ledger" }) as never,
      retirementReport: () => null,
      settings: () => options.settings ?? defaultSeatTickSettings(PROJECT),
      openPullRequests: async (request) => {
        if (options.githubRun) return openPullRequestsForRepo({ ...request, run: options.githubRun });
        return options.pullRequestsUnavailable
          ? { ok: false, unavailable: options.pullRequestsUnavailable }
          : { ok: true, pullRequests: options.openPullRequests ?? [] };
      },
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

/* ------------------------------------------------------------------------- *
 * The tick settings a project decides for itself (#1275).
 * ------------------------------------------------------------------------- */

function offSettings(over: Partial<SeatTickSettings> = {}): SeatTickSettings {
  return {
    ...defaultSeatTickSettings(PROJECT),
    enabled: false,
    reason: "the only open lane is a draft nothing can discharge",
    updatedAt: "2026-08-28T11:00:00.000Z",
    setBy: { kind: "manager", conversationId: CONVERSATION, project: PROJECT, seatEpoch: 7 },
    ...over,
  };
}

test("a project whose tick is off is checked, journaled and never woken (#1275)", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE, settings: offSettings() });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent).toEqual([]);
  /* The line is the whole difference between a tick that is off and a tick
     that broke: one keeps writing, the other stops. */
  expect(record).toMatchObject({
    verdict: "quiet",
    delivery: null,
    detail: "ticking is off for this project: the only open lane is a draft nothing can discharge",
  });
  expect(rig.cards.map((entry) => entry.card)).toEqual([{
    ref: "seat-tick-settings",
    kind: "tick-settings",
    state: "open",
    settings: { reason: offSettings().reason, until: null, setBy: offSettings().setBy, updatedAt: "2026-08-28T11:00:00.000Z" },
    detail: "ticking is off for this project: no wake will be sent until it is turned back on",
  }]);
});

test("a tick setting that reached its expiry is written back to the default by the check that reads it (#1275)", async () => {
  const settings = offSettings({ until: new Date(NOW - MINUTE).toISOString() });
  const persisted: SeatTickSettings[] = [];
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE, settings });
  const record = await runSeatTickCheck(PROJECT, { ...rig.deps, writeSettings: (_project, row) => { persisted.push(row); } });
  /* The wake goes out — the setting lapsed — and the record on disk stops
     saying "off" beside a tick that is ticking. */
  expect(record).toMatchObject({ verdict: "wake" });
  expect(persisted).toEqual([defaultSeatTickSettings(PROJECT)]);
  expect(rig.cards[0]!.card).toMatchObject({ state: "resolved" });
});

test("the lapse ends the setting that expired and keeps the monitor prompt it never covered (#1280)", async () => {
  const settings = offSettings({ until: new Date(NOW - MINUTE).toISOString(), monitorPrompt: MONITOR_PROMPT });
  const persisted: SeatTickSettings[] = [];
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE, settings });
  await runSeatTickCheck(PROJECT, { ...rig.deps, writeSettings: (_project, row) => { persisted.push(row); } });
  /* The expiry was set on the on/off, so that is what it ended. The words the
     seat left for its own wakes were not part of it, and the wake this very
     check sent still carries them. */
  expect(persisted).toEqual([{
    ...defaultSeatTickSettings(PROJECT),
    monitorPrompt: MONITOR_PROMPT,
    updatedAt: settings.updatedAt,
    setBy: settings.setBy,
  }]);
  expect(rig.sent[0]!.text).toContain(MONITOR_PROMPT);
});

test("the board card for a quiet tick is written, kept in step, and closed when the tick comes back (#1275)", async () => {
  const project = `card-lifecycle-${crypto.randomUUID().slice(0, 8)}`;
  const tasksFile = path.join(SANDBOX, "state", "tasks.json");
  const readCards = (): { text: string; status: string }[] => {
    const raw = fs.existsSync(tasksFile) ? JSON.parse(fs.readFileSync(tasksFile, "utf8")) as { tasks?: { project: string; text: string; status: string }[] } : {};
    return (raw.tasks ?? []).filter((task) => task.project === project).map((task) => ({ text: task.text, status: task.status }));
  };

  const off = harness({ pipelines: OPEN_LANE, settings: { ...offSettings(), project } });
  /* The real card writer, not the harness stub: this is the board surface the
     issue asks for. */
  await runSeatTickCheck(project, { ...off.deps, ensureCard: undefined });
  const raised = readCards();
  expect(raised).toHaveLength(1);
  expect(raised[0]!.text).toContain("This project's seat tick is not on its default settings");
  expect(raised[0]!.text).toContain("the only open lane is a draft nothing can discharge");
  expect(raised[0]!.status).not.toBe("done");

  /* A check that finds the same setting rewrites nothing … */
  await runSeatTickCheck(project, { ...off.deps, ensureCard: undefined });
  expect(readCards()).toEqual(raised);

  /* … a changed setting updates the one card … */
  const slowed = harness({
    pipelines: OPEN_LANE,
    settings: { ...offSettings(), project, enabled: true, wakeIntervalMinutes: 240, reason: "batching this board", updatedAt: "2026-08-28T11:30:00.000Z" },
  });
  await runSeatTickCheck(project, { ...slowed.deps, ensureCard: undefined });
  const updated = readCards();
  expect(updated).toHaveLength(1);
  expect(updated[0]!.text).toContain("batching this board");

  /* … and the check that reads the project back on its defaults closes it. */
  const restored = harness({
    pipelines: OPEN_LANE,
    settings: { ...defaultSeatTickSettings(project), project, updatedAt: "2026-08-28T12:00:00.000Z" },
  });
  await runSeatTickCheck(project, { ...restored.deps, ensureCard: undefined });
  expect(readCards().map((task) => task.status)).toEqual(["done"]);
});

/* The card writer resolves the board file per call, not once at import.
   `mutateTasksFile`'s default is frozen the first time `@/lib/tasks/store` is
   loaded anywhere in the process, so a tick that took it would write to
   whichever state dir happened to be set THEN — in a suite, another test
   file's; in a sandboxed run, the real board outside the sandbox. Asserted
   here by moving the state dir under a running tick, which is the only way the
   two readings can be told apart within one process. */
test("a card is written to the state dir the tick is pointed at now, not the one loaded at import", async () => {
  const project = `card-statedir-${crypto.randomUUID().slice(0, 8)}`;
  const moved = fs.mkdtempSync(path.join(SANDBOX, "moved-state-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = moved;
  try {
    const off = harness({ pipelines: OPEN_LANE, settings: { ...offSettings(), project } });
    await runSeatTickCheck(project, { ...off.deps, ensureCard: undefined });
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
  }

  const written = JSON.parse(fs.readFileSync(path.join(moved, "tasks.json"), "utf8")) as { tasks: { project: string; text: string }[] };
  const cards = written.tasks.filter((task) => task.project === project);
  expect(cards).toHaveLength(1);
  expect(cards[0]!.text).toContain("This project's seat tick is not on its default settings");
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

/* #1262, end to end: the seat's very first check, against a journal that
   already holds a day of settled work. The wake that produced the report said
   "stage_completed since the last delivered wake and 85 more" for a seat that
   had never had a delivered wake at all. */
test("a project's first check seals the cursor at the head instead of replaying the journal", async () => {
  const history = [terminalEvent(9848), terminalEvent(9850), terminalEvent(9853)];
  const rig = harness({ pipelines: OPEN_LANE, events: history, state: OVERDUE });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  /* The lane is open and the hour has elapsed, so a wake is owed — but on the
     open lane, not on three days of finished stages. */
  expect(record!.reasons).toEqual(["interval"]);
  expect(rig.sent[0]!.text).not.toContain("the round passed");
  expect(record!.items).toBe(1);
  expect(record!.eventsThrough).toBe(9853);
  expect(rig.written[0]!.eventsThrough).toBe(9853);
});

/* And the check after it is the one the cursor exists for: what happened since
   the tick began is still delivered, in full. */
test("the check after the seal carries the events that arrived since it", async () => {
  const history = [terminalEvent(9848), terminalEvent(9853)];
  const sealed = harness({ pipelines: OPEN_LANE, events: history, state: OVERDUE });
  await runSeatTickCheck(PROJECT, sealed.deps);
  const next = harness({
    pipelines: OPEN_LANE,
    events: [...history, terminalEvent(9854)],
    state: { ...OVERDUE, eventsThrough: sealed.written[0]!.eventsThrough },
  });
  const record = await runSeatTickCheck(PROJECT, next.deps);
  expect(record!.reasons).toEqual(["lane-event"]);
  expect(record!.eventsThrough).toBe(9854);
});

/* ------------------------------------------------------------------------- *
 * #1285 / #1289, end to end: a wake names what is owed now, and silence means
 * nothing is.
 * ------------------------------------------------------------------------- */

/** A lane that ran and finished, with the branch its pull request is the head
    of. Whether it is still open is the whole question both halves turn on. */
const FINISHED_LANE = [{
  id: "pipeline_z9",
  state: "completed",
  createdAt: "2026-08-27T09:00:00.000Z",
  movedAt: "2026-08-27T22:00:00.000Z",
  branch: "topic-merge-queue",
  closedAt: "2026-08-27T22:00:00.000Z",
}];

/* The report: three consecutive wakes whose every item named a pipeline that
   had reached a terminal state the day before. Nothing was owed on any of them,
   and establishing that was the entire cost of the wake. */
test("events belonging to a lane that has finished send nothing, and the check that read them discharges them", async () => {
  const rig = harness({
    pipelines: FINISHED_LANE,
    tasks: [{ id: "task_b2", status: "inbox" }],
    events: [terminalEvent(44), terminalEvent(45), terminalEvent(46)].map((event) => ({ ...event, pipelineId: "pipeline_z9" })),
    state: { ...OVERDUE, eventsThrough: 12 },
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "quiet", delivery: null, detail: "nothing owed" });
  expect(rig.sent).toEqual([]);
  /* And the backlog does not come back for a second, third and fourth wake:
     one look moved the cursor past all of it. */
  expect(rig.written[0]!.eventsThrough).toBe(46);
  expect(record!.eventsThrough).toBe(46);
});

/* Twelve hours of `quiet — nothing owed` while three approved pull requests sat
   unmerged, because the tick counts open lanes and board cards and a finished
   lane is neither. */
test("a completed lane whose pull request is still open wakes the seat, naming the pull request", async () => {
  const rig = harness({
    pipelines: FINISHED_LANE,
    state: OVERDUE,
    openPullRequests: [{
      number: 1289,
      title: "wake on a merge that is waiting",
      headRefName: "topic-merge-queue",
      updatedAt: "2026-08-28T11:30:00.000Z",
    }],
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["unmerged-pr"], items: 1 });
  expect(rig.sent[0]!.text).toContain("pull request #1289 left open by a lane that finished");
  expect(rig.sent[0]!.text).toContain("[pull-request] #1289 — wake on a merge that is waiting");
});

/* And the merge is what silences it, with nothing else to turn off. */
test("once the pull request is merged the same project owes nothing again", async () => {
  const rig = harness({
    pipelines: FINISHED_LANE,
    tasks: [{ id: "task_b2", status: "inbox" }],
    state: OVERDUE,
    openPullRequests: [],
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "quiet", detail: "nothing owed" });
  expect(rig.sent).toEqual([]);

  /* And with the board empty behind it too — one finished lane and nothing
     else — the same merge leaves a project with no wake owed at all. */
  const bare = harness({
    pipelines: FINISHED_LANE,
    state: { ...OVERDUE, lastProposalAt: new Date(NOW - MINUTE).toISOString() },
    openPullRequests: [],
  });
  expect(await runSeatTickCheck(PROJECT, bare.deps)).toMatchObject({ verdict: "quiet" });
  expect(bare.sent).toEqual([]);
});

/* The same lane five days on: out of the hot store, into the archive, and the
   pull request it left open is still the seat's next obligation. Every route
   into this case is a tick that was not able to say so earlier — ticking off,
   a seat busy for days, a `gh` nobody could reach — so the first check that
   CAN must not be the one that reports quiet. */
const ARCHIVED_LANE = [{
  id: "pipeline_z9",
  state: "completed",
  createdAt: "2026-08-22T09:00:00.000Z",
  movedAt: "2026-08-22T22:00:00.000Z",
  branch: "topic-merge-queue",
  closedAt: "2026-08-22T22:00:00.000Z",
}];

test("a lane the archive has taken still wakes the seat over its open pull request", async () => {
  const rig = harness({
    pipelines: [],
    archivedPipelines: ARCHIVED_LANE,
    state: OVERDUE,
    openPullRequests: [{
      number: 1289,
      title: "wake on a merge that is waiting",
      headRefName: "topic-merge-queue",
      updatedAt: "2026-08-28T11:30:00.000Z",
    }],
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["unmerged-pr"], items: 1 });
  expect(rig.sent[0]!.text).toContain("pull request #1289 left open by a lane that finished");
});

test("and once that pull request merges the same project goes quiet", async () => {
  const rig = harness({
    pipelines: [],
    archivedPipelines: ARCHIVED_LANE,
    state: { ...OVERDUE, lastProposalAt: new Date(NOW - MINUTE).toISOString() },
    openPullRequests: [],
  });
  expect(await runSeatTickCheck(PROJECT, rig.deps)).toMatchObject({ verdict: "quiet" });
  expect(rig.sent).toEqual([]);
});

/* ------------------------------------------------------------------------- *
 * A `gh` that could not answer is journaled and retried, never spent.
 * ------------------------------------------------------------------------- */

test("a GitHub failure is journaled as an error rather than published as quiet", async () => {
  const rig = harness({
    pipelines: FINISHED_LANE,
    tasks: [{ id: "task_b2", status: "inbox" }],
    state: OVERDUE,
    pullRequestsUnavailable: "command-failed",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "error", reasons: [], items: 0 });
  expect(record!.detail).toContain("command-failed");
  expect(rig.sent).toEqual([]);
  /* The stamp and the guard are exactly where the previous check left them, so
     the hourly budget is intact and the next check asks again. */
  expect(rig.written[0]!.lastWakeAt).toBe(OVERDUE.lastWakeAt);
  expect(rig.written[0]!.wakesWithoutChange).toEqual({});
  expect(rig.written[0]!.quietSince).toBeNull();
});

test("the check after the failure asks again, and wakes as soon as GitHub answers", async () => {
  const failed = harness({ pipelines: FINISHED_LANE, state: OVERDUE, pullRequestsUnavailable: "timed-out" });
  expect(await runSeatTickCheck(PROJECT, failed.deps)).toMatchObject({ verdict: "error" });

  /* The next check reads the row the failed one wrote — the wake stamp it did
     not move — and the wake is still due. */
  const recovered = harness({
    pipelines: FINISHED_LANE,
    state: failed.written[0]!,
    openPullRequests: [{
      number: 1289,
      title: "wake on a merge that is waiting",
      headRefName: "topic-merge-queue",
      updatedAt: "2026-08-28T11:30:00.000Z",
    }],
  });
  expect(await runSeatTickCheck(PROJECT, recovered.deps)).toMatchObject({ verdict: "wake", reasons: ["unmerged-pr"] });
});

/* The wake that WOULD have gone out is where the failure used to be paid for.
   Delivering it stamps `lastWakeAt` and the retry accounting, so the hour it
   bought was bought by a read that answered nothing. The lane event is held
   for the next check instead — five minutes, not an hour — and the gap is
   journaled for as long as it lasts. */
test("a lane event is held rather than spent while GitHub is unreadable", async () => {
  const rig = harness({
    pipelines: [...OPEN_LANE, ...FINISHED_LANE],
    state: { ...OVERDUE, eventsThrough: 12 },
    events: [terminalEvent(44)],
    pullRequestsUnavailable: "malformed-output",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "error", reasons: [], items: 0 });
  expect(record!.detail).toContain("malformed-output");
  expect(rig.sent).toEqual([]);
  expect(rig.written[0]!.lastWakeAt).toBe(OVERDUE.lastWakeAt);
  expect(rig.written[0]!.wakesWithoutChange).toEqual({});
  /* And the event cursor stays put too, so the check that can answer still has
     the event to name. */
  expect(rig.written[0]!.eventsThrough).toBe(12);
});

/* The three ways `gh` itself fails, each carried through the real seam and the
   real parse, each alongside a lane event that would otherwise have woken the
   seat. None of them may move the stamp, the guard or the cursor, and each
   must still be asked on the next check. */
test("a thrown command, a timeout and unusable output each cost nothing and are asked again", async () => {
  const killed = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" });
  const failures: { name: string; gap: string; run: GithubRunner }[] = [
    { name: "thrown command", gap: "command-failed", run: async () => { throw new Error("gh: command not found"); } },
    { name: "timeout", gap: "timed-out", run: async () => { throw killed; } },
    /* A nonempty answer whose only row names no head branch: the shape that
       used to arrive as a successful empty list. */
    { name: "unusable output", gap: "malformed-output", run: async () => JSON.stringify([{ number: 1289, title: "no head" }]) },
  ];

  for (const failure of failures) {
    let asked = 0;
    const run: GithubRunner = async (args) => {
      asked += 1;
      return failure.run(args);
    };
    const rig = harness({
      pipelines: [...OPEN_LANE, ...FINISHED_LANE],
      state: { ...OVERDUE, eventsThrough: 12, wakesWithoutChange: { "lane-event": 1 }, lastWakeFingerprint: "fp-0" },
      events: [terminalEvent(44)],
      githubRun: run,
    });

    const record = await runSeatTickCheck(PROJECT, rig.deps);
    expect(`${failure.name}: ${record!.verdict}`).toBe(`${failure.name}: error`);
    expect(record!.detail).toContain(failure.gap);
    expect(rig.sent).toEqual([]);
    expect(rig.written[0]!.lastWakeAt).toBe(OVERDUE.lastWakeAt);
    expect(rig.written[0]!.wakesWithoutChange).toEqual({ "lane-event": 1 });
    expect(rig.written[0]!.quietSince).toBeNull();
    expect(asked).toBe(1);

    /* The next check reads the row the failed one wrote and asks `gh` again,
       rather than waiting out an hour it never spent. */
    await runSeatTickCheck(PROJECT, harness({
      pipelines: [...OPEN_LANE, ...FINISHED_LANE],
      state: rig.written[0]!,
      events: [terminalEvent(44)],
      githubRun: run,
    }).deps);
    expect(`${failure.name}: asked ${asked}`).toBe(`${failure.name}: asked 2`);
  }
});

/* The other edge of that table, through the same seam. Exactly the empty array
   is the answer a check may go quiet on, so the refusal above must not grow
   into refusing it: a parse that read `[]` as output nobody can attribute
   would leave every project whose pull requests have all merged in a permanent
   error, which is the same confusion of an answer with a failure, running the
   other way. */
test("the empty array is the one gh answer that still earns quiet", async () => {
  const rig = harness({
    pipelines: FINISHED_LANE,
    tasks: [{ id: "task_b2", status: "inbox" }],
    state: OVERDUE,
    githubRun: async () => "[]",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "quiet", detail: "nothing owed" });
  expect(rig.sent).toEqual([]);
  /* And the row records the quiet, which is the claim an error never makes. */
  expect(rig.written[0]!.quietSince).toBe(new Date(NOW).toISOString());

  /* One usable row beside it, off the same seam and the same parse: the answer
     that is not empty wakes, so the quiet above came from the answer and not
     from a seam that had stopped reporting anything. */
  const open = harness({
    pipelines: FINISHED_LANE,
    tasks: [{ id: "task_b2", status: "inbox" }],
    state: OVERDUE,
    githubRun: async () => JSON.stringify([
      { number: 1289, title: "wake on a merge that is waiting", headRefName: "topic-merge-queue", updatedAt: "2026-08-28T11:30:00.000Z" },
    ]),
  });
  expect(await runSeatTickCheck(PROJECT, open.deps)).toMatchObject({ verdict: "wake", reasons: ["unmerged-pr"] });
  expect(open.sent[0]!.text).toContain("pull request #1289 left open by a lane that finished");
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


/* ------------------------------------------------------------------------- *
 * The agent-authored monitor prompt on the wake the scheduler fires (#1280).
 *
 * The seat cannot schedule itself — that is settled, and stays settled. What
 * it can do is say what the schedule the Viewer arms for it should look at,
 * and these cases are about that instruction surviving the two boundaries a
 * session-scheduled prompt never survived: the next check, and a rotation.
 * ------------------------------------------------------------------------- */

const MONITOR_PROMPT = "before the items, check whether last night's digest actually sent";
const PROMPT_HEADING = "Standing monitor note for this project";

function promptSettings(): SeatTickSettings {
  return {
    ...defaultSeatTickSettings(PROJECT),
    monitorPrompt: MONITOR_PROMPT,
    updatedAt: "2026-08-28T11:00:00.000Z",
    setBy: { kind: "manager", conversationId: CONVERSATION, project: PROJECT, seatEpoch: 7 },
  };
}

test("the wake the scheduler fires carries the project's own monitor prompt, check after check (#1280)", async () => {
  const settings = promptSettings();
  const first = harness({ pipelines: OPEN_LANE, state: OVERDUE, settings });
  const firstRecord = await runSeatTickCheck(PROJECT, first.deps);
  expect(firstRecord).toMatchObject({ verdict: "wake" });
  expect(first.sent[0]!.text).toContain(MONITOR_PROMPT);
  /* Beside what the tick derived, not instead of it, and the contract still
     has the last word. */
  expect(first.sent[0]!.text).toContain("Items:");
  expect(first.sent[0]!.text).toContain("Act on the listed items only");

  /* The next check reads the same row rather than any memory of the last wake,
     so an hour later the instruction is still on the wake. A prompt the seat
     re-typed into a schedule it made for itself lasted exactly one turn; this
     is the difference. */
  const second = harness({ pipelines: OPEN_LANE, state: OVERDUE, settings });
  await runSeatTickCheck(PROJECT, second.deps);
  expect(second.sent[0]!.text).toContain(MONITOR_PROMPT);
});

test("a rotation hands the monitor prompt on: the successor's first wake carries it (#1280)", async () => {
  const settings = promptSettings();
  const before = harness({ pipelines: OPEN_LANE, state: OVERDUE, settings });
  await runSeatTickCheck(PROJECT, before.deps);
  expect(before.sent[0]!.conversationId).toBe(CONVERSATION);

  /* A different seat, a later epoch: the row is the PROJECT's, so what the
     retired seat asked its monitor to watch is what the successor is woken
     with, rather than dying with the session that wrote it. */
  const after = harness({
    seat: { conversationId: SUCCESSOR, seatEpoch: 8, path: null },
    pipelines: OPEN_LANE,
    state: OVERDUE,
    settings,
  });
  await runSeatTickCheck(PROJECT, after.deps);
  expect(after.sent[0]!.conversationId).toBe(SUCCESSOR);
  expect(after.sent[0]!.text).toContain(MONITOR_PROMPT);
});

test("a project with no monitor prompt is woken with exactly the message it was woken with before (#1280)", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.sent[0]!.text).not.toContain(PROMPT_HEADING);
  /* And a row that exists but carries no prompt is the same silence: an empty
     field is not a section with nothing in it. */
  const configured = harness({
    pipelines: OPEN_LANE,
    state: OVERDUE,
    settings: { ...promptSettings(), monitorPrompt: null },
  });
  await runSeatTickCheck(PROJECT, configured.deps);
  expect(configured.sent[0]!.text).toBe(rig.sent[0]!.text);
});

/* ------------------------------------------------------------------------- *
 * Replacing and clearing the prompt while a wake is outstanding (#1280).
 *
 * The delivery layer's idempotency key is what says which two sends are the
 * same message, and it refuses a CHANGED payload under a key it is already
 * holding. The prompt reached the delivered text while the key ignored it, so a
 * wake carrying one prompt that the layer held, followed by the record being
 * changed to another, produced the same key with different text at the very
 * next check — refused, and refused again, until the outstanding wake settled
 * on its own. Replacing and withdrawing a standing instruction is the ordinary
 * use of the field, so these cases are the ordinary path.
 * ------------------------------------------------------------------------- */

const REPLACEMENT_PROMPT = "the digest is fine now; watch the deploy ledger for a rollback that nobody chased";

/** The one rule of the delivery layer these cases turn on: a key it is already
    holding may be replayed with the SAME text, and is refused different text.
    One instance spans both checks, the way the layer's reservation does. */
function reservationLayer(outcome: DeliveryOutcome) {
  const held = new Map<string, string>();
  const accepted: ConversationMessage[] = [];
  const refused: string[] = [];
  return {
    accepted,
    refused,
    deliver: async (message: ConversationMessage): Promise<DeliveryOutcome> => {
      const key = message.clientMessageId ?? "";
      const existing = held.get(key);
      if (existing !== undefined && existing !== message.text) {
        refused.push(key);
        return { ok: false, outcome: "failed", error: "a different payload under a client message id already held", status: 409 };
      }
      held.set(key, message.text);
      accepted.push(message);
      return outcome;
    },
  };
}

const HELD: DeliveryOutcome = { ok: true, target: null, outcome: "held" };

/** A first check whose wake the layer accepts and keeps, so the second check
    runs against a wake that is genuinely still outstanding. */
async function heldWake(layer: ReturnType<typeof reservationLayer>, settings: SeatTickSettings) {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE, settings });
  const record = await runSeatTickCheck(PROJECT, { ...rig.deps, deliver: layer.deliver });
  expect(record!.delivery!.outcome).toBe("held");
  return record!.delivery!.clientMessageId;
}

/** The next check, with the wake the first one left outstanding on the row. */
async function nextCheck(layer: ReturnType<typeof reservationLayer>, outstanding: string, settings: SeatTickSettings) {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: { ...OVERDUE, outstandingWake: outstandingWake({ clientMessageId: outstanding }) },
    settings,
  });
  const record = await runSeatTickCheck(PROJECT, { ...rig.deps, deliver: layer.deliver });
  return record!;
}

test("a prompt replaced while a wake is outstanding delivers under a key of its own (#1280)", async () => {
  const layer = reservationLayer(HELD);
  const outstanding = await heldWake(layer, promptSettings());

  const record = await nextCheck(layer, outstanding, { ...promptSettings(), monitorPrompt: REPLACEMENT_PROMPT });
  expect(layer.refused).toEqual([]);
  expect(record.delivery!.clientMessageId).not.toBe(outstanding);
  expect(record.delivery!.outcome).toBe("held");
  expect(layer.accepted.at(-1)!.text).toContain(REPLACEMENT_PROMPT);
});

test("a prompt cleared while a wake is outstanding delivers under the key a promptless wake has (#1280)", async () => {
  const layer = reservationLayer(HELD);
  const outstanding = await heldWake(layer, promptSettings());

  const record = await nextCheck(layer, outstanding, { ...promptSettings(), monitorPrompt: null });
  expect(layer.refused).toEqual([]);
  expect(record.delivery!.clientMessageId).not.toBe(outstanding);
  /* Withdrawn means withdrawn: the key is the one this wake would have had if
     the project had never set a prompt, and the text carries no note. */
  expect(record.delivery!.clientMessageId).toBe(outstanding.slice(0, outstanding.lastIndexOf(":prompt-")));
  expect(layer.accepted.at(-1)!.text).not.toContain(PROMPT_HEADING);
});

test("an outstanding wake whose prompt has not changed re-sends as a replay (#1280)", async () => {
  const layer = reservationLayer(HELD);
  const outstanding = await heldWake(layer, promptSettings());

  const record = await nextCheck(layer, outstanding, promptSettings());
  /* Same words, same key, same text: the layer sees the message it is already
     holding, and the seat is spared a second copy of one it may yet receive. */
  expect(layer.refused).toEqual([]);
  expect(record.delivery!.clientMessageId).toBe(outstanding);
  expect(layer.accepted.at(-1)!.text).toBe(layer.accepted[0]!.text);
});

test("a promptless wake keeps the exact client message id it had before the prompt existed (#1280)", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  /* Nothing after the fingerprint: a project that never set a prompt is not
     paying for the field with a changed identity. */
  expect(record!.delivery!.clientMessageId).toBe(
    `seat-tick:${PROJECT}:7:${OVERDUE.lastWakeAt}:interval:${rig.written[0]!.lastWakeFingerprint}`);
});
