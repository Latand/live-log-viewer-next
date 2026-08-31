import type { FlowEngine, RoleConfig } from "@/lib/flows/types";

export type PipelineAccess = "read-only" | "read-write";
export type PipelineSandbox = "full" | "restricted";

export type PipelineRepoPreflightErrorCode =
  | "missing"
  | "not_directory"
  | "repo_unreadable"
  | "repo_untraversable"
  | "not_git"
  /** A Git probe could not reach a verdict — a spawn/exec failure, a timeout, or
      a transient non-zero exit that is not the definitive "not a git repository"
      message. Kept distinct so a hiccup never masquerades as not_git (#353 AC3). */
  | "probe_failed"
  | "git_metadata_unwritable"
  | "worktree_parent_unwritable";

export type PipelineRepoPreflight =
  | { ok: true; repoDir: string; gitCommonDir: string; worktreeParent: string }
  /** `detail` carries the underlying stderr/reason for a probe_failed transient so
      the failure preserves fidelity instead of collapsing to a generic code. */
  | { ok: false; code: PipelineRepoPreflightErrorCode; path: string; detail?: string };

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
  /** Repository mutation policy, enforced when the stage settles. It does not
      select the engine's tool/network sandbox. */
  access?: PipelineAccess;
  /** Tool/network boundary, independent from the repository policy in
      `access`. Omitted stages run with full host access. */
  sandbox?: PipelineSandbox;
  /** Repository-relative files or directories a read-only stage may produce.
      The controller alone records these paths in Git. */
  outputs?: string[];
  /** The account this stage runs on (#1279). Omitted, the stage resolves its
      account the way every unattended launch does — inside whatever set the
      pipeline's project allows. Named, it is honored only when the project
      allows it; otherwise the stage is refused, never quietly reseated. */
  account?: string | null;
  "prompt": string;
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

export type PipelineVerdictRecovery = {
  state: "pending" | "recovered" | "exhausted";
  checks: number;
  maxChecks: number;
  startedAt: string;
  lastCheckedAt: string;
  nextCheckAt: string | null;
  /** Content-free parser diagnostic for the latest rejected canonical turn. */
  reason: string;
  /** Identifies the selected assistant message without persisting its content. */
  messageTs: number | null;
};

export type PipelineStageAttempt = {
  n: number;
  /** Lineage-adopted evidence. Historical attempts never drive the execution cursor. */
  historical?: boolean;
  state: PipelineAttemptState;
  effectiveRole: EffectivePipelineRole;
  launchId: string | null;
  conversationId: string | null;
  sessionId: string | null;
  agentPath: string | null;
  paneId: string | null;
  flowId: string | null;
  /** Clean pipeline SHA expected when the first reviewer launches. */
  expectedReviewHeadSha?: string | null;
  /** Exact clean SHA captured by the first launched reviewer round. */
  reviewHeadSha?: string | null;
  /** Authoritative projection of the embedded flow. The generation is a
      content digest, so reconciliation remains idempotent across processes and
      independently committed flow/pipeline writes. */
  reviewFlowSync?: {
    generation: string;
    sourceRevision?: number;
    roundCount: number;
    implementerHeadSha: string | null;
    reviewerHeadSha: string | null;
    verdict: import("@/lib/flows/types").ReviewVerdict | null;
    relayState: import("@/lib/flows/types").FlowState;
    terminalState: import("@/lib/flows/types").FlowState | null;
    hostClaim?: import("@/lib/flows/types").FlowHostClaim | null;
    synchronizedAt: string;
    sourceUpdatedAt: string | null;
    lagMs: number | null;
  };
  startedAt: string | null;
  completedAt: string | null;
  /** Bounded wait for a structured delivery controller that is between
      publications (#1191). `startedAt` is wall-clock from the first sighting,
      so the budget covers the time a failing spawn attempt spent inside
      `spawnAgent` as well as the backoff; `retryAfter` is when the next
      activation may run. Persisted because the wait is spent between ticks —
      sleeping through it would hold the pipeline mutation past the flow
      pipeline controller's phase deadline. */
  controllerWait?: {
    startedAt: string;
    rounds: number;
    retryAfter: string;
  };
  /** Exactly-once relay (#353): the `{{prev.output}}` payload persisted when the
      cursor advanced here. Null on pre-v3 attempts, which fall back to the
      legacy positional scan. */
  input: string | null;
  activatedBy: PipelineEdgeActivation | null;
  output: string | null;
  verdict: StageVerdict | null;
  error: string | null;
  /** Bounded, append-only reconciliation receipt for terminal parser misses. */
  verdictRecovery?: PipelineVerdictRecovery;
};

