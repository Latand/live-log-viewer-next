import { roleNameById } from "@/components/builderCopy";
import { reviewerBindingTargetsForRound } from "@/components/flows/flowModel";
import { currentMemberPath } from "@/lib/accounts/identity";
import { applyPipelineSnapshot, revertPipelineSnapshot } from "@/hooks/useFiles";
import { getLocale, translate, type MessageKey, type TFunction } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { Flow, FlowEngine } from "@/lib/flows/types";
import { PIPELINE_DISALLOWED_ROLE_IDS } from "@/lib/pipelines/types";
import type {
  CreatePipelineRequest,
  EffectivePipelineRole,
  Pipeline,
  PipelineAccess,
  PipelineAction,
  PipelineAttemptState,
  PipelineEdgeKind,
  PipelineRepoPreflight,
  PipelineRepoPreflightErrorCode,
  PipelineStage,
  PipelineStageAttempt,
  PipelineRoleId,
  PipelineStageInput,
  PipelineStageKind,
  PipelineState,
  PatchPipelineRequest,
  StageVerdictStatus,
} from "@/lib/pipelines/types";

import { PIPELINES_CHANGED_EVENT } from "./pipelineEvents";

export { PIPELINES_CHANGED_EVENT };

/** Client-safe list of the pipeline role ids an operator may assign to a stage,
    minus the ones a pipeline may not use (deployer needs interactive deploy
    confirmation). Mirrors the server's PIPELINE_ROLE_IDS; the API re-validates. */
export const PIPELINE_ROLE_OPTIONS: readonly PipelineRoleId[] = (
  ["orchestrator", "reviewer", "verifier", "builder", "architect", "cleaner", "prod-auditor", "deployer"] as const
).filter((roleId) => !PIPELINE_DISALLOWED_ROLE_IDS.includes(roleId));

/** The stage-override form's raw values (issue #118 on-canvas controls). */
export type StageOverrideForm = { roleId: string; engine: FlowEngine; model: string; effort: string; prompt: string };

/**
 * Builds an override-stage PATCH body that carries ONLY the fields the operator
 * actually changed from the stage's current config (issue #118 Finding 4).
 * Sending an unchanged engine/model/effort would pin the previous role's runtime
 * as an explicit override and defeat the backend's "changing the role resets
 * unpinned runtime to its defaults" rule — so a role-only change must omit them.
 * The prompt too travels only when edited, so an untouched stage's stored
 * prompt is never rewritten by an unrelated override (issue #221 §5).
 */
export function stageOverrideBody(stage: PipelineStage, form: StageOverrideForm): Omit<PatchPipelineRequest, "action"> {
  const body: Omit<PatchPipelineRequest, "action"> = { stageId: stage.id };
  const prompt = form.prompt.trim();
  if (prompt && prompt !== stage.prompt) body.prompt = prompt;
  if (form.roleId !== (stage.role?.roleId ?? "")) body.role = form.roleId ? { roleId: form.roleId as PipelineRoleId } : null;
  if (form.engine !== stage.effectiveRole.engine) body.engine = form.engine;
  if (form.model.trim() !== (stage.effectiveRole.model ?? "")) body.model = form.model.trim() || null;
  if (form.effort !== (stage.effectiveRole.effort ?? "")) body.effort = form.effort || null;
  return body;
}

/**
 * A node can seed a pipeline (its transcript becomes the src lineage of stage 0)
 * whenever it is a claude/codex session — a root or a child, whether or not it
 * already hosts a review-loop flow. This is intentionally broader than
 * `canStartFlow`: the pipeline entry point (#93 AC3) must not inherit flow-only
 * eligibility, which excludes children and flow-hosting roots.
 */
export function canSourcePipeline(file: FileEntry): boolean {
  if (file.engine !== "claude" && file.engine !== "codex") return false;
  /* Claude children scan as kind "subagent" (agent-*.jsonl); they seed pipelines
     just like a root "session" does, so AC3 reaches every Claude child too. */
  if (file.root === "claude-projects") return file.kind === "session" || file.kind === "subagent";
  return file.root === "codex-sessions";
}

/** Stable DOM id for a pipeline's dashboard strip, so the on-board hub can
    reveal the always-available detailed surface (#93 §2.2). */
export function pipelineStripDomId(pipelineId: string): string {
  return `pipeline-strip-${pipelineId}`;
}

/**
 * Canonicalizes every stage attempt's `agentPath` to the transcript that
 * currently hosts its conversation (issues #325/#353). Durable pipeline records
 * freeze the launch-time path; an account migration rotates the member onto a
 * new transcript, and every projection that string-matches the frozen path —
 * group halos, rails, compact claiming, worker stacks, strip mounting, open
 * actions — silently drops the live generation, which then renders as a
 * detached standalone card while the pipeline group under-counts its members.
 * Applying this at the dashboard's data boundary repairs all of them at once.
 * Identity-stable: untouched records (the common case) return the same
 * references, so memoized consumers don't churn.
 */
export function resolvePipelineMemberPaths(pipelines: Pipeline[], files: readonly FileEntry[]): Pipeline[] {
  let changedAny = false;
  const out = pipelines.map((pipeline) => {
    let changed = false;
    const runs = pipeline.runs.map((run) => {
      let runChanged = false;
      const attempts = run.attempts.map((attempt) => {
        const path = currentMemberPath(attempt.agentPath, attempt.conversationId, files);
        if (path === attempt.agentPath) return attempt;
        runChanged = true;
        return { ...attempt, agentPath: path };
      });
      if (!runChanged) return run;
      changed = true;
      return { ...run, attempts };
    });
    if (!changed) return pipeline;
    changedAny = true;
    return { ...pipeline, runs };
  });
  return changedAny ? out : pipelines;
}

export function pipelinesForProject(pipelines: Pipeline[], project: string, files: FileEntry[]): Pipeline[] {
  const paths = new Set(files.filter((file) => file.project === project).map((file) => file.path));
  return pipelines.filter((pipeline) => {
    if (pipeline.state === "closed" && !pipeline.restored) return false;
    if (pipeline.project === project) return true;
    return pipeline.runs.some((run) => run.attempts.some((attempt) => Boolean(attempt.agentPath && paths.has(attempt.agentPath))));
  });
}
export function pipelineStateLabel(t: TFunction, state: PipelineState): string {
  return t(`pipelineState.${state}`);
}

export const PIPELINE_BUSY_STATES: ReadonlySet<PipelineState> = new Set(["provisioning", "running"]);
export const PIPELINE_ATTENTION_STATES: ReadonlySet<PipelineState> = new Set(["needs_decision", "paused"]);

