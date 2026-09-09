import type { BoardTask } from "./types";

/**
 * Board membership of a task band: the rule the board itself applies.
 *
 * The task-centered board (#1586) draws one band per recorded task. Every task
 * ever created therefore reached the canvas, including the several hundred that
 * never had an agent on them: the operator's board became a vertical stack of
 * empty full-width bands with the working ones scrolled far off screen. The
 * repair is a per-task flag, not a deletion and not an archive — the task list
 * keeps every row, and «Show on board» puts a band back at any time.
 *
 * The rule is deliberately narrow: the flag is honoured only while the task is
 * EMPTY. A task that holds an agent draws its band whatever the flag says, so
 * hiding can never lose a live conversation.
 *
 * Pure by design — the board's client bundle imports this. The one-time
 * migration that first set the flag lives in `boardVisibilityMigration`, which
 * reaches the task store and stays server-side.
 */

/** Name recorded in the tasks file once the migration has run. */
export const EMPTY_BOARD_VISIBILITY_MIGRATION = "emptyTaskBandsHidden";

/**
 * Durable emptiness: a task is empty when nothing was ever associated with it.
 *
 * Read from the task's own recorded assignments, never from what the board
 * happens to be rendering. The board's `files` are one scan of one viewport —
 * a conversation whose transcript is not in the current page, or whose project
 * is not the open one, is missing from it, and using that as the test would
 * hide tasks whose agents simply were not on screen. An assignment row is
 * written at spawn and outlives the process, the pane, and the transcript.
 */
export function taskHasAgents(task: BoardTask): boolean {
  return task.assignments.length > 0;
}

/** Whether the board should draw a band for this task. */
export function taskShowsOnBoard(task: BoardTask): boolean {
  return task.board !== "hidden" || taskHasAgents(task);
}
