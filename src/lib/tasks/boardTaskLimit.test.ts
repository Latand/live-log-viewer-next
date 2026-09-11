import { describe, expect, test } from "bun:test";

import { BOARD_TASKS_PER_PROJECT_LIMIT, createTask, patchTask } from "./commands";
import { countBoardTasks } from "./boardVisibility";
import type { BoardTask } from "./types";

/**
 * The per-project limit is a bound on BANDS, not on stored rows (#1627).
 *
 * The board the operator was refused on carried 493 rows of one project and
 * drew five of them: every other row is a finished or historical task the
 * #1614 migration flagged `hidden`, which keeps its place in the task list and
 * nothing on the canvas. Admission counted the rows, so creating a task had
 * been refused since the 300th of them was written, and the refusal asked for
 * the one remedy that destroys the history.
 */

const deps = { now: () => "2026-09-10T00:00:00.000Z", id: () => "task-new" };

function row(index: number, overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id: `task-${index}`,
    project: "proj",
    status: "done",
    text: `task ${index}`,
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Stored history: off the board, still in the task list. */
function history(count: number, offset = 0): BoardTask[] {
  return Array.from({ length: count }, (_, index) => row(index + offset, { board: "hidden" }));
}

/** Bands: what the board actually draws. */
function bands(count: number, offset = 0): BoardTask[] {
  return Array.from({ length: count }, (_, index) => row(index + offset, { board: "shown" }));
}

const noScene = () => false;

describe("the count the limit is taken against", () => {
  test("counts the bands of one project, not its stored rows", () => {
    const tasks = [...history(493), ...bands(5, 493), ...bands(7, 1000).map((task) => ({ ...task, project: "other" }))];

    expect(tasks).toHaveLength(505);
    expect(countBoardTasks(tasks, "proj", noScene)).toBe(5);
    expect(countBoardTasks(tasks, "other", noScene)).toBe(7);
  });

  test("a row with no flag at all is a band: it is what a fresh task looks like", () => {
    expect(countBoardTasks([row(1)], "proj", noScene)).toBe(1);
  });

  test("a hidden task holding a band is counted by a caller that can see the scene", () => {
    const staffed = row(1, { board: "hidden", assignments: [{ path: "/live.jsonl", panePid: null, state: "linked", error: null, at: "2026-09-10T00:00:00.000Z" }] });
    const tasks = [staffed, ...history(3, 10)];

    /* The board draws this task's band whatever its flag says, and a caller
       that resolved the bands says so. A caller with no scene answers "no" and
       says out loud that it is not guessing. */
    expect(countBoardTasks(tasks, "proj", (task) => task.id === staffed.id)).toBe(1);
    expect(countBoardTasks(tasks, "proj", noScene)).toBe(0);
  });
});

describe("create admission", () => {
  test("493 stored rows the board does not draw do not refuse a new task", () => {
    const stored = history(493);

    const created = createTask(stored, { project: "proj", text: "a new task", placement: "unplaced" }, [], deps);

    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error);
    expect(created.tasks).toHaveLength(494);
    /* Every historical row is still there, still hidden, still untouched. */
    expect(created.tasks.filter((task) => task.board === "hidden")).toHaveLength(493);
  });

  test("a board actually at the limit refuses one more band, and says what to do", () => {
    const full = [...history(200), ...bands(BOARD_TASKS_PER_PROJECT_LIMIT, 200)];

    const refused = createTask(full, { project: "proj", text: "one band too many", placement: "unplaced" }, [], deps);

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("the band cap did not hold");
    expect(refused.status).toBe(409);
    expect(refused.code).toBe("TASK_BOARD_FULL");
    expect(refused.error).toContain(`${BOARD_TASKS_PER_PROJECT_LIMIT} task bands`);
    expect(refused.error).toContain('board: "hidden"');
    /* The old refusal asked for the history to be destroyed. This one does not. */
    expect(refused.error).not.toContain("delete");
  });

  test("a full board still admits a task created off it, with its receipt", () => {
    const full = bands(BOARD_TASKS_PER_PROJECT_LIMIT);

    const created = createTask(full, { project: "proj", text: "recorded, not drawn", placement: "unplaced", board: "hidden", clientRequestId: "req-off-board" }, [], deps);

    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error);
    expect(created.task.board).toBe("hidden");
    expect(created.recentCreates).toEqual([{ clientRequestId: "req-off-board", taskId: "task-new" }]);
    expect(countBoardTasks(created.tasks, "proj", noScene)).toBe(BOARD_TASKS_PER_PROJECT_LIMIT);
  });

  test("an unusable board value is refused rather than silently shown", () => {
    const refused = createTask([], { project: "proj", text: "t", placement: "unplaced", board: "off" }, [], deps);

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("an invalid flag was accepted");
    expect(refused.status).toBe(400);
    expect(refused.field).toBe("board");
  });

  test("a replay of an accepted create is answered, never refused by a board that filled behind it", () => {
    const first = createTask(bands(BOARD_TASKS_PER_PROJECT_LIMIT - 1), { project: "proj", text: "the last band", placement: "unplaced", clientRequestId: "req-1" }, [], deps);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);

    const replay = createTask(first.tasks, { project: "proj", text: "the last band", placement: "unplaced", clientRequestId: "req-1" }, first.recentCreates, deps);

    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.error);
    expect(replay.replay).toBe(true);
    expect(replay.task.id).toBe(first.task.id);
    expect(replay.tasks).toHaveLength(BOARD_TASKS_PER_PROJECT_LIMIT);
  });

  test("a caller that can see the scene has its staffed hidden bands counted against the cap", () => {
    const staffed = history(BOARD_TASKS_PER_PROJECT_LIMIT).map((task) => ({
      ...task,
      assignments: [{ path: `/${task.id}.jsonl`, panePid: null, state: "linked" as const, error: null, at: "2026-09-10T00:00:00.000Z" }],
    }));

    const blind = createTask(staffed, { project: "proj", text: "another", placement: "unplaced" }, [], deps);
    expect(blind.ok).toBe(true);

    const seeing = createTask(staffed, { project: "proj", text: "another", placement: "unplaced" }, [], { ...deps, hasBoardMembers: () => true });
    expect(seeing.ok).toBe(false);
    if (seeing.ok) throw new Error("bands the caller could see were not counted");
    expect(seeing.code).toBe("TASK_BOARD_FULL");
  });
});

