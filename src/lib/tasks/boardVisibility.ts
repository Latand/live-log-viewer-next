import type { BoardTask, TaskAssignment } from "./types";

/**
 * The board's empty-band preference, and the rule that applies it.
 *
 * The task-centered board (#1586) draws one band per recorded task. Every task
 * ever created therefore reached the canvas, including the several hundred that
 * never had an agent on them: the operator's board became a vertical stack of
 * empty full-width bands with the working ones scrolled far off screen. The
 * repair is a per-task flag, not a deletion and not an archive — the task list
 * keeps every row, and «Show on board» puts a band back at any time.
 *
 * The flag is honoured only while the task has nothing on the board, so hiding
 * can never lose a live conversation. WHAT COUNTS AS HOLDING SOMETHING is the
 * whole question, and it is answered where it can be: at render, by what the
 * band actually resolved (`bandHoldsMembers` in `scheme/taskBands`), which is
 * passed in here as `hasMembers`.
 *
 * Two answers that look plausible and are not:
 *
 *  - the assignment ROW. It is written at spawn and never removed, so a task
 *    whose conversation has since been archived, hidden or aged off the board
 *    keeps it forever — 319 of the operator's 385 empty bands carried one.
 *  - the SCAN. It lists transcripts; the board applies hidden/archive/placement
 *    policy on top of them, so a conversation the scan carries may have no card
 *    on the scene at all. A dry run against the operator's own state kept 265
 *    tasks that way while only 11 bands actually held a conversation.
 *
 * Being off screen is a third thing again, and not membership either: the
 * camera frames a part of the board, and a member scrolled far out of view is
 * still a member. Nothing in this module reads a viewport.
 *
 * The scan-keyed helpers below answer a smaller, honest question for surfaces
 * that have no scene to consult — "does this task still name a conversation the
 * scan carries?" — which the task panel shows as a note beside its preference
 * control. They are never the visibility rule.
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
 * Whether at least one recorded assignment still names a conversation the scan
 * carries. Not membership — the board may draw no card for that conversation —
 * but enough to tell a task that once had an agent from one that never did.
 */
export function taskHasBoardMembers(task: BoardTask, keys: BoardConversationKeys): boolean {
  return task.assignments.some((assignment) => assignmentOnBoard(assignment, keys));
}

/**
 * Whether the board should draw a band for this task.
 *
 * `hasMembers` is the caller's answer to the membership question — for the
 * board, what its band resolved. It is passed in rather than computed here so
 * that the surface which can actually see the scene is the one that answers,
 * and every other surface has to say out loud that it is guessing.
 */
export function taskShowsOnBoard(task: BoardTask, hasMembers: boolean): boolean {
  return task.board !== "hidden" || hasMembers;
}

/**
 * How many of a project's tasks occupy a band on the board.
 *
 * This is the count the per-project admission limit is taken against (#1627).
 * It is the same rule the board renders by — {@link taskShowsOnBoard} — asked
 * of every row of one project, so the number a refusal quotes and the number of
 * bands the operator can see are the same statement, and there is no second
 * definition of membership to drift from the first.
 *
 * `hasMembers` is again the caller's answer, and again nobody guesses it here.
 * A caller with no scene to consult passes `() => false`, which counts exactly
 * the tasks the board is ASKED to draw: a hidden row that still holds an agent
 * draws its band whatever the flag says, but that band belongs to a launch, and
 * mandatory launch membership is exempt from this limit by construction
 * (`ensureTaskMembership`) — so counting it would only refuse the operator a
 * band they can see is missing. A caller that can answer truthfully (the board,
 * a test, any surface holding the resolved bands) passes its own predicate and
 * gets those rows counted.
 */
export function countBoardTasks(
  tasks: readonly BoardTask[],
  project: string,
  hasMembers: (task: BoardTask) => boolean,
): number {
  let count = 0;
  for (const task of tasks) {
    if (task.project !== project) continue;
    if (taskShowsOnBoard(task, hasMembers(task))) count += 1;
  }
  return count;
}

/**
 * The note the task panel shows: does this row still name a conversation the
 * open project's scan carries?
 *
 * A task belonging to another project is answered from its own recorded
 * assignments, because this scan carries no conversation of that board and its
 * silence is not evidence. Informational only — the panel offers its preference
 * control on every row whatever this says.
 */
export function taskMembershipInScope(task: BoardTask, project: string, keys: BoardConversationKeys): boolean {
  return task.project === project ? taskHasBoardMembers(task, keys) : task.assignments.length > 0;
}
