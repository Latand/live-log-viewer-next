import crypto from "node:crypto";
import fs from "node:fs";

import { agentRegistry } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { pageFromEvents, readLifecycleJournal } from "@/lib/lifecycle/journal";
import { agentLivenessSnapshot, productionLivenessSources, type AgentLivenessRecord } from "@/lib/lifecycle/liveness";
import { canonicalOrchestratorProject, activeOrchestratorSeats, orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { loadArchivedPipelines, loadPipelinesForList } from "@/lib/pipelines/store";
import { projectTaskPipelineIds } from "@/lib/pipelines/taskBinding";
import type { Pipeline } from "@/lib/pipelines/types";
import { runtimeHostClient, type RuntimeHostClient } from "@/lib/runtime/client";
import { latestLedgerDeployment } from "@/lib/runtime/deploymentLedger";
import type { StructuredHostRetirementReport } from "@/lib/runtime/structuredHostRetirement";
import { loadTasks } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";

import { evidenceFromPipelines, evidenceFromTasks } from "./evidence";
import { openPullRequestsForRepo, type OpenPullRequestsResult } from "./githubEvidence";
import { redactBounded } from "./redact";
import {
  SEAT_TICK_WAKE_INTERVAL_MS,
  seatTickSourceGapAfterFailure,
  seatTickSourceRetryDue,
  seatTickWakeDue,
  seatTurnProgressing,
} from "./seatTick";
import { effectiveSeatTickSettings, readSeatTickSettings, type SeatTickSettings } from "./seatTickSettings";
import type { PipelineSummary, TaskSummary } from "./viewerApi";
import {
  type SeatTickActivity,
  type SeatTickCheckInput,
  type SeatTickEventInput,
  type SeatTickOutstandingWake,
  type SeatTickPipelineInput,
  type SeatTickPolicy,
  type SeatTickProjectState,
  type SeatTickPullRequestGap,
  type SeatTickPullRequestInput,
  type SeatTickSeatInput,
  type SeatTickSignalInput,
  type SeatTickSourceGap,
  type SeatTickTaskInput,
} from "./types";

/**
 * Everything the pre-check reads (issue #1245), and nothing else.
 *
 * Every source here is durable and already written by the Viewer: the seat
 * store, the pipeline store, the board, the lifecycle journal, the liveness
 * plane, the deployment ledger and the host retirement report. No transcript is
 * scanned by this module and no model is called — the one transcript read in
 * the whole check belongs to `agent_activity`'s own bounded evidence pass,
 * which is where the answer to "is this turn still moving?" already lives.
 */

/** How much of the lifecycle journal one check carries. A backlog can no longer
    bury a live event behind this bound: the history in front of it is sealed
    away by the check that read it (#1285), so the pages advance at the check
    interval and cost nothing, rather than at one paid wake apiece. */
const EVENT_PAGE = 200;
/** Open pull requests one check reads. Bounds the `gh` answer, not the lanes:
    a project with more open pull requests than this has other problems. */
const PULL_REQUEST_LIMIT = 60;
/** Bounded pull request title carried into a wake item. */
const PULL_REQUEST_TITLE_LIMIT = 120;
/** Liveness rows one project's check asks for. */
const LIVENESS_LIMIT = 60;

/**
 * What became of a wake the delivery layer accepted and kept.
 *
 * Asked of whichever layer is actually holding it, never of a mirror of that
 * layer. `retained` means it is still the holder's to deliver, so no stamp of
 * the tick's may move; `landed` means the seat has it; `dropped` means the
 * holder settled it without ever delivering it, so the next check may raise it
 * again; `unknown` means the holder could not be asked, which is not evidence
 * of anything and leaves the wake outstanding.
 */
export type SeatTickWakeState = "retained" | "landed" | "dropped" | "unknown";

/**
 * What taking a retained wake back achieved.
 *
 * `too-late` is the answer this whole mechanism has to be able to give: the
 * holder had already let the payload go, so the replaced seat may have received
 * it. Reporting it as a revocation would be the silent version of the defect
 * the tick exists to prevent, so it is named instead.
 */
export type SeatTickWithdrawal = "withdrawn" | "too-late" | "unknown";

/** Runtime receipt statuses the host has not finished with. `delivering` and
    `applying` are the drain's own in-flight window: still not landed, and no
    longer safe to take back. */
const RUNTIME_QUEUED: ReadonlySet<string> = new Set(["pending", "queued"]);
const RUNTIME_IN_FLIGHT: ReadonlySet<string> = new Set(["delivering", "applying"]);
const RUNTIME_LANDED: ReadonlySet<string> = new Set(["delivered", "applied", "answered"]);

/** The delivery the Viewer registry is holding under this wake's idempotency
    key. The key is the tick's own and carries the project, the seat epoch and
    the state fingerprint, so it identifies one wake across the whole file. */
function registryDeliveryFor(wake: SeatTickOutstandingWake): { id: string; state: string } | null {
  const found = Object.values(agentRegistry().readOnlySnapshot().heldDeliveries)
    .find((delivery) => delivery.clientMessageId === wake.clientMessageId);
  return found ? { id: found.id, state: found.state } : null;
}

/**
 * The runtime host's own verdict on the operation carrying this wake.
 *
 * `currentRetryLeaf` follows a retried send to the operation that is actually
 * live, because a retry leaves the parent terminal and the leaf is the one the
 * drain will deliver. An operation the host has never heard of is one nothing
 * will deliver, which is a drop rather than an unknown.
 */
export async function runtimeWakeState(operationId: string, client: RuntimeHostClient): Promise<SeatTickWakeState> {
  const current = await client.operationStatus(operationId, { currentRetryLeaf: true });
  if (!current) return "dropped";
  const status = current.receipt.status;
  if (RUNTIME_QUEUED.has(status) || RUNTIME_IN_FLIGHT.has(status)) return "retained";
  if (RUNTIME_LANDED.has(status)) return "landed";
  /* `failed`, `interrupted` and the terminal-but-unverified `uncertain`. None
     of them is evidence the seat was woken, so none of them advances a stamp. */
  return "dropped";
}

/**
 * Take the wake out of the runtime host's queue.
 *
 * This is the same operation transition the delivery drain itself issues to
 * abandon an effect: it settles the receipt and completes the outbox row inside
 * one immediate transaction, so the drain cannot pick the effect up afterwards.
 * Marking the Viewer's registry mirror instead would leave the host's queue
 * untouched and the wake would still be delivered.
 *
 * An operation already in the drain's hands is deliberately NOT transitioned.
 * The engine write may have happened, and failing the receipt underneath a
 * drain that is about to settle it would break that drain for a claim the tick
 * cannot honestly make anyway.
 */
export async function withdrawRuntimeWake(
  operationId: string,
  reason: string,
  client: RuntimeHostClient,
): Promise<SeatTickWithdrawal> {
  const current = await client.operationStatus(operationId, { currentRetryLeaf: true });
  if (!current) return "withdrawn";
  const status = current.receipt.status;
  if (RUNTIME_LANDED.has(status) || RUNTIME_IN_FLIGHT.has(status)) return "too-late";
  if (!RUNTIME_QUEUED.has(status)) return "withdrawn";
  try {
    const settled = await client.transitionOperation(current.operationId, "failed", { reason });
    return settled.receipt.status === "failed" ? "withdrawn" : "too-late";
  } catch {
    /* The host refuses the transition exactly when the operation left the queue
       between the read and the write — which is the drain taking it. */
    const after = await client.operationStatus(current.operationId, { currentRetryLeaf: true });
    return after && RUNTIME_LANDED.has(after.receipt.status) ? "too-late" : "unknown";
  }
}

export interface SeatTickSources {
  seatFor: typeof orchestratorSeatFor;
  /** Projects that currently hold an active seat. */
  activeSeats: () => string[];
  pipelines: () => readonly Pipeline[];
  /** Settled lanes the hot store has already let go of (#1289). Cold storage,
      so it is read only once a check has decided it would pay for a `gh`
      subprocess anyway — and it has to be read at all because the obligation a
      finished lane leaves behind outlives the lane's three days of residence. */
  archivedPipelines: () => readonly Pipeline[];
  tasks: () => BoardTask[];
  registry: () => ReturnType<typeof agentRegistry>;
  /** The registry's own activity verdict — `agent_activity`'s answer, which is
      the only thing this module is allowed to call a stall. */
  liveness: (request: { project?: string; conversationId?: string; stallAfterMs: number; limit: number }) => Promise<AgentLivenessRecord[]>;
  /** The lifecycle journal, read whole and paged in-process, so the tick's own
      cursor decides what is unread rather than a cursor that advanced at poll
      time. */
  lifecycleJournal: typeof readLifecycleJournal;
  /** The most recently started deployment, read in recency order rather than
      sliced off an ordering that has nothing to do with time. */
  latestDeployment: typeof latestLedgerDeployment;
  retirementReport: () => StructuredHostRetirementReport | null;
  /** The project's own tick settings (#1275), read fresh per check so a change
      an agent just recorded takes effect at the very next check rather than at
      the next deploy. A project nobody configured reads the defaults. */
  settings: (project: string) => SeatTickSettings;
  /** Open pull requests in the project's repository (#1289), through the same
      `gh` seam as the proposal source. Read at most once per wake interval, and
      only for a project that has a finished lane to attribute one to: a
      subprocess per project per five-minute check would be a cost the tick's
      whole design is arranged to avoid. Answers with a result rather than a
      list, because "no pull request is open" and "nobody could be asked" are
      the two facts this reason must never confuse. */
  openPullRequests: (options: { cwd: string; limit: number }) => Promise<OpenPullRequestsResult>;
  /** Whether the layer holding a retained wake still has it, and whether the
      seat ever got it. The tick's stamps move on this answer and nothing else. */
  wakeState: (wake: SeatTickOutstandingWake) => Promise<SeatTickWakeState>;
  /** Take a retained wake back from that same layer, before it can reach a seat
      that has been replaced. The reason is stored where the payload is. */
  withdrawWake: (wake: SeatTickOutstandingWake, reason: string) => Promise<SeatTickWithdrawal>;
  now: () => number;
}

export function defaultSeatTickSources(): SeatTickSources {
  return {
    seatFor: orchestratorSeatFor,
    activeSeats: () => activeOrchestratorSeats().map((seat) => seat.project),
    pipelines: () => loadPipelinesForList(),
    archivedPipelines: () => loadArchivedPipelines(),
    tasks: () => loadTasks(),
    registry: () => agentRegistry(),
    liveness: async (request) => {
      const snapshot = await agentLivenessSnapshot({
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        ...(request.project ? { project: request.project, liveOnly: true } : {}),
        stallAfterMs: request.stallAfterMs,
        limit: request.limit,
      }, productionLivenessSources());
      return snapshot.conversations;
    },
    lifecycleJournal: readLifecycleJournal,
    latestDeployment: latestLedgerDeployment,
    retirementReport: () => {
      try {
        return JSON.parse(fs.readFileSync(statePath("host-retirement-report.json"), "utf8")) as StructuredHostRetirementReport;
      } catch {
        return null;
      }
    },
    settings: (project) => readSeatTickSettings(project),
    openPullRequests: (options) => openPullRequestsForRepo(options),
    /* One rule for both halves: ask, and act on, the layer that is actually
       holding the payload. A send the runtime host queued belongs to the runtime
       host — the registry row beside it is a mirror, and settling a mirror stops
       nothing. A send parked behind an account migration never reached a host at
       all, and there the registry reservation IS the retention. */
    wakeState: async (wake) => {
      if (wake.operationId) {
        const client = runtimeHostClient();
        return client ? runtimeWakeState(wake.operationId, client) : "unknown";
      }
      const delivery = registryDeliveryFor(wake);
      if (!delivery) return "unknown";
      if (delivery.state === "delivered") return "landed";
      if (delivery.state === "failed") return "dropped";
      return "retained";
    },
    withdrawWake: async (wake, reason) => {
      if (wake.operationId) {
        const client = runtimeHostClient();
        return client ? withdrawRuntimeWake(wake.operationId, reason, client) : "unknown";
      }
      const delivery = registryDeliveryFor(wake);
      if (!delivery) return "unknown";
      if (delivery.state === "delivered") return "too-late";
      if (delivery.state === "failed") return "withdrawn";
      agentRegistry().terminalizeHeldDelivery(delivery.id, reason);
      /* An attempt whose journal outcome is unknown may already have been
         written to the engine; terminalizing stops another attempt, and the
         honest report is still that the seat may have it. */
      return delivery.state === "delivery-uncertain" ? "too-late" : "withdrawn";
    },
    now: () => Date.now(),
  };
}

/**
 * A lane the seat could still act on.
 *
 * `hiddenAt` is part of the predicate because hiding something and then
 * reporting it as work is a contradiction on its own terms (#1274). A draft the
 * operator discarded before this fix landed carries `hiddenAt` with `state:
 * "draft"` and `closedAt: null`, and read as open it was parked by the stall
 * rule at every check — an hourly wake carrying a lane whose only exit verb was
 * the one the operator had just refused to press. Records written from now on
 * settle properly (`discardDraft`); this clause is what retires the ones
 * already on disk.
 */
function isOpen(pipeline: Pipeline): boolean {
  return !pipeline.closedAt && !pipeline.hiddenAt && pipeline.state !== "completed" && pipeline.state !== "closed";
}

/**
 * A lane that RAN and reached the end, which is the only kind whose pull
 * request is an obligation (#1289).
 *
 * A hidden record is excluded on the same reasoning as {@link isOpen}: a
 * discarded draft never ran, so nothing it names was ever published and there
 * is nothing for it to have left behind.
 */
function isFinished(pipeline: Pipeline): boolean {
  return !pipeline.hiddenAt && (!!pipeline.closedAt || pipeline.state === "completed" || pipeline.state === "closed");
}

/** The projection `evidence.ts` correlates on, built in-process rather than
    fetched over HTTP: movement is attempt-level, never `createdAt`. */
function pipelineSummary(pipeline: Pipeline): PipelineSummary {
  const activityAt = [
    pipeline.pausedAt,
    pipeline.resumedAt,
    ...pipeline.runs.flatMap((run) => run.attempts.flatMap((attempt) => [attempt.startedAt, attempt.completedAt])),
  ].filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)));
  return {
    id: pipeline.id,
    task: pipeline.task,
    project: pipeline.project,
    state: pipeline.state,
    createdAt: pipeline.createdAt,
    closedAt: pipeline.closedAt,
    ...(pipeline.spec ? { spec: pipeline.spec } : {}),
    activityAt,
  };
}

