import type { BoardTask, TaskAssignment } from "./types";

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
 * The rule is deliberately narrow: the flag is honoured only while the task has
 * nothing on the board. A task that still holds a member draws its band
 * whatever the flag says, so hiding can never lose a live conversation.
 *
 * WHAT COUNTS AS HOLDING SOMETHING is the whole question, and the answer is
 * membership, not history. An assignment row is written at spawn and is never
 * removed, so a task whose conversation has since been archived, hidden or
 * aged out of the board keeps that row forever. Reading the row alone left 319
 * of the operator's 385 empty bands on the board — every one of them drawing
 * `0 working · 0 conversations`, which is the complaint. So an assignment
 * counts when it still resolves to a conversation THE BOARD CARRIES.
 *
 * That is not the same as being on screen. The camera frames a part of the
 * board; a member scrolled far out of view, or in a band the operator has not
 * reached, is still a member and still keeps its task visible. The question is
 * asked against the board's own set of conversations, never against a viewport.
 *
 * Pure by design — the board's client bundle imports this. The one-time
 * migration that first set the flag lives in `boardVisibilityMigration`, which
 * reaches the task store and stays server-side.
 */

/** Name recorded in the tasks file once the migration has run. */
export const EMPTY_BOARD_VISIBILITY_MIGRATION = "emptyTaskBandsHidden";

/** The conversations a board carries, by every key an assignment can name. */
export type BoardConversationKeys = ReadonlySet<string>;

/**
 * Indexes a board's conversations for {@link taskHasBoardMembers}.
 *
 * Both keys are recorded because an assignment may carry either: a durable
 * conversation id (which survives the transcript moving to a new generation and
 * a new path) or, while a spawn is still awaiting scanner attribution, only the
 * path it was launched at.
 */
export function boardConversationKeys(
  files: Iterable<{ path: string; conversationId?: string | null }>,
): Set<string> {
  const keys = new Set<string>();
  for (const file of files) {
    if (file.path) keys.add(file.path);
    if (file.conversationId) keys.add(file.conversationId);
  }
  return keys;
}

/** Whether one recorded assignment still names a conversation on the board. */
export function assignmentOnBoard(assignment: TaskAssignment, keys: BoardConversationKeys): boolean {
  if (assignment.conversationId && keys.has(assignment.conversationId)) return true;
  return Boolean(assignment.path && keys.has(assignment.path));
}

/**
 * Durable membership: at least one recorded assignment still resolves to a
 * conversation this board carries.
 *
 * Read from the task's own recorded assignments against the board's own
 * conversations — never from what a viewport happens to be showing.
 */
export function taskHasBoardMembers(task: BoardTask, keys: BoardConversationKeys): boolean {
  return task.assignments.some((assignment) => assignmentOnBoard(assignment, keys));
}

/**
 * Whether the board should draw a band for this task.
 *
 * `hasMembers` is the caller's answer to the membership question above, because
 * the two callers resolve it from different evidence and must not each invent
 * their own rule: the board asks its own workflow projection, which has already
 * resolved every assignment to a scanned conversation (including generations),
 * and the server asks the scan the board is about to be served.
 */
export function taskShowsOnBoard(task: BoardTask, hasMembers: boolean): boolean {
  return task.board !== "hidden" || hasMembers;
}

/**
 * Membership as the OPEN project's board can judge it, for surfaces that list
 * tasks across projects (the task panel).
 *
 * A task belonging to another project is judged by its recorded assignments
 * instead: this scan carries no conversations of that board, so the absence of
 * a member here is not evidence of anything, and treating it as one would offer
 * to hide a band that project is drawing.
 */
export function taskMembershipInScope(task: BoardTask, project: string, keys: BoardConversationKeys): boolean {
  return task.project === project ? taskHasBoardMembers(task, keys) : task.assignments.length > 0;
}
