import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { applyAssignmentPatches, createTask, deleteTask, mergeAssignments, patchTask, TASKS_PER_PROJECT_LIMIT } from "./commands";
import { firstLineTitle } from "./helpers";
import { reconcileTasks } from "./reconcile";
import { assembleSendResults } from "./send";
import { isTask, loadTasks, mutateTasks, saveTasks } from "./store";
import type { BoardTask } from "./types";
import type { DeliveryOutcome } from "@/lib/delivery";
import type { FileEntry } from "@/lib/types";

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-tasks-"));
  return path.join(dir, "tasks.json");
}

function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id: "task-1",
    project: "proj",
    status: "inbox",
    text: "First line\nbody",
    pos: { x: 10, y: 20 },
    assignments: [],
    createdAt: "2026-07-05T10:00:00.000Z",
    updatedAt: "2026-07-05T10:00:00.000Z",
    ...overrides,
  };
}

function file(pathname: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: pathname,
    root: "claude-projects",
    name: path.basename(pathname),
    project: "proj",
    title: path.basename(pathname),
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

describe("task store", () => {
  test("round-trips valid tasks", () => {
    const filePath = tmpFile();
    const tasks = [task()];
    saveTasks(tasks, filePath);
    expect(loadTasks(filePath)).toEqual(tasks);
  });

  test("corrupt or missing files load as an empty list", () => {
    const filePath = tmpFile();
    expect(loadTasks(filePath)).toEqual([]);
    fs.writeFileSync(filePath, "{", "utf8");
    expect(loadTasks(filePath)).toEqual([]);
  });

  test("runtime validation filters malformed tasks", () => {
    const filePath = tmpFile();
    const valid = task();
    fs.writeFileSync(filePath, JSON.stringify({ tasks: [valid, { ...valid, id: 3 }, { ...valid, pos: { x: Number.NaN, y: 0 } }] }));
    expect(loadTasks(filePath)).toEqual([valid]);
    expect(isTask(valid)).toBe(true);
  });

  test("mutateTasks transforms the freshest snapshot and persists the result", () => {
    const filePath = tmpFile();
    saveTasks([task()], filePath);
    const result = mutateTasks((tasks) => {
      const outcome = patchTask(tasks, "task-1", { text: "edited" }, "2026-07-05T11:00:00.000Z");
      return { tasks: outcome.ok ? outcome.tasks : undefined, result: outcome };
    }, filePath);
    expect(result.ok).toBe(true);
    expect(loadTasks(filePath)[0]!.text).toBe("edited");
  });

  test("mutateTasks skips the write when the mutation returns no tasks", () => {
    const filePath = tmpFile();
    saveTasks([task()], filePath);
    const before = fs.statSync(filePath).mtimeMs;
    const result = mutateTasks((tasks) => ({ tasks: undefined, result: tasks.length }), filePath);
    expect(result).toBe(1);
    expect(fs.statSync(filePath).mtimeMs).toBe(before);
  });

  test("a mutation between another mutation's slow work and its write is preserved", () => {
    /* The reviewer scenario: reconciliation computed against an old snapshot
       must not overwrite an edit that landed meanwhile. Each mutateTasks call
       re-loads, so the second writer folds into the first writer's output. */
    const filePath = tmpFile();
    saveTasks([task(), task({ id: "task-2", text: "other" })], filePath);
    /* Handler A does slow async work here (file scan, delivery)… meanwhile
       handler B edits task-2 through the store. */
    mutateTasks((tasks) => {
      const outcome = patchTask(tasks, "task-2", { text: "edited by B" }, "2026-07-05T11:00:00.000Z");
      return { tasks: outcome.ok ? outcome.tasks : undefined, result: outcome };
    }, filePath);
    /* …then handler A applies its own outcome; the fresh load sees B's edit. */
    mutateTasks((tasks) => {
      const outcome = patchTask(tasks, "task-1", { status: "done" }, "2026-07-05T11:00:01.000Z");
      return { tasks: outcome.ok ? outcome.tasks : undefined, result: outcome };
    }, filePath);
    const final = loadTasks(filePath);
    expect(final.find((item) => item.id === "task-1")!.status).toBe("done");
    expect(final.find((item) => item.id === "task-2")!.text).toBe("edited by B");
  });
});

describe("task command helpers", () => {
  test("create enforces text and project caps", () => {
    const tooLong = createTask([], { project: "proj", text: "x".repeat(6001), pos: { x: 0, y: 0 } });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.status).toBe(400);

    const fullProject = Array.from({ length: TASKS_PER_PROJECT_LIMIT }, (_, index) => task({ id: `task-${index}` }));
    const capped = createTask(fullProject, { project: "proj", text: "new", pos: { x: 0, y: 0 } });
    expect(capped.ok).toBe(false);
    if (!capped.ok) expect(capped.status).toBe(409);
  });

  test("patch is last-write-wins and delete wins late patches", () => {
    const initial = [task()];
    const first = patchTask(initial, "task-1", { text: "one" }, "2026-07-05T10:01:00.000Z");
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    const second = patchTask(first.tasks, "task-1", { text: "two", status: "blocked" }, "2026-07-05T10:02:00.000Z");
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error);
    expect(second.task.text).toBe("two");
    expect(second.task.status).toBe("blocked");
    expect(second.task.updatedAt).toBe("2026-07-05T10:02:00.000Z");

    const deleted = deleteTask(second.tasks, "task-1");
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) throw new Error(deleted.error);
    const late = patchTask(deleted.tasks, "task-1", { text: "late" });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.status).toBe(404);
  });

  test("first line title uses a fallback for blank text", () => {
    expect(firstLineTitle("  Title  \nbody")).toBe("Title");
    expect(firstLineTitle("\nbody")).toBe("Без назви");
  });
});

