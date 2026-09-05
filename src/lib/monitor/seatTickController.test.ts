import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

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
const { defaultSeatTickSources, wakeStateFromRecord } = await import("./seatTickSources");
const { resolveOriginalSend } = await import("@/lib/runtime/sendSettlement");
const { readSeatTickState, writeSeatTickState } = await import("./seatTickState");
const { SeatTickAccounting, outcomeIdentity } = await import("./seatTickAccounting");
const { FileRuntimeEventStore } = await import("@/lib/runtime/eventStore");
const { statePath } = await import("@/lib/configDir");
const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { sessionKeyFromTranscript } = await import("@/lib/agent/sessionKey");
const { projectForCwd } = await import("@/lib/scanner/describe");
import type { AgentHostStatus, DurableMembershipInput } from "@/lib/agent/registry";
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

afterEach(() => {
  stopSeatTick();
  setAgentRegistryForTests(null);
});
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
  /** Every liveness read the check made, in order (#1465). */
  liveness: { project?: string; conversationId?: string }[];
  /** Registry snapshot reads the check made (#1465). */
  snapshots: number;
}

type PipelineFixture = { id: string; state: string; createdAt: string; movedAt: string | null; branch?: string; closedAt?: string | null; project?: string };

function pipelineRecord(entry: PipelineFixture) {
  return {
    id: entry.id,
    task: `lane ${entry.id}`,
    taskIds: [],
    project: entry.project ?? PROJECT,
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
  /** The board write failing rather than landing: `throws` is the state dir
      gone or the file locked, `refused` is the create the board declined. Both
      leave the condition uncarded, which is what the tick may not remember as
      having been reported (#1298). */
  cardWrite?: "throws" | "refused";
  /** A real, isolated registry holding the seat's spawned children (#1465).
      Absent, the stub registry below answers with an empty snapshot. */
  registry?: InstanceType<typeof AgentRegistry>;
  /** The liveness plane's verdict for a child conversation, by id (#1465). */
  childActivity?: Record<string, Partial<AgentLivenessRecord>>;
  /** A durable row store of this test's own, in place of the in-memory one,
      so a fresh controller can read what an earlier check wrote (#1465). */
  stateFile?: string;
  /** The check's clock, when a test advances it across ticks (#1465). */
  now?: number;
  /** The transport, one level below `delivery`: a layer that reserves, then
      answers or throws, the way the production one does (#1465). */
  deliverWith?: (message: ConversationMessage) => Promise<DeliveryOutcome>;
  /** Ask the production `wakeState` — the durable delivery record under the
      wake's own key — instead of the stub (#1465). Needs `registry`. */
  realWakeState?: boolean;
}): Harness {
  const sent: ConversationMessage[] = [];
  const journal: SeatTickRunRecord[] = [];
  const cards: { project: string; card: SeatTickCard }[] = [];
  const written: SeatTickProjectState[] = [];
  const withdrawn: { wake: SeatTickOutstandingWake; reason: string }[] = [];
  const livenessReads: { project?: string; conversationId?: string }[] = [];
  const result: Harness = { deps: {}, sent, journal, cards, written, withdrawn, liveness: livenessReads, snapshots: 0, seat: options.seat === undefined ? { conversationId: CONVERSATION, seatEpoch: 7, path: null } : options.seat };
  let reads = 0;
  const localStateFile = options.stateFile ?? path.join(fs.mkdtempSync(path.join(SANDBOX, "controller-state-")), "seat-tick.json");
  if (!options.stateFile) writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: result.seat?.seatEpoch ?? null, ...options.state, accounting: undefined }, localStateFile);

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
    readState: (project) => {
      if (!options.stateFile && project !== PROJECT && !readSeatTickState(project, localStateFile).lastCheckAt) {
        writeSeatTickState(project, { ...emptySeatTickState(), seatEpoch: result.seat?.seatEpoch ?? null, ...options.state, accounting: undefined }, localStateFile);
      }
      return readSeatTickState(project, localStateFile);
    },
    writeState: (project, row) => {
      written.push(row);
      writeSeatTickState(project, row, localStateFile);
    },
    appendRecord: (record) => { journal.push(record); },
    ensureCard: (project, card) => {
      cards.push({ project, card });
      if (options.cardWrite === "throws") throw new Error("the board file cannot be written");
      return options.cardWrite !== "refused";
    },
    deliver: async (message) => {
      sent.push(message);
      if (options.deliverWith) return options.deliverWith(message);
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
      registry: () => {
        if (options.registry) {
          const registry = options.registry;
          return {
            pageSeatChildren: registry.pageSeatChildren.bind(registry),
            seatTickConversation: registry.seatTickConversation.bind(registry),
            conversation: (id: string) => registry.conversation(id as never),
            conversationForPath: (artifactPath: string) => registry.conversationForPath(artifactPath),
            readOnlySnapshot: () => { result.snapshots += 1; return registry.readOnlySnapshot(); },
          } as never;
        }
        return {
          pageSeatChildren: () => ({ file: EMPTY_SNAPSHOT, keys: [], nextKey: "", throughKey: "", complete: true, evidenceGap: false }),
          seatTickConversation: () => ({ id: CONVERSATION, turn: { state: options.turn ?? "idle" } }),
          conversation: () => ({ turn: { state: options.turn ?? "idle" } }),
          conversationForPath: () => null,
          readOnlySnapshot: () => { result.snapshots += 1; return EMPTY_SNAPSHOT; },
        } as never;
      },
      liveness: async (request) => {
        livenessReads.push({ ...(request.project ? { project: request.project } : {}), ...(request.conversationId ? { conversationId: request.conversationId } : {}) });
        const child = request.conversationId ? options.childActivity?.[request.conversationId] : undefined;
        if (child) return [{ conversationId: request.conversationId, lifecycle: "running", reason: "host_alive_turn_active", turnState: "busy", ...child } as AgentLivenessRecord];
        return request.conversationId && options.seatActivity
          ? [{ lifecycle: "running", reason: "host_alive_turn_active", ...options.seatActivity } as AgentLivenessRecord]
          : [];
      },
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
      wakeState: async (wake) => {
        if (options.realWakeState) {
          let evidence: Awaited<ReturnType<typeof resolveOriginalSend>> | null = null;
          return wakeStateFromRecord(wake, {
            lookup: async (binding) => (evidence = await resolveOriginalSend(binding, { registry: options.registry, client: null })),
            settle: async () => evidence?.kind === "found" && evidence.current.readable ? evidence.current.value : null,
            runtime: async () => "unknown",
          });
        }
        if (options.holderThrows) throw new Error("the layer holding the wake cannot be read");
        return options.wakeState ?? "retained";
      },
      withdrawWake: async (wake, reason) => {
        if (options.holderThrows) throw new Error("the layer holding the wake cannot be read");
        withdrawn.push({ wake, reason });
        return options.withdrawal ?? "withdrawn";
      },
      now: () => options.now ?? NOW,
    },
  };
  return result;
}

/** What a registry with nothing in it answers a snapshot read with. */
const EMPTY_SNAPSHOT = { entries: {}, receipts: {}, lineageEdges: {}, memberships: {}, conversations: {}, conversationAliases: {}, heldDeliveries: {}, deliveryOperationOwners: {} };

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
    commit: { proposal: false, reasons: ["interval"], fingerprint: "fp-1", eventsThrough: 44, children: [] },
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
  expect(rig.written.at(-1)!.lastWakeAt).toBe(new Date(NOW).toISOString());
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
    state: { lastWakeAt: first.written.at(-1)!.lastWakeAt, lastWakeFingerprint: first.written.at(-1)!.lastWakeFingerprint },
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
  expect(rig.written.at(-1)!.lastWakeAt).toBe(OVERDUE.lastWakeAt);
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
  expect(rig.written.at(-1)!.lastWakeAt).toBe(OVERDUE.lastWakeAt);
  expect(rig.written.at(-1)!.eventsThrough).toBe(12);
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
  expect(rig.written.at(-1)!.outstandingWake).toMatchObject({
    clientMessageId: record!.delivery!.clientMessageId,
    conversationId: CONVERSATION,
    seatEpoch: 7,
    operationId: "op-wake-1",
    commit: { proposal: false, reasons: ["lane-event"], fingerprint: record!.delivery!.clientMessageId.split(":").at(-1)!, eventsThrough: 44, children: [] },
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
  expect(rig.written.at(-1)!.outstandingWake).toMatchObject({ operationId: null, seatEpoch: 7 });
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
  expect(rig.written.at(-1)!.outstandingWake).toBeNull();
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
  expect(rig.written.at(-1)!.outstandingWake).toEqual(outstanding);
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
  expect(rig.written.at(-1)!.lastWakeAt).toBe(new Date(NOW).toISOString());
  expect(rig.written.at(-1)!.lastWakeReasons).toEqual(["interval"]);
  expect(rig.written.at(-1)!.eventsThrough).toBe(44);
  expect(rig.written.at(-1)!.outstandingWake).toBeNull();
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
    return reads > 4
      ? { active: { conversationId: SUCCESSOR, seatEpoch: 8, path: null } as never, pending: null, history: [] }
      : seatFor(project);
  }) as typeof seatFor;
  await runSeatTickCheck(PROJECT, rig.deps);
  expect(rig.withdrawn.map((entry) => entry.wake.operationId)).toEqual(["op-inflight"]);
  expect(rig.written.at(-1)!.outstandingWake).toBeNull();
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
  expect(rig.written.at(-1)!.outstandingWake).toEqual(outstanding);
});

/* Before #1465 this check sent the new wake and let its landing settle the old
   one. That put a second wake in flight behind one the seat may yet receive —
   the duplicate the issue's correction warns about — so a different wake now
   waits until the holder answers for the first. */