/**
 * Is the pipeline actively working its cursor stage? Pausing a running pipeline
 * flips `state` to `paused` but preserves the busy state in `pausedState`; the
 * cursor stage must keep its active tone (only the pulse/chevron animation
 * freezes, which callers handle). Reading `state` alone would demote a paused
 * live stage to `pending`/`dim`.
 */
export function pipelineCursorActive(pipeline: Pipeline): boolean {
  if (PIPELINE_BUSY_STATES.has(pipeline.state)) return true;
  return pipeline.state === "paused" && pipeline.pausedState !== null && PIPELINE_BUSY_STATES.has(pipeline.pausedState);
}

/** Does this pipeline still need the operator's eyes? Drives rail/project badges. */
export function pipelineNeedsAttention(pipeline: Pipeline): boolean {
  return pipeline.state !== "closed" && PIPELINE_ATTENTION_STATES.has(pipeline.state);
}

/* ── Stage chip state matrix (§3 of the #93 design) ─────────────────────── */

export type StageChipState =
  | "pending"
  | "running"
  | "reviewing"
  | "committing"
  | "passed"
  | "failed"
  | "needs_decision"
  | "skipped";

export const STAGE_TONES: Record<StageChipState, { color: string; soft: string }> = {
  pending: { color: "var(--color-muted)", soft: "var(--color-sunken)" },
  running: { color: "var(--color-accent)", soft: "var(--color-accent-soft)" },
  reviewing: { color: "var(--color-accent)", soft: "var(--color-accent-soft)" },
  committing: { color: "var(--color-accent)", soft: "var(--color-accent-soft)" },
  passed: { color: "var(--color-success)", soft: "var(--color-success-soft)" },
  failed: { color: "var(--color-danger)", soft: "var(--color-danger-soft)" },
  needs_decision: { color: "var(--color-warning)", soft: "var(--color-warning-soft)" },
  skipped: { color: "var(--color-muted)", soft: "var(--color-sunken)" },
};

/**
 * The glyph paired with every state so color is never the sole signal (AC4/AC8).
 * Every state carries a distinct, non-empty glyph: pending is no longer blank,
 * and committing (▾, landing the commit) reads apart from running (▸) even
 * though the §3 matrix gives them the same accent tone.
 */
export const STAGE_GLYPH: Record<StageChipState, string> = {
  pending: "○",
  running: "▸",
  reviewing: "⟳",
  committing: "▾",
  passed: "✓",
  failed: "✕",
  needs_decision: "●!",
  skipped: "↷",
};

export function latestAttempt(pipeline: Pipeline, stageId: string): PipelineStageAttempt | null {
  return pipeline.runs.find((run) => run.stageId === stageId)?.attempts.at(-1) ?? null;
}

export function stageAttempts(pipeline: Pipeline, stageId: string): PipelineStageAttempt[] {
  return pipeline.runs.find((run) => run.stageId === stageId)?.attempts ?? [];
}

/**
 * Transcript artifacts already represented by the compact pipeline rail.
 * The current run keeps its latest agent pane. During a review loop the flow's
 * implementer stays as the single full conversation pane while reviewer
 * transcripts remain reachable through the review evidence row. Completed
 * pipelines have no live pane, so their entire transcript chain is compact.
 */
export function compactPipelineArtifactPaths(
  pipelines: readonly Pipeline[],
  flows: readonly Flow[],
  files: readonly FileEntry[] = [],
): Set<string> {
  const flowsById = new Map(flows.map((flow) => [flow.id, flow] as const));
  const fullPanePaths = new Set<string>();

  for (const pipeline of pipelines) {
    if (!pipeline.cursor || pipeline.state === "completed" || pipeline.state === "closed" || pipeline.state === "draft") continue;
    const stage = pipeline.stages.find((candidate) => candidate.id === pipeline.cursor!.stageId);
    const attempt = stage ? latestAttempt(pipeline, stage.id) : null;
    if (!stage || !attempt) continue;
    if (stage.kind === "review-loop") {
      const stageIndex = pipeline.stages.findIndex((candidate) => candidate.id === stage.id);
      const priorRunPath = pipeline.stages
        .slice(0, stageIndex)
        .reverse()
        .find((candidate) => {
          const prior = latestAttempt(pipeline, candidate.id);
          return candidate.kind === "run" && prior?.state === "passed" && prior.agentPath;
        });
      const implementerPath = attempt.flowId
        ? flowsById.get(attempt.flowId)?.implementerPath
        : priorRunPath
          ? latestAttempt(pipeline, priorRunPath.id)?.agentPath
          : null;
      if (implementerPath) fullPanePaths.add(implementerPath);
    } else if (attempt.agentPath) {
      fullPanePaths.add(attempt.agentPath);
    }
  }

  const compact = new Set<string>();
  for (const pipeline of pipelines) {
    for (const run of pipeline.runs) {
      for (const attempt of run.attempts) {
        if (attempt.agentPath && !fullPanePaths.has(attempt.agentPath)) compact.add(attempt.agentPath);
        const flow = attempt.flowId ? flowsById.get(attempt.flowId) : null;
        if (!flow) continue;
        if (!fullPanePaths.has(flow.implementerPath)) compact.add(flow.implementerPath);
        for (const round of flow.rounds) {
          for (const { path } of reviewerBindingTargetsForRound(flow, round, files)) {
            if (!fullPanePaths.has(path)) compact.add(path);
          }
        }
      }
    }
  }
  return compact;
}

/** Keep compact transcript evidence out of every world-scene source. */
export function excludeCompactPipelineArtifacts<T extends { path: string }>(
  files: T[],
  compactPaths: ReadonlySet<string>,
): T[] {
  return compactPaths.size ? files.filter((file) => !compactPaths.has(file.path)) : files;
}

/**
 * Pipeline review rounds live in the compact evidence rail, so their flow decks
 * leave board layout and minimap bounds. The real flow catalog remains available
 * to history controls and runtime actions.
 */
export function compactPipelineLayoutFlows(pipelines: readonly Pipeline[], flows: readonly Flow[]): Flow[] {
  const compactFlowIds = new Set<string>();
  for (const pipeline of pipelines) {
    for (const run of pipeline.runs) {
      for (const attempt of run.attempts) if (attempt.flowId) compactFlowIds.add(attempt.flowId);
    }
  }
  return compactFlowIds.size ? flows.filter((flow) => !compactFlowIds.has(flow.id)) : [...flows];
}