export type PipelineStageRun = {
  stageId: string;
  attempts: PipelineStageAttempt[];
};

export type PipelineCursorState = "pending" | "spawning" | "running" | "reviewing" | "committing";

export type PipelineState = "draft" | "provisioning" | "running" | "needs_decision" | "paused" | "completed" | "closed";

/** A stage host a close asked the runtime to kill without confirming that it
    died (#670). Durable, so the possible survivor stays addressable: the board
    keeps showing the closed lane until a later close settles it. */
export type PipelineUnconfirmedHost = {
  stageId: string;
  attempt: number;
  conversationId: string | null;
  agentPath: string | null;
  paneId: string | null;
  operationId: string | null;
  detail: string;
  at: string;
};

export type PipelineCreationIntent = {
  kind: "task-spawn";
  taskId: string;
  launchId: string;
};

/** Durable receipt of finished-attempt host reaping (#574, #1123). Each stage
    attempt is settled independently, so an idle host can be retired while the
    rest of its pipeline runs or waits for a decision. */
export type PipelineTerminalReap = {
  /** Sweeps in the current unsettled batch that dispatched at least one kill,
      or were cut off by the budget. Reset when a later attempt becomes eligible. */
  rounds: number;
  /** Hosts whose termination this reap evidenced, across all batches. */
  stopped: number;
  lastAt: string;
  /** Stage-attempt keys already proved absent, stopped, or handed to the idle
      lifecycle after the runtime reported a later active turn. */
  settledAttempts: string[];
  /** Set once the current batch has no unfinished host, or the round ceiling is
      reached. A later finished attempt opens a new batch. */
  settledAt: string | null;
};

export type Pipeline = {
  id: string;
  task: string;
  /** Durable board-task membership. The legacy `task` field remains the title. */
  taskIds: string[];
  /** Launch-correlated creation evidence reserved before task-spawn actuation. */
  creationIntent?: PipelineCreationIntent;
  /** Pinned specification and acceptance criteria, matching Flow.spec from #85. */
  spec?: string;
  project: string;
  repoDir: string;
  worktreeDir: string;
  branch: string;
  baseBranch: string;
  baseRef: string;
  lastPassedCommit: string;
  /** The revision the orchestrator last published to `origin/<branch>`. The
      review layer fences every round on the published head, so publication is
      the pipeline's job, not a stage's; recording what landed lets a steady
      state skip the remote probe entirely. Null while nothing is published
      (a fresh pipeline, or a repo with no `origin` to publish to). */
  publishedCommit?: string | null;
  stages: PipelineStage[];
  runs: PipelineStageRun[];
  /** The cursor carries the durable relay record (#353): the forwarded input and
      the activating edge are persisted in the same atomic write as the verdict
      that advanced here, so a crash between advance and spawn replays the
      identical prompt. */
  cursor: { stageId: string; state: PipelineCursorState; input: string | null; activatedBy: PipelineEdgeActivation | null } | null;
  state: PipelineState;
  pausedState: Exclude<PipelineState, "paused" | "draft"> | null;
  /** When the pipeline was last paused, and when it was last resumed. Durable
      because they are the only record a pause/resume transition leaves: the
      lifecycle journal (#686) derives its `stage_paused`/`stage_resumed` events
      from them, and a key built on the timestamp is what lets a second pause
      after a resume be a genuinely new event instead of a replay of the first. */
  pausedAt?: string | null;
  resumedAt?: string | null;
  stateDetail: string | null;
  srcPath: string | null;
  srcConversationId: string | null;
  createdAt: string;
  closedAt: string | null;
  hiddenAt?: string | null;
  /** Hosts the last close could not confirm terminated. Present only while one
      is outstanding; a close that confirms every kill clears it. */
  unconfirmedHosts?: PipelineUnconfirmedHost[];
  /** Receipt of the finished-host sweep completion triggers (#574). Absent
      until the pipeline first settles terminally with launched hosts to check. */
  terminalReap?: PipelineTerminalReap;
  /** Read-model marker set when a hidden container is projected for a pinned
      member, or for a closed lane still holding an unconfirmed host. */
  restored?: boolean;
  /** Durable user pin for the desktop board's world-space pipeline group. */
  pos?: { x: number; y: number };
};