function taskSummary(task: BoardTask & { pipelineIds: string[] }): TaskSummary {
  return {
    id: task.id,
    project: task.project,
    status: task.status,
    text: task.text,
    updatedAt: task.updatedAt,
    assignments: task.assignments?.map((assignment) => ({ state: assignment.state, path: assignment.path, conversationId: assignment.conversationId ?? null })) ?? [],
    pipelineIds: task.pipelineIds,
  };
}

function activityOf(record: AgentLivenessRecord | undefined): SeatTickActivity | null {
  /* The row's own turn state travels with its verdict. Reading the verdict
     without it is how a settled turn that had simply gone quiet was reported as
     the seat's stall (#1262): the threshold measures silence, not an open
     turn. */
  return record ? { lifecycle: record.lifecycle, reason: record.reason, turnState: record.turnState } : null;
}

/**
 * The liveness rows for a project, indexed by the pipeline each one is running.
 *
 * A liveness read that cannot answer answers with nothing. It never says
 * "dead", and a lane with no row is a lane the tick has no stall evidence
 * about — which the decision reads as "still in flight", never as "stuck".
 */
async function laneActivity(project: string, policy: SeatTickPolicy, sources: SeatTickSources): Promise<Map<string, SeatTickActivity>> {
  const byPipeline = new Map<string, SeatTickActivity>();
  let rows: AgentLivenessRecord[];
  try {
    rows = await sources.liveness({ project, stallAfterMs: policy.stallAfterMs, limit: LIVENESS_LIMIT });
  } catch {
    return byPipeline;
  }
  for (const row of rows) {
    const pipelineId = row.pipeline?.pipelineId;
    if (!pipelineId || byPipeline.has(pipelineId)) continue;
    const activity = activityOf(row);
    if (activity) byPipeline.set(pipelineId, activity);
  }
  return byPipeline;
}

