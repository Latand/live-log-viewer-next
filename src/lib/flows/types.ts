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

export type Round = {
  n: number; // 1-based
  reviewerPath: string | null; // reviewer run's transcript path once known
  reviewerConversationId?: string | null;
  /** Engine account frozen when this round starts; subsequent polling and retry
      must never silently adopt a newly selected active account. */
  accountId?: string | null;
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
  baseRef: string; // resolved git SHA captured at creation
  baseMode: "head" | "merge-base";
  mode: "auto" | "manual";
  reviewerMode: "headless" | "pane";
  roundLimit: number; // default 5; 0 = unlimited
  state: FlowState;
  pausedState?: FlowState | null;
  /** Human-readable reason shown on the strip for needs_decision/paused. */
  stateDetail: string | null;
  rounds: Round[];
  createdAt: string;
  closedAt: string | null;
};

export type FlowPreset = {
  name: string;
  implementer: RoleConfig;
  reviewer: RoleConfig;
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
