import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerSeatTickKick, type SeatTickSignal } from "./seatTickSignal";
import { appendLifecycleEvents } from "@/lib/lifecycle/journal";
import { loadTasks, saveTasks } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";

afterEach(() => registerSeatTickKick(null));

test("committed board changes kick the existing controller; unchanged saves do not", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tick-board-notify-"));
  const file = path.join(directory, "tasks.json");
  const signals: SeatTickSignal[] = [];
  registerSeatTickKick((signal) => {
    expect(loadTasks(file)).toHaveLength(1);
    signals.push(signal);
  });
  const task: BoardTask = { id: "pending-task", project: "fixture-project", status: "assigned", text: "work",
    placement: "unplaced", assignments: [], createdAt: "2026-09-08T09:21:00.000Z", updatedAt: "2026-09-08T09:21:00.000Z" };
  try {
    saveTasks([task], file);
    saveTasks(loadTasks(file), file);
    expect(signals).toEqual([{ project: "fixture-project" }]);
    saveTasks([{ ...task, status: "done" }], file);
    expect(signals).toHaveLength(2);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("a committed lifecycle event kicks once and an idempotent replay does not", () => {
  const signals: SeatTickSignal[] = [];
  registerSeatTickKick((signal) => signals.push(signal));
  const event = { key: `fixture-${crypto.randomUUID()}`, type: "review_verdict" as const,
    at: "2026-09-08T09:21:00.000Z", project: "fixture-project", summary: "review finished" };
  appendLifecycleEvents([event]);
  appendLifecycleEvents([event]);
  expect(signals).toEqual([{ project: "fixture-project" }]);
});