/** Tasks whose assignment or source transcript belongs to this pipeline. */
export function pipelineLineage(
  pipeline: Pipeline,
  flows: readonly Flow[] = [],
  files: readonly FileEntry[] = [],
): {
  paths: Set<string>;
  conversationIds: Set<string>;
} {
  const paths = new Set<string>();
  const conversationIds = new Set<string>();
  if (pipeline.srcPath) paths.add(pipeline.srcPath);
  if (pipeline.srcConversationId) conversationIds.add(pipeline.srcConversationId);
  const flowsById = new Map(flows.map((flow) => [flow.id, flow] as const));
  for (const run of pipeline.runs) {
    for (const attempt of run.attempts) {
      if (attempt.agentPath) paths.add(attempt.agentPath);
      if (attempt.conversationId) conversationIds.add(attempt.conversationId);
      const flow = attempt.flowId ? flowsById.get(attempt.flowId) : null;
      if (!flow) continue;
      paths.add(flow.implementerPath);
      if (flow.implementerConversationId) conversationIds.add(flow.implementerConversationId);
      for (const round of flow.rounds) {
        for (const binding of reviewerBindingTargetsForRound(flow, round, files)) {
          paths.add(binding.path);
          if (binding.conversationId) conversationIds.add(binding.conversationId);
        }
      }
    }
  }
  return { paths, conversationIds };
}

/** Tasks whose assignment or source transcript belongs to this pipeline. */
export function pipelineLinkedTasks(
  pipeline: Pipeline,
  tasks: readonly BoardTask[],
  flows: readonly Flow[] = [],
  files: readonly FileEntry[] = [],
): BoardTask[] {
  const taskIds = (pipeline as Pipeline & { taskIds?: readonly string[] }).taskIds;
  if (taskIds?.length) {
    const byId = new Map(tasks.map((task) => [task.id, task] as const));
    return taskIds.flatMap((id) => {
      const task = byId.get(id);
      return task ? [task] : [];
    });
  }
  const { paths, conversationIds } = pipelineLineage(pipeline, flows, files);
  if (!paths.size && !conversationIds.size) return [];
  return tasks.filter((task) =>
    (task.source ? paths.has(task.source.path) : false) ||
    task.assignments.some((assignment) =>
      Boolean(
        (assignment.path && paths.has(assignment.path)) ||
        (assignment.conversationId && conversationIds.has(assignment.conversationId)),
      ),
    ),
  );
}

/** Keep one explicitly opened compact-history pane per pipeline. */
export function replaceCompactPipelineEphemeral(
  current: readonly string[],
  nextPath: string,
  pipelines: readonly Pipeline[],
  flows: readonly Flow[],
  files: readonly FileEntry[] = [],
): string[] {
  const owner = pipelines.find((pipeline) => pipelineLineage(pipeline, flows, files).paths.has(nextPath));
  const ownerPaths = owner ? pipelineLineage(owner, flows, files).paths : null;
  const retained = ownerPaths ? current.filter((path) => !ownerPaths.has(path)) : [...current];
  return retained.includes(nextPath) ? retained : [...retained, nextPath];
}

/**
 * The board node that should host this pipeline's compact strip (§2.2 "Board
 * strip rule"): the current stage's latest attempt agent path, so controls sit
 * over the node the operator is watching. Returns null when the current stage is
 * a review-loop — the flow's own FlowStrip owns that slot — or when it hasn't
 * materialized a session yet, or the pipeline is closed. The current stage is the
 * cursor's, falling back to the last stage once the chain completes (matching the
 * hub's cursor read).
 */
export function pipelineBoardStripPath(pipeline: Pipeline): string | null {
  if (pipeline.state === "closed") return null;
  const stageId = pipeline.cursor?.stageId ?? pipeline.stages.at(-1)?.id ?? null;
  if (!stageId) return null;
  const stage = pipeline.stages.find((candidate) => candidate.id === stageId);
  if (!stage || stage.kind === "review-loop") return null;
  return latestAttempt(pipeline, stageId)?.agentPath ?? null;
}

/** Map from board node path → the pipeline whose compact strip mounts over it. */
export function pipelineStripByPath(pipelines: Pipeline[]): Map<string, Pipeline> {
  const map = new Map<string, Pipeline>();
  for (const pipeline of pipelines) {
    const path = pipelineBoardStripPath(pipeline);
    if (path) map.set(path, pipeline);
  }
  return map;
}

/**
 * Resolves a stage's chip state from its latest attempt and the pipeline cursor,
 * following the state matrix: a terminal attempt state wins; otherwise a stage
 * under an active cursor shows running/reviewing/committing; everything else is
 * pending.
 */
export function stageChipState(pipeline: Pipeline, stage: PipelineStage): StageChipState {
  const attempt = latestAttempt(pipeline, stage.id);
  if (attempt) {
    if (attempt.state === "passed") return "passed";
    if (attempt.state === "skipped") return "skipped";
    if (attempt.state === "failed") return "failed";
    if (attempt.state === "needs_decision") return "needs_decision";
  }
  const onCursor = pipeline.cursor?.stageId === stage.id;
  if (onCursor && pipelineCursorActive(pipeline)) {
    if (pipeline.cursor?.state === "committing" || attempt?.state === "committing") return "committing";
    if (stage.kind === "review-loop" || pipeline.cursor?.state === "reviewing" || attempt?.state === "reviewing") return "reviewing";
    return "running";
  }
  return "pending";
}

export function stageAccess(pipeline: Pipeline, stage: PipelineStage): PipelineAccess {
  const attempt = latestAttempt(pipeline, stage.id);
  return attempt?.effectiveRole.access ?? stage.access ?? (stage.kind === "review-loop" ? "read-only" : "read-write");
}

/** Ids of flows that actually have a board deck to reveal. A deck is created only
    when the flow's implementer is placed (buildSchemeLayout), so a flow counts as
    renderable only when it is open and its implementer path appears in
    `placedPaths` (the current layout's node paths). An open flow whose implementer
    is unplaced has zero decks, and Open-review/hops must stay disabled for it. */
export function renderableFlowIds(flows: Flow[], placedPaths: ReadonlySet<string>): Set<string> {
  return new Set(
    flows.filter((flow) => (flow.state !== "closed" || flow.restored) && placedPaths.has(flow.implementerPath)).map((flow) => flow.id),
  );
}

/**
 * How a stage chip / "open transcript" reveals an attempt on the board. A
 * review-loop stage stores the reviewer transcript in `agentPath`;
 * foldClaimedReviewers then removes that transcript from the board and folds it
 * into the flow's round deck, so opening the raw path reveals nothing. Route
 * those to the embedded flow (deck + round focus); a plain run stage opens its
 * own node by path. `renderableFlows` disables the flow target for a
 * closed/missing flow, and `renderablePaths` disables the run target for a
 * transcript that has left the scanned file set, so every unreachable action is
 * disabled and none silently no-ops (AC4).
 */
