import type { Flow, FlowAnnotation, ReviewVerdict } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { TmuxEndpointHealth } from "@/lib/tmux";
import type { Workflow } from "@/lib/workflows/types";
import type { TurnState } from "@/lib/accounts/migration/contracts";

export type RootKey =
  | "codex-sessions"
  | "claude-projects"
  | "claude-tasks";

export type Engine = "codex" | "claude" | "shell";
export type Activity = "live" | "recent" | "stalled" | "idle";
export type Fmt = "codex" | "claude" | "plain";

export interface StructuredSpawnCardState {
  launchId: string;
  clientAttemptId: string | null;
  accountId: string | null;
  state: "starting" | "binding" | "queued" | "failed" | "recovered";
  initialMessage: "pending" | "queued" | "delivered" | "failed";
  retrySafe: boolean;
  error: string | null;
}

/** Current quota wall affecting a hosted conversation. Account provenance
    joins the existing conversation identity at the read-model boundary. */
export interface RateLimitState {
  source: "pane" | "account";
  accountId: string | null;
  window: "session" | "weekly" | null;
  /** Unix seconds when work can resume, when the engine reports it. */
  resetAt: number | null;
}

/** One sidebar entry returned by GET /api/files. */
export interface FileEntry {
  path: string;
  root: RootKey;
  /** Path relative to its root. */
  name: string;
  project: string;
  /** Working directory recorded by the conversation transcript. */
  cwd?: string | null;
  /** Identity-bound session creation time parsed from the transcript header. */
  sessionStartedAt?: string | null;
  /** Native Codex parent thread parsed from the identity-bound transcript header. */
  nativeParentThreadId?: string | null;
  /** Canonical parent-repository root when cwd belongs to a linked worktree. */
  projectRoot?: string | null;
  /** Git worktree name when cwd lives under <repo>/.claude/worktrees/<name>. */
  worktree?: string;
  title: string;
  /** The scanner-derived title, kept as provenance when a user rename
      (issue #33) overrode `title`. Absent when no override is in effect. */
  autoTitle?: string;
  /** Revision of the active custom-title override, echoed back as the
      base revision on the next `PATCH /api/session/title` for optimistic
      concurrency. Absent when the session has no override. */
  titleRevision?: number;
  /** Whether this entry may be renamed (issue #33): only main Claude/Codex
      sessions qualify — subagents (Claude `agent-*`, native Codex threads with a
      parent) and background/shell tasks do not. Computed server-side because
      Codex subagent detection needs transcript metadata; the client reads this
      flag rather than importing the Node-only eligibility logic. */
  renamable?: boolean;
  engine: Engine;
  kind: string;
  fmt: Fmt;
  /** Absolute path of the parent node (tree link) or null for roots. */
  parent: string | null;
  /** Durable lineage tombstone when the parent conversation transcript is gone. */
  parentRemoved?: { conversationId: string; path: string | null };
  /** Unix seconds. */
  mtime: number;
  size: number;
  activity: Activity;
  /** Machine-readable reason behind `activity` (jsonl_turn_open, mtime_fresh…). */
  activityReason?: string;
  /** Whether transcript-backed scanner derivations completed for this file identity. */
  derivationComplete?: boolean;
  /** Complete provider-authoritative turn evidence retained independently from activity projection. */
  authoritativeTurn?: TurnState;
  /** Real OS process state when the entry maps to a process, else null. */
  proc: "running" | "done" | "killed" | null;
  pid: number | null;
  /** Set when this conversation was spawned by a handoff from `parent`. */
  handoff?: boolean;
  /** At least one human-authored message exists in the transcript (issue #112).
      Sourced from the reaper's sticky authorship evidence (PR #125), which
      filters Claude task-notification records and viewer-injected relays. A
      hard pin against worker-class auto-collapse — an owner-touched card never
      collapses. Absent when unknown (no reaper observation yet). */
  userAuthored?: boolean;
  /** The reaper has NOT scanned this transcript since its latest activity, so
      its authorship is unconfirmed (issue #112). The board's worker
      auto-collapse fails closed on this — an unverified worker is pinned like an
      owner-authored one until a reaper cycle clears it. Set for claude/codex
      transcripts whose mtime is newer than the reaper's last run (or when the
      reaper has never run). */
  authorshipUnverified?: boolean;
  /** Short model name (fable, gpt-5.5, sonnet…) or null when unknown. */
  model: string | null;
  /** Exact model identifier recorded by the agent CLI. Kept separate from the
      display-normalized `model` because resuming a pinned Claude model needs
      the original identifier. */
  launchModel?: string | null;
  /** Reasoning-effort tier (minimal|low|medium|high|xhigh|max|ultra) or null
      when no reliable source exists (claude transcripts carry none). */
  effort?: string | null;
  /** Codex service tier read from the live argv; null when unavailable. */
  fast?: boolean | null;
  /** Structured Claude prompt that is currently blocking the live agent. */
  pendingQuestion: PendingQuestion | null;
  /** Newest still-pending self-scheduled wakeup, for the board timer chip. */
  pendingWakeup?: PendingWakeup | null;
  /** Newest TodoWrite/update_plan state — the agent's plan and current goal. */
  plan?: AgentPlan | null;
  /** Context-window fullness from the transcript tail, when it carries usage. */
  ctx?: CtxUsage | null;
  /** Codex only: the thread's declared goal (objective + status). */
  goal?: AgentGoal | null;
  /** Boundaries of the most-recent turn — the prompt (or relayed message) that
      started it and, once the agent falls idle, the last assistant/tool output
      that closed it. `endedAt` is null while the turn is still running, so the
      UI ticks live elapsed; when set, the feed prints a «Worked for …» caption
      and the card meta row parks the run length in a tooltip. Absent when no
      turn boundary can be derived from the transcript tail (issue #231). */
  lastTurn?: TurnBoundary | null;
  /** Best-effort TUI scrape fallback for prompts without a transcript protocol. */
  waitingInput: WaitingInput | null;
  /** Live pane wall or fresh structured account exhaustion. */
  rateLimit?: RateLimitState | null;
  /** claude-tasks only: recovered originating Bash command ("" if not found). */
  cmd?: string;
  /** claude-tasks only: the Bash tool `description` field. */
  cmdDesc?: string;
  /** Review-loop ownership for grouping implementer/reviewer sessions. */
  flow?: FlowAnnotation;
  /** Terminal review outcome of a one-shot reviewer, parsed from the reviewer
      transcript's last assistant message (issue #325). Present only on current
      generations carrying a durable `role=reviewer` edge; a clean "NO FINDINGS"
      reply projects as APPROVE with zero findings. Absent while the reviewer is
      still working or when its tail carries no verdict. */
  review?: { verdict: ReviewVerdict; findingsCount: number | null; observedAt: string | null } | null;
  /** Stable registry projection used by board adapters after paths rotate. */
  durableLineage?: {
    kind: "spawn" | "review";
    role: string | null;
    parentConversationId: string | null;
    reviewsConversationId: string | null;
    memberships: Array<{
      kind: "flow" | "pipeline";
      containerId: string;
      role: string;
      slot: string;
      stageId: string | null;
      stageOrder: number | null;
      round: number | null;
      parentConversationId: string | null;
    }>;
  };
  /** Stable Viewer conversation identity (issue #40 account migration). Owns
      the card across native generation changes; falls back to `path` while the
      backend coordinator is unmerged. See {@link ConversationMigration} and
      `conversationIdentity`. Consumers must never derive current identity by
      walking `predecessorPath`/`migratedTo` — those are compatibility metadata. */
  conversationId?: string;
  /** Native generation number under the current account; provenance only. */
  generation?: number;
  /** Compatibility link to the archived predecessor transcript of a committed
      migration. Presence marks this entry as a successor (renders a feed
      divider); never used to determine identity. */
  predecessorPath?: string | null;
  /** Human label of the account the predecessor ran under, for the "Continued
      from «…»" divider. Divider stays hidden until the server supplies it. */
  predecessorLabel?: string;
  /** Compatibility link to the successor transcript once a migration commits.
      Presence marks this entry as an archived predecessor: it folds into the
      successor's history and never renders a standalone card. */
  migratedTo?: string | null;
  /** Live per-session migration annotation while an intent drains. Absent for
      every session not currently migrating. */
  migration?: ConversationMigration;
  /** Durable launch projection shown before its transcript enters the scan. */
  spawn?: StructuredSpawnCardState;
}