/**
 * The seat, with the registry's verdict on the turn it is holding.
 *
 * The verdict is only asked for when the registry says the turn is open, which
 * is the only case anything reads it: a settled turn is never skipped and never
 * signalled. Targeted by conversation id, the way `get_orchestrator` asks it —
 * the targeted branch resolves one transcript and never sweeps the catalog.
 */
async function seatInput(project: string, policy: SeatTickPolicy, sources: SeatTickSources): Promise<SeatTickSeatInput | null> {
  const seat = sources.seatFor(project).active;
  if (!seat?.conversationId) return null;
  const conversation = sources.registry().conversation(seat.conversationId as `conversation_${string}`);
  const turn = conversation?.turn.state ?? "unknown";
  let activity: SeatTickActivity | null = null;
  if (turn === "busy") {
    try {
      const rows = await sources.liveness({ conversationId: seat.conversationId, stallAfterMs: policy.stallAfterMs, limit: 1 });
      activity = activityOf(rows[0]);
    } catch {
      /* An unanswerable liveness read says nothing. The decision treats an
         absent verdict as "not provably progressing", so the tick keeps working
         rather than waiting behind a turn it cannot see. */
      activity = null;
    }
  }
  return { conversationId: seat.conversationId, seatEpoch: seat.seatEpoch, path: seat.path, turn, activity };
}