test("a different wake is withheld while the outstanding one is unresolved, and the row keeps the first (#1465)", async () => {
  const rig = harness({
    pipelines: OPEN_LANE,
    state: { ...OVERDUE, outstandingWake: outstandingWake() },
    wakeState: "retained",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "deferred-outstanding" } });
  expect(record!.delivery!.clientMessageId).not.toBe(outstandingWake().clientMessageId);
  expect(rig.sent).toEqual([]);
  expect(rig.written.at(-1)!.outstandingWake).toEqual(outstandingWake());
  expect(rig.written.at(-1)!.lastWakeAt).toBe(OVERDUE.lastWakeAt);
});

test("the same outstanding wake remains fenced under its original key (#1465)", async () => {
  const first = harness({
    pipelines: OPEN_LANE,
    state: OVERDUE,
    delivery: { ok: true, target: null, outcome: "queued", operationId: "op-wake-1", receipt: {} as never, structured: true },
  });
  const raised = await runSeatTickCheck(PROJECT, first.deps);
  const outstanding = first.written.at(-1)!.outstandingWake!;
  expect(outstanding.clientMessageId).toBe(raised!.delivery!.clientMessageId);

  const second = harness({ pipelines: OPEN_LANE, state: { ...OVERDUE, outstandingWake: outstanding }, wakeState: "retained" });
  const record = await runSeatTickCheck(PROJECT, second.deps);
  expect(record!.delivery).toEqual({ clientMessageId: outstanding.clientMessageId, outcome: "deferred-outstanding" });
  expect(second.sent).toHaveLength(0);
});

test("a delivered wake is what moves the event cursor past the events it carried", async () => {
  const rig = harness({ pipelines: OPEN_LANE, events: [terminalEvent(44)], state: { ...OVERDUE, eventsThrough: 12 } });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record!.reasons).toEqual(["lane-event"]);
  expect(rig.written.at(-1)!.eventsThrough).toBe(44);
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
  expect(rig.written.at(-1)!.eventsThrough).toBe(9853);
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
    state: { ...OVERDUE, eventsThrough: sealed.written.at(-1)!.eventsThrough },
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
  expect(rig.written.at(-1)!.eventsThrough).toBe(46);
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
  expect(rig.written.at(-1)!.lastWakeAt).toBe(OVERDUE.lastWakeAt);
  expect(rig.written.at(-1)!.wakesWithoutChange).toEqual({});
  expect(rig.written.at(-1)!.quietSince).toBeNull();
});

test("the check after the failure asks again, and wakes as soon as GitHub answers", async () => {
  const failed = harness({ pipelines: FINISHED_LANE, state: OVERDUE, pullRequestsUnavailable: "timed-out" });
  expect(await runSeatTickCheck(PROJECT, failed.deps)).toMatchObject({ verdict: "error" });

  /* The next check reads the row the failed one wrote — the wake stamp it did
     not move — and the wake is still due. */
  const recovered = harness({
    pipelines: FINISHED_LANE,
    state: failed.written.at(-1)!,
    openPullRequests: [{
      number: 1289,
      title: "wake on a merge that is waiting",
      headRefName: "topic-merge-queue",
      updatedAt: "2026-08-28T11:30:00.000Z",
    }],
  });
  expect(await runSeatTickCheck(PROJECT, recovered.deps)).toMatchObject({ verdict: "wake", reasons: ["unmerged-pr"] });
});

/* The lane event goes out (#1298), and the wake it goes out on says what the
   check could not see. Withholding it was the four-hour silence: the event had
   nothing to do with GitHub, and the seat heard about neither. */
test("a lane event still wakes the seat while GitHub is unreadable, and the wake names the gap", async () => {
  const rig = harness({
    pipelines: [...OPEN_LANE, ...FINISHED_LANE],
    state: { ...OVERDUE, eventsThrough: 12 },
    events: [terminalEvent(44)],
    pullRequestsUnavailable: "malformed-output",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["lane-event"], items: 1 });
  /* The journal line carries the gap beside the reason, so an hour that ran on
     one blind source reads back as exactly that. */
  expect(record!.detail).toContain("malformed-output");
  expect(rig.sent[0]!.text).toContain("Evidence unavailable:");
  expect(rig.sent[0]!.text).toContain("pull-requests: the open pull requests of this project's finished lanes could not be read (malformed-output)");
  /* And the reason that rests on the unreadable source is not among them: an
     empty answer nobody could read names no pull request. */
  expect(record!.reasons).not.toContain("unmerged-pr");
});

/* The acceptance case (#1298), end to end: a parked lane, a pull-request
   source that cannot be read, and a seat that used to hear nothing at all. */
test("a parked lane and an unreadable pull-request source produce a wake naming both", async () => {
  const parked = [{ id: "pipeline_p1", state: "paused", createdAt: "2026-08-28T09:00:00.000Z", movedAt: "2026-08-28T09:30:00.000Z" }];
  const first = harness({
    pipelines: [...parked, ...FINISHED_LANE],
    state: OVERDUE,
    pullRequestsUnavailable: "command-failed",
  });
  /* The first check is the one that establishes the stall; a lane between two
     attempts is never called stuck, so this one wakes on the interval instead
     and the parked lane is remembered for the next. */
  expect(await runSeatTickCheck(PROJECT, first.deps)).toMatchObject({ verdict: "wake" });
  expect(first.written.at(-1)!.stalledSeen).toEqual(["pipeline_p1"]);

  const rig = harness({
    pipelines: [...parked, ...FINISHED_LANE],
    state: { ...first.written.at(-1)!, ...OVERDUE },
    pullRequestsUnavailable: "command-failed",
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["stalled"] });
  expect(rig.sent[0]!.text).toContain("pipeline_p1");
  expect(rig.sent[0]!.text).toContain("Evidence unavailable:");
});

/* The same case with the failure arriving the way production produced it: `gh`
   itself throwing, through the real seam and the real parse, rather than a
   classified result the test picked. Twenty-three checks reported `error` while
   these two lanes stood parked; the wake below is what the seat should have
   been getting all along. */
test("a gh that throws beside a parked lane still wakes the seat, and names what it could not see", async () => {
  const parked = [{ id: "pipeline_p1", state: "paused", createdAt: "2026-08-28T09:00:00.000Z", movedAt: "2026-08-28T09:30:00.000Z" }];
  const run: GithubRunner = async () => { throw new Error("gh: could not authenticate"); };
  const first = harness({ pipelines: [...parked, ...FINISHED_LANE], state: OVERDUE, githubRun: run });
  await runSeatTickCheck(PROJECT, first.deps);
  expect(first.written.at(-1)!.stalledSeen).toEqual(["pipeline_p1"]);

  const rig = harness({
    pipelines: [...parked, ...FINISHED_LANE],
    state: { ...first.written.at(-1)!, ...OVERDUE },
    githubRun: run,
  });
  const record = await runSeatTickCheck(PROJECT, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["stalled"] });
  /* The reason that stands names the parked lane … */
  expect(rig.sent[0]!.text).toContain("pipeline_p1");
  /* … the wake says which evidence it could not read … */
  expect(rig.sent[0]!.text).toContain("Evidence unavailable:");
  expect(rig.sent[0]!.text).toContain("command-failed");
  /* … and the reason that rested on the failed source is not among them. */
  expect(record!.reasons).not.toContain("unmerged-pr");
  /* Nothing about the failed read was recorded as quiet. */
  expect(rig.written.at(-1)!.quietSince).toBeNull();
});

/* The three ways `gh` itself fails, each carried through the real seam and the
   real parse, each alongside a lane event that would otherwise have woken the
   seat. Each wakes on the reason that stands, names the gap it could not read,
   raises no `unmerged-pr`, and is asked again on the next check. */
test("a thrown command, a timeout and unusable output each name their gap and are asked again", async () => {
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
    expect(`${failure.name}: ${record!.verdict}`).toBe(`${failure.name}: wake`);
    expect(`${failure.name}: ${record!.reasons.join(",")}`).toBe(`${failure.name}: lane-event`);
    expect(record!.detail).toContain(failure.gap);
    expect(rig.sent[0]!.text).toContain(failure.gap);
    expect(rig.written.at(-1)!.quietSince).toBeNull();
    /* The run of failures is on the row, and it is a fresh one: a source that
       has only just stopped answering is retried at every check. */
    expect(rig.written.at(-1)!.pullRequestGap).toMatchObject({ gap: failure.gap, attempts: 1, reported: false });
    expect(asked).toBe(1);

    /* The next check reads the row the failed one wrote and asks `gh` again,
       rather than waiting out an hour on one failure. */
    await runSeatTickCheck(PROJECT, harness({
      pipelines: [...OPEN_LANE, ...FINISHED_LANE],
      state: { ...rig.written.at(-1)!, ...OVERDUE },
      events: [terminalEvent(44)],
      githubRun: run,
    }).deps);
    expect(`${failure.name}: asked ${asked}`).toBe(`${failure.name}: asked 2`);
  }
});

/* The standing outage, put where an operator looks (#1298). Every one of the
   twenty-three failures was journaled, and the journal is not what anyone was
   reading — the operator read the board, and the board said nothing. */
test("a source unreadable since before the wake interval is carded once, and the row remembers", async () => {
  const gap = {
    gap: "command-failed" as const,
    since: new Date(NOW - 4 * 60 * MINUTE).toISOString(),
    lastAttemptAt: new Date(NOW - 61 * MINUTE).toISOString(),
    attempts: 23,
    reported: false,
  };
  const rig = harness({
    pipelines: [...OPEN_LANE, ...FINISHED_LANE],
    state: { ...OVERDUE, pullRequestGap: gap },
    pullRequestsUnavailable: "command-failed",
  });
  await runSeatTickCheck(PROJECT, rig.deps);
  const carded = rig.cards.find((entry) => entry.card.kind === "source-unreadable");
  expect(carded?.card.ref).toBe("seat-tick-source-pull-requests");
  expect(carded?.card.detail).toContain("command-failed, 24 attempt(s)");
  expect(rig.written.at(-1)!.pullRequestGap).toMatchObject({ reported: true, attempts: 24, since: gap.since });

  /* And the next check says nothing further: one card per outage, whatever the
     tick then does about it. */
  const again = harness({
    pipelines: [...OPEN_LANE, ...FINISHED_LANE],
    state: { ...rig.written.at(-1)!, ...OVERDUE },
    pullRequestsUnavailable: "command-failed",
  });
  await runSeatTickCheck(PROJECT, again.deps);
  expect(again.cards.filter((entry) => entry.card.kind === "source-unreadable")).toEqual([]);
});