/** Per-session migration annotation carried on a {@link FileEntry} while an
    account-migration intent drains. The coordinator's internal phases collapse
    to the four user-visible card states via `cardMigrationState`. */
export interface ConversationMigration {
  /** The durable engine-wide intent this session belongs to. */
  intentId: string;
  /** Whether the intent was authored by a manual selection or the auto-balancer. */
  trigger: "manual" | "quota";
  /** Raw coordinator phase (`waiting-turn` | `preparing` | `successor-starting`
      | `verifying` | `committed` | `failed-recoverable` | `rolled-back` | …). */
  phase: string;
  /** Target account id the session is moving to. */
  targetAccountId: string;
  /** Human label of the target account, safe for display. */
  targetLabel?: string;
  /** Human label of the current (source) account, for the failed-state
      "Keep on «…»" per-session rollback action. Keep hides without it. */
  sourceLabel?: string;
  /** Number of composer/queue deliveries held for the successor. */
  heldDeliveries?: number;
  /** Secret-free failure reason from the server, shown on failed ribbons. */
  failure: string | null;
  /** Optimistic-concurrency revision of the owning operation. */
  revision?: number;
}

export interface ProjectCatalogEntry {
  project: string;
  /** Canonical repository root derived from every conversation in the full scan. */
  projectRoot?: string;
  /** Unix seconds of the newest valid transcript candidate in the project. */
  smt: number;
  /** Lightweight count from the full candidate scan. */
  conversations: number;
}

