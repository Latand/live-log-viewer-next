/**
 * The bounded list projection behind `list_pipelines` (issue #863).
 *
 * `list_pipelines` used to filter the registry, slice it to `limit`, and hand
 * back whole `Pipeline` records. Each surviving row therefore still carried
 * `spec`, `stages[].prompt`, `stages[].effectiveRole.promptScaffold` and
 * `runs[].attempts[]` with every persisted `input`/`output` transcript body —
 * 365 KB per row, a 37 MB response for 100 rows. Everything downstream then paid
 * for that graph again: redaction walked it (1.1 s of CPU), and it was serialized
 * for the receipt row, the size metric, the content block and the SDK's
 * `structuredContent` before being written into SQLite. At concurrency 8 that was
 * a 12 s service p95 and gigabytes of RSS.
 *
 * A list row is a board card: identity, placement, state, cursor, and per-stage
 * counts. Full prompts, specs, relay inputs and transcript tails stay behind
 * `get_pipeline`, which is unchanged and remains the detail read.
 *
 * Ordering, the project/state/includeClosed predicates and the `limit` bound are
 * exactly the ones the previous implementation applied, so MCP stays at parity
 * with `GET /api/pipelines` filtered the same way.
 */
import type { FlowEngine } from "@/lib/flows/types";

import { latestOperationalStageAttempt } from "./attemptSelection";
import { loadArchivedPipelines, loadPipelinesForList } from "./store";
import type {
  Pipeline,
  PipelineAccess,
  PipelineAttemptState,
  PipelineCursorState,
  PipelineRoleId,
  PipelineStage,
  PipelineStageAttempt,
  PipelineStageKind,
  PipelineState,
  StageVerdictStatus,
} from "./types";

export const PIPELINE_LIST_DEFAULT_LIMIT = 100;
export const PIPELINE_LIST_MAX_LIMIT = 200;

/** Free text an operator authored (a task title, a state detail, an attempt
    error) has no length bound in the registry, so a row would not have one
    either. Clamped rather than dropped: the first lines are what identifies a
    lane on the board, and `get_pipeline` still returns the untruncated value. */
const MAX_ROW_TEXT = 400;

/** Rows are projected in batches, yielding to the event loop between them, so a
    caller's deadline timer can actually fire mid-call instead of waiting for a
    synchronous walk to release the loop. */
const YIELD_EVERY_ROWS = 25;

export type PipelineListFilter = {
  project?: string | null;
  state?: string | null;
  includeClosed?: boolean;
  limit?: number | null;
};

/** The bounded view of one attempt: who ran, how it ended, where to look next. */
export type PipelineListAttempt = {
  n: number;
  state: PipelineAttemptState;
  verdict: StageVerdictStatus | null;
  conversationId: string | null;
  flowId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Clamped; present only when the attempt recorded one. */
  error: string | null;
};

export type PipelineListStage = {
  id: string;
  kind: PipelineStageKind;
  roleId: PipelineRoleId | null;
  engine: FlowEngine | null;
  model: string | null;
  effort: string | null;
  access: PipelineAccess | null;
  next: string | null;
  onFail: { to: string; maxRounds: number } | null;
  attempts: number;
  latestAttempt: PipelineListAttempt | null;
};

export type PipelineListRow = {
  id: string;
  /** Clamped title. */
  task: string;
  taskIds: string[];
  project: string;
  repoDir: string;
  worktreeDir: string;
  branch: string;
  baseBranch: string;
  state: PipelineState;
  pausedState: Pipeline["pausedState"];
  /** Clamped. */
  stateDetail: string | null;
  /** Whether a pinned specification exists — the body itself is a get_pipeline read. */
  hasSpec: boolean;
  createdAt: string;
  closedAt: string | null;
  hiddenAt: string | null;
  cursor: { stageId: string; state: PipelineCursorState } | null;
  attemptCount: number;
  unconfirmedHostCount: number;
  stages: PipelineListStage[];
  pos: { x: number; y: number } | null;
};

export type PipelineListProjectionOptions = {
  /**
   * Cancellation checkpoint, invoked around the registry read and between row
   * batches. Throwing abandons the projection — which is the point: the MCP
   * binding passes the call's deadline/abort check here so a caller that has
   * already given up stops the work rather than paying for a result nobody will
   * read. The registry parse itself is one synchronous step that cannot be
   * interrupted, so it is bracketed by checkpoints rather than split.
   */
  checkpoint?: () => void;
  /** Record source; defaults to the bounded, cached store read. */
  source?: () => readonly Pipeline[];
};

function clampText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  return value.length <= MAX_ROW_TEXT ? value : `${value.slice(0, MAX_ROW_TEXT)}…`;
}

function boundedLimit(limit: number | null | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return PIPELINE_LIST_DEFAULT_LIMIT;
  return Math.max(1, Math.min(PIPELINE_LIST_MAX_LIMIT, Math.trunc(limit)));
}

/**
 * The registry rows a list call selects, in registry order.
 *
 * Filters and stops at `limit` in one pass, before any row is materialized, so
 * nested history is never touched for a record that was going to be dropped.
 */