export function stageOpenTarget(
  stage: PipelineStage,
  attempt: PipelineStageAttempt | null,
  renderableFlows?: ReadonlySet<string>,
  renderablePaths?: ReadonlySet<string>,
): { kind: "flow"; flowId: string } | { kind: "path"; path: string } | null {
  if (!attempt) return null;
  /* A review-loop stage's agentPath is always the reviewer transcript the board
     folds into the round deck, so never route to it — the flow (or nothing) is
     the only valid target. Only a run stage opens its own node by path. */
  if (stage.kind === "review-loop") {
    if (!attempt.flowId) return null;
    if (renderableFlows && !renderableFlows.has(attempt.flowId)) return null;
    return { kind: "flow", flowId: attempt.flowId };
  }
  if (!attempt.agentPath) return null;
  /* A run transcript that has vanished from the scan can't be revealed, so the
     chip/Open-transcript stays disabled and never no-ops on a missing file. */
  if (renderablePaths && !renderablePaths.has(attempt.agentPath)) return null;
  return { kind: "path", path: attempt.agentPath };
}

/** Resolve compact history after pipeline review decks leave the board. */
export function compactStageOpenTarget(
  stage: PipelineStage,
  attempt: PipelineStageAttempt | null,
  flows: readonly Flow[],
  renderableFlows?: ReadonlySet<string>,
  renderablePaths?: ReadonlySet<string>,
  files: readonly FileEntry[] = [],
): { kind: "flow"; flowId: string } | { kind: "path"; path: string } | null {
  const direct = stageOpenTarget(stage, attempt, renderableFlows, renderablePaths);
  if (direct || stage.kind !== "review-loop" || !attempt?.flowId) return direct;
  const flow = flows.find((candidate) => candidate.id === attempt.flowId);
  if (!flow) return null;
  for (const round of [...flow.rounds].reverse()) {
    const reviewerPath = [...reviewerBindingTargetsForRound(flow, round, files)]
      .reverse()
      .find(({ path }) => !renderablePaths || renderablePaths.has(path))
      ?.path;
    if (reviewerPath) return { kind: "path", path: reviewerPath };
  }
  if (!renderablePaths || renderablePaths.has(flow.implementerPath)) return { kind: "path", path: flow.implementerPath };
  return null;
}

/**
 * Does a stage attempt have something the verdict popover can show — a
 * structured verdict, an error, or a park on this stage (inline Retry/Skip)? A
 * plain running/spawning attempt has none, so its trigger stays disabled rather
 * than opening a misleading "no findings" sheet (shared desktop + mobile).
 */
export function stageHasEvidence(pipeline: Pipeline, stage: PipelineStage, attempt: PipelineStageAttempt | null): boolean {
  if (!attempt) return false;
  if (attempt.verdict || attempt.error) return true;
  return pipeline.state === "needs_decision" && pipeline.cursor?.stageId === stage.id;
}

/**
 * Active retries and review rounds still need a bounded history entry point
 * even before the current attempt produces a verdict. Only count transcript
 * paths the board can actually open, matching the actions rendered by
 * VerdictPopover.
 */
export function stageHasNavigableHistory(
  pipeline: Pipeline,
  stage: PipelineStage,
  attempt: PipelineStageAttempt | null,
  flows: readonly Flow[] = [],
  availablePaths?: ReadonlySet<string>,
  files: readonly FileEntry[] = [],
): boolean {
  if (!attempt) return false;
  const pathAvailable = (path: string) => !availablePaths || availablePaths.has(path);
  const attempts = stageAttempts(pipeline, stage.id);
  if (attempts.some((prior) => prior.n < attempt.n && Boolean(prior.agentPath && pathAvailable(prior.agentPath)))) return true;

  const flowIds = new Set(attempts.flatMap((item) => item.flowId ? [item.flowId] : []));
  const attemptPaths = new Set(attempts.flatMap((item) => item.agentPath ? [item.agentPath] : []));
  return flows.some((flow) => flowIds.has(flow.id) && flow.rounds.some((round) =>
    reviewerBindingTargetsForRound(flow, round, files).some(({ path }) =>
      !attemptPaths.has(path) && pathAvailable(path),
    ),
  ));
}

/** Mobile dock stages stay small only when every history entry point is empty. */
export function stageDockCompact(
  pipeline: Pipeline,
  stage: PipelineStage,
  attempt: PipelineStageAttempt | null,
  flows: readonly Flow[] = [],
  renderableFlows?: ReadonlySet<string>,
  renderablePaths?: ReadonlySet<string>,
  files: readonly FileEntry[] = [],
): boolean {
  return !stageHasEvidence(pipeline, stage, attempt)
    && !stageHasNavigableHistory(pipeline, stage, attempt, flows, renderablePaths, files)
    && compactStageOpenTarget(stage, attempt, flows, renderableFlows, renderablePaths, files) === null;
}

/** Localized label for a raw attempt state (the prior-attempt audit), so a
    verdict-less attempt never shows an English identifier in the uk UI. */
export function attemptStateLabel(t: TFunction, state: PipelineAttemptState): string {
  return t(`pipelineChipState.${state}`);
}

/** Short label a chip shows: the role's localized display name, or the stage id
    for raw role-less stages. */
export function stageChipLabel(t: TFunction, stage: PipelineStage): string {
  if (stage.role?.roleId) return roleNameById(t, stage.role.roleId);
  if (stage.kind === "review-loop") return t("pipelineStrip.reviewStage");
  return stage.id;
}

const CURSORLESS_LIVE_STATES: ReadonlySet<PipelineAttemptState> = new Set([
  "pending", "spawning", "running", "reviewing", "committing",
]);

/**
 * The 1-based array position of the stage a cursorless pipeline rests on (#353).
 * A live attempt (pending/spawning/running/reviewing/committing) marks the stage
 * the cursor held the moment it cleared, so a pipeline closed mid-flight keeps
 * that stage across pending, running, and every in-progress state. Once every
 * attempt has settled, the stage whose latest attempt completed most recently is
 * the terminal one — a completed jump/merge graph reports the stage it truly
 * ended on, and a pipeline closed on a failed, passed, or skipped stage keeps
 * that stage. Returns -1 when no attempt exists, so the caller keeps the n/n
 * fallback.
 */
function cursorlessStageIndex(pipeline: Pipeline): number {
  let liveIndex = -1;
  let settledIndex = -1;
  let settledAt = "";
  pipeline.stages.forEach((stage, candidateIndex) => {
    const attempt = latestAttempt(pipeline, stage.id);
    if (!attempt) return;
    if (CURSORLESS_LIVE_STATES.has(attempt.state)) liveIndex = candidateIndex;
    const stamp = attempt.completedAt ?? attempt.startedAt ?? "";
    if ((attempt.completedAt || attempt.startedAt) && (settledIndex === -1 || stamp >= settledAt)) {
      settledIndex = candidateIndex;
      settledAt = stamp;
    }
  });
  return liveIndex >= 0 ? liveIndex : settledIndex;
}

