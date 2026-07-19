import type { FlowEngine, RoleConfig } from "@/lib/flows/types";

export type PipelineAccess = "read-only" | "read-write";

export type PipelineRepoPreflightErrorCode =
  | "missing"
  | "not_directory"
  | "repo_unreadable"
  | "repo_untraversable"
  | "not_git"
  | "git_metadata_unwritable"
  | "worktree_parent_unwritable";

export type PipelineRepoPreflight =
  | { ok: true; repoDir: string; gitCommonDir: string; worktreeParent: string }
  | { ok: false; code: PipelineRepoPreflightErrorCode; path: string };

export type PipelineRoleId =
  | "orchestrator"
  | "reviewer"
  | "verifier"
  | "builder"
  | "architect"
  | "cleaner"
  | "prod-auditor"
  | "deployer";

/**
 * Roles a pipeline stage may not use. Deployer demands an explicit
 * `confirm: "deploy"` gate (resolveSpawnRole / DraftAgentPane) that a pipeline —
 * which spawns its stages automatically, without a per-stage confirmation — has
 * no way to honor, so it is excluded from the builder and rejected by the API.
 */
export const PIPELINE_DISALLOWED_ROLE_IDS: readonly PipelineRoleId[] = ["deployer"];

/** Durable reference to the shared role registry introduced by issue #35. */
export type PipelineRoleRef = {
  roleId: PipelineRoleId;
  /** Typed parameter values the operator chose; substituted into the role's
      prompt scaffold at create time (falling back to registry defaults). */
  params?: Record<string, string | number>;
};

export type EffectivePipelineRole = RoleConfig & {
  roleId: PipelineRoleId | null;
  access: PipelineAccess;
  promptScaffold: string | null;
};

export type PipelineStageKind = "run" | "review-loop";

export type PipelineEdgeKind = "pass" | "fail";

/** Verdict-keyed fail successor (#353): where a `fail` verdict routes next, and
    how many times this edge may fire before the pipeline parks for the
    operator. Cycles live exclusively on fail edges; the pass graph stays
    acyclic so every pass path terminates. */
export type PipelineFailEdge = { to: string; maxRounds: number };

export type PipelineStageInput = {
  id: string;
  kind: PipelineStageKind;
  role?: PipelineRoleRef;
  engine?: FlowEngine;
  model?: string | null;
  effort?: string | null;
  access?: PipelineAccess;
  prompt: string;
  /** Pass edge: the stage activated when this one passes. Schema v3 allows any
      stage id (direct links, merges), constrained to an acyclic pass graph. */
  next: string | null;
  /** Fail edge; absent/null parks a failed stage for the operator as before. */
  onFail?: PipelineFailEdge | null;
};

export type PipelineStage = PipelineStageInput & {
  /** Immutable registry resolution captured when the pipeline is created. */
  effectiveRole: EffectivePipelineRole;
};

export type StageVerdictStatus = "pass" | "fail" | "needs_decision";

export type StageVerdict = {
  status: StageVerdictStatus;
  findings?: string[];
  confidence?: number;
};

export type PipelineAttemptState =
  | "pending"
  | "spawning"
  | "running"
  | "reviewing"
  | "committing"
  | "passed"
  | "failed"
  | "needs_decision"
  | "skipped";

/** Durable provenance for a cursor activation / attempt: which stage's attempt
    advanced here, along which verdict edge. Loop budgets are derived from these
    records (never a separate counter), so counts cannot drift from evidence. */
export type PipelineEdgeActivation = { stageId: string; attempt: number; edge: PipelineEdgeKind };

export type PipelineStageAttempt = {
  n: number;
  state: PipelineAttemptState;
  effectiveRole: EffectivePipelineRole;
  launchId: string | null;
  conversationId: string | null;
  sessionId: string | null;
  agentPath: string | null;
  paneId: string | null;
  flowId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Exactly-once relay (#353): the `{{prev.output}}` payload persisted when the
      cursor advanced here. Null on pre-v3 attempts, which fall back to the
      legacy positional scan. */
  input: string | null;
  activatedBy: PipelineEdgeActivation | null;
  output: string | null;
  verdict: StageVerdict | null;
  error: string | null;
};

export type PipelineStageRun = {
  stageId: string;
  attempts: PipelineStageAttempt[];
};

export type PipelineCursorState = "pending" | "spawning" | "running" | "reviewing" | "committing";

export type PipelineState = "draft" | "provisioning" | "running" | "needs_decision" | "paused" | "completed" | "closed";

export type Pipeline = {
  id: string;
  task: string;
  /** Pinned specification and acceptance criteria, matching Flow.spec from #85. */
  spec?: string;
  project: string;
  repoDir: string;
  worktreeDir: string;
  branch: string;
  baseBranch: string;
  baseRef: string;
  lastPassedCommit: string;
  stages: PipelineStage[];
  runs: PipelineStageRun[];
  /** The cursor carries the durable relay record (#353): the forwarded input and
      the activating edge are persisted in the same atomic write as the verdict
      that advanced here, so a crash between advance and spawn replays the
      identical prompt. */
  cursor: { stageId: string; state: PipelineCursorState; input: string | null; activatedBy: PipelineEdgeActivation | null } | null;
  state: PipelineState;
  pausedState: Exclude<PipelineState, "paused" | "draft"> | null;
  stateDetail: string | null;
  srcPath: string | null;
  srcConversationId: string | null;
  createdAt: string;
  closedAt: string | null;
  hiddenAt?: string | null;
  /** Read-model marker set when a hidden container is projected for a pinned member. */
  restored?: boolean;
};

export type CreatePipelineRequest = {
  task: string;
  spec?: string;
  repoDir: string;
  /** Merge target branch; defaults to main when the pipeline starts. */
  baseBranch?: string;
  /** Explicit git commit-ish to pin; defaults to the fetched origin branch. */
  baseRef?: string;
  stages: PipelineStageInput[];
  src?: string;
  autoStart?: boolean;
};

export type PipelineAction =
  | "start"
  | "update-draft"
  | "add-stage"
  | "remove-stage"
  | "reorder-stage"
  | "set-edge"
  | "pause"
  | "resume"
  | "retry-stage"
  | "skip-stage"
  | "override-stage"
  | "delete"
  | "close";

export type PatchPipelineRequest = {
  action: PipelineAction;
  /** for override-stage: the not-yet-started stage to re-configure (issue #118
      on-canvas stage controls). Only fields present are changed; a stage that
      already ran an attempt is rejected so the override always targets the future.
      `role` swaps the canonical role (resolved through the registry like create,
      with the same param + disallowed-role validation); `null` clears it back to
      the Builder default. Changing the role resets any unpinned engine/model/
      effort to the new role's defaults; an explicit engine/model/effort still wins. */
  stageId?: string;
  role?: PipelineRoleRef | null;
  engine?: FlowEngine;
  model?: string | null;
  effort?: string | null;
  prompt?: string;
  task?: string;
  spec?: string;
  repoDir?: string;
  stage?: PipelineStageInput;
  index?: number;
  stageIds?: string[];
  toIndex?: number;
  /** for set-edge (#353): rewires `stageId`'s pass or fail edge. `to: null`
      clears it (a cleared pass edge makes the stage terminal). A stage that has
      already run keeps its pass edge frozen (history names its successor); a
      fail edge freezes once traversed. `maxRounds` bounds fail-edge cycles. */
  edge?: PipelineEdgeKind;
  to?: string | null;
  maxRounds?: number;
};

export type PipelinesResponse = {
  pipelines: Pipeline[];
};