export interface FilesResponse {
  files: FileEntry[];
  /** Rows added only to resolve the current deep-link pin, including closure. */
  pinOverlayPaths?: string[];
  projectCatalog?: ProjectCatalogEntry[];
  /** Existing local repository fallback for projects whose conversations lack cwd metadata. */
  projectCwds?: Record<string, string>;
  flows: Flow[];
  pipelines: Pipeline[];
  /** Present when the pipelines store failed closed; the rest of the payload stays valid. */
  pipelinesError?: string;
  workflows: Workflow[];
  tasks: BoardTask[];
  systemHealth: { tmux: TmuxEndpointHealth };
  /** Durable conversation-id aliases (old id → canonical id), so a deep link
      copied before provisional-id adoption still resolves its card. */
  conversationAliases?: Record<string, string>;
}

export type PlanStepStatus = "pending" | "in_progress" | "completed";

/** How full an agent's context window is (codex token_count events; claude
    assistant usage vs the model's window). */
export type CtxSource = "runtime" | "provider" | "registry" | "unknown";
export type CtxConfidence = "exact" | "approximate" | "unknown";

export interface CtxUsage {
  usedTokens: number;
  /** Null when the transcript and known-model table cannot establish it. */
  windowTokens: number | null;
  /** Rounded 0–100, or null along with an unknown window. */
  pct: number | null;
  source: CtxSource;
  confidence: CtxConfidence;
  /** Bundled snapshot id, present for registry-derived capacity. */
  registryVersion?: string;
  /** ISO timestamp of the transcript usage record, with scan time fallback. */
  observedAt: string;
}

