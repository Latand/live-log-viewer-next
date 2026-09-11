import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import type { BoardTask } from "@/lib/tasks/types";

/**
 * The band cap over the real HTTP admission paths (#1627).
 *
 * The unit suite (`src/lib/tasks/boardTaskLimit.test.ts`) pins the rule; this
 * one pins where the count is TAKEN. Both routes decide inside the serialized
 * read-modify-write of the task file, against the state that is actually
 * persisted at that moment — so a caller holding a snapshot from before the
 * board filled cannot spend a slot that is already gone, and the last free slot
 * is taken by exactly one of two racing restores.
 */

const previousStateDir = process.env.LLV_STATE_DIR;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-band-cap-"));
process.env.LLV_STATE_DIR = sandbox;

const createRoute = await import("./route");
const taskRoute = await import("./[id]/route");
const { saveTasks, loadTasks, TASKS_FILE } = await import("@/lib/tasks/store");
const { BOARD_TASKS_PER_PROJECT_LIMIT } = await import("@/lib/tasks/commands");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function row(id: string, board: "shown" | "hidden"): BoardTask {
  return {
    id,
    project: "proj",
    status: "done",
    text: `task ${id}`,
    placement: "unplaced",
    board,
    assignments: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function seed(shown: number, hidden: number): void {
  saveTasks([
    ...Array.from({ length: shown }, (_, index) => row(`band-${index}`, "shown")),
    ...Array.from({ length: hidden }, (_, index) => row(`history-${index}`, "hidden")),
  ]);
}

function post(body: Record<string, unknown>): Promise<Response> {
  return createRoute.POST(new NextRequest("http://127.0.0.1/api/tasks", {
    method: "POST",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function patch(id: string, body: Record<string, unknown>): Promise<Response> {
  return taskRoute.PATCH(new NextRequest(`http://127.0.0.1/api/tasks/${id}`, {
    method: "PATCH",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  /* The store resolved its path when it was first imported, which in a
     multi-file run may have been another file's sandbox; using the path it
     actually resolved keeps every case here reading and writing one file. */
  fs.rmSync(TASKS_FILE, { force: true });
});

test("a project whose stored history dwarfs the cap still takes a new task", async () => {
  seed(5, 488);
  expect(loadTasks()).toHaveLength(493);

  const response = await post({ project: "proj", text: "a new task", placement: "unplaced", clientRequestId: "req-history" });

  expect(response.status).toBe(200);
  const body = await response.json() as { task: BoardTask };
  expect(body.task.text).toBe("a new task");
  /* Nothing was closed, deleted or re-flagged to make room. */
  expect(loadTasks()).toHaveLength(494);
  expect(loadTasks().filter((task) => task.board === "hidden")).toHaveLength(488);
});

test("a full board refuses another band, and takes the same task off the board", async () => {
  seed(BOARD_TASKS_PER_PROJECT_LIMIT, 12);

  const refused = await post({ project: "proj", text: "one too many", placement: "unplaced", clientRequestId: "req-full" });
  expect(refused.status).toBe(409);
  expect((await refused.json() as { error: string }).error).toContain("task bands");
  expect(loadTasks()).toHaveLength(BOARD_TASKS_PER_PROJECT_LIMIT + 12);

  const accepted = await post({ project: "proj", text: "one too many", placement: "unplaced", board: "hidden", clientRequestId: "req-off" });
  expect(accepted.status).toBe(200);
  expect((await accepted.json() as { task: BoardTask }).task.board).toBe("hidden");
  expect(loadTasks()).toHaveLength(BOARD_TASKS_PER_PROJECT_LIMIT + 13);
});

test("hiding one band frees exactly one slot, and the create that follows takes it", async () => {
  seed(BOARD_TASKS_PER_PROJECT_LIMIT, 0);

  expect((await patch("band-0", { board: "hidden" })).status).toBe(200);

  const first = await post({ project: "proj", text: "into the freed slot", placement: "unplaced", clientRequestId: "req-a" });
  expect(first.status).toBe(200);

  const second = await post({ project: "proj", text: "one slot, two creates", placement: "unplaced", clientRequestId: "req-b" });
  expect(second.status).toBe(409);
});

test("two restores racing for the last slot: one band appears, and the loser keeps its row", async () => {
  seed(BOARD_TASKS_PER_PROJECT_LIMIT - 1, 2);

  const [first, second] = await Promise.all([patch("history-0", { board: "shown" }), patch("history-1", { board: "shown" })]);

  const statuses = [first.status, second.status].sort();
  expect(statuses).toEqual([200, 409]);
  const stored = loadTasks();
  expect(stored.filter((task) => task.board !== "hidden")).toHaveLength(BOARD_TASKS_PER_PROJECT_LIMIT);
  /* The refused restore lost nothing: its row, its project and its history are
     exactly as they were. */
  const loser = stored.find((task) => task.board === "hidden" && task.id.startsWith("history-"));
  expect(loser).toBeDefined();
  expect(loser!.project).toBe("proj");
});

test("a create replayed under its own request id is answered even after the board filled behind it", async () => {
  seed(BOARD_TASKS_PER_PROJECT_LIMIT - 1, 0);

  const first = await post({ project: "proj", text: "the last band", placement: "unplaced", clientRequestId: "req-replay" });
  expect(first.status).toBe(200);
  const created = (await first.json() as { task: BoardTask }).task;

  const replay = await post({ project: "proj", text: "the last band", placement: "unplaced", clientRequestId: "req-replay" });
  expect(replay.status).toBe(200);
  expect((await replay.json() as { task: BoardTask }).task.id).toBe(created.id);
  expect(loadTasks()).toHaveLength(BOARD_TASKS_PER_PROJECT_LIMIT);
});
