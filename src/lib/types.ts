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

declare const epochSecondsBrand: unique symbol;
/**
 * A wall clock in epoch SECONDS — the unit {@link FileEntry.mtime} and every
 * age comparison drawn against it are measured in.
 *
 * Branded on purpose: a millisecond clock is the same primitive and reads the
 * same at a glance, and feeding one to a seconds comparison is silent (an age
 * 1000x too large, every TTL blown, every transcript "ancient"). Passing a
 * plain `number` where this is asked for is a type error, so the conversion
 * has to happen where it can be seen.
 */
export type EpochSeconds = number & { readonly [epochSecondsBrand]: true };

/** Declare that a number already IS epoch seconds (a fixture, a parsed field). */
export function epochSeconds(value: number): EpochSeconds {
  return value as EpochSeconds;
}

/** Convert a millisecond wall clock (`Date.now()`) to epoch seconds. */
export function epochSecondsFromMs(ms: number): EpochSeconds {
  return (ms / 1000) as EpochSeconds;
}

export interface StructuredSpawnCardState {
  launchId: string;
  clientAttemptId: string | null;
  accountId: string | null;
  /** The displayed account came from an explicit launch pin, so account
      selection changes cannot retarget this launch. */
  accountPin?: boolean;
  /** The durable conversation this launch created/owns (issue #653). The client
      keys the launch-owned optimistic bubble on THIS id, so a pane renders the
      bubble only inside its own conversation — never leaked into an unrelated
      pane. A legacy payload that omits it cannot own a launch bubble. */
  conversationId?: string;
  /** The native generation this launch owns or reserves inside
      {@link conversationId} (issue #922). Conversation identity alone is
      insufficient because the outbox intentionally survives account-migration
      generations. The client joins launch bubbles only when both values match. */
  generation?: number;
  state: "starting" | "binding" | "queued" | "reconciling" | "recoverable-timeout" | "live-late-success" | "failed" | "recovered";
  initialMessage: "pending" | "queued" | "delivered" | "failed";
  retrySafe: boolean;
  error: string | null;
  /** The initial launch prompt (issue #614), sourced from the queued initial
      delivery so ANY surface — not only the browser that ran the composer —
      renders it as the conversation's first user bubble while the transcript is
      still absent. Present only while the delivery still carries its text (it is
      cleared once delivered, by which point the transcript echoes it); the seed
      it produces is keyed by {@link launchId}, so it survives a refresh and
      transcript adoption and never duplicates the composer's own seed. */
  prompt?: string;
  /** How many images rode with the launch prompt, for the bubble's count chip. */
  promptImages?: number;
  /** Submission moment (ms) of the launch prompt — the receipt's creation time —
      so the seeded bubble orders ahead of any follow-up the operator queues. */
  promptAt?: number;
  /** The canonical text the transcript will echo for this launch (issue #615) —
      the delivered message, which for a role launch is the scaffold PLUS the raw
      draft. The optimistic bubble displays `prompt` (the raw draft) but retires on
      THIS text, so a scaffolded role launch never lingers and never duplicates. */
  promptEcho?: string;
  /** When the launch's initial message actually reached the agent (ms, issue
      #648). A structured / MCP spawn journals its first user record with SDK /
      agent provenance, so the transcript renders it as a system row and the
      echo-text retirement never fires. This receipt timestamp is the independent
      settlement proof: the client settles the launch bubble to `delivered` with
      THIS value as its `settledAt`, so it retires on the delivered TTL even when
      no echo ever matches. Present once the delivery receipt reports delivered;
      it survives prompt scrubbing so a materialized window can still settle. */
  deliveredAt?: number;
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

/**
 * A decision the project's orchestrator is waiting on the operator for
 * (issue #1168): its newest unanswered `blocked`/`question` bridge report.
 *
 * The bridge report log is drained only by the voice gateway, so with that
 * channel off a manager saying "I cannot proceed" reached the operator as
 * prose in a feed and nothing more. This is the same fact, shaped for the
 * attention queue and carrying only what that queue needs: the report's own
 * key, so re-reading the log can never enqueue it twice, and the time it was
 * filed, which is both the item's `since` and what ages it out. The report's
 * prose stays in the feed that already renders it.
 */
export interface BridgeAsk {
  /** The caller's report key — stable across re-reads, and the item's id. */
  id: string;
  /** ISO time the manager filed the report; the attention item's `since`. */
  at: string;
}

/** One sidebar entry returned by GET /api/files. */
export interface FileEntry {
  path: string;
  root: RootKey;
  /** Path relative to its root. */
  name: string;
  project: string;
  /** Human repository label carried separately from the stable project key. */
  projectName?: string;
  /** The scanner could not prove a repository identity for this entry. */
  projectUnresolved?: true;
  /** Durable conversation-level project authority (issue #315): explicit
      operator spawn intent or a completed relocation. When present, `project`
      was resolved from it and derived-attribution overlays must not regroup
      the entry. */
  projectOwnership?: { project: string; source: "operator" | "relocation"; setAt: string; operationId: string };
  /** Working directory recorded by the conversation transcript. */
  cwd?: string | null;
  /** Identity-bound session creation time parsed from the transcript header. */
  sessionStartedAt?: string | null;
  /** Native Codex parent thread parsed from the identity-bound transcript header. */
  nativeParentThreadId?: string | null;
  /** Source thread of a Codex provider `thread/fork` artifact (issue #708),
      parsed from the FIRST `session_meta` row of the identity-bound header.
      `null` means the header was read and named no source; absent means no
      reader has resolved it yet, so a consumer must derive it itself. */
  nativeForkSourceThreadId?: string | null;
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
  /** How this conversation came to exist (issue #339 board provenance):
      `viewer` for preallocated spawn cards, receipt-owned conversations and
      `viewer-spawn` lineage edges; `engine` for engine-native subagent edges.
      A Viewer root carries `viewer` provenance even though it has no parent
      edge. Unattributed external roots stay undefined. */
  spawnOrigin?: "viewer" | "engine";
  /** Durable report-run marker (issue #1091): this conversation is the Telegram
      Daily Report run with THIS run id, read from the launch receipt the
      registry keeps. It survives a registry reload with no Daily Reports
      history file present, which is what lets the board group the runs under
      the Telegram panel and lets a run be re-linked to its stored report. */
  telegramReport?: { runId: string };
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
      filters Claude task-notification records and viewer-injected relays. This
      protects process reaping; the board's pure view projection uses its own
      activity, settlement and operator-pin evidence. */
  userAuthored?: boolean;
  /** The reaper has NOT scanned this transcript since its latest activity, so
      its authorship is unconfirmed (issue #112). Set for claude/codex
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
  /** The open bridge ask this conversation's orchestrator seat is sitting on
      (issue #1168), stamped server-side from the durable report log. Present
      only on a designated seat's entry; null or absent everywhere else. */
  bridgeAsk?: BridgeAsk | null;
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
  /** Timestamp of the newest visible assistant message in the transcript tail,
      in Unix epoch milliseconds. Synthetic no-op records and tool-only
      assistant records do not count: this is acknowledgment evidence the
      operator could actually see. Null means the complete scanned tail carried
      no such message; absent means the derivation has not run or a truncated
      prefix prevents that conclusion. */
  lastAssistantMessageAt?: number | null;
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
    /** Recorded delegation depth (#393): 0 for operator/external roots,
        depth(origin)+1 for delegated launches; absent/null for legacy records. */
    depth?: number | null;
    parentConversationId: string | null;
    reviewsConversationId: string | null;
    memberships: Array<{
      kind: "flow" | "pipeline" | "orchestrator";
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
  /** Terminal cross-conversation supersedence (issue #383): a recovery spawn
      or stage retry replaced this round with a successor conversation. The
      card leaves Current Work, never projects working/waiting, and its
      composer is replaced by navigation to the live successor. Projection
      metadata only — never identity-bearing. */
  supersededBy?: {
    /** Immediate successor — the next round in the chain; retained as history. */
    conversationId: string;
    path: string | null;
    at: string;
    reason: string;
    /** Live end of the supersedence chain (A→B→C projects C on A): primary
        navigation opens the tail, the immediate edge above stays the lineage. */
    tailConversationId?: string;
    tailPath?: string | null;
  };
  /** Lineage of a supersedence-chain tail (issue #383): this card continues
      round N of the superseded predecessor named here. */
  continues?: { conversationId: string; path: string | null; round: number };
  /** Live per-session migration annotation while an intent drains. Absent for
      every session not currently migrating. */
  migration?: ConversationMigration;
  /** Durable launch projection shown before its transcript enters the scan. */
  spawn?: StructuredSpawnCardState;
  /** Transient launch/delivery facts of the launch that CREATED this live
      conversation (issue #569). The launch never projects a second board entry
      once its transcript exists — it folds into this conversation's own window
      as compact status chips, and drops off once it stops being news. */
  launch?: StructuredSpawnCardState;
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
  /** Human repository label; grouping and routing continue to use `project`. */
  displayName?: string;
  /** Canonical repository root derived from every conversation in the full scan. */
  projectRoot?: string;
  /** GitHub `owner/repo` of the projectRoot's origin remote, cached server-side;
      null when the root has no resolvable GitHub remote (issue chips then render
      as plain text instead of dead links). */
  repository?: string | null;
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
  /** Legacy project key to stable repository identity aliases. */
  projectAliases?: Record<string, string>;
  /** Stable repository identity to human display label. */
  projectDisplayNames?: Record<string, string>;
  /** Projects the operator crowned (server-durable): they pin to the top of the
      rail on every client, unlimited count. */
  crownedProjects?: string[];
  /** Existing local repository fallback for projects whose conversations lack cwd metadata. */
  projectCwds?: Record<string, string>;
  flows: Flow[];
  pipelines: Pipeline[];
  /** Present when the pipelines store failed closed; the rest of the payload stays valid. */
  pipelinesError?: string;
  workflows: Workflow[];
  tasks: BoardTask[];
  systemHealth: {
    tmux: TmuxEndpointHealth;
    registry?: Omit<
      import("@/lib/agent/registry").AgentRegistryStorageDiagnostics,
      "mirrorAgeMs" | "writerRatePerSecond"
    >;
  };
  /** Durable conversation-id aliases (old id → canonical id), so a deep link
      copied before provisional-id adoption still resolves its card. */
  conversationAliases?: Record<string, string>;
  /** Durable launch routes (`spawn:<launchId>` → canonical conversation id), so
      a refresh or a copied launch link lands on the live conversation instead
      of a placeholder that outlived its own success (issue #569). */
  launchRoutes?: Record<string, string>;
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
  /** Set on a superseded/conflicting request (issue #383): the live successor
      conversation the caller should redirect to instead. */
  successorConversationId?: string;
}

export type LimitsSource = "live" | "transcript" | "cache" | "unavailable";
export type LimitWindowSource = LimitsSource | "account";

/** One rate-limit window (5h session or weekly) of an engine subscription. */
export interface LimitWindow {
  usedPercent: number;
  /** Unix seconds of this window's selected observation after reconciliation. */
  observedAt?: number | null;
  /** Selected origin for this window after per-window reconciliation. */
  source?: LimitWindowSource;
  /** Unix seconds when the window resets, or null when unknown. */
  resetsAt: number | null;
  /** The window's own length in minutes as the provider declared it (Codex
      `windowDurationMins` / `window_minutes`; 300 and 10080 for Claude's two
      windows). This is the horizon the number carries, and labels are taken
      from it. Absent on snapshots cached before issue #606. */
  windowMinutes?: number | null;
}

/** Plan rate limits of one engine, returned by GET /api/limits. */
export interface EngineLimits {
  session: LimitWindow | null;
  weekly: LimitWindow | null;
  plan: string | null;
  /** Unix seconds of the oldest selected window observation. Null means the
      provider supplied no observation clock. */
  capturedAt: number | null;
}

/** Origin and freshness are independent for each engine. Reasons are safe for
    display/logging and never contain credential material. */
export interface LimitsProvenance {
  source: LimitsSource;
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
  /** True when the current snapshot carries no window of this horizon at all —
      e.g. a Codex plan that reports only a weekly limit. The chart then names
      that reason instead of the generic "no history yet" (issue #606). */
  windowUnreported?: boolean;
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
/** How many structured hosts one resources payload may carry. The footer polls
    this list, so the bound belongs to the payload rather than to any one
    producer: the registry read, the process scan and the served rows all stop
    here however many hosts the machine accumulated. */
export const RESOURCE_STRUCTURED_HOST_LIMIT = 512;

export interface ResourceSession {
  target: string;
  /** Root pid of the attributed tree: the tmux pane for a legacy row, the host
      process itself for a structured one. */
  panePid: number;
  /** Transport that owns this row. Absent on observations persisted before
      structured hosts were listed, which only ever held tmux panes. */
  kind?: "tmux" | "structured";
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
  /** Structured rows only, from the registry record behind the host. */
  model?: string | null;
  role?: string | null;
  conversationId?: string | null;
  /** Pipeline stage this host serves, when it belongs to one. */
  stage?: string | null;
  /** `owned`: the runtime still holds the host and can terminate it through its
      own lifecycle. `released`: only the registry knows it. `orphaned`: its
      worktree is gone, or no registry record covers the process at all. */
  ownership?: "owned" | "released" | "orphaned";
  /** A live orchestrator seat. Listed like any other host, but left out of the
      bulk kills unless the operator ticks it explicitly. */
  seat?: boolean;
  /** The engine turn has not settled: killing this host interrupts work. */
  turnBusy?: boolean;
}

/** GET /api/resources response. `system` is null when no platform probe worked. */
export interface ResourcesPayload {
  system: ResourcesSystem | null;
  sessions: ResourceSession[];
}
