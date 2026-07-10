import { getLocale, translate, type MessageKey, type TFunction } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { FlowEngine } from "@/lib/flows/types";
import type {
  CreatePipelineRequest,
  Pipeline,
  PipelineAccess,
  PipelineAction,
  PipelineStage,
  PipelineStageAttempt,
  PipelineRoleId,
  PipelineStageInput,
  PipelineStageKind,
  PipelineState,
  StageVerdictStatus,
} from "@/lib/pipelines/types";

export const PIPELINES_CHANGED_EVENT = "llv:pipelines-changed";

/** Stable DOM id for a pipeline's dashboard strip, so the on-board hub can
    reveal the always-available detailed surface (#93 §2.2). */
export function pipelineStripDomId(pipelineId: string): string {
  return `pipeline-strip-${pipelineId}`;
}

export function pipelinesForProject(pipelines: Pipeline[], project: string, files: FileEntry[]): Pipeline[] {
  const paths = new Set(files.filter((file) => file.project === project).map((file) => file.path));
  return pipelines.filter((pipeline) => {
    if (pipeline.state === "closed") return false;
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
  pending: { color: "#8b8b95", soft: "#efeff3" },
  running: { color: "#5a51e0", soft: "#ecebfb" },
  reviewing: { color: "#5a51e0", soft: "#ecebfb" },
  committing: { color: "#5a51e0", soft: "#ecebfb" },
  passed: { color: "#1a8a3e", soft: "#e7f4ea" },
  failed: { color: "#c62828", soft: "#fbeaea" },
  needs_decision: { color: "#e0ae45", soft: "#faf0da" },
  skipped: { color: "#8b8b95", soft: "#efeff3" },
};

/** The glyph paired with every state so color is never the sole signal (a11y). */
export const STAGE_GLYPH: Record<StageChipState, string> = {
  pending: "",
  running: "▸",
  reviewing: "⟳",
  committing: "▸",
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

/** Short label a chip shows: the role's registry id, or the stage id for raw stages. */
export function stageChipLabel(t: TFunction, stage: PipelineStage): string {
  if (stage.role?.roleId) return stage.role.roleId;
  if (stage.kind === "review-loop") return t("pipelineStrip.reviewStage");
  return stage.id;
}

/** A spoken one-liner for a pipeline's current position — used by the board's
    live region so a state/cursor transition is announced, not just spatial nav. */
export function pipelineAnnouncement(t: TFunction, pipeline: Pipeline): string {
  const total = pipeline.stages.length;
  const cursorStageId = pipeline.cursor?.stageId ?? null;
  const index = cursorStageId ? pipeline.stages.findIndex((stage) => stage.id === cursorStageId) : -1;
  const stage = index >= 0 ? pipeline.stages[index]! : null;
  const stageLabel = stage ? stageChipLabel(t, stage) : "";
  return t("pipelineStrip.announce", {
    task: pipeline.task,
    state: pipelineStateLabel(t, pipeline.state),
    stage: stageLabel,
    k: index >= 0 ? index + 1 : total,
    n: total,
  });
}

export const VERDICT_TONES: Record<StageVerdictStatus, { color: string; soft: string }> = {
  pass: { color: "#1a8a3e", soft: "#e7f4ea" },
  fail: { color: "#c62828", soft: "#fbeaea" },
  needs_decision: { color: "#e0ae45", soft: "#faf0da" },
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
};

export type PipelineTemplate = {
  id: string;
  labelKey: MessageKey;
  stages: Array<Pick<DraftStage, "kind" | "roleId" | "access" | "prompt">>;
};

/** Client-side starters. They only seed rows; persisted templates are a later slice. */
export const PIPELINE_TEMPLATES: readonly PipelineTemplate[] = [
  {
    id: "planBuildReview",
    labelKey: "pipelineDialog.templates.planBuildReview",
    stages: [
      { kind: "run", roleId: "architect", access: "read-only", prompt: "Plan {{task}}" },
      { kind: "run", roleId: "builder", access: "read-write", prompt: "{{prev.output}}" },
      { kind: "review-loop", roleId: "reviewer", access: "read-only", prompt: "Review the implementation against {{task}}." },
    ],
  },
  {
    id: "buildReview",
    labelKey: "pipelineDialog.templates.buildReview",
    stages: [
      { kind: "run", roleId: "builder", access: "read-write", prompt: "{{task}}" },
      { kind: "review-loop", roleId: "reviewer", access: "read-only", prompt: "Review the implementation against {{task}}." },
    ],
  },
  {
    id: "buildVerify",
    labelKey: "pipelineDialog.templates.buildVerify",
    stages: [
      { kind: "run", roleId: "builder", access: "read-write", prompt: "{{task}}" },
      { kind: "run", roleId: "verifier", access: "read-only", prompt: "Verify {{prev.output}} satisfies {{task}}." },
    ],
  },
  {
    id: "blank",
    labelKey: "pipelineDialog.templates.blank",
    stages: [
      { kind: "run", roleId: "", access: "read-write", prompt: "" },
      { kind: "run", roleId: "", access: "read-write", prompt: "" },
    ],
  },
];

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

/** Any parameter with a non-empty value is worth sending; blanks fall back to
    the role's registry default server-side, so an all-blank map is omitted. */
function hasParams(params: Record<string, string | number>): boolean {
  return Object.values(params).some((value) => value !== "" && value !== undefined && value !== null);
}

/** Folds the builder's draft stages into the ordered, id/next-derived POST body. */
export function draftStagesToInput(drafts: DraftStage[]): PipelineStageInput[] {
  const taken = new Set<string>();
  const ids = drafts.map((draft) => deriveStageId(draft.kind, draft.roleId, taken));
  return drafts.map((draft, index) => ({
    id: ids[index]!,
    kind: draft.kind,
    ...(draft.roleId
      ? { role: { roleId: draft.roleId as PipelineRoleId, ...(hasParams(draft.roleParams) ? { params: draft.roleParams } : {}) } }
      : {}),
    engine: draft.engine,
    ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
    ...(draft.effort ? { effort: draft.effort } : {}),
    ...(draft.kind === "review-loop" ? {} : { access: draft.access }),
    prompt: draft.prompt,
    next: ids[index + 1] ?? null,
  }));
}

export async function createPipeline(req: CreatePipelineRequest): Promise<{ pipeline?: Pipeline; error?: string }> {
  try {
    const response = await fetch("/api/pipelines", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    const json = (await response.json().catch(() => null)) as { pipeline?: Pipeline; error?: string } | null;
    if (response.ok && json?.pipeline) {
      window.dispatchEvent(new Event(PIPELINES_CHANGED_EVENT));
      return { pipeline: json.pipeline };
    }
    return { error: json?.error ?? translate(getLocale(), "pipelineModel.failed", { status: response.status }) };
  } catch {
    return { error: translate(getLocale(), "common.serverUnavailable") };
  }
}

export async function patchPipeline(id: string, action: PipelineAction): Promise<string | null> {
  try {
    const response = await fetch(`/api/pipelines/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (response.ok) {
      window.dispatchEvent(new Event(PIPELINES_CHANGED_EVENT));
      return null;
    }
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    return json?.error ?? translate(getLocale(), "pipelineModel.failed", { status: response.status });
  } catch {
    return translate(getLocale(), "common.serverUnavailable");
  }
}
