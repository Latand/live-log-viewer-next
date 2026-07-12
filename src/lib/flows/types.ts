// Shared contract for review-loop flows (docs/review-loop-ui.md).
// This file is the seam between the server engine (src/lib/flows/*) and the
// UI (src/components/*). Extend it only when the spec changes.

export type FlowEngine = "claude" | "codex";

export type RoleConfig = {
  engine: FlowEngine;
  model: string | null; // null = engine default
  effort: string | null; // null = engine default; codex: low|medium|high|xhigh, claude: low|medium|high|xhigh|max
};

export type FlowRoleKey = "implementer" | "reviewer";

export type FlowTemplateId = "implement-review-loop";

export type FlowState =
  | "waiting_ready"
  | "spawn_pending"
  | "spawning"
  | "reviewing"
  | "relay_pending"
  | "relaying"
  | "fixing"
  | "approved"
  | "done_comment"
  | "needs_decision"
  | "paused"
  | "closed";

export type ReviewVerdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export type FlowBlock = {
  reason: "rate_limited";
  /** Stable address for a future continue-on-account action. */
  conversationId: string | null;
  /** Exhausted account. A successor action can exclude it from targets. */
  accountId: string | null;
  resetAt: number | null;
};

export type Round = {
  n: number; // 1-based
  reviewerPath: string | null; // reviewer run's transcript path once known
  reviewerConversationId?: string | null;
  /** Reviewer role frozen when this round is created/retried and re-frozen at
      launch (issue #118 + #117). The engine launches, recovers and polls the
      reviewer through this snapshot, so a mid-flight `set-roles` (which mutates
      flow.roles.reviewer) can never change the engine/model of a round already
      spawning or reviewing. A Codex-configured flow may persist its configured
      Claude fallback here when every Codex account is exhausted. Absent on rounds
      persisted before this field existed — the engine falls back to
      flow.roles.reviewer for those. */
  reviewerRole?: RoleConfig | null;
  /** Engine account frozen when this round starts; subsequent polling and retry
      must never silently adopt a newly selected active account. */
  accountId?: string | null;
  /** Engine-qualified accounts already tried for this logical round. */
  attemptedAccounts?: string[];
  /** Automatic no-verdict retries already consumed by this logical round. */
  autoRetryCount?: number;
  /** Reviewer session/thread id, persisted as soon as it is known: claude
      pre-chooses it at spawn, codex reports it in the first `--json` event.
      Survives viewer restarts so the transcript claim stays deterministic. */
  sessionId?: string | null;
  /** Headless reviewers: OS pid of the detached reviewer process, persisted
      at spawn. The process outlives the viewer (detached + file-backed
      stdio), so after a restart the engine re-attaches through this pid and
      the on-disk stdout/last-message artifacts instead of giving up. */
  reviewerPid?: number | null;
  /** Pane-mode reviewers: the tmux pane the round booted, captured at spawn
      so cancel-round can stop it even before the scanner attributes the
      transcript. The window name guards against pane-id reuse. */
  reviewerPane?: { paneId: string; windowName: string } | null;
  findingsPath: string | null; // round artifact file once written
  triggeredBy: "marker" | "button";
  readyNote: string | null; // text after REVIEW_READY:
  verdict: ReviewVerdict | null;
  findingsCount: number | null;
  startedAt: string;
  spawnStartedAt?: string | null; // reviewer launch started
  relayStartedAt?: string | null; // findings delivery started
  reviewedAt: string | null; // verdict detected
  relayedAt: string | null; // findings delivered to implementer
  error: string | null;
};

export type Flow = {
  id: string;
  template: FlowTemplateId;
  project: string; // FileEntry.project of the implementer
  cwd: string; // implementer's working directory
  implementerPath: string; // transcript path of the attached session
  implementerConversationId?: string | null;
  roles: Record<FlowRoleKey, RoleConfig>;
  /** Configured cross-engine fallback for unattended reviewer launches. */
  reviewerFallback?: RoleConfig | null;
  baseRef: string; // resolved git SHA captured at creation
  /** Pinned task specification and acceptance criteria shown to every reviewer. */
  spec?: string;
  baseMode: "head" | "merge-base";
  mode: "auto" | "manual";
  reviewerMode: "headless" | "pane";
  roundLimit: number; // default 5; 0 = unlimited
  state: FlowState;
  pausedState?: FlowState | null;
  /** Human-readable reason shown on the strip for needs_decision/paused. */
  stateDetail: string | null;
  /** Ephemeral read-model block derived from the attached implementer. */
  block?: FlowBlock | null;
  rounds: Round[];
  createdAt: string;
  closedAt: string | null;
};

export type FlowPreset = {
  name: string;
  implementer: RoleConfig;
  reviewer: RoleConfig;
  managed?: "role-registry";
};

export type CreateFlowRequest = {
  implementerPath: string;
  preset?: string; // preset name; mutually exclusive with roles
  roles?: Record<FlowRoleKey, RoleConfig>;
  baseMode: "head" | "merge-base";
  /** Explicit review base (a resolved sha). The workflow engine passes the
      workflow branch start here so every round reviews the whole workflow
      diff; when absent the base resolves from baseMode in the session cwd. */
  baseRef?: string;
  /** Optional pinned task specification and acceptance criteria for the flow. */
  spec?: string;
  mode: "auto" | "manual";
  reviewerMode: "headless" | "pane";
  roundLimit: number;
};

export type FlowAction =
  | "pause"
  | "resume"
  | "set-mode"
  | "advance"
  | "retry-round"
  | "cancel-round"
  | "set-round-limit"
  | "extend"
  | "another-round"
  | "set-roles"
  | "close";

export type PatchFlowRequest = {
  action: FlowAction;
  /** for set-mode */
  mode?: "auto" | "manual";
  /** for extend: how many rounds to add (default 1);
      for set-round-limit: the absolute limit, 0 = unlimited */
  rounds?: number;
  /** for advance/retry-round: a user note the next reviewer sees as the
      round's ready note */
  note?: string;
  /** for set-roles: a partial override of the REVIEWER role config, applied to
      the next round without recreating the flow (issue #118). Only the provided
      fields change, and a round already in flight keeps the role it froze at
      spawn (see Round.reviewerRole). The implementer is intentionally not
      overridable: it is an already-attached live session whose engine/account
      cannot be reseated in place, so accepting an implementer override would be a
      no-op reported as success. Reseating the implementer is a separate feature. */
  roles?: { reviewer?: Partial<RoleConfig> };
};

/** Per-transcript annotation piggybacked on /api/files entries. */
export type FlowAnnotation = {
  flowId: string;
  flowRole: FlowRoleKey;
  /** round number for reviewer transcripts, null for the implementer */
  round: number | null;
};

export type FlowsResponse = {
  flows: Flow[];
  presets: FlowPreset[];
};