/**
 * The single source of the header "stage k/n" counter (#353): every consumer —
 * strip header, live-region announcement, dock, projection — reads this one
 * derivation so the counter stays consistent with the rendered members.
 * k is the 1-based cursor position; a completed or closed chain reads the
 * position of the stage it rests on, derived from its attempts.
 */
export function pipelineStagePosition(pipeline: Pipeline): { k: number; n: number } {
  const n = pipeline.stages.length;
  if (pipeline.cursor) {
    const index = pipeline.stages.findIndex((stage) => stage.id === pipeline.cursor!.stageId);
    return { k: index >= 0 ? index + 1 : n, n };
  }
  const restingIndex = cursorlessStageIndex(pipeline);
  return { k: restingIndex >= 0 ? restingIndex + 1 : n, n };
}

/** A spoken one-liner for a pipeline's current position — used by the board's
    live region so a state/cursor transition gets its own announcement alongside
    the spatial-nav messages. */
export function pipelineAnnouncement(t: TFunction, pipeline: Pipeline): string {
  const { k, n } = pipelineStagePosition(pipeline);
  const stage = pipeline.cursor ? pipeline.stages.find((candidate) => candidate.id === pipeline.cursor!.stageId) ?? null : null;
  const stageLabel = stage ? stageChipLabel(t, stage) : "";
  return t("pipelineStrip.announce", {
    task: pipeline.task,
    state: pipelineStateLabel(t, pipeline.state),
    stage: stageLabel,
    k,
    n,
  });
}

export const VERDICT_TONES: Record<StageVerdictStatus, { color: string; soft: string }> = {
  pass: { color: "var(--color-success)", soft: "var(--color-success-soft)" },
  fail: { color: "var(--color-danger)", soft: "var(--color-danger-soft)" },
  needs_decision: { color: "var(--color-warning)", soft: "var(--color-warning-soft)" },
};

export function verdictStatusLabel(t: TFunction, status: StageVerdictStatus): string {
  const key: MessageKey = status === "pass" ? "pipelineVerdict.pass" : status === "fail" ? "pipelineVerdict.fail" : "pipelineVerdict.needsDecision";
  return t(key);
}

/* ── Builder templates (§1.4) ───────────────────────────────────────────── */

/** A stage the builder edits before it becomes a {@link PipelineStageInput}. */
export type DraftStage = {
  key: string;
  kind: PipelineStageKind;
  roleId: string;
  engine: FlowEngine;
  model: string;
  effort: string;
  access: PipelineAccess;
  prompt: string;
  roleParams: Record<string, string | number>;
  /** The operator edited engine/model/effort by hand, so role/param autofill must
      no longer clobber the runtime. Selecting a role preserves the pin (design
      §1.3); selecting "No role" clears it back to the pipeline default. */
  runtimeOverridden?: boolean;
};

export type PipelineTemplate = {
  id: string;
  labelKey: MessageKey;
  stages: Array<Pick<DraftStage, "kind" | "roleId" | "access" | "prompt">>;
};

/** Client-side starters. They only seed rows; persisted templates are a later
    slice. Stage prompts are PURE wiring tokens (issue #221 §5): the role
    scaffold carries the instructions, the tokens only route the task text /
    previous stage's output in — so the builder can show the wiring as a
    plain-language caption and treat any extra text as the operator's own
    additional prompt. */
export const PIPELINE_TEMPLATES: readonly PipelineTemplate[] = [
  {
    id: "planBuildReview",
    labelKey: "pipelineTemplates.planBuildReview",
    stages: [
      { kind: "run", roleId: "architect", access: "read-only", prompt: "{{task}}" },
      { kind: "run", roleId: "builder", access: "read-write", prompt: "{{prev.output}}" },
      { kind: "review-loop", roleId: "reviewer", access: "read-only", prompt: "{{task}}" },
    ],
  },
  {
    id: "buildReview",
    labelKey: "pipelineTemplates.buildReview",
    stages: [
      { kind: "run", roleId: "builder", access: "read-write", prompt: "{{task}}" },
      { kind: "review-loop", roleId: "reviewer", access: "read-only", prompt: "{{task}}" },
    ],
  },
  {
    id: "buildVerify",
    labelKey: "pipelineTemplates.buildVerify",
    stages: [
      { kind: "run", roleId: "builder", access: "read-write", prompt: "{{task}}" },
      { kind: "run", roleId: "verifier", access: "read-only", prompt: "{{prev.output}}" },
    ],
  },
  {
    id: "blank",
    labelKey: "pipelineTemplates.blank",
    stages: [
      { kind: "run", roleId: "", access: "read-write", prompt: "{{task}}" },
      { kind: "run", roleId: "", access: "read-write", prompt: "{{prev.output}}" },
    ],
  },
];

/* ── Stage prompt wiring (issue #221 §5) ────────────────────────────────────
   The {{task}}/{{prev.output}} tokens are plumbing the operator never needs to
   see: the engine substitutes them (and ALWAYS appends the pinned task) when it
   renders the stage prompt. The builder therefore splits a stored prompt into
   its wiring (shown as a plain-language caption) and the operator's additional
   text (the only editable part), and reassembles on save. */

const WIRING_TOKEN_RE = /\{\{(?:task|prev\.output)\}\}/g;

/** Default wiring for a stage by chain position: the first stage receives the
    task, every later one the previous stage's output. */
export function defaultStageWiring(index: number): string {
  return index > 0 ? "{{prev.output}}" : "{{task}}";
}

/** The operator-authored part of a stage prompt: everything except the wiring
    tokens, whitespace-normalized. */
