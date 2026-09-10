import { mutateTasksFile, TASKS_FILE, type TaskMigrations } from "./store";

import { EMPTY_BOARD_VISIBILITY_MIGRATION } from "./boardVisibility";

/**
 * The one-time transition that emptied a board carrying hundreds of bandless
 * tasks. Kept apart from `boardVisibility` because that module states the rule
 * the BOARD applies and is imported by client components; this one reaches the
 * task store and must never enter the browser bundle.
 */

export interface BoardVisibilityMigrationResult {
  /** False when the migration had already been recorded, or when the scan it
      must judge against had nothing in it — nothing was read or written. */
  applied: boolean;
  hidden: number;
  scanned: number;
}

/** The conversations the board carries, as the scan reports them. */
export interface BoardScanFile {
  path: string;
  conversationId?: string | null;
}

/**
 * Turns the empty-band preference off for every legacy task, once.
 *
 * What it must NOT do is decide membership. The scan is not the rendered board:
 * it lists transcripts, while the board applies hidden/archive/placement policy
 * on top of them, so a conversation present in the scan may have no card on the
 * scene at all. A dry run against the operator's own state made that concrete —
 * 265 tasks would have been kept by a scan-key rule while only 11 bands
 * actually carried a conversation. Guessing membership from scanner data trades
 * one wrong answer for another.
 *
 * So the flag is written as what it is: a preference, set once for tasks that
 * predate it, saying "do not draw an empty band for me". Membership is decided
 * where it can actually be decided — at render, by what the board resolved
 * (`bandHoldsMembers`) — and a task that still holds a member, a draft or a
 * recovery representation draws its band whatever this preference says. Nothing
 * is deleted, no assignment is touched, every row stays in the task list, and
 * an explicit flag the operator already set is never overwritten. Tasks created
 * afterwards start shown, so a deliberately empty new task is not swept up.
 *
 * Recorded by name in the tasks file, so a later run is a no-op even if the
 * operator has since restored some of those bands by hand — a migration that
 * re-ran would undo their choice.
 */
export function migrateEmptyTaskBoardVisibility(
  boardScan: readonly BoardScanFile[],
  now = () => new Date().toISOString(),
  filePath = TASKS_FILE,
): BoardVisibilityMigrationResult {
  /* The scan is not read for membership — only as evidence that the Viewer has
     produced a scene at least once, so this one-time, operator-visible write
     does not land during a cold boot before there is a board to change. */
  if (!boardScan.length) return { applied: false, hidden: 0, scanned: 0 };
  return mutateTasksFile<BoardVisibilityMigrationResult>((state) => {
    if (state.migrations?.[EMPTY_BOARD_VISIBILITY_MIGRATION]) {
      return { state: undefined, result: { applied: false, hidden: 0, scanned: state.tasks.length } };
    }
    let hidden = 0;
    const tasks = state.tasks.map((task) => {
      if (task.board !== undefined) return task;
      hidden += 1;
      return { ...task, board: "hidden" as const };
    });
    const migrations: TaskMigrations = { ...(state.migrations ?? {}), [EMPTY_BOARD_VISIBILITY_MIGRATION]: now() };
    return {
      state: { ...state, tasks, migrations },
      result: { applied: true, hidden, scanned: state.tasks.length },
    };
  }, filePath);
}

/* Process-level guard so the read paths that feed the board can call this on
   every request without paying for a file transaction after the first one. A
   scan with nothing in it defers without consuming the attempt, so a board
   served before its first conversation is scanned is still migrated later.

   A failure retries a bounded number of times: a task file that is permanently
   unreadable would otherwise re-enter the transaction on every poll and log
   from every one of them. After the last attempt the migration stays deferred
   until the process restarts, and says so once. */
let attempts = 0;
const MIGRATION_ATTEMPT_LIMIT = 3;

/** Runs {@link migrateEmptyTaskBoardVisibility} at most once per process. */
export function ensureEmptyTaskBoardVisibilityMigration(
  files: readonly BoardScanFile[],
  filePath = TASKS_FILE,
): void {
  if (attempts >= MIGRATION_ATTEMPT_LIMIT || !files.length) return;
  attempts += 1;
  try {
    const result = migrateEmptyTaskBoardVisibility(files, undefined, filePath);
    /* A deferral is not an attempt: nothing was read, so nothing was learnt. */
    if (!result.applied && result.scanned === 0) attempts -= 1;
    else attempts = MIGRATION_ATTEMPT_LIMIT;
  } catch (error) {
    if (attempts >= MIGRATION_ATTEMPT_LIMIT) {
      console.error("[tasks] empty task band visibility migration abandoned for this process", error);
    } else {
      console.error("[tasks] empty task band visibility migration deferred", error);
    }
  }
}

/** Test seam: forget that this process already ran the migration. */
export function resetEmptyTaskBoardVisibilityMigrationGuard(): void {
  attempts = 0;
}
