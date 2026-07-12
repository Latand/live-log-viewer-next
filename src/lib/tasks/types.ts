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

/** Where a task's card lives on the board.
 *  - `pinned`  ⇔ `pos` present; the card is drawn and draggable.
 *  - `unplaced` — no `pos`; created from the panel/mobile, absent from the
 *    board until an explicit place-on-map action pins it (identity unchanged).
 *  - `auto` — reserved for #17's render-derived placement; #8 never writes it.
 *  Legacy rows (a `pos`, no `placement`) load as `pinned`. */
export type TaskPlacement = "pinned" | "unplaced" | "auto";

/** Content-addressed durable image attached to a task at creation time. The
    bytes live at `attachments/tasks/<sha256>.<ext>` under the viewer state dir,
    shared across tasks/drafts; delivery references the path and never deletes it. */
export interface TaskAttachment {
  /** uuid, one per task↔file link. */
  id: string;
  /** Content address of the bytes — identical images upload to one file. */
  sha256: string;
  ext: "png" | "jpg" | "gif" | "webp";
  mime: string;
  bytes: number;
  createdAt: string;
}

export interface BoardTask {
  id: string; // crypto.randomUUID(), server-side
  project: string; // FileEntry.project — the board the card lives on
  status: TaskStatus;
  /** Plain text, ≤ 6000 chars (server-enforced). First line acts as the
      title everywhere a compact label is needed. */
  text: string;
  /** Placement state; `pinned` ⇔ `pos` present. */
  placement: TaskPlacement;
  /** Own world position on the board — the card is dragged freely. Absent
      while `placement` is `unplaced`. */
  pos?: { x: number; y: number };
  /** ISO-8601 UTC instant of the optional deadline. */
  dueAt?: string;
  /** IANA zone captured when `dueAt` was set/last edited: display and
      re-editing happen in this zone; overdue derives at render from `dueAt`. */
  dueTz?: string;
  /** Durable image attachments carried into every delivery as file paths. */
  attachments?: TaskAttachment[];
  assignments: TaskAssignment[];
  /** User prompt that produced an auto-captured inbox card. */
  source?: TaskSource;
  createdAt: string;
  updatedAt: string; // bumped by every PATCH
}