function signals(project: string, seat: SeatTickSeatInput | null, sources: SeatTickSources): SeatTickSignalInput[] {
  const found: SeatTickSignalInput[] = [];
  /* The LATEST deployment, asked for as such. The ledger's default ordering is
     by entity id — a random UUID — so taking an element out of a one-row "tail"
     reported a rolled-back deploy from earlier in the day while the four newest
     had all succeeded (#1262). A signal that says production rolled back is one
     an orchestrator acts on, so it has to be about the deployment that actually
     happened last. */
  const latest = sources.latestDeployment();
  const last = latest.state === "ok" ? latest.value : null;
  if (last && last.terminal && last.phase !== "succeeded") {
    found.push({ id: "deploy", label: `the last deployment ended ${last.phase}` });
  }
  const report = sources.retirementReport();
  const undetermined = report?.refused.filter((refusal) => refusal.undetermined).length ?? 0;
  if (report && (report.failed.length > 0 || undetermined > 0)) {
    found.push({ id: "host-retirement", label: `host retirement: ${report.failed.length} failed, ${undetermined} undetermined` });
  }
  /* The one signal that is about the seat itself: its own turn has stopped
     progressing. The tick's wake is what brings such a seat back, which is the
     reversal recorded in this PR's ADR — and, because this is a signal, it is
     agenda enough for the hourly interval to carry it. */
  const seatActivity = seat?.activity;
  if (seat && seat.turn === "busy" && seatActivity && seatStalled(seatActivity)) {
    found.push({ id: "seat-host", label: `the seat's own turn is ${seatActivity.lifecycle} in ${project} (${seatActivity.reason})` });
  }
  return found;
}

