import { mutateTasksFile, TASKS_FILE, type TaskMigrations } from "./store";

import { EMPTY_BOARD_VISIBILITY_MIGRATION, taskHasAgents } from "./boardVisibility";

/**
 * The one-time transition that emptied a board carrying hundreds of bandless
 * tasks. Kept apart from `boardVisibility` because that module states the rule
 * the BOARD applies and is imported by client components; this one reaches the
 * task store and must never enter the browser bundle.
 */

export interface BoardVisibilityMigrationResult {
  /** False when the migration had already been recorded — nothing was read or written. */
  applied: boolean;
  hidden: number;
  scanned: number;
}

/**
 * Hides every existing task that has no durable agent association, once.
 *
 * Recorded by name in the tasks file, so a later run is a no-op even if the
 * operator has since restored some of those bands by hand — a migration that
 * re-ran would undo their choice. Tasks created after it are unaffected and
 * start visible.
 */
export function migrateEmptyTaskBoardVisibility(
  now = () => new Date().toISOString(),
  filePath = TASKS_FILE,
): BoardVisibilityMigrationResult {
  return mutateTasksFile<BoardVisibilityMigrationResult>((state) => {
    if (state.migrations?.[EMPTY_BOARD_VISIBILITY_MIGRATION]) {
      return { state: undefined, result: { applied: false, hidden: 0, scanned: state.tasks.length } };
    }
    let hidden = 0;
    const tasks = state.tasks.map((task) => {
      if (taskHasAgents(task) || task.board !== undefined) return task;
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
   failure clears the guard so the next request retries rather than leaving the
   board permanently unmigrated. */
let attempted = false;

/** Runs {@link migrateEmptyTaskBoardVisibility} at most once per process. */
export function ensureEmptyTaskBoardVisibilityMigration(filePath = TASKS_FILE): void {
  if (attempted) return;
  attempted = true;
  try {
    migrateEmptyTaskBoardVisibility(undefined, filePath);
  } catch (error) {
    attempted = false;
    console.error("[tasks] empty task band visibility migration deferred", error);
  }
}

/** Test seam: forget that this process already ran the migration. */
export function resetEmptyTaskBoardVisibilityMigrationGuard(): void {
  attempted = false;
}
