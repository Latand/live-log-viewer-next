import type { Flow, FlowAnnotation } from "@/lib/flows/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { Workflow } from "@/lib/workflows/types";

export type RootKey =
  | "codex-sessions"
  | "claude-projects"
  | "claude-tasks";

export type Engine = "codex" | "claude" | "shell";
export type Activity = "live" | "recent" | "stalled" | "idle";
export type Fmt = "codex" | "claude" | "plain";

/** One sidebar entry returned by GET /api/files. */
export interface FileEntry {
  path: string;
  root: RootKey;
  /** Path relative to its root. */
  name: string;
  project: string;
  /** Git worktree name when cwd lives under <repo>/.claude/worktrees/<name>. */
  worktree?: string;
  title: string;
  engine: Engine;
  kind: string;
  fmt: Fmt;
  /** Absolute path of the parent node (tree link) or null for roots. */
  parent: string | null;
  /** Unix seconds. */
  mtime: number;
  size: number;
  activity: Activity;
  /** Machine-readable reason behind `activity` (jsonl_turn_open, mtime_fresh…). */
  activityReason?: string;
  /** Real OS process state when the entry maps to a process, else null. */
  proc: "running" | "done" | "killed" | null;
  pid: number | null;
  /** Set when this conversation was spawned by a handoff from `parent`. */
  handoff?: boolean;
  /** Short model name (fable, gpt-5.5, sonnet…) or null when unknown. */
  model: string | null;
  /** Exact model identifier recorded by the agent CLI. Kept separate from the
      display-normalized `model` because resuming a pinned Claude model needs
      the original identifier. */
  launchModel?: string | null;
  /** Reasoning-effort tier (minimal|low|medium|high|xhigh|max) or null when
      no reliable source exists (claude transcripts carry none). */
  effort?: string | null;
  /** Structured Claude prompt that is currently blocking the live agent. */
  pendingQuestion: PendingQuestion | null;
  /** Newest TodoWrite/update_plan state — the agent's plan and current goal. */
  plan?: AgentPlan | null;
  /** Context-window fullness from the transcript tail, when it carries usage. */
  ctx?: CtxUsage | null;
  /** Codex only: the thread's declared goal (objective + status). */
  goal?: AgentGoal | null;
  /** Best-effort TUI scrape fallback for prompts without a transcript protocol. */
  waitingInput: WaitingInput | null;
  /** claude-tasks only: recovered originating Bash command ("" if not found). */
  cmd?: string;
  /** claude-tasks only: the Bash tool `description` field. */
  cmdDesc?: string;
  /** Review-loop ownership for grouping implementer/reviewer sessions. */
  flow?: FlowAnnotation;
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
  /** Unix seconds of the newest valid transcript candidate in the project. */
  smt: number;
  /** Lightweight count from the full candidate scan. */
  conversations: number;
}

export interface FilesResponse {
  files: FileEntry[];
  projectCatalog?: ProjectCatalogEntry[];
  flows: Flow[];
  workflows: Workflow[];
  tasks: BoardTask[];
}

export type PlanStepStatus = "pending" | "in_progress" | "completed";

/** How full an agent's context window is (codex token_count events; claude
    assistant usage vs the model's window). */
export interface CtxUsage {
  usedTokens: number;
  windowTokens: number;
  /** Rounded 0–100. */
  pct: number;
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
}

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
