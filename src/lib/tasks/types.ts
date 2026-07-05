export type TaskStatus = "inbox" | "assigned" | "blocked" | "done";

export type AssignmentState = "delivered" | "failed" | "spawning";

export interface TaskAssignment {
  /** Transcript path; null while a codex spawn awaits scanner attribution. */
  path: string | null;
  /** tmux pane pid captured at spawn — the codex rollout attribution handle. */
  panePid: number | null;
  state: AssignmentState;
  /** Last delivery error, shown on the ⚠ edge; null when delivered. */
  error: string | null;
  at: string; // ISO of the last attempt
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
  createdAt: string;
  updatedAt: string; // bumped by every PATCH
}
