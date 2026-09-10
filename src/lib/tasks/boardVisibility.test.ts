import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  boardConversationKeys,
  EMPTY_BOARD_VISIBILITY_MIGRATION,
  taskHasBoardMembers,
  taskMembershipInScope,
  taskShowsOnBoard,
} from "./boardVisibility";
import {
  ensureEmptyTaskBoardVisibilityMigration,
  migrateEmptyTaskBoardVisibility,
  resetEmptyTaskBoardVisibilityMigrationGuard,
} from "./boardVisibilityMigration";
import { patchTask } from "./commands";
import { loadTasksFile, saveTasksFile } from "./store";
import type { BoardTask } from "./types";

/**
 * Board membership of a task band (#1614 item 1).
 *
 * Every test here owns its own state file under a throwaway temp directory, so
 * nothing reads or writes the operator's real task state.
 */

function stateFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llv-board-visibility-")), "tasks.json");
}

function task(id: string, over: Partial<BoardTask> = {}): BoardTask {
  return {
    id, project: "repo-board", status: "assigned", text: `Task ${id}`, placement: "unplaced",
    assignments: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as BoardTask;
}

const assignment = { path: "/agent.jsonl", conversationId: "conversation-agent", panePid: null, state: "delivered" as const, error: null, at: "2026-01-01T00:00:00.000Z" };
/* A row left behind by a launch whose conversation the board no longer draws —
   archived, hidden, or simply never scanned again. On the reported board 319 of
   385 empty bands looked exactly like this. */
const staleAssignment = { ...assignment, path: "/archived.jsonl", conversationId: "conversation-archived" };
/* The board carries one conversation: the one `assignment` names. */
const scanFiles = [{ path: "/agent.jsonl", conversationId: "conversation-agent" }];
const board = boardConversationKeys(scanFiles);

test("the flag governs tasks with nothing on the board — a task still holding one shows whatever it says", () => {
  expect(taskShowsOnBoard(task("plain"), false)).toBe(true);
  expect(taskShowsOnBoard(task("hidden", { board: "hidden" }), false)).toBe(false);
  expect(taskShowsOnBoard(task("restored", { board: "shown" }), false)).toBe(true);
  /* The invariant that keeps a live conversation reachable: a member overrides
     the flag, so hiding can never take a working band off the board. */
  const staffed = task("staffed", { board: "hidden", assignments: [assignment] });
  expect(taskHasBoardMembers(staffed, board)).toBe(true);
  expect(taskShowsOnBoard(staffed, taskHasBoardMembers(staffed, board))).toBe(true);
});

test("membership is what the board carries, not that an assignment row exists (#1614)", () => {
  /* The interpretation this replaces asked `assignments.length > 0`, which is
     true for every task ever launched. It is the difference between 66 bands
     leaving the operator's board and 385. */
  const stale = task("stale", { board: "hidden", assignments: [staleAssignment] });
  expect(stale.assignments).toHaveLength(1);
  expect(taskHasBoardMembers(stale, board)).toBe(false);
  expect(taskShowsOnBoard(stale, taskHasBoardMembers(stale, board))).toBe(false);

  /* One resolving row among several stale ones is still membership. */
  const mixed = task("mixed", { board: "hidden", assignments: [staleAssignment, assignment] });
  expect(taskShowsOnBoard(mixed, taskHasBoardMembers(mixed, board))).toBe(true);

  /* Either key resolves it: a durable conversation id survives the transcript
     moving to a new path, and a spawn awaiting attribution has only the path. */
  const moved = task("moved", { board: "hidden", assignments: [{ ...assignment, path: "/agent-2.jsonl" }] });
  expect(taskHasBoardMembers(moved, board)).toBe(true);
  const pathOnly = task("path-only", { board: "hidden", assignments: [{ ...assignment, conversationId: null }] });
  expect(taskHasBoardMembers(pathOnly, board)).toBe(true);

  /* Nothing here consults a camera: the key set is the board's conversations,
     however far outside the viewport they are laid out. */
  expect(taskHasBoardMembers(task("none", { assignments: [] }), board)).toBe(false);
});

test("a task of another project is judged by its own record, never by this board's scan", () => {
  /* The task panel lists every project. This scan carries no conversation of
     another board, so absence here is not evidence — and treating it as one
     would offer to hide a band that project is drawing. */
  const foreign = task("foreign", { project: "other-repo", assignments: [staleAssignment] });
  expect(taskMembershipInScope(foreign, "repo-board", board)).toBe(true);
  expect(taskMembershipInScope({ ...foreign, project: "repo-board" }, "repo-board", board)).toBe(false);
  expect(taskMembershipInScope(task("empty-foreign", { project: "other-repo" }), "repo-board", board)).toBe(false);
});

test("the one-time migration hides existing empty tasks, keeps every task, and never runs twice", () => {
  const file = stateFile();
  const before: BoardTask[] = [
    task("empty-one"),
    task("empty-two"),
    task("staffed", { assignments: [assignment] }),
    task("already-decided", { board: "shown" }),
  ];
  saveTasksFile({ tasks: before, recentCreates: [], migrations: {} }, file);

  const first = migrateEmptyTaskBoardVisibility(scanFiles, () => "2026-02-02T00:00:00.000Z", file);
  expect(first).toEqual({ applied: true, hidden: 3, scanned: 4 });

  const after = loadTasksFile(file);
  /* Nothing is deleted or archived: every row is still in the task list. */
  expect(after.tasks.map((entry) => entry.id).sort()).toEqual(["already-decided", "empty-one", "empty-two", "staffed"]);
  const boardOf = new Map(after.tasks.map((entry) => [entry.id, entry.board]));
  expect(boardOf.get("empty-one")).toBe("hidden");
  expect(boardOf.get("empty-two")).toBe("hidden");
  /* The preference is written for the task with an agent too — its band is kept
     by what the board resolves, not by the flag — and an explicit prior
     decision by the operator wins. */
  expect(boardOf.get("staffed")).toBe("hidden");
  expect(taskShowsOnBoard(after.tasks.find((entry) => entry.id === "staffed")!, true)).toBe(true);
  expect(boardOf.get("already-decided")).toBe("shown");
  expect(after.migrations?.[EMPTY_BOARD_VISIBILITY_MIGRATION]).toBe("2026-02-02T00:00:00.000Z");

  /* A restore by hand must survive: re-running the migration would undo the
     operator's choice, so the recorded marker refuses the second run. */
  const restored = patchTask(after.tasks, "empty-one", { board: "shown" });
  expect(restored.ok).toBe(true);
  if (!restored.ok) throw new Error("patch refused");
  saveTasksFile({ tasks: restored.tasks, recentCreates: [], migrations: after.migrations }, file);

  const second = migrateEmptyTaskBoardVisibility(scanFiles, () => "2026-03-03T00:00:00.000Z", file);
  expect(second.applied).toBe(false);
  const settled = loadTasksFile(file);
  expect(settled.tasks.find((entry) => entry.id === "empty-one")?.board).toBe("shown");
  expect(settled.migrations?.[EMPTY_BOARD_VISIBILITY_MIGRATION]).toBe("2026-02-02T00:00:00.000Z");
});

test("a task write that does not mean to touch migrations keeps the marker", () => {
  const file = stateFile();
  saveTasksFile({ tasks: [task("empty-one")], recentCreates: [], migrations: {} }, file);
  migrateEmptyTaskBoardVisibility(scanFiles, () => "2026-02-02T00:00:00.000Z", file);

  const current = loadTasksFile(file);
  /* A caller that carries only tasks and receipts — the shape most writers in
     the codebase use — must not erase the marker and let the migration re-run. */
  saveTasksFile({ tasks: current.tasks, recentCreates: [] }, file);
  expect(loadTasksFile(file).migrations?.[EMPTY_BOARD_VISIBILITY_MIGRATION]).toBe("2026-02-02T00:00:00.000Z");
  expect(migrateEmptyTaskBoardVisibility(scanFiles, () => "2026-04-04T00:00:00.000Z", file).applied).toBe(false);
});

test("the flag round-trips through PATCH and through the persisted file", () => {
  const file = stateFile();
  const rows = [task("solo")];
  const hidden = patchTask(rows, "solo", { board: "hidden" });
  expect(hidden.ok).toBe(true);
  if (!hidden.ok) throw new Error("patch refused");
  expect(hidden.task.board).toBe("hidden");
  saveTasksFile({ tasks: hidden.tasks, recentCreates: [], migrations: {} }, file);
  expect(loadTasksFile(file).tasks[0]!.board).toBe("hidden");

  const shown = patchTask(hidden.tasks, "solo", { board: "shown" });
  expect(shown.ok).toBe(true);
  if (!shown.ok) throw new Error("patch refused");
  expect(shown.task.board).toBe("shown");
  expect(taskShowsOnBoard(shown.task, false)).toBe(true);

  const refused = patchTask(shown.tasks, "solo", { board: "archived" });
  expect(refused.ok).toBe(false);
  if (refused.ok) throw new Error("invalid visibility accepted");
  expect(refused.status).toBe(400);
});

test("the migration sets the empty-band preference on every legacy task, membership decided at render (#1614)", () => {
  /* The shape of the reported board, in miniature: most empty bands DO carry an
     assignment — one whose conversation the board draws nothing for. Neither
     the assignment row nor the scanner's file list can tell those apart from a
     live one (a scan lists transcripts; the board applies hidden/archive
     /placement policy on top of them), so the migration decides nothing about
     membership. It writes the preference for tasks that predate it, and the
     board keeps what it actually resolved. */
  const file = stateFile();
  const stale = Array.from({ length: 6 }, (_, index) => task(`stale-${index}`, {
    assignments: [{ ...staleAssignment, path: `/archived-${index}.jsonl`, conversationId: `conversation-archived-${index}` }],
  }));
  const before: BoardTask[] = [
    ...stale,
    task("never-launched"),
    task("held", { assignments: [assignment] }),
    task("decided", { board: "shown", assignments: [{ ...staleAssignment }] }),
  ];
  saveTasksFile({ tasks: before, recentCreates: [], migrations: {} }, file);

  const result = migrateEmptyTaskBoardVisibility(scanFiles, () => "2026-02-02T00:00:00.000Z", file);
  expect(result).toEqual({ applied: true, hidden: 8, scanned: 9 });

  const after = loadTasksFile(file);
  /* Every row survives, and no assignment was deleted to make the board look
     emptier. */
  expect(after.tasks).toHaveLength(9);
  expect(after.tasks.every((entry) => entry.assignments.length === before.find((row) => row.id === entry.id)!.assignments.length)).toBe(true);
  const boardOf = new Map(after.tasks.map((entry) => [entry.id, entry.board]));
  for (const entry of stale) expect(boardOf.get(entry.id)).toBe("hidden");
  expect(boardOf.get("never-launched")).toBe("hidden");
  /* Including the one that still holds an agent: the preference is set, and it
     is the render-time answer that keeps its band. That is the whole point of
     the two halves — the flag never has to be right about membership. */
  expect(boardOf.get("held")).toBe("hidden");
  expect(taskShowsOnBoard(after.tasks.find((entry) => entry.id === "held")!, true)).toBe(true);
  expect(taskShowsOnBoard(after.tasks.find((entry) => entry.id === "stale-0")!, false)).toBe(false);
  /* An explicit decision the operator already made is never overwritten. */
  expect(boardOf.get("decided")).toBe("shown");
});

test("a scan-listed conversation whose card is off the board does not keep a legacy band (#1614)", () => {
  /* The scan is not the rendered scene: it lists transcripts, and the board
     applies its own hidden/archive/placement policy on top. A rule that read
     scan keys would keep this task; the preference plus the render-time answer
     does not. */
  const file = stateFile();
  saveTasksFile({ tasks: [task("scan-listed-off-board", { assignments: [assignment] })], recentCreates: [], migrations: {} }, file);
  migrateEmptyTaskBoardVisibility(scanFiles, () => "2026-09-10T00:00:00.000Z", file);
  const migrated = loadTasksFile(file).tasks[0]!;
  expect(migrated.assignments).toHaveLength(1);
  expect(migrated.board).toBe("hidden");
  /* Its card is not on the scene, so the board resolved no member for it. */
  expect(taskShowsOnBoard(migrated, false)).toBe(false);
});

test("the one-time write waits for a board to have been produced at least once", () => {
  const file = stateFile();
  saveTasksFile({ tasks: [task("held", { assignments: [assignment] }), task("empty")], recentCreates: [], migrations: {} }, file);

  /* Nothing scanned yet: this is an operator-visible one-time change, and it
     does not land during a cold boot before there is a board to change.
     Nothing is written and the marker is not recorded. */
  const deferred = migrateEmptyTaskBoardVisibility([], () => "2026-02-02T00:00:00.000Z", file);
  expect(deferred).toEqual({ applied: false, hidden: 0, scanned: 0 });
  const untouched = loadTasksFile(file);
  expect(untouched.tasks.every((entry) => entry.board === undefined)).toBe(true);
  expect(untouched.migrations?.[EMPTY_BOARD_VISIBILITY_MIGRATION]).toBeUndefined();

  /* The first scan that produced anything settles it. */
  const applied = migrateEmptyTaskBoardVisibility(scanFiles, () => "2026-02-03T00:00:00.000Z", file);
  expect(applied).toEqual({ applied: true, hidden: 2, scanned: 2 });
  const settled = loadTasksFile(file);
  expect(settled.tasks.every((entry) => entry.board === "hidden")).toBe(true);
});

test("a deferral does not consume the once-per-process attempt, and an unreadable file stops logging", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-board-visibility-guard-"));
  const file = path.join(dir, "tasks.json");
  saveTasksFile({ tasks: [task("empty")], recentCreates: [], migrations: {} }, file);
  resetEmptyTaskBoardVisibilityMigrationGuard();

  /* Called before the first scan lands, twice: neither call spends the attempt. */
  ensureEmptyTaskBoardVisibilityMigration([], file);
  ensureEmptyTaskBoardVisibilityMigration([], file);
  expect(loadTasksFile(file).migrations?.[EMPTY_BOARD_VISIBILITY_MIGRATION]).toBeUndefined();

  ensureEmptyTaskBoardVisibilityMigration(scanFiles, file);
  expect(loadTasksFile(file).tasks[0]!.board).toBe("hidden");

  /* A permanently unreadable file is retried a bounded number of times rather
     than re-entering the transaction on every poll for the life of the process. */
  const broken = path.join(dir, "broken.json");
  fs.writeFileSync(broken, "{ not json", "utf8");
  resetEmptyTaskBoardVisibilityMigrationGuard();
  const errors: unknown[][] = [];
  const previous = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) ensureEmptyTaskBoardVisibilityMigration(scanFiles, broken);
  } finally {
    console.error = previous;
  }
  expect(errors).toHaveLength(3);
  expect(String(errors[2]![0])).toContain("abandoned");
});