/** The same standing outage every test below reports on: unreadable for four
    hours, and never yet put in front of anybody. */
function standingGap(over: Partial<SeatTickProjectState["pullRequestGap"] & object> = {}) {
  return {
    gap: "command-failed" as const,
    since: new Date(NOW - 4 * 60 * MINUTE).toISOString(),
    lastAttemptAt: new Date(NOW - 61 * MINUTE).toISOString(),
    attempts: 23,
    reported: false,
    ...over,
  };
}

/* The report is remembered only once it EXISTS (#1298). The controller catches
   a failed card write on purpose — one board file nobody can write is not a
   reason to stop ticking — and the row it then persisted said the operator had
   been told. That suppressed the one report the outage owes for as long as the
   outage lasted, which is the whole failure this card was added to end. */
test("a card write that fails leaves the outage unreported, and the next check reports it", async () => {
  const gap = standingGap();
  const blocked = harness({
    pipelines: [...OPEN_LANE, ...FINISHED_LANE],
    state: { ...OVERDUE, pullRequestGap: gap },
    pullRequestsUnavailable: "command-failed",
    cardWrite: "throws",
  });
  await runSeatTickCheck(PROJECT, blocked.deps);
  /* The card was attempted and the check carried on — the wake still went out
     over the reason that does not rest on the failed source. */
  expect(blocked.cards.filter((entry) => entry.card.kind === "source-unreadable")).toHaveLength(1);
  expect(blocked.sent).toHaveLength(1);
  /* And the row says what is true: nobody has been told. */
  expect(blocked.written.at(-1)!.pullRequestGap).toMatchObject({ reported: false, attempts: 24, since: gap.since });

  /* A board that refuses the create rather than throwing is the same fact
     arriving as a return value, and is remembered the same way. */
  const refused = harness({
    pipelines: [...OPEN_LANE, ...FINISHED_LANE],
    state: { ...OVERDUE, pullRequestGap: blocked.written.at(-1)!.pullRequestGap! },
    pullRequestsUnavailable: "command-failed",
    cardWrite: "refused",
  });
  await runSeatTickCheck(PROJECT, refused.deps);
  expect(refused.written.at(-1)!.pullRequestGap).toMatchObject({ reported: false });

  /* The retry: the same outage, a board that accepts the write, and only now
     does the row remember having said it. */
  const retried = harness({
    pipelines: [...OPEN_LANE, ...FINISHED_LANE],
    state: { ...OVERDUE, pullRequestGap: refused.written.at(-1)!.pullRequestGap! },
    pullRequestsUnavailable: "command-failed",
  });
  await runSeatTickCheck(PROJECT, retried.deps);
  const carded = retried.cards.find((entry) => entry.card.kind === "source-unreadable");
  expect(carded?.card.detail).toContain(`${gap.since.slice(0, 16).replace("T", " ")} UTC`);
  expect(retried.written.at(-1)!.pullRequestGap).toMatchObject({ reported: true, since: gap.since });

  /* And having been reported once, it is not reported again. */
  const settled = harness({
    pipelines: [...OPEN_LANE, ...FINISHED_LANE],
    state: { ...OVERDUE, pullRequestGap: retried.written.at(-1)!.pullRequestGap! },
    pullRequestsUnavailable: "command-failed",
  });
  await runSeatTickCheck(PROJECT, settled.deps);
  expect(settled.cards.filter((entry) => entry.card.kind === "source-unreadable")).toEqual([]);
});

/* Through the real card writer, because the defect lives in the receipt rather
   than in the decision: every outage of one source shares the card's `ref`, so
   a second outage replayed the FIRST outage's create receipt and wrote nothing
   — onto a board whose first card the operator had since completed. The row
   then remembered a report that exists nowhere. */
test("a second outage of the same source is carded again after the first card was completed", async () => {
  const project = `source-outage-${crypto.randomUUID().slice(0, 8)}`;
  const tasksFile = path.join(SANDBOX, "state", "tasks.json");
  const readCards = (): { text: string; status: string }[] => {
    const raw = fs.existsSync(tasksFile) ? JSON.parse(fs.readFileSync(tasksFile, "utf8")) as { tasks?: { project: string; text: string; status: string }[] } : {};
    return (raw.tasks ?? []).filter((task) => task.project === project).map((task) => ({ text: task.text, status: task.status }));
  };
  const lanes = [...OPEN_LANE, ...FINISHED_LANE].map((lane) => ({ ...lane, project }));
  const outage = (gap: ReturnType<typeof standingGap>) => harness({
    pipelines: lanes,
    state: { ...OVERDUE, pullRequestGap: gap },
    pullRequestsUnavailable: "command-failed",
    settings: defaultSeatTickSettings(project),
  });

  const first = outage(standingGap());
  await runSeatTickCheck(project, { ...first.deps, ensureCard: undefined });
  expect(readCards()).toHaveLength(1);
  expect(readCards()[0]!.text).toContain("Seat tick cannot read one of its evidence sources");
  expect(first.written.at(-1)!.pullRequestGap).toMatchObject({ reported: true });

  /* The operator reads it and closes it. */
  const board = JSON.parse(fs.readFileSync(tasksFile, "utf8")) as { tasks: { project: string; status: string }[] };
  for (const task of board.tasks) if (task.project === project) task.status = "done";
  fs.writeFileSync(tasksFile, JSON.stringify(board));

  /* An interval later the standing source is asked again and answers, which is
     what ends the run — and leaves the next outage a run of its own. */
  const recovered = harness({
    pipelines: lanes,
    state: {
      ...OVERDUE,
      pullRequestGap: { ...first.written.at(-1)!.pullRequestGap!, lastAttemptAt: new Date(NOW - 61 * MINUTE).toISOString() },
    },
    openPullRequests: [],
    settings: defaultSeatTickSettings(project),
  });
  await runSeatTickCheck(project, { ...recovered.deps, ensureCard: undefined });
  expect(recovered.written.at(-1)!.pullRequestGap).toBeNull();
  expect(readCards().map((card) => card.status)).toEqual(["done"]);

  /* And the second outage is put in front of the operator, rather than
     replaying the receipt of a card they have already dealt with. */
  const second = standingGap({ since: new Date(NOW - 2 * 60 * MINUTE).toISOString(), attempts: 11 });
  const later = outage(second);
  await runSeatTickCheck(project, { ...later.deps, ensureCard: undefined });
  const cards = readCards();
  expect(cards).toHaveLength(2);
  const open = cards.filter((card) => card.status !== "done");
  expect(open).toHaveLength(1);
  expect(open[0]!.text).toContain(`${second.since.slice(0, 16).replace("T", " ")} UTC`);
  expect(later.written.at(-1)!.pullRequestGap).toMatchObject({ reported: true, since: second.since });
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
  expect(rig.written.at(-1)!.quietSince).toBe(new Date(NOW).toISOString());

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
  expect(rig.written.at(-1)!.lastWakeAt).toBe(OVERDUE.lastWakeAt);
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
  expect(rig.written.at(-1)!.lastProposalAt).toBe(new Date(NOW).toISOString());
});

/* An empty log reads exactly like a run that never happened — the ambiguity
   this journal exists to remove — so a check that throws still leaves a line. */
