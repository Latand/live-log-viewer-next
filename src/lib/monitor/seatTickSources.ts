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
import { ledgerDeployments } from "@/lib/runtime/deploymentLedger";
import type { StructuredHostRetirementReport } from "@/lib/runtime/structuredHostRetirement";
import { loadTasks } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";

import { evidenceFromPipelines, evidenceFromTasks } from "./evidence";
import type { PipelineSummary, TaskSummary } from "./viewerApi";
import {
  type SeatTickActivity,
  type SeatTickCheckInput,
  type SeatTickEventInput,
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

/** One delivery the runtime is still holding for a conversation, in the only
    three fields the tick needs to recognize its own and take it back. */
export interface SeatTickPendingDelivery {
  id: string;
  clientMessageId: string | null;
  state: "held" | "assigned" | "delivered" | "failed" | "delivery-uncertain";
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
  deployments: typeof ledgerDeployments;
  retirementReport: () => StructuredHostRetirementReport | null;
  /** What the runtime is still holding for a conversation. The tick reads this
      to find the wake it sent that never landed. */
  pendingDeliveries: (conversationId: string) => SeatTickPendingDelivery[];
  /** Take a retained wake back before it can land. The reason is stored on the
      delivery, so the revocation is legible where the delivery is. */
  revokeDelivery: (id: string, reason: string) => void;
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
    deployments: ledgerDeployments,
    retirementReport: () => {
      try {
        return JSON.parse(fs.readFileSync(statePath("host-retirement-report.json"), "utf8")) as StructuredHostRetirementReport;
      } catch {
        return null;
      }
    },
    pendingDeliveries: (conversationId) => agentRegistry()
      .pendingDeliveries(conversationId as `conversation_${string}`)
      .map((delivery) => ({ id: delivery.id, clientMessageId: delivery.clientMessageId, state: delivery.state })),
    revokeDelivery: (id, reason) => { agentRegistry().terminalizeHeldDelivery(id, reason); },
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
  return record ? { lifecycle: record.lifecycle, reason: record.reason } : null;
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
  const deployments = sources.deployments(1);
  const last = deployments.state === "ok" ? deployments.value[deployments.value.length - 1] : null;
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
  if (seat && seat.turn === "busy" && seatActivity && (seatActivity.lifecycle === "stalled" || seatActivity.lifecycle === "gone")) {
    found.push({ id: "seat-host", label: `the seat's own turn is ${seatActivity.lifecycle} in ${project} (${seatActivity.reason})` });
  }
  return found;
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
function eventsSince(project: string, cursor: number, sources: SeatTickSources): { events: SeatTickEventInput[]; terminalPending: boolean } {
  const journal = sources.lifecycleJournal();
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
  }));

  const { events, terminalPending } = eventsSince(canonical, state.eventsThrough, sources);

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
    state,
    policy,
  };
}