/** Boundaries of a single conversational turn, in Unix epoch **milliseconds**.
    `startedAt` is the timestamp of the prompt (or relayed message) that opened
    the turn; `endedAt` is the timestamp of the last assistant/tool output once
    the agent goes idle, or null while the turn is still running. Derived in the
    scanner from per-message transcript timestamps for both engines (issue #231). */
export interface TurnBoundary {
  startedAt: number;
  endedAt: number | null;
}

/** Codex thread goal (update_goal tool / thread_goal_updated events): the
    session-level objective and its lifecycle. Claude has no counterpart. */
export interface AgentGoal {
  objective: string | null;
  status: "active" | "complete" | "blocked";
  tokensUsed: number | null;
  timeUsedSeconds: number | null;
}

export interface PlanStep {
  text: string;
  status: PlanStepStatus;
}

/** Latest self-reported working plan of an agent: Claude's TodoWrite todos or
    Codex's update_plan steps, whichever the transcript tail carries. */
export interface AgentPlan {
  steps: PlanStep[];
  done: number;
  total: number;
  /** The step being worked on right now — the agent's current goal. */
  current: string | null;
  /** ISO timestamp of the plan update record, when the transcript had one. */
  updatedAt: string | null;
}

export interface PendingQuestionOption {
  label: string;
  description: string;
  recommended: boolean;
}

export interface PendingQuestionItem {
  question: string;
  header: string;
  multiSelect: boolean;
  options: PendingQuestionOption[];
}

export interface PendingQuestion {
  kind: "question" | "plan";
  toolUseId: string;
  transcriptPath: string;
  pid: number;
  paneTarget: string | null;
  askedAt: string;
  questions?: PendingQuestionItem[];
  plan?: string;
}

/** The newest still-pending `ScheduleWakeup` of a conversation, surfaced as a
    board timer chip so an idle-looking orchestrator reads as sleeping until a
    known time (issue #161 §3). Absent once the wakeup has fired or been
    superseded. */
export interface PendingWakeup {
  /** Absolute fire time in epoch ms. */
  fireAt: number;
  /** The one-line "why", for the chip's hover/tap title. */
  reason: string;
}

export interface WaitingMenuOption {
  /** Digit the TUI expects for this option. */
  value: number;
  label: string;
  description: string;
  recommended: boolean;
}

/** One question of a multi-question dialog strip («☐ Build error … ✔ Submit»). */
export interface WaitingMenuTab {
  label: string;
  done: boolean;
}

/** Select dialog parsed straight off the pane screen — see parseScreenMenu. */
export interface WaitingMenu {
  question: string;
  tabs: WaitingMenuTab[];
  options: WaitingMenuOption[];
}

export interface WaitingInput {
  since: number;
  screenTail: string;
  target: string;
  /** Structured dialog when the screen parsed as one; null keeps the raw tail. */
  menu: WaitingMenu | null;
}

/** Response of GET /api/log (forward tail polling and `before` history reads). */
export interface LogChunk {
  /** Tail mode: next offset to poll from. History mode: start of this chunk. */
  offset: number;
  /** File offset where `data` begins. */
  start: number;
  /** Current file size in bytes. */
  size: number;
  data: string;
}

/** One action on the activity timeline, extracted from a transcript tail. */
export interface ActionEvent {
  /** Unix seconds. */
  ts: number;
  /** Transcript path the action belongs to. */
  file: string;
  /** Short conversation/agent name. */
  actor: string;
  kind: "user" | "turn" | "spawn" | "msg";
  label: string;
}

export interface ApiError {
  error: string;
}

/** One rate-limit window (5h session or weekly) of an engine subscription. */
export interface LimitWindow {
  usedPercent: number;
  /** Unix seconds when the window resets, or null when unknown. */
  resetsAt: number | null;
}

/** Plan rate limits of one engine, returned by GET /api/limits. */
export interface EngineLimits {
  session: LimitWindow | null;
  weekly: LimitWindow | null;
  plan: string | null;
  /** Unix seconds when the numbers were captured. Codex limits come from the
      newest session transcript, so they can lag behind; null = fetched live. */
  capturedAt: number | null;
}