/**
 * Whether the seat's own turn has stopped, in the sense the signal claims.
 *
 * `gone` is the host: it is dead whatever the turn was doing, and resuming it
 * is what the wake is for. `stalled` is the one that needed narrowing. It has
 * two roots — a dead host or an expired launch under an OPEN turn, and a
 * transcript silent past the threshold — and the second fires on silence alone,
 * so a seat that finished its turn cleanly and sat quiet for forty minutes was
 * reported stalled to itself (#1262). The transcript's own turn state, which is
 * what the verdict was computed from, is what tells the two apart; the
 * registry's turn record is a different fact and is stale in exactly this case.
 */
function seatStalled(activity: SeatTickActivity): boolean {
  if (activity.lifecycle === "gone") return true;
  return activity.lifecycle === "stalled" && activity.turnState === "busy";
}

/** The repository a project's `gh` reads run in: the newest pipeline that named
    one. Null when nothing ever did, and the proposal then ranks the board alone. */
export function repoDirForProject(
  project: string,
  sources: SeatTickSources,
  /** Lanes the caller has already read out of cold storage. A project whose
      every lane has been archived still has a repository, and asking `gh`
      nothing because the hot store happens to be empty is the same silence
      read off a different shelf (#1289). Never read here on its own: the
      caller pays for the archive when it has already decided to. */
  archived: readonly Pipeline[] = [],
): string | null {
  const canonical = canonicalOrchestratorProject(project);
  const named = [...sources.pipelines(), ...archived]
    .filter((pipeline) => pipeline.repoDir && canonicalOrchestratorProject(pipeline.project) === canonical)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  return named[0]?.repoDir ?? null;
}

/**
 * A digest of everything a wake could change. Two equal fingerprints across two
 * wakes is exactly what "that wake changed nothing" means.
 *
 * Every field a wake reason is decided from has to be in here, because this
 * digest is also what identifies a retry-guard entry: a guard keyed on less
 * than the condition it guards outlives that condition. A card's `updatedAt` is
 * the case #1262 produced — it decides whether the card is an unstarted task or
 * backlog, so moving a stale card is precisely the act that should bring the
 * reason back, and while it was missing from here the guard held the reason
 * suppressed with the card's movement invisible to it.
 */
function changeFingerprint(
  pipelines: readonly SeatTickPipelineInput[],
  tasks: readonly SeatTickTaskInput[],
  pullRequests: readonly SeatTickPullRequestInput[],
): string {
  const parts = [
    ...pipelines.map((pipeline) => `p:${pipeline.id}:${pipeline.state}:${pipeline.updatedAt ?? ""}`),
    ...tasks.map((task) => `t:${task.id}:${task.status}:${task.owned}:${task.updatedAt ?? ""}`),
    /* The set of unmerged pull requests, for the same reason the card's
       movement instant is here: it decides a wake reason, so a guard keyed on
       less than it would hold the reason suppressed while a SECOND pull request
       went unmerged behind the first. A merge or a close removes the row, which
       is what lets the guard reset the moment the seat acts. */
    ...pullRequests.map((pullRequest) => `pr:${pullRequest.number}:${pullRequest.pipelineId}`),
  ].sort();
  return crypto.createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32);
}

