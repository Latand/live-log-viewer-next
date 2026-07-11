import type { FlowEngine, RoleConfig } from "@/lib/flows/types";

export type PipelineAccess = "read-only" | "read-write";

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

export type PipelineStageInput = {
  id: string;
  kind: PipelineStageKind;
  role?: PipelineRoleRef;
  engine?: FlowEngine;
  model?: string | null;
  effort?: string | null;
  access?: PipelineAccess;
  prompt: string;
  next: string | null;
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
  output: string | null;
  verdict: StageVerdict | null;
  error: string | null;
};

export type PipelineStageRun = {
  stageId: string;
  attempts: PipelineStageAttempt[];
};

export type PipelineCursorState = "pending" | "spawning" | "running" | "reviewing" | "committing";

export type PipelineState = "provisioning" | "running" | "needs_decision" | "paused" | "completed" | "closed";

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
  cursor: { stageId: string; state: PipelineCursorState } | null;
  state: PipelineState;
  pausedState: Exclude<PipelineState, "paused"> | null;
  stateDetail: string | null;
  srcPath: string | null;
  srcConversationId: string | null;
  createdAt: string;
  closedAt: string | null;
};

export type CreatePipelineRequest = {
  task: string;
  spec?: string;
  repoDir: string;
  stages: PipelineStageInput[];
  src?: string;
};

export type PipelineAction = "pause" | "resume" | "retry-stage" | "skip-stage" | "close";

export type PatchPipelineRequest = {
  action: PipelineAction;
};

export type PipelinesResponse = {
  pipelines: Pipeline[];
};
