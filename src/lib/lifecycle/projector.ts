import type { HeldDelivery } from "@/lib/accounts/migration/contracts";
import type { Pipeline, PipelineEdgeActivation, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { ViewerDeploymentStatus } from "@/lib/runtime/contracts";

import { appendLifecycleEvents, readLifecycleJournal, type LifecycleEventInput, type LifecycleJournalFile } from "./journal";
import type { AgentLivenessRecord } from "./liveness";
import type { LifecycleEventType, LifecycleState } from "./vocabulary";

/**
 * Derives lifecycle events from the durable records the Viewer already keeps —
 * pipeline attempts, held deliveries, deployments, and the #645 liveness
 * snapshot — instead of threading emit calls through every mutation site.
 *
 * Every event key is a deterministic function of the transition it names, so
 * running the projection twice appends nothing the second time. That is what
 * makes "replay must not duplicate" a property of the design rather than a rule
 * a producer has to remember.
 */

/** Attempt states that are terminal for their stage. */
const ATTEMPT_EVENT_TYPE: Partial<Record<PipelineStageAttempt["state"], LifecycleEventType>> = {
  passed: "stage_completed",
  failed: "stage_failed",
  needs_decision: "stage_blocked",
};

function attemptKey(pipeline: Pipeline, stageId: string, attempt: PipelineStageAttempt, suffix: string): string {
  return `pipeline:${pipeline.id}:stage:${stageId}:attempt:${attempt.n}:${suffix}`;
}

/** A review stage's verdict is high-signal in its own right, so a completed
    review-loop attempt yields the verdict event beside the stage event. */
function isReviewStage(pipeline: Pipeline, stageId: string): boolean {
  return pipeline.stages.find((stage) => stage.id === stageId)?.kind === "review-loop";
}

/**
 * A pause and a resume leave exactly one durable mark each: the timestamp the
 * `pause`/`resume` action wrote. Keying on it makes a second pause after a
 * resume a new event while a re-projection of the same one appends nothing.
 */
function pipelinePauseEvents(pipeline: Pipeline): LifecycleEventInput[] {
  const events: LifecycleEventInput[] = [];
  const stageId = pipeline.cursor?.stageId ?? null;
  const lineage = { project: pipeline.project, pipelineId: pipeline.id, stageId };
  if (pipeline.pausedAt) {
    events.push({
      ...lineage,
      key: `pipeline:${pipeline.id}:paused:${pipeline.pausedAt}`,
      type: "stage_paused",
      at: pipeline.pausedAt,
      summary: `${stageId ?? pipeline.id} paused${pipeline.stateDetail ? `: ${pipeline.stateDetail}` : ""}`,
    });
  }
  if (pipeline.resumedAt) {
    events.push({
      ...lineage,
      key: `pipeline:${pipeline.id}:resumed:${pipeline.resumedAt}`,
      type: "stage_resumed",
      at: pipeline.resumedAt,
      summary: `${stageId ?? pipeline.id} resumed`,
    });
  }
  return events;
}

/**
 * A repair round is ready the moment a fail edge is traversed: the reviewer's
 * findings are in and an earlier stage has been re-activated to fix them. The
 * activation record (`{stageId, attempt, edge}`) names that exact transition on
 * both the pending cursor and the attempt it becomes, so one key covers the
 * whole handover and the event lands once — whether it is projected before the
 * repair agent spawns or after.
 */
function repairReadyEvent(
  pipeline: Pipeline,
  toStageId: string,
  activation: PipelineEdgeActivation,
): LifecycleEventInput | null {
  if (activation.edge !== "fail") return null;
  const source = pipeline.runs
    .find((run) => run.stageId === activation.stageId)?.attempts
    .find((attempt) => attempt.n === activation.attempt);
  return {
    key: `pipeline:${pipeline.id}:repair:${activation.stageId}:${activation.attempt}:to:${toStageId}`,
    type: "repair_ready",
    /* The findings landed when the failing attempt completed; that is when the
       repair became available, and it is the same instant however this
       transition is later re-projected. */
    at: source?.completedAt ?? source?.startedAt ?? pipeline.createdAt,
    project: pipeline.project,
    pipelineId: pipeline.id,
    stageId: toStageId,
    summary: `${toStageId} is ready to repair the findings from ${activation.stageId} attempt ${activation.attempt}`,
  };
}

function pipelineDecisionEvent(pipeline: Pipeline, decision: Pipeline["decisions"][number]): LifecycleEventInput | null {
  const run = pipeline.runs.find((candidate) => candidate.stageId === decision.stageId);
  const attemptN = decision.targetAttempt ?? decision.sourceAttempt;
  const attempt = run?.attempts.find((candidate) => !candidate.historical && candidate.n === attemptN) ?? null;
  const lineage = {
    project: pipeline.project,
    pipelineId: pipeline.id,
    stageId: decision.stageId,
    attempt: attemptN,
    conversationId: attempt?.conversationId ?? null,
    role: attempt?.effectiveRole?.roleId ?? null,
  };
  const base = {
    ...lineage,
    key: `pipeline:${pipeline.id}:stage:${decision.stageId}:decision:${decision.revision}:${decision.state}`,
    at: decision.terminalAt ?? decision.updatedAt,
  };
  if (decision.state === "awaiting_input") {
    return { ...base, type: "stage_blocked", summary: `${decision.stageId} decision ${decision.revision} awaits operator input` };
  }
  if (decision.state === "held") {
    return { ...base, type: "delivery_held", summary: `${decision.stageId} decision ${decision.revision} held for attempt ${attemptN}` };
  }
  if (["admitting", "queued", "delivering"].includes(decision.state)) {
    return { ...base, type: "delivery_queued", summary: `${decision.stageId} decision ${decision.revision} ${decision.state} for attempt ${attemptN}` };
  }
  if (decision.state === "delivered") {
    return { ...base, type: "delivery_delivered", summary: `${decision.stageId} decision ${decision.revision} started attempt ${attemptN}` };
  }
  if (decision.state === "failed") {
    return { ...base, type: "delivery_expired", summary: `${decision.stageId} decision ${decision.revision} failed for attempt ${attemptN}` };
  }
  if (decision.state === "superseded" || decision.state === "closed") {
    return {
      ...base,
      type: "delivery_expired",
      summary: `${decision.stageId} decision ${decision.revision} ${decision.state} before attempt ${attemptN}`,
    };
  }
  return null;
}

export function projectPipelineEvents(pipelines: Pipeline[]): LifecycleEventInput[] {
  const events: LifecycleEventInput[] = [];
  for (const pipeline of pipelines) {
    events.push(...pipelinePauseEvents(pipeline));
    for (const decision of pipeline.decisions ?? []) {
      const event = pipelineDecisionEvent(pipeline, decision);
      if (event) events.push(event);
    }
    /* A repair is ready as soon as the fail edge is traversed — visible on the
       pending cursor before the repair agent exists, and on the attempt once it
       does. Both build the same key, so it is journaled exactly once. */
    const activations: Array<[string, PipelineEdgeActivation]> = [];
    if (pipeline.cursor?.activatedBy) activations.push([pipeline.cursor.stageId, pipeline.cursor.activatedBy]);
    for (const run of pipeline.runs) {
      for (const attempt of run.attempts) {
        if (!attempt.historical && attempt.activatedBy) activations.push([run.stageId, attempt.activatedBy]);
      }
    }
    for (const [toStageId, activation] of activations) {
      const repair = repairReadyEvent(pipeline, toStageId, activation);
      if (repair) events.push(repair);
    }
    for (const run of pipeline.runs) {
      for (const attempt of run.attempts) {
        if (attempt.historical) continue;
        const lineage = {
          project: pipeline.project,
          pipelineId: pipeline.id,
          stageId: run.stageId,
          attempt: attempt.n,
          conversationId: attempt.conversationId,
          role: attempt.effectiveRole?.roleId ?? null,
        };
        if (attempt.startedAt) {
          events.push({
            ...lineage,
            key: attemptKey(pipeline, run.stageId, attempt, "started"),
            type: "stage_started",
            at: attempt.startedAt,
            summary: `${run.stageId} started`,
          });
        }
        const type = ATTEMPT_EVENT_TYPE[attempt.state];
        if (!type) continue;
        const at = attempt.completedAt ?? attempt.startedAt ?? pipeline.createdAt;
        const verdict = attempt.verdict;
        const summary = attempt.error
          ?? verdict?.findings?.[0]
          ?? attempt.output
          ?? `${run.stageId} ${attempt.state}`;
        events.push({ ...lineage, key: attemptKey(pipeline, run.stageId, attempt, attempt.state), type, at, summary });
        if (verdict && isReviewStage(pipeline, run.stageId)) {
          events.push({
            ...lineage,
            key: attemptKey(pipeline, run.stageId, attempt, `verdict:${verdict.status}`),
            type: "review_verdict",
            at,
            summary: `${verdict.status}: ${verdict.findings?.[0] ?? attempt.output ?? "no findings"}`,
          });
        }
      }
    }
  }
  return events;
}

const DELIVERY_EVENT_TYPE: Partial<Record<HeldDelivery["state"], LifecycleEventType>> = {
  held: "delivery_held",
  assigned: "delivery_queued",
  delivered: "delivery_delivered",
  failed: "delivery_expired",
};

/** Delivery receipts are lineage-poor by nature — they carry a conversation,
    never a pipeline — and their text is operator content, so only the state
    transition is journaled, never the message body. */
export function projectDeliveryEvents(deliveries: HeldDelivery[]): LifecycleEventInput[] {
  const events: LifecycleEventInput[] = [];
  for (const delivery of deliveries) {
    const type = DELIVERY_EVENT_TYPE[delivery.state];
    if (!type) continue;
    events.push({
      key: `delivery:${delivery.id}:${delivery.state}`,
      type,
      at: delivery.deliveredAt ?? delivery.assignedAt ?? delivery.createdAt,
      conversationId: delivery.conversationId,
      summary: type === "delivery_expired"
        ? `delivery ${delivery.id} failed after ${delivery.attempts} attempt(s)`
        : `delivery ${delivery.id} ${delivery.state}`,
    });
  }
  return events;
}

const DEPLOYMENT_EVENT_TYPE: Partial<Record<ViewerDeploymentStatus["phase"], LifecycleEventType>> = {
  admitted: "deploy_ready",
  succeeded: "deploy_succeeded",
  failed: "deploy_failed",
  "rolled-back": "deploy_failed",
};

export function projectDeploymentEvents(deployments: ViewerDeploymentStatus[]): LifecycleEventInput[] {
  const events: LifecycleEventInput[] = [];
  for (const deployment of deployments) {
    const type = DEPLOYMENT_EVENT_TYPE[deployment.phase];
    if (!type) continue;
    events.push({
      key: `deployment:${deployment.deploymentId}:${deployment.phase}`,
      type,
      at: deployment.updatedAt,
      summary: deployment.error
        ?? `deploy ${deployment.revision.slice(0, 12)} ${deployment.phase}`,
    });
  }
  return events;
}

/** Event types that record an observation of an agent's own liveness, as
    opposed to the stage it happens to be running. Only these decide what the
    journal last believed about a conversation. */
const AGENT_LIVENESS_EVENT_TYPES = new Set<LifecycleEventType>(["agent_stalled", "agent_gone", "agent_resumed"]);

/**
 * What the journal last observed about each conversation's own liveness. This
 * is what makes `agent_resumed` expressible at all: "resumed" is not a property
 * of one reading, it is the difference between two, and the durable journal is
 * where the previous one lives.
 */
export function lastObservedAgentState(file: LifecycleJournalFile): Map<string, LifecycleState> {
  const states = new Map<string, LifecycleState>();
  for (const event of file.events) {
    if (!event.conversationId || !AGENT_LIVENESS_EVENT_TYPES.has(event.type)) continue;
    states.set(event.conversationId, event.state);
  }
  return states;
}

/**
 * A liveness reading observed by #645 becomes a durable event, so the
 * operator's sweep leaves a record instead of a transient reading. The key
 * carries the last transcript timestamp: a conversation that stalls again after
 * making progress is a genuinely new event, while re-observing the same frozen
 * transcript is the same one.
 *
 * Three of the four readings are news; `waiting` and `starting` are not. A
 * `gone` reading is deliberately narrow — every settled transcript in the
 * inventory is `gone`, and journaling all of them would bury the journal in
 * agents nobody is waiting on. It is recorded only for a conversation the
 * Viewer still expects work from: one whose pipeline attempt has not reached a
 * terminal state, or one the journal already saw stall.
 */
export function projectLivenessEvents(
  records: AgentLivenessRecord[],
  previous: ReadonlyMap<string, LifecycleState> = new Map(),
): LifecycleEventInput[] {
  const events: LifecycleEventInput[] = [];
  for (const record of records) {
    const subject = record.conversationId ?? record.transcriptPath;
    const marker = record.lastRecordAt ?? "unknown";
    const at = record.lastRecordAt ?? new Date().toISOString();
    const lineage = {
      project: record.project,
      pipelineId: record.pipeline?.pipelineId ?? null,
      stageId: record.pipeline?.stageId ?? null,
      attempt: record.pipeline?.attempt ?? null,
      conversationId: record.conversationId,
    };
    const before = record.conversationId ? previous.get(record.conversationId) : undefined;
    if (record.lifecycle === "stalled") {
      events.push({
        ...lineage,
        key: `liveness:${subject}:stalled:${marker}`,
        type: "agent_stalled",
        at,
        summary: record.reason === "host_gone_turn_open"
          ? `agent host is gone with the turn still open${record.pipeline ? ` while the pipeline reports ${record.pipeline.reportedState}` : ""}`
          : `transcript silent for ${Math.round((record.silentForMs ?? 0) / 60_000)} min under a live host`,
      });
      continue;
    }
    if (record.lifecycle === "gone") {
      const stageStillOpen = record.pipeline !== null && !TERMINAL_ATTEMPT_STATES.has(record.pipeline.reportedState);
      if (!stageStillOpen && before !== "stalled") continue;
      events.push({
        ...lineage,
        key: `liveness:${subject}:gone:${marker}`,
        type: "agent_gone",
        at,
        summary: stageStillOpen
          ? `agent host exited while the pipeline still reports ${record.pipeline!.reportedState}`
          : "the stalled agent's host has exited",
      });
      continue;
    }
    /* Progress after the journal recorded a stall or an exit: the one reading
       that retires an outstanding alarm. */
    if (record.lifecycle === "running" && (before === "stalled" || before === "gone")) {
      events.push({
        ...lineage,
        key: `liveness:${subject}:resumed:${marker}`,
        type: "agent_resumed",
        at,
        summary: "the agent is producing transcript records again",
      });
    }
  }
  return events;
}

/** Attempt states a stage has finished in. A host that exits on one of these
    finished; only an unfinished one makes its exit news. */
const TERMINAL_ATTEMPT_STATES = new Set<PipelineStageAttempt["state"]>([
  "passed",
  "failed",
  "needs_decision",
  "skipped",
]);

export interface LifecycleProjectionInput {
  pipelines?: Pipeline[];
  deliveries?: HeldDelivery[];
  deployments?: ViewerDeploymentStatus[];
  liveness?: AgentLivenessRecord[];
  /** What the journal last observed about each conversation, so `agent_resumed`
      and a narrow `agent_gone` can be derived. Defaults to the durable journal. */
  observed?: ReadonlyMap<string, LifecycleState>;
}

export function projectLifecycleEvents(input: LifecycleProjectionInput): LifecycleEventInput[] {
  return [
    ...projectPipelineEvents(input.pipelines ?? []),
    ...projectDeliveryEvents(input.deliveries ?? []),
    ...projectDeploymentEvents(input.deployments ?? []),
    ...projectLivenessEvents(input.liveness ?? [], input.observed ?? new Map()),
  ].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

/** In-process throttle for the projection sweep, tracked per source domain.
    Lives on `globalThis` because Next bundles instrumentation separately from
    route handlers: a module-level singleton would silently become two in a
    standalone build. */
const projectionStore = globalThis as typeof globalThis & { __llvLifecycleProjectionAt?: Record<string, number> };

/** Minimum spacing between projections driven by a poll. */
export const PROJECTION_THROTTLE_MS = 1_000;

type ProjectionDomain = "liveness" | "lifecycle";

function domainFor(input: LifecycleProjectionInput): ProjectionDomain {
  return input.liveness?.length && !input.pipelines?.length && !input.deliveries?.length && !input.deployments?.length
    ? "liveness" : "lifecycle";
}

/**
 * Projects and appends in one step, throttled so a tight polling loop does not
 * re-scan every pipeline on every call. Returns how many genuinely new events
 * were recorded.
 */
export function refreshLifecycleJournal(
  input: LifecycleProjectionInput,
  options: { now?: number; force?: boolean } = {},
): { appended: number; skipped: number; throttled: boolean } {
  const now = options.now ?? Date.now();
  const stamps = projectionStore.__llvLifecycleProjectionAt ??= {};
  const domain = domainFor(input);
  const last = stamps[domain] ?? 0;
  if (!options.force && now - last < PROJECTION_THROTTLE_MS) return { appended: 0, skipped: 0, throttled: true };
  stamps[domain] = now;
  const observed = input.observed
    ?? (input.liveness?.length ? lastObservedAgentState(readLifecycleJournal()) : undefined);
  const result = appendLifecycleEvents(projectLifecycleEvents({ ...input, observed }));
  return { appended: result.appended.length, skipped: result.skipped, throttled: false };
}