/** Projects worth checking: everyone with a seat, plus everyone with work and
    nobody to do it. A project with neither is not a project the tick has an
    opinion about. */
export function seatTickProjects(sources: SeatTickSources): string[] {
  const projects = new Set(sources.activeSeats().map(canonicalOrchestratorProject));
  for (const pipeline of sources.pipelines()) {
    if (isOpen(pipeline) && pipeline.project) projects.add(canonicalOrchestratorProject(pipeline.project));
  }
  for (const task of sources.tasks()) {
    if ((task.status === "inbox" || task.status === "assigned") && task.project) projects.add(canonicalOrchestratorProject(task.project));
  }
  return [...projects].sort();
}

/**
 * Everything past the seat's own event cursor.
 *
 * The lifecycle digest's per-subscriber cursor is not used here, and the reason
 * is the one rule this whole file is arranged around: that cursor advances when
 * the relay is READ, and an acknowledged event is never offered again. A wake
 * that is then refused at the seat epoch, held by a migration, or queued behind
 * a host that never takes it would leave the seat permanently unaware of the
 * lane event that produced it. So the tick keeps its own cursor in its own row
 * and moves it only when a wake actually landed — and, exactly as the digest
 * does, it asks about a pending terminal event over the whole range rather than
 * one page of it.
 */
function eventsSince(
  project: string,
  cursor: number | null,
  openPipelineIds: ReadonlySet<string>,
  sources: SeatTickSources,
): { events: SeatTickEventInput[]; cursor: number } {
  const journal = sources.lifecycleJournal();
  /* `lastSeq` is the head the journal maintains; the newest event's seq is the
     same number written a second way, and taking the larger keeps a head that
     somehow lagged its own events from replaying them as new. */
  const head = Math.max(journal.lastSeq, journal.events.at(-1)?.seq ?? 0);
  /* The first check for a project SEALS the cursor at the head instead of
     reading from zero. A first run has no backlog to catch up on: everything
     already in the journal happened before the tick existed for this seat, and
     handing it over as the seat's instruction for the turn is what #1262
     records — four-day-old merges listed as work, with ninety-three more items
     held back. The seal is written once and only once; from then on the cursor
     is the seat's, and it moves only when a wake lands. */
  if (cursor === null) return { events: [], cursor: head };
  const page = pageFromEvents(journal, { project, afterSeq: cursor, limit: EVENT_PAGE });
  return {
    events: page.events.map((event) => ({
      seq: event.seq,
      at: event.at,
      type: event.type,
      summary: event.summary,
      pipelineId: event.pipelineId,
      /* An open lane is always in the hot store; the archive only ever takes
         SETTLED records. So a pipeline id the store no longer lists names a
         lane that ended long enough ago to have been archived, and reading it
         as terminal is the same answer arrived at from the other side. An event
         that names no pipeline is never terminal here — nothing about a deploy
         outcome or a held delivery has finished (#1285). */
      pipelineTerminal: event.pipelineId !== null && !openPipelineIds.has(event.pipelineId),
    })),
    cursor,
  };
}

/**
 * Pull requests the project's finished lanes left open (#1289).
 *
 * The correlation is the lane's own branch against the pull request's head
 * ref — durable on both sides, and the only tie that survives the lane being
 * closed, its worktree being removed and its host being reaped.
 *
 * The bounds keep it cheap and keep it from becoming a route around the hourly
 * wake. It is read only when a wake could actually be raised from it — the tick
 * is on for this project, the interval has elapsed, there is a seat to wake and
 * its turn is not already moving — only when the project has a finished lane to
 * attribute one to, and only when some pipeline named a repository to ask in.
 * Each of those is an answer: this check would raise no wake from this reason
 * whatever GitHub said. A read that FAILED is not an answer, and leaves with
 * {@link SeatTickPullRequestGap} rather than an empty list.
 *
 * One more bound joined them (#1298): a source that has been failing for longer
 * than a whole wake interval is asked once per interval rather than once per
 * check. That one saves a subprocess and nothing else — the failure it already
 * established is replayed on every check in between, so no check between two
 * attempts is entitled to a conclusion the attempt would have denied it.
 *
 * The lanes come from the hot store AND the archive, because the obligation is
 * the pull request still being open and that outlives the lane's three days of
 * residence. Reading only the hot store made the reason decay on a timer: a
 * tick switched off, a seat busy for days, or a `gh` unreachable until the lane
 * settled out all arrive at the first eligible check with nothing to attribute
 * a pull request to, and report quiet over one still sitting open — the same
 * twelve-hour silence #1289 exists to end, taken slowly. The retry guard does
 * not cover the gap either: it counts wakes that changed nothing, and a wake
 * that was never sent has nothing to count. The archive is cold storage, so it
 * is read only after every cheap gate above has passed, at which point the
 * check has already committed to a `gh` subprocess and a snapshot read is the
 * cheaper half of the pair.
 */