export function stagePromptExtra(prompt: string): string {
  return prompt
    .replace(WIRING_TOKEN_RE, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Does the stage's prompt route the previous stage's output in? (The pinned
    task is always appended by the engine, so it needs no probe.) */
export function stageReceivesPrevOutput(prompt: string): boolean {
  return prompt.includes("{{prev.output}}");
}

/** Reassemble a stage prompt from its current wiring tokens plus the edited
    additional text. Token order is preserved; a prompt that lost every token
    (legacy free text) falls back to the position default so the stage never
    loses its input. */
export function buildStagePrompt(currentPrompt: string, extra: string, index: number): string {
  const tokens = [...new Set(currentPrompt.match(WIRING_TOKEN_RE) ?? [])];
  const wiring = tokens.length ? tokens.join("\n") : defaultStageWiring(index);
  const text = extra.trim();
  return text ? `${wiring}\n\n${text}` : wiring;
}

/**
 * The linear-chain invariant the API enforces (a review-loop needs a preceding
 * run) is owned client-side: stage 1 can never be a review-loop. Any reorder or
 * deletion that floats one to the front demotes it back to a run — without this
 * a review-loop moved up would submit and 400. A run stage may keep read-only
 * access, so only the kind changes.
 */
export function normalizeStageOrder(stages: DraftStage[]): DraftStage[] {
  const first = stages[0];
  if (first && first.kind === "review-loop") {
    return stages.map((stage, index) => (index === 0 ? { ...stage, kind: "run" as const } : stage));
  }
  return stages;
}

/**
 * The linear-chain invariant the #189 API enforces: no review-loop may precede
 * the first run stage (a review loop reviews a preceding run). For a non-empty
 * plan this reduces to "stage 0 is a run"; an empty plan is trivially valid. The
 * canvas builder guards its reorder/remove/add-review controls with this so it
 * never fires a PATCH the server would 400 (issue #136).
 */
export function reviewLoopChainValid(kinds: readonly PipelineStageKind[]): boolean {
  const firstRun = kinds.indexOf("run");
  const firstReview = kinds.indexOf("review-loop");
  return firstReview === -1 || (firstRun !== -1 && firstRun < firstReview);
}

/** Slugs a role id / kind into a URL-safe stage id, deduped with numeric suffixes. */
export function deriveStageId(kind: PipelineStageKind, roleId: string, taken: Set<string>): string {
  const base =
    (roleId ? roleId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() : "") ||
    (kind === "review-loop" ? "review" : "stage");
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** Trims string params and drops the blank ones. Whitespace-only text would be
    rejected by the server's boundedText, so it is normalized to absent here
    (resolving to the registry default), keeping client and API in agreement. */
function sanitizeRoleParams(params: Record<string, string | number>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) out[key] = trimmed;
    } else if (value !== undefined && value !== null) {
      out[key] = value;
    }
  }
  return out;
}

/** Folds the builder's draft stages into the ordered, id/next-derived POST body.
    Runtime fields (engine/model/effort) are the operator's only when
    `runtimeOverridden` is set; otherwise they are catalog autofill for display,
    so they are omitted and the server resolves the current role/Builder defaults.
    Emitting them would freeze stale values across registry changes and can pair a
    stale engine with a fresh default model into a 400. */
export function draftStagesToInput(drafts: DraftStage[]): PipelineStageInput[] {
  const taken = new Set<string>();
  const ids = drafts.map((draft) => deriveStageId(draft.kind, draft.roleId, taken));
  return drafts.map((draft, index) => {
    const params = sanitizeRoleParams(draft.roleParams);
    return {
      id: ids[index]!,
      kind: draft.kind,
      ...(draft.roleId
        ? { role: { roleId: draft.roleId as PipelineRoleId, ...(Object.keys(params).length ? { params } : {}) } }
        : {}),
      ...(draft.runtimeOverridden
        ? {
            engine: draft.engine,
            ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
            ...(draft.effort ? { effort: draft.effort } : {}),
          }
        : {}),
      ...(draft.kind === "review-loop" ? {} : { access: draft.access }),
      prompt: draft.prompt,
      next: ids[index + 1] ?? null,
    };
  });
}

export type PipelineClientResult = {
  pipeline?: Pipeline;
  error?: string;
  code?: PipelineRepoPreflightErrorCode;
  field?: "repoDir";
  path?: string;
};

export type PipelinePreflightClientResult = PipelineRepoPreflight & { error?: string };

export async function preflightPipelineRepository(
  repoDir: string,
  signal?: AbortSignal,
): Promise<PipelinePreflightClientResult> {
  try {
    const response = await fetch("/api/pipelines/preflight", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoDir }),
      signal,
    });
    const json = (await response.json().catch(() => null)) as (PipelineRepoPreflight & { error?: string }) | null;
    if (response.ok && json?.ok) return json;
    if (json && !json.ok && json.code) return { ok: false, code: json.code, path: json.path };
    return { ok: false, code: "missing", path: repoDir, error: translate(getLocale(), "pipelineModel.failed", { status: response.status }) };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { ok: false, code: "missing", path: repoDir, error: translate(getLocale(), "common.serverUnavailable") };
  }
}