test("a check that throws still leaves one journal line, naming the failure", async () => {
  const rig = harness({ pipelines: OPEN_LANE, state: OVERDUE });
  const record = await runSeatTickCheck(PROJECT, { ...rig.deps, readState: () => { throw new Error("the row cannot be read"); } });
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

test("a prompt replaced while a wake is outstanding waits for original-key settlement (#1280)", async () => {
  const layer = reservationLayer(HELD);
  const outstanding = await heldWake(layer, promptSettings());

  const record = await nextCheck(layer, outstanding, { ...promptSettings(), monitorPrompt: REPLACEMENT_PROMPT });
  expect(layer.refused).toEqual([]);
  expect(record.delivery!.clientMessageId).not.toBe(outstanding);
  expect(record.delivery!.outcome).toBe("deferred-outstanding");
  expect(layer.accepted).toHaveLength(1);
});

test("a prompt cleared while a wake is outstanding retains the original attempt (#1280)", async () => {
  const layer = reservationLayer(HELD);
  const outstanding = await heldWake(layer, promptSettings());

  const record = await nextCheck(layer, outstanding, { ...promptSettings(), monitorPrompt: null });
  expect(layer.refused).toEqual([]);
  expect(record.delivery!.clientMessageId).not.toBe(outstanding);
  /* Withdrawn means withdrawn: the key is the one this wake would have had if
     the project had never set a prompt, and the text carries no note. */
  expect(record.delivery!.clientMessageId).toBe(outstanding.slice(0, outstanding.lastIndexOf(":prompt-")));
  expect(layer.accepted).toHaveLength(1);
});

test("an outstanding wake whose prompt has not changed stays under its original key (#1280)", async () => {
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
    `seat-tick:${PROJECT}:7:${OVERDUE.lastWakeAt}:interval:${rig.written.at(-1)!.lastWakeFingerprint}`);
});

/* ------------------------------------------------------------------------- *
 * Standalone spawned children (#1465).
 *
 * A manager that works through plain `spawn_agent` children has no pipeline
 * lane the tick can see, so before this the interval wake could never fire and
 * a finished worker was never announced. Every case below runs the real
 * controller over a real, isolated registry holding real lineage edges,
 * receipts, turn observations and host entries — the same durable facts the
 * production check reads — with only the dispatch transport substituted.
 * ------------------------------------------------------------------------- */

interface ChildFixture {
  dir: string;
  cwd: string;
  project: string;
  /** The check's clock: three minutes past the fixture's own writes, so a
      `starting` receipt the spawn path never advanced has outlived its
      admission lease and is no evidence of a host. */
  now: number;
  /** The row the seat starts from, already on disk. */
  seed(over?: Partial<SeatTickProjectState>): void;
  row(): SeatTickProjectState;
  acknowledged(): string[];
  registry: InstanceType<typeof AgentRegistry>;
  seat: { conversationId: string; seatEpoch: number; path: string | null };
  stateFile: string;
  spawn(options: {
    title: string;
    turn?: "busy" | "idle" | "terminal" | "unknown";
    terminalAt?: string | null;
    host?: AgentHostStatus | null;
    cwd?: string;
    parent?: string | null;
    memberships?: DurableMembershipInput[];
    /** No conversation record at all: a reservation nothing has settled. */
    unobserved?: boolean;
  }): { id: string; launchId: string; path: string };
}

/** A registry of this test's own, holding one seat and whatever children the
    test spawns under it. The project is the one the child's cwd resolves to
    through the real attribution path, so the seat's project and its children's
    agree exactly the way a real spawn's do. */
function childFixture(name: string, gitRepository = false): ChildFixture {
  const dir = fs.mkdtempSync(path.join(SANDBOX, `${name}-`));
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd, { recursive: true });
  if (gitRepository) {
    fs.mkdirSync(path.join(cwd, ".git"));
    fs.writeFileSync(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(cwd, ".git", "config"), '[remote "origin"]\n  url = https://example.invalid/fixtures/' + path.basename(dir) + '.git\n');
  }
  const registry = new AgentRegistry(path.join(dir, "agent-registry.json"), () => false, undefined, { sqliteMode: "sqlite" });
  const seatPath = path.join(dir, `${crypto.randomUUID()}.jsonl`);
  const seatConversation = registry.ensureConversation("claude", seatPath, null);
  const project = projectForCwd(cwd);
  if (!project) throw new Error("fixture cwd resolves to no project");
  const now = Date.now() + 3 * MINUTE;
  const stateFile = path.join(dir, "seat-tick.json");
  const fixture: ChildFixture = {
    dir,
    cwd,
    project,
    now,
    registry,
    seat: { conversationId: seatConversation.id, seatEpoch: 7, path: seatPath },
    stateFile,
    seed(over = {}) {
      writeSeatTickState(project, {
        ...emptySeatTickState(),
        seatEpoch: 7,
        lastWakeAt: new Date(now - 61 * MINUTE).toISOString(),
        /* The proposal slot is not due, so an empty board is quiet rather than
           a proposal: what these cases test is the harvest, not the slot. */
        lastProposalAt: new Date(now - MINUTE).toISOString(),
        ...over,
      }, stateFile);
    },
    row: () => readSeatTickState(project, stateFile),
    acknowledged: () => new SeatTickAccounting(`${stateFile}.sqlite`, project).collection.snapshot()
      .flatMap((row) => row.kind === "outcome" && row.status === "acknowledged" ? [row.input.conversationId] : row.kind === "legacy" && row.reconciled ? [row.conversationId] : []),
    spawn(options) {
      const childCwd = options.cwd ?? cwd;
      const childPath = path.join(dir, `${crypto.randomUUID()}.jsonl`);
      const observedChild = options.unobserved ? null : registry.ensureConversation("claude", childPath, null);
      const parent = options.parent === undefined ? seatConversation.id : options.parent;
      const begun = registry.beginSpawnRequest({
        engine: "claude",
        cwd: childCwd,
        transport: "structured",
        ...(observedChild ? { conversationId: observedChild.id } : {}),
        ...(parent ? { parentConversationId: parent as never, parentSource: "explicit" } : {}),
        launchProfile: { title: options.title },
        ...(options.memberships ? { memberships: options.memberships } : {}),
      });
      const child = observedChild ?? { id: begun.receipt.conversationId, generations: [] };
      if (!options.unobserved) {
        registry.reconcileConversations([{
          engine: "claude",
          path: childPath,
          accountId: null,
          launchProfile: emptyLaunchProfile({ cwd: childCwd, title: options.title }),
          turn: { state: options.turn ?? "busy", source: "assistant", terminalAt: options.terminalAt ?? null },
          observedAt: new Date(now - 5 * MINUTE).toISOString(),
        }]);
      }
      if (options.host) {
        registry.upsert({
          key: sessionKeyFromTranscript("claude", childPath)!,
          artifactPath: childPath,
          cwd: childCwd,
          accountId: null,
          status: options.host,
          host: null,
          claimEpoch: 0,
          claimOwner: null,
          pendingAction: null,
        });
      }
      if (!options.unobserved && (options.turn === "terminal" || options.turn === "idle")) {
        const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
        ledger.append(child.generations[0]!.id, { kind: "turn-started", turnId: "turn-one", seq: 1 });
        ledger.append(child.generations[0]!.id, { kind: "turn-ended", turnId: "turn-one", status: "completed", seq: 2 });
      }
      return { id: child.id, launchId: begun.receipt.launchId, path: childPath };
    },
  };
  return fixture;
}

function childRig(fixture: ChildFixture, over: Parameters<typeof harness>[0] = {}): Harness {
  return harness({ seat: fixture.seat, registry: fixture.registry, stateFile: fixture.stateFile, now: fixture.now, ...over });
}

/** An instant `minutes` before the fixture's clock, for terminal outcomes. */
function ago(fixture: ChildFixture, minutes: number): string {
  return new Date(fixture.now - minutes * MINUTE).toISOString();
}

/* The RED assertion this lane was cut for: a running child and nothing else is
   open work with an agenda, and the interval wake carries it. On the code
   before #1465 this check ended `proactive` — a proposal brief dispatched over
   a worker still running. */
test("a running spawned child with no lane is open work, and the interval wake names it (#1465)", async () => {
  const fixture = childFixture("running-child");
  const child = fixture.spawn({ title: "build the exporter", turn: "busy", host: "live" });
  fixture.seed();
  const rig = childRig(fixture, { childActivity: { [child.id]: { lifecycle: "running", reason: "host_alive_turn_active" } } });

  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["interval"], items: 1, deferred: 0 });
  expect(rig.sent).toHaveLength(1);
  expect(rig.sent[0]!.text).toContain(`[child] ${child.id}`);
  expect(rig.sent[0]!.text).toContain("build the exporter");
  /* A live turn the liveness plane calls running is not a stall, however long
     it has been open. */
  expect(rig.cards).toEqual([]);
  expect(rig.liveness).toEqual([{ conversationId: child.id }]);
});

test("a finished child is harvested by exactly one wake, across ticks, a fresh controller and a rotation (#1465)", async () => {
  const fixture = childFixture("finished-child");
  const child = fixture.spawn({ title: "review the exporter", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();

  const first = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, first.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1 });
  expect(record!.detail).toContain("a spawned child finished and its outcome is unharvested");
  expect(first.sent[0]!.text).toContain(`[child] ${child.id}`);
  expect(first.sent[0]!.text).toContain("review the exporter");
  /* The landing wrote the cursor: this child is now the seat's business. */
  expect(fixture.acknowledged()).toEqual([child.id]);
  expect(fixture.row().lastWakeAt).toBe(new Date(fixture.now).toISOString());

  /* Same controller, the interval elapsed again: nothing owed. */
  const later = fixture.now + 61 * MINUTE;
  const second = childRig(fixture, { now: later });
  expect(await runSeatTickCheck(fixture.project, second.deps)).toMatchObject({ verdict: "quiet", items: 0 });
  expect(second.sent).toEqual([]);

  /* A fresh controller reading the row off disk. */
  const third = childRig(fixture, { now: later });
  expect(await runSeatTickCheck(fixture.project, third.deps)).toMatchObject({ verdict: "quiet" });
  expect(third.sent).toEqual([]);

  /* A rotation: the successor inherits the harvest cursor with the clock. */
  const rotated = childRig(fixture, { now: later, seat: { ...fixture.seat, seatEpoch: 8 } });
  expect(await runSeatTickCheck(fixture.project, rotated.deps)).toMatchObject({ verdict: "quiet", seatEpoch: 8 });
  expect(rotated.sent).toEqual([]);
  expect(fixture.row()).toMatchObject({ seatEpoch: 8 });
  expect(fixture.acknowledged()).toEqual([child.id]);
});

test("a child whose host was released after a settled turn is finished, and harvested once (#1465)", async () => {
  const fixture = childFixture("unhosted-child");
  const child = fixture.spawn({ title: "draft the changelog", turn: "idle", host: "dead" });
  fixture.seed();
  const rig = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1 });
  expect(rig.sent[0]!.text).toContain(`[child] ${child.id}`);
  expect(fixture.acknowledged()).toEqual([child.id]);
  /* No liveness read for a turn the registry says has settled. */
  expect(rig.liveness).toEqual([]);
});

test("a launch that failed before it ran is a terminal child with a failed outcome, harvested once (#1465)", async () => {
  const fixture = childFixture("failed-child");
  const child = fixture.spawn({ title: "build the exporter", unobserved: true });
  fixture.registry.failSpawn(child.launchId, "the host could not be started");
  fixture.seed();
  const rig = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1 });
  expect(record!.detail).toContain("a spawned child failed");
  expect(rig.sent[0]!.text).toContain(`[child] ${child.id} — build the exporter — spawned child failed, outcome unharvested`);
  expect(fixture.acknowledged()).toEqual([child.id]);
  const again = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  expect(await runSeatTickCheck(fixture.project, again.deps)).toMatchObject({ verdict: "quiet" });
});