interface PullRequestEvidence {
  pullRequests: SeatTickPullRequestInput[];
  /** Null means the question was answered — including answered with nothing
      open, which is what the tick is entitled to go quiet on. */
  unavailable: SeatTickPullRequestGap | null;
  /** The source's run of failures as this check leaves it (#1298). Carried on
      the row so the next check knows whether this is weather or configuration,
      and so a standing outage is reported once rather than every five minutes. */
  gap: SeatTickSourceGap | null;
}

async function unmergedPullRequests(context: {
  project: string;
  seat: SeatTickSeatInput | null;
  wakeDue: boolean;
  enabled: boolean;
  now: number;
  wakeIntervalMs: number;
  /** What the previous checks made of this source. */
  gap: SeatTickSourceGap | null;
  sources: SeatTickSources;
}): Promise<PullRequestEvidence> {
  /* Nothing was asked, so nothing is concluded — and the run of failures is
     left exactly as it stands. A gate is a statement about this check, never
     about whether the source can be read. */
  const unasked: PullRequestEvidence = { pullRequests: [], unavailable: null, gap: context.gap };
  if (!context.wakeDue || !context.enabled) return unasked;
  /* The other two ways a check can be unable to raise any reason at all: a
     project with nobody to wake ends in `no-seat`, and a seat whose turn is
     genuinely moving ends in `skipped`, both before a wake reason is composed.
     Without this clause a seat that stays busy for hours pays a `gh` subprocess
     every five minutes for the whole turn, to answer a question that check was
     never going to ask. */
  if (!context.seat || seatTurnProgressing(context.seat)) return unasked;

  const at = new Date(context.now).toISOString();
  const failed = (kind: SeatTickPullRequestGap): PullRequestEvidence => ({
    pullRequests: [],
    unavailable: kind,
    gap: seatTickSourceGapAfterFailure(context.gap, kind, at),
  });
  /* A source that has been unreadable for longer than a whole wake interval is
     asked at that interval and no faster (#1298). The gap it already produced
     is replayed in between, so every check still refuses to call this quiet —
     what the backoff saves is the subprocess, never a conclusion. */
  if (context.gap && !seatTickSourceRetryDue(context.gap, context.now, context.wakeIntervalMs)) {
    return { pullRequests: [], unavailable: context.gap.gap, gap: context.gap };
  }

  let archived: readonly Pipeline[];
  try {
    archived = context.sources.archivedPipelines();
  } catch {
    /* Lanes half-read are obligations half-seen, and an obligation that cannot
       be seen is exactly what gets reported as quiet. */
    return failed("lanes-unreadable");
  }
  const finished = [...context.sources.pipelines(), ...archived]
    .filter((pipeline) => canonicalOrchestratorProject(pipeline.project) === context.project && isFinished(pipeline));
  if (finished.length === 0) return unasked;
  const cwd = repoDirForProject(context.project, context.sources, archived);
  if (!cwd) return unasked;

  let result: OpenPullRequestsResult;
  try {
    /* The seam answers with a result; a seam that throws instead is the same
       fact arriving by exception, and neither is an empty list. */
    result = await context.sources.openPullRequests({ cwd, limit: PULL_REQUEST_LIMIT });
  } catch {
    result = { ok: false, unavailable: "command-failed" };
  }
  if (!result.ok) return failed(result.unavailable);
  const open = result.pullRequests;
  const byBranch = new Map<string, Pipeline>();
  for (const pipeline of finished) {
    if (!pipeline.branch) continue;
    /* Two lanes on one branch is a relaunch: the newest is the one whose
       finishing left the pull request open. */
    const held = byBranch.get(pipeline.branch);
    if (!held || Date.parse(pipeline.createdAt) > Date.parse(held.createdAt)) byBranch.set(pipeline.branch, pipeline);
  }
  const found: SeatTickPullRequestInput[] = [];
  for (const pullRequest of open) {
    const lane = byBranch.get(pullRequest.headRefName);
    if (!lane) continue;
    found.push({
      number: pullRequest.number,
      title: redactBounded(pullRequest.title, PULL_REQUEST_TITLE_LIMIT),
      pipelineId: lane.id,
      pipelineTitle: redactBounded(lane.task.split("\n")[0] ?? "", PULL_REQUEST_TITLE_LIMIT),
      updatedAt: pullRequest.updatedAt,
    });
  }
  /* An answer, so the run of failures is over: the source spoke, whatever it
     said. This is the only thing that clears the row, which is what makes the
     next outage a fresh run with its own report. */
  return { pullRequests: found.sort((left, right) => left.number - right.number), unavailable: null, gap: null };
}

