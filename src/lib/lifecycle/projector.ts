import type { HeldDelivery } from "@/lib/accounts/migration/contracts";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { ViewerDeploymentStatus } from "@/lib/runtime/contracts";

import { appendLifecycleEvents, type LifecycleEventInput } from "./journal";
import type { AgentLivenessRecord } from "./liveness";
import type { LifecycleEventType } from "./vocabulary";

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

export function projectPipelineEvents(pipelines: Pipeline[]): LifecycleEventInput[] {
  const events: LifecycleEventInput[] = [];
  for (const pipeline of pipelines) {
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

/**
 * A stall observed by #645 becomes a durable event, so the operator's sweep
 * leaves a record instead of a transient reading. The key carries the last
 * transcript timestamp: a conversation that stalls again after making progress
 * is a genuinely new event, while re-observing the same frozen transcript is
 * the same one.
 */
export function projectLivenessEvents(records: AgentLivenessRecord[]): LifecycleEventInput[] {
  const events: LifecycleEventInput[] = [];
  for (const record of records) {
    if (record.lifecycle !== "stalled") continue;
    const marker = record.lastRecordAt ?? "unknown";
    events.push({
      key: `liveness:${record.conversationId ?? record.transcriptPath}:stalled:${marker}`,
      type: "agent_stalled",
      at: record.lastRecordAt ?? new Date().toISOString(),
      project: record.project,
      pipelineId: record.pipeline?.pipelineId ?? null,
      stageId: record.pipeline?.stageId ?? null,
      attempt: record.pipeline?.attempt ?? null,
      conversationId: record.conversationId,
      summary: record.reason === "host_gone_turn_open"
        ? `agent host is gone with the turn still open${record.pipeline ? ` while the pipeline reports ${record.pipeline.reportedState}` : ""}`
        : `transcript silent for ${Math.round((record.silentForMs ?? 0) / 60_000)} min under a live host`,
    });
  }
  return events;
}

export interface LifecycleProjectionInput {
  pipelines?: Pipeline[];
  deliveries?: HeldDelivery[];
  deployments?: ViewerDeploymentStatus[];
  liveness?: AgentLivenessRecord[];
}

export function projectLifecycleEvents(input: LifecycleProjectionInput): LifecycleEventInput[] {
  return [
    ...projectPipelineEvents(input.pipelines ?? []),
    ...projectDeliveryEvents(input.deliveries ?? []),
    ...projectDeploymentEvents(input.deployments ?? []),
    ...projectLivenessEvents(input.liveness ?? []),
  ].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

/** In-process throttle for the projection sweep. It lives on `globalThis`
    because Next bundles instrumentation separately from route handlers: a
    module-level singleton would silently become two in a standalone build. */
const projectionStore = globalThis as typeof globalThis & { __llvLifecycleProjectionAt?: number };

/** Minimum spacing between projections driven by a poll. */
export const PROJECTION_THROTTLE_MS = 1_000;

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
  const last = projectionStore.__llvLifecycleProjectionAt ?? 0;
  if (!options.force && now - last < PROJECTION_THROTTLE_MS) return { appended: 0, skipped: 0, throttled: true };
  projectionStore.__llvLifecycleProjectionAt = now;
  const result = appendLifecycleEvents(projectLifecycleEvents(input));
  return { appended: result.appended.length, skipped: result.skipped, throttled: false };
}