export type CreatePipelineRequest = {
  task: string;
  taskIds?: string[];
  spec?: string;
  repoDir: string;
  /** Merge target branch; defaults to main when the pipeline starts. */
  baseBranch?: string;
  /** Explicit git commit-ish to pin; defaults to the fetched origin branch. */
  baseRef?: string;
  stages: PipelineStageInput[];
  /** Creator transcript. API callers may omit it only when caller authentication can derive it. */
  src?: string;
  autoStart?: boolean;
};

/* The accepted actions, declared once (#774). The MCP tool schema publishes
   these to callers and the PATCH route admits exactly this set; an action added
   to one and forgotten in the other is the defect this constant prevents. */
export const PIPELINE_ACTIONS = [
  "start",
  "update-draft",
  "set-position",
  "add-stage",
  "remove-stage",
  "reorder-stage",
  "set-edge",
  "pause",
  "resume",
  "retry-stage",
  "skip-stage",
  "override-stage",
  "link-task",
  "unlink-task",
  "set-src",
  "delete",
  "close",
] as const;

export type PipelineAction = (typeof PIPELINE_ACTIONS)[number];

export type PatchPipelineRequest = {
  action: PipelineAction;
  /** Board task used by link-task and unlink-task. */
  taskId?: string;
  /** Creator transcript used by set-src. */
  srcPath?: string;
  /** Explicit authorization to replace existing creator lineage. */
  overwrite?: boolean;
  /** for override-stage: the not-yet-started stage to re-configure (issue #118
      on-canvas stage controls). Only fields present are changed; a stage that
      already ran an attempt is rejected so the override always targets the future.
      `role` swaps the canonical role (resolved through the registry like create,
      with the same param + disallowed-role validation); `null` clears it back to
      the Builder default. Changing the role resets any unpinned engine/model/
      effort to the new role's defaults; an explicit engine/model/effort still wins. */
  stageId?: string;
  /** retry-stage identity fence for a retry initiated from a launch receipt. */
  launchId?: string;
  role?: PipelineRoleRef | null;
  engine?: FlowEngine;
  model?: string | null;
  effort?: string | null;
  /** for override-stage: the not-yet-started run stage's access. Review-loop
      stages stay read-only (the resolver rejects read-write there). */
  access?: PipelineAccess;
  /** for override-stage: the account the stage runs on (#1279); `null` clears
      the pin back to the project's ordinary selection. Refused when the
      project's binding does not allow the named account. */
  account?: string | null;
  prompt?: string;
  task?: string;
  spec?: string;
  repoDir?: string;
  /** for set-position: exact world coordinates selected by a user drag. */
  pos?: { x: number; y: number };
  stage?: PipelineStageInput;
  index?: number;
  stageIds?: string[];
  toIndex?: number;
  /** for close: dismiss the hosts a previous close could not confirm, once the
      operator has judged them (a recycled pane id can look alive forever, so an
      unidentifiable host would otherwise pin the closed lane to the board).
      Only unconfirmed hosts are dismissed; one proven to be still running still
      refuses the close. */
  acknowledgeHosts?: boolean;
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