test("more terminal children than the wake carries leave the rest owed, oldest harvested first (#1465)", async () => {
  const fixture = childFixture("bounded-harvest");
  const oldest = fixture.spawn({ title: "first worker", turn: "terminal", terminalAt: ago(fixture, 30) });
  const middle = fixture.spawn({ title: "second worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  const newest = fixture.spawn({ title: "third worker", turn: "terminal", terminalAt: ago(fixture, 10) });
  fixture.seed();
  const policy = { ...DEFAULT_SEAT_TICK_POLICY, itemsPerWake: 1 };

  const first = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, { ...first.deps, policy });
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1, deferred: 2 });
  expect(first.sent[0]!.text).toContain(`[child] ${oldest.id}`);
  expect(first.sent[0]!.text).not.toContain(middle.id);
  expect(fixture.acknowledged()).toEqual([oldest.id]);

  const second = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  const next = await runSeatTickCheck(fixture.project, { ...second.deps, policy });
  expect(next).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 1, deferred: 1 });
  expect(second.sent[0]!.text).toContain(`[child] ${middle.id}`);
  expect(new Set(fixture.acknowledged())).toEqual(new Set([oldest.id, middle.id]));

  const third = childRig(fixture, { now: fixture.now + 122 * MINUTE });
  await runSeatTickCheck(fixture.project, { ...third.deps, policy });
  expect(third.sent[0]!.text).toContain(`[child] ${newest.id}`);
  expect(new Set(fixture.acknowledged())).toEqual(new Set([oldest.id, middle.id, newest.id]));
});

test("every owed child beyond the cursor cap is named once across landings and restarts (#1465)", async () => {
  const fixture = childFixture("harvest-capacity");
  const owed = Array.from({ length: 205 }, (_, index) => fixture.spawn({
    title: `worker ${index}`,
    turn: "terminal",
    terminalAt: ago(fixture, 300 - index),
  }));
  fixture.seed();
  let projectedRows = 0;
  const pageChildren = fixture.registry.pageSeatChildren.bind(fixture.registry);
  fixture.registry.pageSeatChildren = (...args) => {
    const page = pageChildren(...args);
    projectedRows += page?.keys.length ?? 0;
    return page;
  };
  const named: string[] = [];
  for (let tick = 0; tick < 45; tick += 1) {
    projectedRows = 0;
    // Each check constructs a fresh controller over the same durable row.
    const rig = childRig(fixture, { now: fixture.now + tick * 61 * MINUTE });
    await runSeatTickCheck(fixture.project, {
      ...rig.deps,
      policy: { ...DEFAULT_SEAT_TICK_POLICY, itemsPerWake: 5 },
    });
    expect(projectedRows).toBeLessThanOrEqual(60);
    expect(rig.snapshots).toBe(0);
    expect(rig.liveness.length).toBeLessThanOrEqual(60);
    for (const message of rig.sent) {
      for (const match of message.text.matchAll(/\[child\] (\S+) /g)) named.push(match[1]!);
    }
  }
  const unique = new Set(named);
  expect({ named: named.length, unique: unique.size, missing: owed.filter((child) => !unique.has(child.id)).length })
    .toEqual({ named: 205, unique: 205, missing: 0 });
}, 180_000);

test("a harvested child the seat re-instructs is owed again when it next finishes (#1465)", async () => {
  const fixture = childFixture("reinstructed-child");
  const child = fixture.spawn({ title: "iterate on the exporter", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  await runSeatTickCheck(fixture.project, childRig(fixture).deps);
  expect(fixture.acknowledged()).toEqual([child.id]);

  /* The seat sent it more work: the turn is open again under a live host. */
  fixture.registry.reconcileConversations([{
    engine: "claude",
    path: child.path,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title: "iterate on the exporter" }),
    turn: { state: "busy", source: "assistant", terminalAt: null },
    observedAt: ago(fixture, 1),
  }]);
  fixture.registry.upsert({
    key: sessionKeyFromTranscript("claude", child.path)!,
    artifactPath: child.path,
    cwd: fixture.cwd,
    accountId: null,
    status: "live",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const running = childRig(fixture, { now: fixture.now + 61 * MINUTE, childActivity: { [child.id]: { lifecycle: "running", reason: "host_alive_turn_active" } } });
  expect(await runSeatTickCheck(fixture.project, running.deps)).toMatchObject({ verdict: "wake", reasons: ["interval"] });
  expect(fixture.acknowledged()).toEqual([child.id]);

  fixture.registry.reconcileConversations([{
    engine: "claude",
    path: child.path,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title: "iterate on the exporter" }),
    turn: { state: "terminal", source: "lifecycle", terminalAt: new Date(fixture.now + 90 * MINUTE).toISOString() },
    observedAt: new Date(fixture.now + 90 * MINUTE).toISOString(),
  }]);
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  ledger.append(generation, { kind: "turn-started", turnId: "reinstructed", seq: 3 });
  ledger.append(generation, { kind: "turn-ended", turnId: "reinstructed", status: "completed", seq: 4 });
  const finished = childRig(fixture, { now: fixture.now + 122 * MINUTE });
  expect(await runSeatTickCheck(fixture.project, finished.deps)).toMatchObject({ verdict: "wake", reasons: ["child-terminal"] });
  expect(fixture.acknowledged()).toEqual([child.id, child.id]);
});

/* ------------------------------------------------------------------------- *
 * The receipt boundary (#1465, on the #1490 contract). Every case here asks
 * the PRODUCTION `wakeState` — the durable delivery record under the key the
 * tick bound before the send — over the isolated registry, with no runtime
 * host to reach.
 * ------------------------------------------------------------------------- */

/** A wake the delivery record is holding for this seat under the tick's own
    key, in the state the case names, with a plan that harvests one child. */
function recordedWake(fixture: ChildFixture, options: {
  key?: string;
  state: "assigned" | "delivered" | "lost" | "unverified" | "none";
  operationId?: string | null;
  children?: string[];
}): SeatTickOutstandingWake {
  const key = options.key ?? "seat-tick:record:7:first:child-terminal:fp-1";
  const operationId = options.operationId === undefined ? "op-record-1" : options.operationId;
  if (options.state !== "none") {
    const reservation = fixture.registry.holdDelivery(
      fixture.seat.conversationId as never,
      "wake text",
      key,
      "text",
      [],
      null,
      operationId ? { operationId, kind: "send", policy: "queue" } : {},
    );
    if (options.state === "delivered") fixture.registry.recordDeliveryOutcome(reservation.id, "delivered", null, "delivered");
    if (options.state === "lost") fixture.registry.recordDeliveryOutcome(reservation.id, "failed", "fenced before actuation", "lost");
    if (options.state === "unverified") fixture.registry.recordDeliveryOutcome(reservation.id, "failed", "the host took it and died", "unverified");
  }
  return {
    clientMessageId: key,
    conversationId: fixture.seat.conversationId,
    seatEpoch: 7,
    operationId,
    commit: { proposal: false, reasons: ["child-terminal"], fingerprint: "fp-1", eventsThrough: 3, children: options.children ?? [] },
  };
}

test("a wake the record still holds is retained: no stamp moves and the row keeps it (#1465)", async () => {
  const fixture = childFixture("receipt-assigned");
  setAgentRegistryForTests(fixture.registry);
  const wake = recordedWake(fixture, { state: "assigned" });
  fixture.seed({ outstandingWake: wake, eventsThrough: 3 });
  const rig = childRig(fixture, { realWakeState: true });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(rig.journal.map((line) => line.verdict)).toEqual([record!.verdict]);
  expect(fixture.row()).toMatchObject({ outstandingWake: wake, lastWakeAt: ago(fixture, 61), eventsThrough: 3, harvestedChildren: [] });
});

test("a wake the record says was delivered lands, on the plan the raising check wrote (#1465)", async () => {
  const fixture = childFixture("receipt-delivered");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  const wake = recordedWake(fixture, { state: "delivered", children: [child.id] });
  fixture.seed({ outstandingWake: wake, eventsThrough: 1 });
  const rig = childRig(fixture, { realWakeState: true });
  await runSeatTickCheck(fixture.project, rig.deps);
  expect(rig.journal[0]).toMatchObject({ verdict: "landed", delivery: { clientMessageId: wake.clientMessageId, outcome: "landed" } });
  expect(fixture.row()).toMatchObject({
    outstandingWake: null,
    lastWakeAt: new Date(fixture.now).toISOString(),
    eventsThrough: 3,
    harvestedChildren: [],
  });
  expect(fixture.acknowledged()).toContain(child.id);
  /* The landing credited the harvest, so the same check has nothing to raise. */
  expect(rig.sent).toEqual([]);
});

test("a wake the record proves was never delivered is dropped, and raised again in the same check (#1465)", async () => {
  const fixture = childFixture("receipt-lost");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  const wake = recordedWake(fixture, { state: "lost", children: [child.id] });
  fixture.seed({ outstandingWake: wake });
  const rig = childRig(fixture, { realWakeState: true });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(rig.journal[0]).toMatchObject({ verdict: "dropped" });
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "delivered" } });
  expect(rig.sent).toHaveLength(1);
  expect(fixture.row()).toMatchObject({ outstandingWake: null });
  expect(fixture.acknowledged()).toContain(child.id);
});

test("a wake the record ended without proof stays outstanding and uncredited (#1465)", async () => {
  const fixture = childFixture("receipt-unverified");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  const wake = recordedWake(fixture, { state: "unverified", children: [child.id] });
  fixture.seed({ outstandingWake: wake, eventsThrough: 1 });
  const rig = childRig(fixture, { realWakeState: true });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(rig.journal[0]).toMatchObject({ verdict: "uncertain", delivery: { clientMessageId: wake.clientMessageId, outcome: "uncertain" } });
  /* The interval starts — the seat may have the message — and nothing the wake
     carried is acknowledged: cursor and harvest untouched, no second send. */
  expect(fixture.row()).toMatchObject({ outstandingWake: wake, lastWakeAt: ago(fixture, 61), eventsThrough: 1, harvestedChildren: [] });
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "deferred-outstanding" } });
  expect(rig.sent).toEqual([]);
  /* And the next interval offers the child again. */
  const next = childRig(fixture, { realWakeState: true, now: fixture.now + 61 * MINUTE });
  expect(await runSeatTickCheck(fixture.project, next.deps)).toMatchObject({ verdict: "wake", reasons: ["child-terminal"] });
  expect(next.sent).toEqual([]);
  expect(fixture.row().outstandingWake).toEqual(wake);
});