export async function gatherSeatTickInput(
  project: string,
  state: SeatTickProjectState,
  policy: SeatTickPolicy,
  sources: SeatTickSources,
): Promise<SeatTickCheckInput> {
  const now = sources.now();
  const canonical = canonicalOrchestratorProject(project);
  const settings = effectiveSeatTickSettings(sources.settings(canonical), now, SEAT_TICK_WAKE_INTERVAL_MS);
  const seat = await seatInput(canonical, policy, sources);

  const openLanes = sources.pipelines().filter((pipeline) => isOpen(pipeline) && canonicalOrchestratorProject(pipeline.project) === canonical);
  const evidence = evidenceFromPipelines(openLanes.map(pipelineSummary));
  const activity = openLanes.length > 0 ? await laneActivity(canonical, policy, sources) : new Map<string, SeatTickActivity>();
  const pipelines: SeatTickPipelineInput[] = openLanes.map((pipeline, index) => ({
    id: pipeline.id,
    title: evidence[index]!.title,
    state: evidence[index]!.state,
    updatedAt: evidence[index]!.updatedAt,
    stageActivity: activity.get(pipeline.id) ?? null,
    stageId: pipeline.cursor?.stageId ?? null,
  }));

  /* Pipeline membership is the read model the board itself uses, so "owned"
     means the same thing here as it does on the card. */
  const board = projectTaskPipelineIds(sources.tasks(), [...sources.pipelines()])
    .filter((task) => canonicalOrchestratorProject(task.project) === canonical);
  const taskEvidence = evidenceFromTasks(board.map(taskSummary));
  const tasks: SeatTickTaskInput[] = board.map((task, index) => ({
    id: task.id,
    title: taskEvidence[index]!.title,
    status: task.status,
    owned: taskEvidence[index]!.owner !== null,
    updatedAt: task.updatedAt ?? null,
  }));

  /* The open set spans EVERY project, not this one's lanes: an event is history
     because its own lane finished, and reading a lane from another project as
     terminal because it is not in this project's slice would be the same claim
     made about the wrong pipeline. */
  const openPipelineIds = new Set(sources.pipelines().filter(isOpen).map((pipeline) => pipeline.id));
  const { events, cursor } = eventsSince(canonical, state.eventsThrough, openPipelineIds, sources);
  const { pullRequests, unavailable: pullRequestsUnavailable, gap: pullRequestGap } = await unmergedPullRequests({
    project: canonical,
    seat,
    /* The same clause the decision applies, asked here because the read behind
       it is a subprocess: a reason that cannot be raised this check is a reason
       whose evidence is not worth fetching. The decision applies the bound
       again on its own terms — this is a cost gate, never the bound itself. */
    wakeDue: seatTickWakeDue(state.lastWakeAt, now, settings.wakeIntervalMs),
    enabled: settings.enabled,
    now,
    wakeIntervalMs: settings.wakeIntervalMs,
    gap: state.pullRequestGap,
    sources,
  });

  return {
    project: canonical,
    now,
    seat,
    pipelines,
    tasks,
    events,
    pullRequests,
    pullRequestsUnavailable,
    signals: signals(canonical, seat, sources),
    changeFingerprint: changeFingerprint(pipelines, tasks, pullRequests),
    /* The sealed cursor travels on the state the decision carries forward, so a
       check of any verdict — a skip included, which remembers nothing else —
       persists where the journal stood when the tick first saw this project.
       The source's run of failures rides out the same way (#1298): the gather
       is what attempted the read, so the gather is what records what became of
       it, and the decision reads that row to know whether this is the outage
       worth putting on the board. */
    state: { ...state, eventsThrough: cursor, pullRequestGap },
    policy,
    settings,
  };
}
