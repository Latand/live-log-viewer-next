import type { Pipeline, PipelineEdgeActivation, PipelineStageAttempt } from "./types";

export function latestOperationalStageAttempt(pipeline: Pipeline, stageId: string): PipelineStageAttempt | null {
  return pipeline.runs
    .find((run) => run.stageId === stageId)
    ?.attempts.findLast((attempt) => !attempt.historical) ?? null;
}

function sameActivation(left: PipelineEdgeActivation | null, right: PipelineEdgeActivation | null): boolean {
  if (left === null || right === null) return left === right;
  return left.stageId === right.stageId && left.attempt === right.attempt && left.edge === right.edge;
}

function attemptTimestamp(attempt: PipelineStageAttempt): number | null {
  for (const value of [attempt.startedAt, attempt.completedAt]) {
    const parsed = value ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function activationDepth(
  attempts: ReadonlyMap<string, PipelineStageAttempt>,
  stageId: string,
  attempt: PipelineStageAttempt,
): number {
  const seen = new Set<string>([`${stageId}:${attempt.n}`]);
  let depth = 0;
  let activation = attempt.activatedBy;
  while (activation) {
    const key = `${activation.stageId}:${activation.attempt}`;
    if (seen.has(key)) break;
    seen.add(key);
    const parent = attempts.get(key);
    if (!parent) break;
    depth += 1;
    activation = parent.activatedBy;
  }
  return depth;
}

/** Selects the attempt representing the pipeline's latest operational work.
 * The materialized cursor attempt is authoritative during active execution.
 * A pending cursor may precede attempt creation, so durable timestamps and
 * activation lineage order the remaining non-historical evidence. */
export function latestOperationalPipelineAttempt(pipeline: Pipeline): PipelineStageAttempt | null {
  if (pipeline.cursor) {
    const cursorAttempt = latestOperationalStageAttempt(pipeline, pipeline.cursor.stageId);
    if (cursorAttempt && (pipeline.cursor.state !== "pending"
      || sameActivation(cursorAttempt.activatedBy, pipeline.cursor.activatedBy))) {
      return cursorAttempt;
    }
  }

  const attemptsByKey = new Map<string, PipelineStageAttempt>();
  const candidates: Array<{ stageId: string; attempt: PipelineStageAttempt }> = [];
  for (const run of pipeline.runs) {
    for (const attempt of run.attempts) {
      if (attempt.historical) continue;
      attemptsByKey.set(`${run.stageId}:${attempt.n}`, attempt);
      candidates.push({ stageId: run.stageId, attempt });
    }
  }

  let selected: { attempt: PipelineStageAttempt; timestamp: number | null; depth: number } | null = null;
  for (const candidate of candidates) {
    const timestamp = attemptTimestamp(candidate.attempt);
    const depth = activationDepth(attemptsByKey, candidate.stageId, candidate.attempt);
    if (!selected
      || (timestamp !== null && (selected.timestamp === null || timestamp > selected.timestamp))
      || (timestamp === selected.timestamp && depth > selected.depth)) {
      selected = { attempt: candidate.attempt, timestamp, depth };
    }
  }
  return selected?.attempt ?? null;
}