test("a wake the record has no trace of is unknown, and a different wake waits behind it (#1465)", async () => {
  const fixture = childFixture("receipt-absent");
  setAgentRegistryForTests(fixture.registry);
  fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  const wake = recordedWake(fixture, { state: "none", operationId: null });
  fixture.seed({ outstandingWake: wake });
  const rig = childRig(fixture, { realWakeState: true });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(rig.journal.map((line) => line.verdict)).toEqual(["wake"]);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "deferred-outstanding" } });
  expect(rig.sent).toEqual([]);
  expect(fixture.row()).toMatchObject({ outstandingWake: wake, lastWakeAt: ago(fixture, 61) });
});

test("a registry that cannot be read fails the check outright, and moves nothing (#1465)", async () => {
  const fixture = childFixture("receipt-unreadable");
  setAgentRegistryForTests(fixture.registry);
  const wake = recordedWake(fixture, { state: "assigned" });
  fixture.seed({ outstandingWake: wake });
  fixture.registry.seatTickConversation = () => { throw new Error("registry unavailable"); };
  const rig = childRig(fixture, { realWakeState: true });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  /* The seat's own turn is read off the same registry, so the whole check
     ends as an error line: no wake, no stamp, and the row keeps the wake. */
  expect(record).toMatchObject({ verdict: "error", delivery: null });
  expect(record!.detail).toContain("the check failed");
  expect(fixture.row()).toMatchObject({ outstandingWake: wake, lastWakeAt: ago(fixture, 61) });
  expect(rig.sent).toEqual([]);
});

test("a snapshot that cannot be taken leaves the children unread: a wake names the gap, and nothing else owed is an error (#1465)", async () => {
  const fixture = childFixture("children-unreadable");
  fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const rig = childRig(fixture);
  const registry = fixture.registry;
  const blind = {
    ...rig.deps.sources!,
    registry: () => ({
      seatTickConversation: registry.seatTickConversation.bind(registry),
            conversation: (id: string) => registry.conversation(id as never),
      conversationForPath: (artifactPath: string) => registry.conversationForPath(artifactPath),
      readOnlySnapshot: () => { throw new Error("the registry snapshot is being rewritten"); },
    }) as never,
  };
  const record = await runSeatTickCheck(fixture.project, { ...rig.deps, sources: blind });
  expect(record).toMatchObject({ verdict: "error" });
  expect(record!.detail).toBe("the seat's spawned children could not be read (registry-unreadable), so nothing owed is not established");
  expect(fixture.row()).toMatchObject({ lastWakeAt: ago(fixture, 61), harvestedChildren: [] });
  expect(rig.sent).toEqual([]);

  /* A reason that stands on its own still wakes, and the wake names the gap. */
  const withCard = childRig(fixture, { tasks: [{ id: "task_c2", status: "assigned" }] });
  const cardSources = { ...withCard.deps.sources!, registry: blind.registry, tasks: () => [{ id: "task_c2", project: fixture.project, status: "assigned", text: "card", placement: "unplaced", assignments: [], createdAt: ago(fixture, 30), updatedAt: ago(fixture, 30) }] as never };
  const woken = await runSeatTickCheck(fixture.project, { ...withCard.deps, sources: cardSources });
  expect(woken).toMatchObject({ verdict: "wake", reasons: ["unstarted-task"] });
  expect(woken!.detail).toContain("the seat's spawned children could not be read (registry-unreadable)");
  expect(withCard.sent[0]!.text).toContain("registry-unreadable");
});

test("an absorbing refusal that names an operation is recorded outstanding under it (#1465)", async () => {
  const fixture = childFixture("absorbing-refusal");
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const rig = childRig(fixture, {
    delivery: { ok: false, outcome: "failed", error: "an earlier attempt began actuating", status: 409, actuation: "started", operationId: "op-absorbed-1", resend: "verify-first" },
    wakeState: "retained",
  });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "failed" } });
  expect(fixture.row().outstandingWake).toMatchObject({
    clientMessageId: record!.delivery!.clientMessageId,
    operationId: "op-absorbed-1",
    commit: { reasons: ["child-terminal"], children: [outcomeIdentity(["claude", fixture.registry.conversation(child.id as never)!.generations[0]!.id, "turn-one"])] },
  });
  expect(fixture.row()).toMatchObject({ lastWakeAt: ago(fixture, 61), harvestedChildren: [] });
});

test("a send that never returned is looked up under its own key, and kept outstanding when the record holds it (#1465)", async () => {
  const fixture = childFixture("send-threw-reserved");
  setAgentRegistryForTests(fixture.registry);
  const child = fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const rig = childRig(fixture, {
    deliverWith: async (message) => {
      /* The layer reserved the key and queued the runtime operation, then the
         control channel died before the answer came back. */
      fixture.registry.holdDelivery(message.conversationId as never, message.text, message.clientMessageId, "text", [], null, { operationId: "op-unreturned-1", kind: "send", policy: "queue" });
      throw new Error("Viewer control did not reconnect after 2 attempts");
    },
    realWakeState: true,
  });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "unreturned" } });
  expect(fixture.row().outstandingWake).toMatchObject({
    clientMessageId: record!.delivery!.clientMessageId,
    operationId: null,
    commit: { children: [outcomeIdentity(["claude", fixture.registry.conversation(child.id as never)!.generations[0]!.id, "turn-one"])] },
  });
  expect(fixture.row()).toMatchObject({ lastWakeAt: ago(fixture, 61), harvestedChildren: [] });
  /* The next check asks the record: still assigned, so still retained, and
     the same wake is not dispatched a second time under a fresh key. */
  const next = childRig(fixture, { realWakeState: true, deliveryThrows: true });
  const again = await runSeatTickCheck(fixture.project, next.deps);
  expect(again!.delivery!.clientMessageId).toBe(record!.delivery!.clientMessageId);
  expect(next.sent).toHaveLength(0);
});

test("a send that never returned and left no record retains its original prepared attempt (#1465)", async () => {
  const fixture = childFixture("send-threw-absent");
  setAgentRegistryForTests(fixture.registry);
  fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const rig = childRig(fixture, { deliveryThrows: true, realWakeState: true });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "unreturned" } });
  expect(fixture.row()).toMatchObject({ outstandingWake: { clientMessageId: record!.delivery!.clientMessageId }, lastWakeAt: ago(fixture, 61), harvestedChildren: [] });
  expect(rig.journal).toHaveLength(1);
});

test("a send that never returned with an unreadable record is kept outstanding without a handle (#1465)", async () => {
  const fixture = childFixture("send-threw-unreadable");
  fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const rig = childRig(fixture, { deliveryThrows: true });
  const record = await runSeatTickCheck(fixture.project, {
    ...rig.deps,
    sources: { ...rig.deps.sources!, originalSend: async () => ({ kind: "unreadable", reason: "the delivery record could not be read" }) },
  });
  expect(record).toMatchObject({ verdict: "wake", delivery: { outcome: "unreturned" } });
  expect(fixture.row().outstandingWake).toMatchObject({ clientMessageId: record!.delivery!.clientMessageId, operationId: null });
});

test("a child finishing while a wake is unresolved dispatches nothing, and is harvested by the wake after the landing (#1465)", async () => {
  const fixture = childFixture("child-finishes-mid-flight");
  const child = fixture.spawn({ title: "long worker", turn: "busy", host: "live" });
  fixture.seed();
  const activity: Record<string, Partial<AgentLivenessRecord>> = { [child.id]: { lifecycle: "running", reason: "host_alive_turn_active" } };
  const first = childRig(fixture, {
    childActivity: activity,
    delivery: { ok: true, target: null, outcome: "queued", operationId: "op-flight-1", receipt: {} as never, structured: true },
    wakeState: "retained",
  });
  const raised = await runSeatTickCheck(fixture.project, first.deps);
  expect(raised).toMatchObject({ verdict: "wake", reasons: ["interval"] });
  expect(fixture.row().outstandingWake).toMatchObject({ operationId: "op-flight-1", commit: { children: [] } });

  /* The child finishes while the runtime still holds the interval wake. */
  fixture.registry.reconcileConversations([{
    engine: "claude",
    path: child.path,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title: "long worker" }),
    turn: { state: "terminal", source: "lifecycle", terminalAt: ago(fixture, 1) },
    observedAt: ago(fixture, 1),
  }]);
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "turn-one", seq: 1 });
  ledger.append(generation, { kind: "turn-ended", turnId: "turn-one", status: "completed", seq: 2 });
  const second = childRig(fixture, { wakeState: "retained" });
  const withheld = await runSeatTickCheck(fixture.project, second.deps);
  expect(withheld).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], delivery: { outcome: "deferred-outstanding" } });
  expect(second.sent).toEqual([]);
  expect(fixture.row()).toMatchObject({ outstandingWake: { operationId: "op-flight-1" }, harvestedChildren: [] });

  /* The holder delivers the first wake: it lands, and it credited no harvest. */
  const third = childRig(fixture, { wakeState: "landed" });
  expect(await runSeatTickCheck(fixture.project, third.deps)).toMatchObject({ verdict: "quiet" });
  expect(third.journal[0]).toMatchObject({ verdict: "landed" });
  expect(fixture.row()).toMatchObject({ outstandingWake: null, harvestedChildren: [] });

  /* The next interval carries the child. */
  const fourth = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  expect(await runSeatTickCheck(fixture.project, fourth.deps)).toMatchObject({ verdict: "wake", reasons: ["child-terminal"] });
  expect(fourth.sent[0]!.text).toContain(`[child] ${child.id}`);
  expect(fixture.acknowledged()).toEqual([child.id]);
});

/* ------------------------------------------------------------------------- *
 * What is NOT this seat's to wake on (#1465).
 * ------------------------------------------------------------------------- */

