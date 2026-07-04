export type RootKey =
  | "codex-jobs"
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
  /** Real OS process state when the entry maps to a process, else null. */
  proc: "running" | "done" | "killed" | null;
  pid: number | null;
  /** Short model name (fable-5, gpt-5.5, sonnet…) or null when unknown. */
  model: string | null;
  /** Structured Claude prompt that is currently blocking the live agent. */
  pendingQuestion: PendingQuestion | null;
  /** Best-effort TUI scrape fallback for prompts without a transcript protocol. */
  waitingInput: WaitingInput | null;
  /** claude-tasks only: recovered originating Bash command ("" if not found). */
  cmd?: string;
  /** claude-tasks only: the Bash tool `description` field. */
  cmdDesc?: string;
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

export interface WaitingInput {
  since: number;
  screenTail: string;
  target: string;
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

export interface LimitsPayload {
  claude: EngineLimits | null;
  codex: EngineLimits | null;
}
