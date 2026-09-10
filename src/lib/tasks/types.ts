export type TaskStatus = "inbox" | "assigned" | "blocked" | "done";

/** Board membership of a task's band. Absent on a row is `shown`; the value is
    written explicitly so a restore is durable and readable in the state file. */
export type TaskBoardVisibility = "shown" | "hidden";

/** `linked` records membership only (#1586): the conversation belongs to the
    task, nothing was delivered or handed off. */
export type AssignmentState = "delivered" | "failed" | "spawning" | "handoff" | "linked";

/** Why a task exists when no operator created it (#1586). The key is the
    durable admission identity — a conversation id, a client launch key, or a
    pipeline/flow id — so a replayed admission converges on this task. */
export interface TaskOrigin {
  kind: "conversation" | "launch" | "pipeline" | "flow";
  key: string;
  /** `pending` until an agent's first-action refinement or an operator edit
      gives the placeholder a real title. */
  refinement: "pending" | "titled";
  /** Conversation whose one-shot refinement titled the task, and the text it
      supplied, so a replay of the same refinement is recognised. */
  refinedBy?: string;
  refinedText?: string;
}

export interface TaskAssignment {
  /** Durable Viewer launch identity used to replay attribution safely. */
  launchId?: string | null;
  /** Client idempotency key paired with launchId. */
  clientAttemptId?: string | null;
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

/** Stable assignment identity used when transcript attribution is incomplete or
 * a conversation has moved to a newer path. Matching uses launch id,
 * conversation id, path, and pane pid in that order — the launch id exists from
 * the moment of spawn, so a pathless spawning assignment is always reachable. */
export interface AssignmentRef {
  launchId?: string | null;
  path?: string | null;
  conversationId?: string | null;
  panePid?: number | null;
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
  /** Placement state (issue #17 owns `auto`): `pinned` ⇔ a human chose this exact
      spot (`pos` present), and the board's collision pass treats it as law —
      never nudged, even atop a pane. `auto` cards (curator/inbox lattice) also
      carry a `pos` but get collision + obstacle clearance. `unplaced` has no
      `pos` and is absent from the board until placed. */
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
  /** Admission origin of a placeholder task (#1586); absent on operator-created tasks. */
  origin?: TaskOrigin;
  /** Whether an EMPTY band may be drawn for this task. Absent means shown — the
      default for every task the operator or an agent creates. `hidden` is only
      ever written by an explicit «Remove from board», by the task panel's
      preference control, or once by the legacy-task migration, and it is a
      preference rather than a claim about membership: a task whose band
      resolves a conversation, a mirror, a container or a draft is drawn
      whatever this says (`boardVisibility`). The task itself is never deleted
      or archived and never leaves the task list. */
  board?: TaskBoardVisibility;
  createdAt: string;
  updatedAt: string; // bumped by every PATCH
}
