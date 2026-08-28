import crypto from "node:crypto";
import fs from "node:fs";

import { agentRegistry } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { pageFromEvents, readLifecycleJournal, someMatchingEvent } from "@/lib/lifecycle/journal";
import { agentLivenessSnapshot, productionLivenessSources, type AgentLivenessRecord } from "@/lib/lifecycle/liveness";
import { isTerminalHighSignalEvent } from "@/lib/lifecycle/vocabulary";
import { canonicalOrchestratorProject, activeOrchestratorSeats, orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { loadPipelinesForList } from "@/lib/pipelines/store";
import { projectTaskPipelineIds } from "@/lib/pipelines/taskBinding";
import type { Pipeline } from "@/lib/pipelines/types";
import { runtimeHostClient, type RuntimeHostClient } from "@/lib/runtime/client";
import { latestLedgerDeployment } from "@/lib/runtime/deploymentLedger";
import type { StructuredHostRetirementReport } from "@/lib/runtime/structuredHostRetirement";
import { loadTasks } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";

import { evidenceFromPipelines, evidenceFromTasks } from "./evidence";
import type { PipelineSummary, TaskSummary } from "./viewerApi";
import {
  type SeatTickActivity,
  type SeatTickCheckInput,
  type SeatTickEventInput,
  type SeatTickOutstandingWake,
  type SeatTickPipelineInput,
  type SeatTickPolicy,
  type SeatTickProjectState,
  type SeatTickSeatInput,
  type SeatTickSignalInput,
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

/** How much of the lifecycle journal one check carries. The reason a terminal
    event is never buried by a backlog is {@link SeatTickCheckInput.terminalPending},
    which is asked over the whole pending range rather than this page. */
const EVENT_PAGE = 200;
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

function isOpen(pipeline: Pipeline): boolean {
  return !pipeline.closedAt && pipeline.state !== "completed" && pipeline.state !== "closed";
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
export function repoDirForProject(project: string, sources: SeatTickSources): string | null {
  const canonical = canonicalOrchestratorProject(project);
  const named = sources.pipelines()
    .filter((pipeline) => pipeline.repoDir && canonicalOrchestratorProject(pipeline.project) === canonical)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  return named[0]?.repoDir ?? null;
}

/** A digest of everything a wake could change. Two equal fingerprints across
    two wakes is exactly what "that wake changed nothing" means. */
function changeFingerprint(pipelines: readonly SeatTickPipelineInput[], tasks: readonly SeatTickTaskInput[]): string {
  const parts = [
    ...pipelines.map((pipeline) => `p:${pipeline.id}:${pipeline.state}:${pipeline.updatedAt ?? ""}`),
    ...tasks.map((task) => `t:${task.id}:${task.status}:${task.owned}`),
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
  sources: SeatTickSources,
): { events: SeatTickEventInput[]; terminalPending: boolean; cursor: number } {
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
  if (cursor === null) return { events: [], terminalPending: false, cursor: head };
  const query = { project, afterSeq: cursor };
  const page = pageFromEvents(journal, { ...query, limit: EVENT_PAGE });
  return {
    events: page.events.map((event) => ({
      seq: event.seq,
      at: event.at,
      type: event.type,
      summary: event.summary,
      pipelineId: event.pipelineId,
    })),
    terminalPending: someMatchingEvent(journal, query, (event) => isTerminalHighSignalEvent(event.type)),
    cursor,
  };
}

export async function gatherSeatTickInput(
  project: string,
  state: SeatTickProjectState,
  policy: SeatTickPolicy,
  sources: SeatTickSources,
): Promise<SeatTickCheckInput> {
  const now = sources.now();
  const canonical = canonicalOrchestratorProject(project);
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

  const { events, terminalPending, cursor } = eventsSince(canonical, state.eventsThrough, sources);

  return {
    project: canonical,
    now,
    seat,
    pipelines,
    tasks,
    events,
    terminalPending,
    signals: signals(canonical, seat, sources),
    changeFingerprint: changeFingerprint(pipelines, tasks),
    /* The sealed cursor travels on the state the decision carries forward, so a
       check of any verdict — a skip included, which remembers nothing else —
       persists where the journal stood when the tick first saw this project. */
    state: { ...state, eventsThrough: cursor },
    policy,
  };
}