export async function createPipeline(req: CreatePipelineRequest): Promise<PipelineClientResult> {
  try {
    const response = await fetch("/api/pipelines", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    const json = (await response.json().catch(() => null)) as PipelineClientResult | null;
    if (response.ok && json?.pipeline) {
      /* The POST echo IS the new record — apply it straight into the client
         cache so the draft's builder appears immediately (issue #221 §3). An
         auto-started pipeline also spawns agents, so only that path still pays
         the full board refetch. */
      applyPipelineSnapshot(json.pipeline, true);
      if (req.autoStart !== false) window.dispatchEvent(new Event(PIPELINES_CHANGED_EVENT));
      return { pipeline: json.pipeline };
    }
    return {
      error: json?.error ?? translate(getLocale(), "pipelineModel.failed", { status: response.status }),
      ...(json?.code ? { code: json.code, field: json.field, path: json.path } : {}),
    };
  } catch {
    return { error: translate(getLocale(), "common.serverUnavailable") };
  }
}

/**
 * Folds a client-side template straight into POST-able stage inputs (issue #196
 * template-first flow). Runtime fields are left to the server (no
 * `runtimeOverridden`), so each role resolves its current registry defaults —
 * the same rule the builder's own submit follows.
 */
export function templateStageInputs(template: PipelineTemplate): PipelineStageInput[] {
  return draftStagesToInput(
    template.stages.map((stage, index) => ({
      key: `tpl-${index}`,
      kind: stage.kind,
      roleId: stage.roleId,
      engine: "claude" as FlowEngine,
      model: "",
      effort: "",
      access: stage.access,
      prompt: stage.prompt,
      roleParams: {},
    })),
  );
}

/** The default action every fresh draft carries (#353): one implement
    conversation wired to the task, so no empty shell ever reaches the board. */
export function defaultDraftStageInputs(): PipelineStageInput[] {
  return [{ id: "implement", kind: "run", role: { roleId: "builder" }, prompt: "{{task}}", next: null }];
}

/**
 * Creates a draft pipeline from a repository that passed the picker preflight,
 * then POSTs `autoStart:false`. A template carries the full role chain from the
 * first render; without one the draft seeds the default implement conversation
 * (#353 — every pipeline contains at least one default action). The 1-stage
 * floor is enforced at Start.
 */
export async function createDraftPipeline(
  _project: string,
  repoPrefill?: string,
  template?: PipelineTemplate,
  /** Source transcript wired as stage 0's lineage (the node `⇢ pipeline` entry);
      its cwd also wins the repo resolution, like a handoff draft's does. */
  src?: string,
): Promise<PipelineClientResult> {
  const repoDir = (repoPrefill ?? "").trim();
  if (!repoDir) return { error: translate(getLocale(), "common.serverUnavailable") };
  return createPipeline({
    task: translate(getLocale(), "pipelineBuilder.untitledTask"),
    repoDir,
    stages: template ? templateStageInputs(template) : defaultDraftStageInputs(),
    ...(src ? { src } : {}),
    autoStart: false,
  });
}

/**
 * Does a stage already have a live board surface? A run stage is present once
 * its latest attempt's transcript is a placed node; a review-loop is present
 * once its flow has a placed round deck (the reviewer transcript itself is
 * folded into the deck, so `agentPath` is never the right probe there).
 */
export function stageHasBoardPresence(
  pipeline: Pipeline,
  stage: PipelineStage,
  placedPaths: ReadonlySet<string>,
  placedFlowIds: ReadonlySet<string>,
): boolean {
  const attempt = latestAttempt(pipeline, stage.id);
  if (!attempt) return false;
  if (stage.kind === "review-loop") return Boolean(attempt.flowId && placedFlowIds.has(attempt.flowId));
  return Boolean(attempt.agentPath && placedPaths.has(attempt.agentPath));
}

export type PipelineStagePresentation = "materialized" | "evidence" | "queued" | "waiting";

const EVIDENCE_ATTEMPT_STATES = new Set(["passed", "failed", "needs_decision", "skipped"]);

export function pipelineStagePresentation(
  pipeline: Pipeline,
  stage: PipelineStage,
  placedPaths: ReadonlySet<string>,
  placedFlowIds: ReadonlySet<string>,
): PipelineStagePresentation {
  if (stageHasBoardPresence(pipeline, stage, placedPaths, placedFlowIds)) return "materialized";
  const attempts = stageAttempts(pipeline, stage.id);
  if (attempts.some((attempt) => EVIDENCE_ATTEMPT_STATES.has(attempt.state))) return "evidence";
  if (pipeline.cursor?.stageId === stage.id && pipelineCursorActive(pipeline)) return "queued";
  return "waiting";
}

/* ── Board projection (#353): one derivation for every truthful surface ──── */

export type PipelineBoardEdge = {
  from: string;
  to: string;
  kind: PipelineEdgeKind;
  /** Fail edges: rounds already traversed / budget, derived from durable
      activation records (never a stored counter). */
  usedRounds?: number;
  maxRounds?: number;
  /** The edge the engine will traverse next (the active cursor stage's pass
      edge) — drives the "which edge runs next" highlight. */
  isNext: boolean;
};

export type PipelineBoardMember = {
  stageId: string;
  /** Materialized attempts of this stage (0 = placeholder-only). */
  attempts: number;
  presentation: PipelineStagePresentation;
};

export type PipelineBoardProjection = {
  id: string;
  /** Header counter — identical to the strip/dock/announcement k/n. */
  position: { k: number; n: number };
  members: PipelineBoardMember[];
  edges: PipelineBoardEdge[];
  /** Total materialized attempts across all stages; the invariant gate asserts
      members' attempt sum equals this. */
  materializedAttempts: number;
  /** Every transcript path this pipeline's group claims (lineage). */
  lineagePaths: Set<string>;
  /** Zero-stage shells stay outside every board surface (#353). */
  onBoard: boolean;
};

/** Rounds a stage's fail edge has already traversed, derived from the durable
    activation records on the target stage's attempts. */
export function stageFailEdgeRoundsUsed(pipeline: Pipeline, stage: PipelineStage): number {
  if (!stage.onFail) return 0;
  const target = pipeline.runs.find((run) => run.stageId === stage.onFail!.to);
  if (!target) return 0;
  return target.attempts.filter((attempt) => attempt.activatedBy?.edge === "fail" && attempt.activatedBy.stageId === stage.id).length;
}

/**
 * Is a stage's fail edge frozen evidence (#353)? A fail edge freezes the instant
 * its verdict routes the cursor along it, while the target attempt is still
 * forming, so the edit control mirrors the API's guard by reading the in-flight
 * cursor activation. That keeps the picker disabled the moment the edge freezes,
 * matching the server the edit would reach.
 */
export function stageFailEdgeFrozen(pipeline: Pipeline, stage: PipelineStage): boolean {
  if (pipeline.cursor?.activatedBy?.edge === "fail" && pipeline.cursor.activatedBy.stageId === stage.id) return true;
  return stageFailEdgeRoundsUsed(pipeline, stage) > 0;
}

/** Verdict-keyed edge list of the conversation graph, with the predicted next
    edge marked (the active cursor stage's pass edge). */
export function pipelineBoardEdges(pipeline: Pipeline): PipelineBoardEdge[] {
  const cursorActive = pipelineCursorActive(pipeline);
  const edges: PipelineBoardEdge[] = [];
  for (const stage of pipeline.stages) {
    if (stage.next) {
      edges.push({
        from: stage.id,
        to: stage.next,
        kind: "pass",
        isNext: cursorActive && pipeline.cursor?.stageId === stage.id,
      });
    }
    if (stage.onFail) {
      edges.push({
        from: stage.id,
        to: stage.onFail.to,
        kind: "fail",
        usedRounds: stageFailEdgeRoundsUsed(pipeline, stage),
        maxRounds: stage.onFail.maxRounds,
        isNext: false,
      });
    }
  }
  return edges;
}

/**
 * The single derivation source for the board's pipeline surfaces (#353, the
 * reopened release gate): header counts, member list, edge list, and claimed
 * lineage all come from here, so the strip header, halo membership, dock, and
 * connector layers cannot disagree with one another.
 */
export function pipelineBoardProjection(
  pipeline: Pipeline,
  flows: readonly Flow[] = [],
  files: readonly FileEntry[] = [],
  placedPaths: ReadonlySet<string> = new Set(),
  placedFlowIds: ReadonlySet<string> = new Set(),
): PipelineBoardProjection {
  const members = pipeline.stages.map((stage) => ({
    stageId: stage.id,
    attempts: stageAttempts(pipeline, stage.id).length,
    presentation: pipelineStagePresentation(pipeline, stage, placedPaths, placedFlowIds),
  }));
  return {
    id: pipeline.id,
    position: pipelineStagePosition(pipeline),
    members,
    edges: pipelineBoardEdges(pipeline),
    materializedAttempts: pipeline.runs.reduce((sum, run) => sum + run.attempts.length, 0),
    lineagePaths: pipelineLineage(pipeline, flows, files).paths,
    onBoard: pipeline.stages.length > 0 && (pipeline.state !== "closed" || Boolean(pipeline.restored)),
  };
}

export function partitionPipelineSurfaces(
  pipelines: readonly Pipeline[],
  memberfulGroupIds: ReadonlySet<string>,
): { memberful: Pipeline[]; shelf: Pipeline[] } {
  const memberful: Pipeline[] = [];
  const shelf: Pipeline[] = [];
  for (const pipeline of pipelines) {
    if (pipeline.state === "closed" && !pipeline.restored) continue;
    if (memberfulGroupIds.has(pipeline.id)) memberful.push(pipeline);
    else shelf.push(pipeline);
  }
  return { memberful, shelf };
}

/** Actions whose side effects reach past the pipeline record (spawned/killed
    agents, closed flows, freed panes) — only these still trigger the full
    /api/files refetch. Draft-shape edits ride the PATCH echo alone. */
const PIPELINE_REFRESH_ACTIONS: ReadonlySet<PipelineAction> = new Set([
  "start",
  "retry-stage",
  "skip-stage",
  "resume",
  "pause",
  "close",
]);

/** Neutral resolution a not-yet-echoed optimistic stage renders with; the PATCH
    echo replaces it (typically within one frame's worth of round-trip). */
const OPTIMISTIC_EFFECTIVE_ROLE: Omit<EffectivePipelineRole, "access"> = {
  roleId: null,
  engine: "claude",
  model: "",
  effort: "",
  promptScaffold: null,
};

/** Clears a dangling pass edge (target gone or self-referential) and a fail edge
    whose target left the plan, matching the safety net the server applies
    (replaceDraftStages). Every intentional edge is preserved, so a local insert
    or removal keeps a custom jump/merge or fail loop as authored (#353). */
function pruneStageEdges(stages: PipelineStage[]): PipelineStage[] {
  const keptIds = new Set(stages.map((stage) => stage.id));
  return stages.map((stage) => ({
    ...stage,
    next: stage.next != null && stage.next !== stage.id && keptIds.has(stage.next) ? stage.next : null,
    onFail: stage.onFail && keptIds.has(stage.onFail.to) ? stage.onFail : null,
  }));
}

/** The pipeline as it will look once `add-stage` persists — applied locally
    before the PATCH so the new placeholder window appears instantly (§3). The
    new stage is spliced into its own seam only (predecessor → new → predecessor's
    old target); every other stage's intentional edge is preserved, mirroring the
    server (#353). */
export function optimisticAddStage(pipeline: Pipeline, input: PipelineStageInput, index: number): Pipeline {
  const stages = [...pipeline.stages];
  const at = Math.max(0, Math.min(index, stages.length));
  const predecessor = at > 0 ? stages[at - 1]! : null;
  const stage: PipelineStage = {
    ...input,
    next: predecessor ? predecessor.next ?? null : stages[at]?.id ?? null,
    effectiveRole: {
      ...OPTIMISTIC_EFFECTIVE_ROLE,
      roleId: input.role?.roleId ?? null,
      ...(input.engine ? { engine: input.engine } : {}),
      access: input.access ?? (input.kind === "review-loop" ? "read-only" : "read-write"),
    },
  };
  if (predecessor) stages[at - 1] = { ...predecessor, next: stage.id };
  stages.splice(at, 0, stage);
  return { ...pipeline, stages: pruneStageEdges(stages) };
}

/** The pipeline as it will look once `remove-stage` persists. Predecessors that
    pointed at the removed stage bypass to its pass target (the chain stays
    connected); fail edges to it park. Every other edge is preserved (#353). */
export function optimisticRemoveStage(pipeline: Pipeline, stageId: string): Pipeline {
  const removed = pipeline.stages.find((stage) => stage.id === stageId);
  const bypass = removed?.next && removed.next !== removed.id ? removed.next : null;
  const stages = pipeline.stages
    .filter((stage) => stage.id !== stageId)
    .map((stage) => ({
      ...stage,
      next: stage.next === stageId ? bypass : stage.next,
      onFail: stage.onFail?.to === stageId ? null : stage.onFail,
    }));
  return { ...pipeline, stages: pruneStageEdges(stages) };
}

/** The pipeline as it will look once `set-edge` persists (#353). */
export function optimisticSetEdge(
  pipeline: Pipeline,
  stageId: string,
  edge: PipelineEdgeKind,
  to: string | null,
  maxRounds?: number,
): Pipeline {
  return {
    ...pipeline,
    stages: pipeline.stages.map((stage) => {
      if (stage.id !== stageId) return stage;
      if (edge === "pass") return { ...stage, next: to };
      return { ...stage, onFail: to === null ? null : { to, maxRounds: maxRounds ?? 5 } };
    }),
  };
}

/** Issues a `set-edge` PATCH with the optimistic echo applied (#353). */
export async function setPipelineEdge(
  pipeline: Pipeline,
  stageId: string,
  edge: PipelineEdgeKind,
  to: string | null,
  maxRounds?: number,
): Promise<string | null> {
  return patchPipeline(
    pipeline.id,
    "set-edge",
    { stageId, edge, to, ...(maxRounds !== undefined ? { maxRounds } : {}) },
    optimisticSetEdge(pipeline, stageId, edge, to, maxRounds),
  );
}

export async function patchPipeline(
  id: string,
  action: PipelineAction,
  extra?: Omit<PatchPipelineRequest, "action">,
  /** Locally predicted post-PATCH pipeline: applied to the client cache BEFORE
      the request so the mutation is perceived instantly, confirmed by the echo,
      rolled back on failure (issue #221 §3). */
  optimistic?: Pipeline,
): Promise<string | null> {
  if (optimistic) applyPipelineSnapshot(optimistic, false);
  try {
    const response = await fetch(`/api/pipelines/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    });
    const json = (await response.json().catch(() => null)) as { pipeline?: Pipeline; error?: string } | null;
    if (response.ok) {
      /* The PATCH echo is the authoritative post-mutation record: applying it
         updates every mounted board surface without a scan refetch. */
      if (json?.pipeline) applyPipelineSnapshot(json.pipeline, true);
      else if (optimistic) revertPipelineSnapshot(id);
      if (PIPELINE_REFRESH_ACTIONS.has(action)) window.dispatchEvent(new Event(PIPELINES_CHANGED_EVENT));
      return null;
    }
    if (optimistic) revertPipelineSnapshot(id);
    return json?.error ?? translate(getLocale(), "pipelineModel.failed", { status: response.status });
  } catch {
    if (optimistic) revertPipelineSnapshot(id);
    return translate(getLocale(), "common.serverUnavailable");
  }
}