/** Origin and freshness are independent for each engine. Reasons are safe for
    display/logging and never contain credential material. */
export interface LimitsProvenance {
  source: "live" | "transcript" | "cache" | "unavailable";
  reason: string | null;
  staleSince: string | null;
  /** ISO timestamp for the next provider refresh after a failed read. */
  retryAt?: string | null;
}

export const LIMITS_RATE_LIMITED_REASON = "oauth-rate-limited";
export const LIMITS_REAUTH_REQUIRED_REASON = "oauth-reauthentication-required";

export interface LimitsPayload {
  claude: EngineLimits | null;
  codex: EngineLimits | null;
  /** The Claude account whose values appear in this payload. */
  claudeAccountId: string | null;
  /** The account whose Codex values appear in this payload. The server always
      stamps it; null remains accepted while a legacy cached/browser payload is
      being replaced after an upgrade. */
  codexAccountId: string | null;
  provenance: { claude: LimitsProvenance; codex: LimitsProvenance };
  /** ISO timestamp from the first failed refresh behind this fallback payload. */
  staleSince?: string | null;
}

/** One remaining-quota sample of the burndown series: `remaining` is the
    percent of quota left (0–100 = 100 − usedPercent) at unix second `t`. */
export interface LimitSample {
  t: number;
  remaining: number;
}

/** A burndown series for one engine window (5h session or weekly). The ideal
    even-pace diagonal runs 100% at `windowStart` → 0% at `resetsAt`; the actual
    curve is `samples`, filtered to the current window. */
export interface BurndownSeries {
  /** Unix seconds at the window's opening (resetsAt − windowSeconds), or null
      when the reset moment is unknown. */
  windowStart: number | null;
  /** Unix seconds when the window resets, or null when unknown. */
  resetsAt: number | null;
  /** Window length in seconds (5h = 18000, weekly = 604800; Codex may differ). */
  windowSeconds: number;
  /** Remaining-quota samples inside the current window, oldest first. */
  samples: LimitSample[];
}

/** Both windows' burndown series for one engine. */
export interface EngineBurndown {
  session: BurndownSeries;
  weekly: BurndownSeries;
}

/** Burndown history for both engines, returned by GET /api/limits/history. */
export interface BurndownPayload {
  claude: EngineBurndown | null;
  codex: EngineBurndown | null;
  claudeAccountId: string | null;
  codexAccountId: string | null;
  /** ISO time the forward poll history began accruing, for the sparse-state
      hint on engines (Claude) that can only be sampled going forward. */
  historySince: string | null;
}

/** Host memory pressure for the rail block, all byte fields absolute.
    swapTotal 0 means "no swap (or the swap probe failed)" — hide the row. */
export interface ResourcesSystem {
  ramTotal: number;
  ramAvailable: number;
  swapTotal: number;
  swapUsed: number;
  /** ISO timestamp of the snapshot behind these numbers. */
  capturedAt: string;
}

/** One tmux pane hosting an agent CLI, with its whole process tree's memory.
    `path` is null for orphans — panes running an agent the scanner could not
    match to any transcript; they are still killable via their target. */
export interface ResourceSession {
  target: string;
  panePid: number;
  path: string | null;
  engine: "claude" | "codex" | null;
  /** Several live panes claim the same stable conversation identity. */
  hostConflict?: boolean;
  title: string | null;
  project: string | null;
  activity: Activity | null;
  lastActiveAt: string | null;
  /** Agent CLI working directory — the identity fallback for orphan rows. */
  cwd: string | null;
  /** Tree totals across the pane pid and every descendant (MCP children included). */
  rssBytes: number;
  swapBytes: number;
  procCount: number;
}

/** GET /api/resources response. `system` is null when no platform probe worked. */
export interface ResourcesPayload {
  system: ResourcesSystem | null;
  sessions: ResourceSession[];
}