test("cross-project, pipeline-owned, engine-native and unrelated conversations add nothing (#1465)", async () => {
  const fixture = childFixture("exclusions");
  const elsewhere = path.join(fixture.dir, "other-repo");
  fs.mkdirSync(elsewhere);
  fixture.spawn({ title: "another project's worker", turn: "terminal", terminalAt: ago(fixture, 20), cwd: elsewhere });
  fixture.spawn({
    title: "a pipeline stage",
    turn: "terminal",
    terminalAt: ago(fixture, 20),
    memberships: [{ kind: "pipeline", containerId: "pipeline_x1", role: "builder", slot: "build", stageId: "build", stageOrder: 1, round: 1, parentConversationId: fixture.seat.conversationId as never }],
  });
  /* An engine-native edge: the engine itself recorded the parent, no Viewer
     spawn was ever asked for. */
  const nativePath = path.join(fixture.dir, `${crypto.randomUUID()}.jsonl`);
  fixture.registry.ensureConversation("claude", nativePath, null);
  fixture.registry.reconcileConversations([{
    engine: "claude",
    path: nativePath,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title: "a native fork", parentConversationId: fixture.seat.conversationId as never }),
    turn: { state: "terminal", source: "lifecycle", terminalAt: ago(fixture, 20) },
    observedAt: ago(fixture, 20),
  }]);
  const edges = Object.values(fixture.registry.readOnlySnapshot().lineageEdges);
  expect(edges.some((edge) => edge.source === "engine-native")).toBe(true);
  /* A conversation started by hand, with no edge at all. */
  const manualPath = path.join(fixture.dir, `${crypto.randomUUID()}.jsonl`);
  fixture.registry.ensureConversation("claude", manualPath, null);
  fixture.registry.reconcileConversations([{
    engine: "claude",
    path: manualPath,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: fixture.cwd, title: "started by hand" }),
    turn: { state: "terminal", source: "lifecycle", terminalAt: ago(fixture, 20) },
    observedAt: ago(fixture, 20),
  }]);
  /* A child of another seat entirely. */
  const otherSeat = fixture.registry.ensureConversation("claude", path.join(fixture.dir, `${crypto.randomUUID()}.jsonl`), null);
  fixture.spawn({ title: "another seat's worker", turn: "terminal", terminalAt: ago(fixture, 20), parent: otherSeat.id });
  fixture.seed();

  const rig = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "quiet", detail: "the board is done and the proposal slot is not due" });
  expect(rig.sent).toEqual([]);
  expect(rig.liveness).toEqual([]);
});

test("a child the registry cannot place is unknown: not open work, not harvested, and said so (#1465)", async () => {
  const fixture = childFixture("unknown-child");
  fixture.spawn({ title: "a reservation nothing settled", unobserved: true });
  fixture.seed();
  const rig = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "error" });
  expect(record!.detail).toContain("registry-unreadable");
  expect(rig.sent).toEqual([]);
  expect(fixture.acknowledged()).toEqual([]);
});

test("a cold inbox with no children stays quiet, and no heartbeat card is needed (#1465)", async () => {
  const fixture = childFixture("cold-inbox");
  fixture.seed();
  const rig = childRig(fixture, { tasks: [{ id: "task_c1", status: "inbox" }] });
  /* The harness's cards belong to the default project; a seat with an inbox
     card and no child of its own has an empty agenda either way. */
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "quiet" });
  expect(rig.sent).toEqual([]);
});

test("a busy child whose host is gone is a stall the registry can see, reported after a second check (#1465)", async () => {
  const fixture = childFixture("gone-child");
  const child = fixture.spawn({ title: "worker whose host died", turn: "busy", host: "dead" });
  fixture.seed();
  const first = childRig(fixture);
  const record = await runSeatTickCheck(fixture.project, first.deps);
  /* Open work, so the interval wakes; the stall waits for its second check. */
  expect(record).toMatchObject({ verdict: "wake", reasons: ["interval"] });
  expect(first.liveness).toEqual([]);
  expect(fixture.row().stalledSeen).toEqual([`child:${child.id}`]);
  const second = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  const stalled = await runSeatTickCheck(fixture.project, second.deps);
  expect(stalled).toMatchObject({ verdict: "wake", reasons: ["stalled"] });
  expect(stalled!.detail).toContain("host_gone_turn_open");
  expect(second.sent[0]!.text).toContain(`[child] ${child.id}`);
});

test("the projection uses bounded keyed registry reads and targeted liveness without transcripts (#1465)", async () => {
  const fixture = childFixture("bounded-read");
  const busy = fixture.spawn({ title: "busy worker", turn: "busy", host: "live" });
  const idle = fixture.spawn({ title: "idle worker", turn: "idle", host: "live" });
  fixture.spawn({ title: "finished worker", turn: "terminal", terminalAt: ago(fixture, 20) });
  fixture.seed();
  const rig = childRig(fixture, { childActivity: { [busy.id]: { lifecycle: "running", reason: "host_alive_turn_active" } } });
  const record = await runSeatTickCheck(fixture.project, rig.deps);
  expect(record).toMatchObject({ verdict: "wake", reasons: ["child-terminal"], items: 3 });
  /* The child source uses keyed projections without a registry snapshot. */
  expect(rig.snapshots).toBe(0);
  /* Liveness is asked by id, for the one child whose turn is open, and never
     project-wide: there is no lane to sweep for. */
  expect(rig.liveness).toEqual([{ conversationId: busy.id }]);
  expect(rig.liveness.some((read) => read.project)).toBe(false);
  /* The fixture wrote no transcript; nothing here could have read one. */
  expect(fs.existsSync(busy.path)).toBe(false);
  expect(fs.existsSync(idle.path)).toBe(false);
});

test("two later turns between ticks are separately owed across controller replacement and seat rotation (#1465)", async () => {
  const fixture = childFixture("multiple-turns");
  const child = fixture.spawn({ title: "iterative worker", turn: "terminal" });
  fixture.seed();
  const first = childRig(fixture);
  await runSeatTickCheck(fixture.project, first.deps);
  expect(first.sent).toHaveLength(1);
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "turn-two", seq: 3 });
  ledger.append(generation, { kind: "turn-ended", turnId: "turn-two", status: "completed", seq: 4 });
  ledger.append(generation, { kind: "turn-started", turnId: "turn-three", seq: 5 });
  ledger.append(generation, { kind: "turn-ended", turnId: "turn-three", status: "error", seq: 6 });
  const next = childRig(fixture, { now: fixture.now + 61 * MINUTE, seat: { ...fixture.seat, seatEpoch: 8 } });
  const result = await runSeatTickCheck(fixture.project, next.deps);
  expect(result).toMatchObject({ verdict: "wake", items: 2 });
  const accounting = new SeatTickAccounting(`${fixture.stateFile}.sqlite`, fixture.project);
  const outcomes = accounting.collection.snapshot().filter((row) => row.kind === "outcome");
  expect(outcomes).toHaveLength(3);
  expect(outcomes.every((row) => row.status === "acknowledged")).toBe(true);
  expect(new Set(outcomes.map((row) => row.identity)).size).toBe(3);
  const again = childRig(fixture, { now: fixture.now + 122 * MINUTE, seat: { ...fixture.seat, seatEpoch: 8 } });
  await runSeatTickCheck(fixture.project, again.deps);
  expect(again.sent).toHaveLength(0);
});

test("a new turn discovered during an unknown send remains owed under the original wake fence (#1465)", async () => {
  const fixture = childFixture("unknown-send-turn");
  const child = fixture.spawn({ title: "worker", turn: "terminal" });
  fixture.seed();
  const first = childRig(fixture, { deliveryThrows: true, wakeState: "unknown" });
  await runSeatTickCheck(fixture.project, first.deps);
  expect(first.sent).toHaveLength(1);
  const outstanding = fixture.row().outstandingWake!;
  expect(outstanding.text).toBe(first.sent[0]!.text);
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "next-turn", seq: 3 });
  ledger.append(generation, { kind: "turn-ended", turnId: "next-turn", status: "completed", seq: 4 });
  for (const wakeState of ["unknown", "uncertain", "retained"] as const) {
    const next = childRig(fixture, { now: fixture.now + 61 * MINUTE, wakeState });
    await runSeatTickCheck(fixture.project, next.deps);
    expect(next.sent).toHaveLength(0);
    expect(fixture.row().outstandingWake!.clientMessageId).toBe(outstanding.clientMessageId);
    expect(fixture.acknowledged()).toEqual([]);
  }
  await runSeatTickCheck(fixture.project, childRig(fixture, { now: fixture.now + 61 * MINUTE, wakeState: "landed" }).deps);
  expect(fixture.acknowledged()).toEqual([child.id]);
  const final = childRig(fixture, { now: fixture.now + 122 * MINUTE });
  expect(await runSeatTickCheck(fixture.project, final.deps)).toMatchObject({ verdict: "wake", items: 1 });
  expect(fixture.acknowledged()).toEqual([child.id, child.id]);
});

test("an old child finishing behind a completed discovery sweep remains owed (#1465)", async () => {
  const fixture = childFixture("out-of-order");
  const old = fixture.spawn({ title: "slow worker", turn: "busy", host: "live" });
  fixture.spawn({ title: "fast worker", turn: "terminal" });
  fixture.seed();
  await runSeatTickCheck(fixture.project, childRig(fixture).deps);
  const generation = fixture.registry.conversation(old.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "late-turn", seq: 1 });
  ledger.append(generation, { kind: "turn-ended", turnId: "late-turn", status: "completed", seq: 2 });
  const later = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  await runSeatTickCheck(fixture.project, later.deps);
  expect(later.sent[0]!.text).toContain(old.id);
  expect(fixture.acknowledged()).toContain(old.id);
});

