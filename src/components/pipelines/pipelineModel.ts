import { getLocale, translate, type MessageKey, type TFunction } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { Flow, FlowEngine } from "@/lib/flows/types";
import { PIPELINE_DISALLOWED_ROLE_IDS } from "@/lib/pipelines/types";
import type {
  CreatePipelineRequest,
  Pipeline,
  PipelineAccess,
  PipelineAction,
  PipelineAttemptState,
  PipelineStage,
  PipelineStageAttempt,
  PipelineRoleId,
  PipelineStageInput,
  PipelineStageKind,
  PipelineState,
  PatchPipelineRequest,
  StageVerdictStatus,
} from "@/lib/pipelines/types";

export const PIPELINES_CHANGED_EVENT = "llv:pipelines-changed";

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
 * Prompt is always sent (it is required and the primary edit).
 */
export function stageOverrideBody(stage: PipelineStage, form: StageOverrideForm): Omit<PatchPipelineRequest, "action"> {
  const body: Omit<PatchPipelineRequest, "action"> = { stageId: stage.id, prompt: form.prompt.trim() };
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
    flows.filter((flow) => flow.state !== "closed" && placedPaths.has(flow.implementerPath)).map((flow) => flow.id),
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

/** Localized label for a raw attempt state (the prior-attempt audit), so a
    verdict-less attempt never shows an English identifier in the uk UI. */
export function attemptStateLabel(t: TFunction, state: PipelineAttemptState): string {
  return t(`pipelineChipState.${state}`);
}

/** Short label a chip shows: the role's registry id, or the stage id for raw stages. */
export function stageChipLabel(t: TFunction, stage: PipelineStage): string {
  if (stage.role?.roleId) return stage.role.roleId;
  if (stage.kind === "review-loop") return t("pipelineStrip.reviewStage");
  return stage.id;
}

/** A spoken one-liner for a pipeline's current position — used by the board's
    live region so a state/cursor transition gets its own announcement alongside
    the spatial-nav messages. */
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

/**
 * Creates an EMPTY draft pipeline straight on the canvas (#136), with no form: it
 * resolves the project's repo directory from the spawn endpoint (the same source
 * the dialog seeds from), then POSTs `autoStart:false` with **zero** stages. The
 * draft renders as a scheme group the operator assembles visually (add stage cards,
 * drag to reorder, edit role/model/effort/prompt) and Starts once it has ≥2 stages.
 * Runs entirely on the #189 draft machinery — no second data path.
 */
export async function createDraftPipeline(
  project: string,
  repoPrefill?: string,
): Promise<{ pipeline?: Pipeline; error?: string }> {
  let repoDir = (repoPrefill ?? "").trim();
  if (!repoDir) {
    try {
      const res = await fetch("/api/spawn?project=" + encodeURIComponent(project));
      const json = (await res.json().catch(() => null)) as { dirs?: string[]; cwd?: string | null } | null;
      repoDir = (typeof json?.cwd === "string" ? json.cwd : "") || json?.dirs?.[0] || "";
    } catch {
      /* fall through to the empty-repo error below */
    }
  }
  if (!repoDir) return { error: translate(getLocale(), "common.serverUnavailable") };
  return createPipeline({
    task: translate(getLocale(), "pipelineBuilder.untitledTask"),
    repoDir,
    stages: [],
    autoStart: false,
  });
}

export async function patchPipeline(
  id: string,
  action: PipelineAction,
  extra?: Omit<PatchPipelineRequest, "action">,
): Promise<string | null> {
  try {
    const response = await fetch(`/api/pipelines/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
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