export function selectPipelineListRecords(
  pipelines: readonly Pipeline[],
  filter: PipelineListFilter,
): readonly Pipeline[] {
  const limit = boundedLimit(filter.limit);
  const project = filter.project || null;
  const state = filter.state || null;
  const includeClosed = filter.includeClosed === true;
  const selected: Pipeline[] = [];
  for (const pipeline of pipelines) {
    if (project && pipeline.project !== project) continue;
    if (state && pipeline.state !== state) continue;
    if (!includeClosed && pipeline.state === "closed") continue;
    /* Hidden is settled for listing purposes (#1274): a lane the operator
       discarded is not in flight, and a listing that reported it as active
       showed it to every project's seat, not only its owner's. `includeClosed`
       still returns it, which is where a settled record belongs. */
    if (!includeClosed && pipeline.hiddenAt) continue;
    selected.push(pipeline);
    if (selected.length >= limit) break;
  }
  return selected;
}

function attemptRow(attempt: PipelineStageAttempt | null): PipelineListAttempt | null {
  if (!attempt) return null;
  return {
    n: attempt.n,
    state: attempt.state,
    verdict: attempt.verdict?.status ?? null,
    conversationId: attempt.conversationId ?? null,
    flowId: attempt.flowId ?? null,
    startedAt: attempt.startedAt ?? null,
    completedAt: attempt.completedAt ?? null,
    error: clampText(attempt.error),
  };
}

function stageRow(
  pipeline: Pipeline,
  stage: PipelineStage,
  attempts: readonly PipelineStageAttempt[],
): PipelineListStage {
  const role = stage.effectiveRole;
  return {
    id: stage.id,
    kind: stage.kind,
    roleId: role?.roleId ?? stage.role?.roleId ?? null,
    engine: role?.engine ?? stage.engine ?? null,
    model: role?.model ?? stage.model ?? null,
    effort: role?.effort ?? stage.effort ?? null,
    access: role?.access ?? stage.access ?? null,
    next: stage.next,
    onFail: stage.onFail ? { to: stage.onFail.to, maxRounds: stage.onFail.maxRounds } : null,
    attempts: attempts.length,
    /* The canonical selector, not "the last element": a lineage-adopted
       historical attempt is evidence, never the stage's current work. */
    latestAttempt: attemptRow(latestOperationalStageAttempt(pipeline, stage.id)),
  };
}

/** One registry record as a board card. Every field is a scalar copy: no part of
    the source record is aliased into the row, so nothing the caller receives can
    retain the cached registry graph. */
export function pipelineListRow(record: Pipeline): PipelineListRow {
  /* Partial harnesses hand in records without runs; normalizing once here keeps
     every reader below — including the shared attempt selector — on the type. */
  const pipeline: Pipeline = record.runs ? record : { ...record, runs: [] };
  const attemptsByStage = new Map<string, readonly PipelineStageAttempt[]>();
  let attemptCount = 0;
  for (const run of pipeline.runs) {
    const attempts = run.attempts ?? [];
    attemptsByStage.set(run.stageId, attempts);
    attemptCount += attempts.length;
  }
  return {
    id: pipeline.id,
    task: clampText(pipeline.task) ?? "",
    taskIds: [...(pipeline.taskIds ?? [])],
    project: pipeline.project,
    repoDir: pipeline.repoDir,
    worktreeDir: pipeline.worktreeDir,
    branch: pipeline.branch,
    baseBranch: pipeline.baseBranch,
    state: pipeline.state,
    pausedState: pipeline.pausedState ?? null,
    stateDetail: clampText(pipeline.stateDetail),
    hasSpec: typeof pipeline.spec === "string" && pipeline.spec.length > 0,
    createdAt: pipeline.createdAt,
    closedAt: pipeline.closedAt ?? null,
    hiddenAt: pipeline.hiddenAt ?? null,
    cursor: pipeline.cursor ? { stageId: pipeline.cursor.stageId, state: pipeline.cursor.state } : null,
    attemptCount,
    unconfirmedHostCount: pipeline.unconfirmedHosts?.length ?? 0,
    stages: (pipeline.stages ?? []).map((stage) => stageRow(pipeline, stage, attemptsByStage.get(stage.id) ?? [])),
    pos: pipeline.pos ? { x: pipeline.pos.x, y: pipeline.pos.y } : null,
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}

/**
 * Read, filter, slice and project a bounded page of list rows.
 *
 * Async on purpose. The old binding was one synchronous walk, so the 30 s
 * deadline timer `createViewerMcpServer` arms could not fire while it owned the
 * event loop: a timed-out caller left the work running to completion and still
 * paid for the receipt write. Yielding between row batches gives that timer a
 * turn, and `checkpoint` is what turns it into an abandoned call.
 */
export async function projectPipelineListRows(
  filter: PipelineListFilter,
  options: PipelineListProjectionOptions = {},
): Promise<PipelineListRow[]> {
  const checkpoint = options.checkpoint ?? (() => {});
  checkpoint();
  const hot = (options.source ?? loadPipelinesForList)();
  /* Settled records live in the cold archive; only a closed-inclusive list
     pays for reading them. */
  const records = filter.includeClosed === true && !options.source
    ? [...hot, ...loadArchivedPipelines()]
    : hot;
  checkpoint();
  const selected = selectPipelineListRecords(records, filter);
  const rows: PipelineListRow[] = [];
  for (const pipeline of selected) {
    if (rows.length > 0 && rows.length % YIELD_EVERY_ROWS === 0) {
      await yieldToEventLoop();
      checkpoint();
    }
    rows.push(pipelineListRow(pipeline));
  }
  return rows;
}