describe("restoring a band answers to the same bound", () => {
  test("a full board refuses «show on board», and the task keeps everything it had", () => {
    const tasks = [...bands(BOARD_TASKS_PER_PROJECT_LIMIT), ...history(1, 900)];

    const refused = patchTask(tasks, "task-900", { board: "shown" });

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("the restore path has no bound");
    expect(refused.status).toBe(409);
    expect(refused.code).toBe("TASK_BOARD_FULL");
    expect(refused.field).toBe("board");
    expect(tasks.find((task) => task.id === "task-900")?.board).toBe("hidden");
  });

  test("hiding a band frees the slot the next restore takes", () => {
    const tasks = [...bands(BOARD_TASKS_PER_PROJECT_LIMIT), ...history(1, 900)];

    const hidden = patchTask(tasks, "task-0", { board: "hidden" });
    expect(hidden.ok).toBe(true);
    if (!hidden.ok) throw new Error(hidden.error);
    expect(countBoardTasks(hidden.tasks, "proj", noScene)).toBe(BOARD_TASKS_PER_PROJECT_LIMIT - 1);

    const restored = patchTask(hidden.tasks, "task-900", { board: "shown" });
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error(restored.error);
    expect(restored.task.board).toBe("shown");
    expect(countBoardTasks(restored.tasks, "proj", noScene)).toBe(BOARD_TASKS_PER_PROJECT_LIMIT);
  });

  test("a task already on the board may re-assert it at the cap; hiding is never refused", () => {
    const tasks = bands(BOARD_TASKS_PER_PROJECT_LIMIT);

    const again = patchTask(tasks, "task-0", { board: "shown" });
    expect(again.ok).toBe(true);

    const away = patchTask(tasks, "task-1", { board: "hidden" });
    expect(away.ok).toBe(true);
  });

  test("a staffed hidden band the caller can see is not double-counted when it is restored", () => {
    /* Its band is already on the canvas, so «show on board» takes no new slot
       even though the board is otherwise full. */
    const staffed = row(900, { board: "hidden", assignments: [{ path: "/live.jsonl", panePid: null, state: "linked", error: null, at: "2026-09-10T00:00:00.000Z" }] });
    const tasks = [...bands(BOARD_TASKS_PER_PROJECT_LIMIT - 1), staffed];

    const restored = patchTask(tasks, "task-900", { board: "shown" }, "2026-09-10T00:00:00.000Z", { hasBoardMembers: (task) => task.id === "task-900" });

    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error(restored.error);
    expect(restored.task.assignments).toHaveLength(1);
  });
});
