import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EMPTY_BOARD_VISIBILITY_MIGRATION, taskHasAgents, taskShowsOnBoard } from "./boardVisibility";
import { migrateEmptyTaskBoardVisibility } from "./boardVisibilityMigration";
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

test("the flag governs empty tasks only — a task holding an agent shows whatever it says", () => {
  expect(taskShowsOnBoard(task("plain"))).toBe(true);
  expect(taskShowsOnBoard(task("hidden", { board: "hidden" }))).toBe(false);
  expect(taskShowsOnBoard(task("restored", { board: "shown" }))).toBe(true);
  /* The invariant that keeps a live conversation reachable: an assignment
     overrides the flag, so hiding can never take a working band off the board. */
  const staffed = task("staffed", { board: "hidden", assignments: [assignment] });
  expect(taskHasAgents(staffed)).toBe(true);
  expect(taskShowsOnBoard(staffed)).toBe(true);
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

  const first = migrateEmptyTaskBoardVisibility(() => "2026-02-02T00:00:00.000Z", file);
  expect(first).toEqual({ applied: true, hidden: 2, scanned: 4 });

  const after = loadTasksFile(file);
  /* Nothing is deleted or archived: every row is still in the task list. */
  expect(after.tasks.map((entry) => entry.id).sort()).toEqual(["already-decided", "empty-one", "empty-two", "staffed"]);
  const boardOf = new Map(after.tasks.map((entry) => [entry.id, entry.board]));
  expect(boardOf.get("empty-one")).toBe("hidden");
  expect(boardOf.get("empty-two")).toBe("hidden");
  /* A task with an agent is never touched, and an explicit prior decision wins. */
  expect(boardOf.get("staffed")).toBeUndefined();
  expect(boardOf.get("already-decided")).toBe("shown");
  expect(after.migrations?.[EMPTY_BOARD_VISIBILITY_MIGRATION]).toBe("2026-02-02T00:00:00.000Z");

  /* A restore by hand must survive: re-running the migration would undo the
     operator's choice, so the recorded marker refuses the second run. */
  const restored = patchTask(after.tasks, "empty-one", { board: "shown" });
  expect(restored.ok).toBe(true);
  if (!restored.ok) throw new Error("patch refused");
  saveTasksFile({ tasks: restored.tasks, recentCreates: [], migrations: after.migrations }, file);

  const second = migrateEmptyTaskBoardVisibility(() => "2026-03-03T00:00:00.000Z", file);
  expect(second.applied).toBe(false);
  const settled = loadTasksFile(file);
  expect(settled.tasks.find((entry) => entry.id === "empty-one")?.board).toBe("shown");
  expect(settled.migrations?.[EMPTY_BOARD_VISIBILITY_MIGRATION]).toBe("2026-02-02T00:00:00.000Z");
});

test("a task write that does not mean to touch migrations keeps the marker", () => {
  const file = stateFile();
  saveTasksFile({ tasks: [task("empty-one")], recentCreates: [], migrations: {} }, file);
  migrateEmptyTaskBoardVisibility(() => "2026-02-02T00:00:00.000Z", file);

  const current = loadTasksFile(file);
  /* A caller that carries only tasks and receipts — the shape most writers in
     the codebase use — must not erase the marker and let the migration re-run. */
  saveTasksFile({ tasks: current.tasks, recentCreates: [] }, file);
  expect(loadTasksFile(file).migrations?.[EMPTY_BOARD_VISIBILITY_MIGRATION]).toBe("2026-02-02T00:00:00.000Z");
  expect(migrateEmptyTaskBoardVisibility(() => "2026-04-04T00:00:00.000Z", file).applied).toBe(false);
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
  expect(taskShowsOnBoard(shown.task)).toBe(true);

  const refused = patchTask(shown.tasks, "solo", { board: "archived" });
  expect(refused.ok).toBe(false);
  if (refused.ok) throw new Error("invalid visibility accepted");
  expect(refused.status).toBe(400);
});