test("concurrent controllers prepare one original wake and stale state cannot overwrite its landing (#1465)", async () => {
  const fixture = childFixture("concurrent-checks");
  const child = fixture.spawn({ title: "worker", turn: "terminal" });
  fixture.seed();
  let release!: () => void;
  let admitted!: () => void;
  const started = new Promise<void>((resolve) => { admitted = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const first = childRig(fixture, { deliverWith: async () => {
    admitted(); await held;
    return { ok: true, target: "structured", outcome: "delivered", structured: true };
  } });
  const pending = runSeatTickCheck(fixture.project, first.deps);
  await started;
  const prepared = fixture.row();
  expect(prepared.outstandingWake?.text).toBe(first.sent[0]!.text);
  const second = childRig(fixture, { wakeState: "unknown" });
  await runSeatTickCheck(fixture.project, second.deps);
  expect(second.sent).toEqual([]);
  release(); await pending;
  expect(first.sent).toHaveLength(1);
  expect(fixture.acknowledged()).toEqual([child.id]);
  expect(() => writeSeatTickState(fixture.project, prepared, fixture.stateFile)).toThrow("stale");
  expect(fixture.row().outstandingWake).toBeNull();
});

test("rotation and prompt changes retain an unknown predecessor wake until proven landing (#1465)", async () => {
  const fixture = childFixture("unknown-rotation");
  fixture.spawn({ title: "worker", turn: "terminal" });
  fixture.seed();
  const first = childRig(fixture, { deliveryThrows: true, wakeState: "unknown" });
  await runSeatTickCheck(fixture.project, first.deps);
  const original = fixture.row().outstandingWake!;
  const rotated = childRig(fixture, { now: fixture.now + 61 * MINUTE,
    seat: { ...fixture.seat, seatEpoch: 8 }, wakeState: "uncertain", withdrawal: "unknown",
    settings: { ...defaultSeatTickSettings(fixture.project), monitorPrompt: "Inspect the implementation evidence." } });
  await runSeatTickCheck(fixture.project, rotated.deps);
  expect(rotated.sent).toHaveLength(0);
  expect(fixture.row().outstandingWake).toEqual(original);
  const landed = childRig(fixture, { now: fixture.now + 122 * MINUTE, seat: { ...fixture.seat, seatEpoch: 8 }, wakeState: "landed" });
  await runSeatTickCheck(fixture.project, landed.deps);
  expect(landed.sent).toHaveLength(0);
  expect(fixture.acknowledged()).toHaveLength(1);
});

test("first tick after rotation discovers predecessor children from committed revocations only (#1465)", async () => {
  const fixture = childFixture("predecessor-discovery");
  const old = fixture.spawn({ title: "predecessor worker", turn: "terminal" });
  const abandoned = fixture.registry.ensureConversation("claude", path.join(fixture.dir, `${crypto.randomUUID()}.jsonl`), null);
  fixture.spawn({ title: "abandoned pending seat worker", turn: "terminal", parent: abandoned.id });
  const successor = fixture.registry.ensureConversation("claude", path.join(fixture.dir, `${crypto.randomUUID()}.jsonl`), null);
  fixture.seed();
  const file = statePath("orchestrator-seats.json");
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  try {
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, nextSeatEpoch: 9, seats: {}, pending: {},
      revocations: [{ project: fixture.project, conversationId: fixture.seat.conversationId, seatEpoch: 7,
        revokedAt: new Date(fixture.now).toISOString(), successorConversationId: successor.id }],
      history: [{ seat: { project: fixture.project, conversationId: abandoned.id, seatEpoch: 6, state: "pending" }, reason: "terminal_error" }],
    }));
    const sent: ConversationMessage[] = [];
    for (let tick = 0; tick < 5; tick++) {
      const rig = childRig(fixture, { now: fixture.now + tick * 61 * MINUTE, seat: { conversationId: successor.id, seatEpoch: 8, path: null } });
      await runSeatTickCheck(fixture.project, rig.deps);
      sent.push(...rig.sent);
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain(old.id);
    expect(fixture.acknowledged()).toEqual([old.id]);
  } finally { if (before) fs.writeFileSync(file, before); else fs.unlinkSync(file); }
});

test("a child in a deleted nested worktree keeps its parent project's harvest obligation (#1465)", async () => {
  const fixture = childFixture("deleted-worktree", true);
  const deletedCwd = path.join(fixture.cwd, ".worktrees", "finished-task");
  expect(fs.existsSync(deletedCwd)).toBe(false);
  const child = fixture.spawn({ title: "worktree worker", turn: "terminal", cwd: deletedCwd });
  fixture.seed();
  const rig = childRig(fixture);
  await runSeatTickCheck(fixture.project, rig.deps);
  expect(rig.sent).toHaveLength(1);
  expect(fixture.acknowledged()).toEqual([child.id]);
});

test("a settled child with an idle retained host is announced once and leaves no running agenda (#1465)", async () => {
  const fixture = childFixture("settled-idle-host");
  const child = fixture.spawn({ title: "settled worker", turn: "idle", host: "idle" });
  fixture.seed();
  const first = childRig(fixture);
  expect(await runSeatTickCheck(fixture.project, first.deps)).toMatchObject({ verdict: "wake", items: 1 });
  expect(fixture.acknowledged()).toEqual([child.id]);
  const second = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  expect(await runSeatTickCheck(fixture.project, second.deps)).toMatchObject({ verdict: "quiet" });
  expect(second.sent).toEqual([]);
});


test("a child inserted behind the discovery cursor is found on the next sweep after rotation (#1465)", async () => {
  const fixture = childFixture("insert-behind");
  for (let n = 0; n < 21; n++) fixture.spawn({ title: `initial ${n}`, turn: "terminal" });
  fixture.seed();
  await runSeatTickCheck(fixture.project, childRig(fixture).deps);
  const added = fixture.spawn({ title: "inserted behind", turn: "terminal" });
  const db = new Database(path.join(fixture.dir, "agent-registry.sqlite"));
  db.query("UPDATE registry_rows SET row_key=? WHERE collection='lineageEdges' AND row_key=?").run("!behind", added.id);
  db.close();
  const sent: ConversationMessage[] = [];
  for (let tick = 1; tick < 18; tick++) {
    const rig = childRig(fixture, { now: fixture.now + tick * 61 * MINUTE, seat: { ...fixture.seat, seatEpoch: 8 } });
    await runSeatTickCheck(fixture.project, rig.deps);
    sent.push(...rig.sent);
  }
  expect(fixture.acknowledged().filter((id) => id === added.id)).toHaveLength(1);
  expect(sent.filter((message) => message.text.includes(added.id))).toHaveLength(1);
}, 60000);

test("ambiguous legacy outcomes rotate behind later proven work and later turns remain owed (#1465)", async () => {
  const fixture = childFixture("legacy-fairness");
  const old = fixture.spawn({ title: "legacy worker", turn: "terminal" });
  const fresh = fixture.spawn({ title: "new worker", turn: "terminal" });
  fs.writeFileSync(fixture.stateFile, JSON.stringify({ version: 2, projects: { [fixture.project]: {
    ...emptySeatTickState(), seatEpoch: 7, harvestedChildren: [old.id],
    lastWakeAt: new Date(fixture.now - 61 * MINUTE).toISOString(), lastProposalAt: new Date(fixture.now).toISOString(),
  } } }));
  const first = childRig(fixture);
  await runSeatTickCheck(fixture.project, first.deps);
  expect(first.sent).toHaveLength(1);
  expect(first.sent[0]!.text).toContain(fresh.id);
  expect(first.sent[0]!.text).not.toContain(old.id);
  const generation = fixture.registry.conversation(old.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  ledger.append(generation, { kind: "turn-started", turnId: "after-migration", seq: 3 });
  ledger.append(generation, { kind: "turn-ended", turnId: "after-migration", status: "completed", seq: 4 });
  const next = childRig(fixture, { now: fixture.now + 61 * MINUTE });
  await runSeatTickCheck(fixture.project, next.deps);
  expect(next.sent).toHaveLength(1);
  expect(next.sent[0]!.text).toContain(old.id);
  const accounting = new SeatTickAccounting(`${fixture.stateFile}.sqlite`, fixture.project);
  const held = accounting.collection.snapshot().filter((row) => row.kind === "outcome" && row.gap === "legacy-delivery-ambiguous");
  expect(held).toHaveLength(1);
  expect(held[0]!.kind === "outcome" && held[0]!.status).toBe("owed");
});


test("rotation after durable prepare and before transport releases the proven unsent attempt (#1465)", async () => {
  const fixture = childFixture("prepare-rotation");
  const child = fixture.spawn({ title: "worker", turn: "terminal" });
  fixture.seed();
  const rig = childRig(fixture);
  const seatFor = rig.deps.sources!.seatFor;
  rig.deps.sources!.seatFor = (project) => fixture.row().outstandingWake
    ? { ...seatFor(project), active: null } : seatFor(project);
  await runSeatTickCheck(fixture.project, rig.deps);
  expect(rig.sent).toEqual([]);
  expect(fixture.row().outstandingWake).toBeNull();
  expect(fixture.acknowledged()).toEqual([]);
  const successor = childRig(fixture, { seat: { ...fixture.seat, seatEpoch: 8 } });
  await runSeatTickCheck(fixture.project, successor.deps);
  expect(successor.sent).toHaveLength(1);
  expect(fixture.acknowledged()).toEqual([child.id]);
});


test("successive completed turns change the retry-guard fingerprint without a sampled running state (#1465)", async () => {
  const fixture = childFixture("turn-retry-guard");
  const child = fixture.spawn({ title: "iterative worker", turn: "terminal" });
  fixture.seed();
  const generation = fixture.registry.conversation(child.id as never)!.generations[0]!.id;
  const ledger = new FileRuntimeEventStore(statePath("structured-host-events"));
  for (let turn = 1; turn <= 5; turn++) {
    if (turn > 1) {
      ledger.append(generation, { kind: "turn-started", turnId: `iteration-${turn}`, seq: turn * 2 - 1 });
      ledger.append(generation, { kind: "turn-ended", turnId: `iteration-${turn}`, status: "completed", seq: turn * 2 });
    }
    const rig = childRig(fixture, { now: fixture.now + (turn - 1) * 61 * MINUTE });
    expect(await runSeatTickCheck(fixture.project, rig.deps)).toMatchObject({ verdict: "wake", items: 1 });
    expect(rig.sent).toHaveLength(1);
  }
  expect(fixture.acknowledged()).toHaveLength(5);
});
