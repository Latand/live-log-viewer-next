export type TaskStatus = "inbox" | "assigned" | "blocked" | "done";

export type AssignmentState = "delivered" | "failed" | "spawning" | "handoff";

export interface TaskAssignment {
  /** Transcript path; null while a codex spawn awaits scanner attribution. */
  path: string | null;
  /** Stable Viewer owner; paths remain native-generation provenance. */
  conversationId?: string | null;
  /** tmux pane pid captured at spawn — the codex rollout attribution handle. */
  panePid: number | null;
  state: AssignmentState;
  /** Last delivery error, shown on the ⚠ edge; null when delivered. */
  error: string | null;
  at: string; // ISO of the last attempt
  /** Account fixed when the agent is first launched; retries keep this owner. */
  accountId?: string | null;
  /** Engine paired with accountId. A Claude account id can equal a Codex id. */
  engine?: "claude" | "codex" | null;
}

export interface TaskSource {
  path: string;
  ts: string | null;
  text: string;
  fingerprint: string;
  engine: "claude" | "codex";
}

export interface BoardTask {
  id: string; // crypto.randomUUID(), server-side
  project: string; // FileEntry.project — the board the card lives on
  status: TaskStatus;
  /** Plain text, ≤ 6000 chars (server-enforced). First line acts as the
      title everywhere a compact label is needed. */
  text: string;
  /** Own world position on the board — the card is dragged freely. */
  pos: { x: number; y: number };
  assignments: TaskAssignment[];
  /** User prompt that produced an auto-captured inbox card. */
  source?: TaskSource;
  createdAt: string;
  updatedAt: string; // bumped by every PATCH
}
