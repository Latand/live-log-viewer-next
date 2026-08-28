import crypto from "node:crypto";
import fs from "node:fs";

import { agentRegistry, type AgentHostStatus } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { pollLifecycleDigest } from "@/lib/lifecycle/digest";
import { evidenceFromPipelines, evidenceFromTasks } from "@/lib/monitor/evidence";
import type { PipelineSummary, TaskSummary } from "@/lib/monitor/viewerApi";
import { activeOrchestratorSeats, canonicalOrchestratorProject, orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { loadPipelinesForList } from "@/lib/pipelines/store";
import { projectTaskPipelineIds } from "@/lib/pipelines/taskBinding";
import type { Pipeline } from "@/lib/pipelines/types";
import { ledgerDeployments } from "@/lib/runtime/deploymentLedger";
import type { StructuredHostRetirementReport } from "@/lib/runtime/structuredHostRetirement";
import { loadTasks } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";

import {
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
 * store, the pipeline store, the board, the lifecycle journal, the deployment
 * ledger and the host retirement report. No transcript is scanned and no model
 * is called — the only file this opens beyond those is a running stage's
 * transcript, and only to `stat` it.
 */

export interface SeatTickSources {
  seatFor: typeof orchestratorSeatFor;
  /** Projects that currently hold an active seat. */
  activeSeats: () => string[];
  pipelines: () => readonly Pipeline[];
  tasks: () => BoardTask[];
  registry: () => ReturnType<typeof agentRegistry>;
  /** The seat host's recorded status, or null when no entry names it. */
  hostStatus: (conversationId: string) => AgentHostStatus | null;
  digest: typeof pollLifecycleDigest;
  transcriptMtimeMs: (path: string) => number | null;
  deployments: typeof ledgerDeployments;
  retirementReport: () => StructuredHostRetirementReport | null;
  now: () => number;
}

export function defaultSeatTickSources(): SeatTickSources {
  return {
    seatFor: orchestratorSeatFor,
    activeSeats: () => activeOrchestratorSeats().map((seat) => seat.project),
    pipelines: () => loadPipelinesForList(),
    tasks: () => loadTasks(),
    registry: () => agentRegistry(),
    hostStatus: (conversationId) => {
      const registry = agentRegistry();
      const conversation = registry.conversation(conversationId as `conversation_${string}`);
      if (!conversation) return null;
      const sessions = new Set(conversation.generations.map((generation) => generation.id));
      for (const entry of Object.values(registry.snapshot().entries)) {
        if (sessions.has(entry.key.sessionId)) return entry.status;
      }
      return null;
    },
    digest: pollLifecycleDigest,
    transcriptMtimeMs: (pathname) => {
      try {
        return fs.statSync(pathname).mtimeMs;
      } catch {
        return null;
      }
    },
    deployments: ledgerDeployments,
    retirementReport: () => {
      try {
        return JSON.parse(fs.readFileSync(statePath("host-retirement-report.json"), "utf8")) as StructuredHostRetirementReport;
      } catch {
        return null;
      }
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

/**
 * How long the running stage's transcript has been silent under an open turn.
 *
 * This is the registry's own `stalled` rule read at the tick's threshold: an
 * open turn plus a transcript that stopped growing. A transcript that cannot be
 * read returns null, because an unread transcript is not a silent one — the
 * pre-check must never call a lane stuck on the strength of a failed `stat`.
 */
function silentForMs(pipeline: Pipeline, sources: SeatTickSources, now: number): number | null {
  const stageId = pipeline.cursor?.stageId ?? null;
  if (!stageId) return null;
  const run = pipeline.runs.find((entry) => entry.stageId === stageId);
  const attempt = [...(run?.attempts ?? [])].reverse().find((entry) => entry.state === "running");
  if (!attempt?.agentPath) return null;
  const conversation = attempt.conversationId?.startsWith("conversation_")
    ? sources.registry().conversation(attempt.conversationId as `conversation_${string}`)
    : sources.registry().conversationForPath(attempt.agentPath);
  /* A settled turn is not a stall, whatever the transcript's age. A running
     attempt with NO conversation record at all is left to the mtime check on
     purpose: that is the "running stage whose host the engine has not noticed"
     shape, and it still has to clear two consecutive checks and the silence
     threshold before anything calls it stuck. */
  if (conversation && conversation.turn.state !== "busy" && conversation.turn.state !== "unknown") return null;
  const mtimeMs = sources.transcriptMtimeMs(attempt.agentPath);
  if (mtimeMs === null) return null;
  return Math.max(0, now - mtimeMs);
}

function seatInput(project: string, sources: SeatTickSources): SeatTickSeatInput | null {
  const seat = sources.seatFor(project).active;
  if (!seat?.conversationId) return null;
  const conversation = sources.registry().conversation(seat.conversationId as `conversation_${string}`);
  return {
    conversationId: seat.conversationId,
    seatEpoch: seat.seatEpoch,
    path: seat.path,
    turn: conversation?.turn.state ?? "unknown",
  };
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
  /* The one signal that is about the seat itself: its host is gone while a turn
     is still open. The tick's wake is what brings such a seat back, which is the
     reversal recorded in this PR's ADR. */
  if (seat && seat.turn === "busy" && sources.hostStatus(seat.conversationId) === "dead") {
    found.push({ id: "seat-host", label: `the seat's own host is dead under an open turn in ${project}` });
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

export function gatherSeatTickInput(
  project: string,
  state: SeatTickProjectState,
  policy: SeatTickPolicy,
  sources: SeatTickSources,
): SeatTickCheckInput {
  const now = sources.now();
  const seat = seatInput(project, sources);
  const canonical = canonicalOrchestratorProject(project);

  const openLanes = sources.pipelines().filter((pipeline) => isOpen(pipeline) && canonicalOrchestratorProject(pipeline.project) === canonical);
  const evidence = evidenceFromPipelines(openLanes.map(pipelineSummary));
  const pipelines: SeatTickPipelineInput[] = openLanes.map((pipeline, index) => ({
    id: pipeline.id,
    title: evidence[index]!.title,
    state: evidence[index]!.state,
    updatedAt: evidence[index]!.updatedAt,
    silentForMs: silentForMs(pipeline, sources, now),
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

  /* The digest is consumed only by a check that will actually decide. A seat
     mid-turn is skipped, and a skipped check that had swallowed a relay would
     lose the very lane events the next one needs. */
  const busy = seat?.turn === "busy";
  let events: SeatTickEventInput[] = [];
  let digestThrough = state.digestThrough;
  if (seat && !busy) {
    const relay = sources.digest({ subscriberId: `seat-tick:${canonical}`, project: canonical, now, maxItems: 25 });
    events = (relay.relay?.items ?? []).map((item) => ({
      at: item.at,
      type: item.type,
      summary: item.summary,
      pipelineId: item.pipelineId,
    }));
    digestThrough = relay.cursor;
  }

  return {
    project: canonical,
    now,
    seat,
    pipelines,
    tasks,
    events,
    signals: signals(canonical, seat, sources),
    changeFingerprint: changeFingerprint(pipelines, tasks),
    digestThrough,
    state,
    policy,
  };
}