describe("task reconciliation", () => {
  test("rewrites successor chains to the terminal transcript", () => {
    const tasks = [task({ assignments: [{ path: "/a", panePid: null, state: "delivered", error: null, at: "old" }] })];
    const result = reconcileTasks([], tasks, {
      now: () => "new",
      successorForPath: (pathname) => ({ "/a": "/b", "/b": "/c" })[pathname] ?? null,
    });
    expect(result.dirty).toBe(true);
    expect(result.tasks[0]?.assignments[0]?.path).toBe("/c");
    expect(result.tasks[0]?.assignments[0]?.at).toBe("new");
  });

  test("fills codex spawn path from pane attribution", () => {
    const tasks = [task({ assignments: [{ path: null, panePid: 42, state: "spawning", error: null, at: "old" }] })];
    const result = reconcileTasks([], tasks, {
      now: () => "new",
      pathForPanePid: (panePid) => (panePid === 42 ? "/codex.jsonl" : null),
    });
    expect(result.dirty).toBe(true);
    expect(result.tasks[0]?.assignments[0]).toEqual({ path: "/codex.jsonl", panePid: 42, state: "delivered", error: null, at: "new" });
  });

  test("keeps no-op inputs referentially stable", () => {
    const tasks = [task({ assignments: [{ path: "/a", panePid: null, state: "delivered", error: null, at: "old" }] })];
    const files = [file("/a")];
    const result = reconcileTasks(files, tasks, { successorForPath: () => null });
    expect(result.dirty).toBe(false);
    expect(result.tasks).toBe(tasks);
  });

  test("marks dead never-attributed spawns as failed once", () => {
    const tasks = [task({ assignments: [{ path: null, panePid: 42, state: "spawning", error: null, at: "old" }] })];
    const result = reconcileTasks([], tasks, {
      now: () => "new",
      panePidAlive: () => false,
    });
    expect(result.dirty).toBe(true);
    expect(result.tasks[0]?.assignments[0]).toEqual({ path: null, panePid: 42, state: "failed", error: "агент не запустився", at: "new" });

    const again = reconcileTasks([], result.tasks, { panePidAlive: () => false });
    expect(again.dirty).toBe(false);
  });
});

describe("task delivery assembly", () => {
  test("builds per-target results and assignment patches", () => {
    const outcomes: DeliveryOutcome[] = [{ ok: true, target: "%1" }, { error: "немає пейна", status: 409 }];
    const assembled = assembleSendResults(task({ id: "12345678-aaaa", text: "Do it" }), ["/one", "/two"], outcomes, "now");
    expect(assembled.message).toBe("Задача #12345678: Do it");
    expect(assembled.delivered).toBe(1);
    expect(assembled.failed).toBe(1);
    expect(assembled.results).toEqual([
      { path: "/one", ok: true, target: "%1", error: null },
      { path: "/two", ok: false, target: null, error: "немає пейна" },
    ]);
    expect(assembled.patches).toEqual([
      { path: "/one", panePid: null, state: "delivered", error: null, at: "now" },
      { path: "/two", panePid: null, state: "failed", error: "немає пейна", at: "now" },
    ]);
  });

  test("merges assignment retries and flips inbox on first success", () => {
    const assignments = mergeAssignments([{ path: "/one", panePid: null, state: "failed", error: "old", at: "old" }], [
      { path: "/one", panePid: null, state: "delivered", error: null, at: "new" },
    ]);
    expect(assignments).toEqual([{ path: "/one", panePid: null, state: "delivered", error: null, at: "new" }]);

    const result = applyAssignmentPatches([task()], "task-1", [{ path: "/one", panePid: null, state: "delivered", error: null, at: "new" }], "new");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.task.status).toBe("assigned");
    expect(result.task.assignments).toEqual([{ path: "/one", panePid: null, state: "delivered", error: null, at: "new" }]);
  });
});
