import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import type { SchemeGroup } from "./layout";
import { legalTaskDrop, overlaps } from "./taskBoardLayout";
import { displayedTaskHeight, edgeObstacles, type PlacedTask } from "./taskGeometry";

function fixture(count: number) {
  const files = Array.from({ length: count }, (_, i) => ({ path: `/fixture/worker-${i}`, conversationId: `conversation_fixture_${i}`, title: `Worker ${i}`, project: "fixture", root: "codex-sessions", kind: "session", fmt: "codex", engine: "codex", mtime: 1, size: 100, activity: "live", proc: "running", pid: null, parent: null, model: null, pendingQuestion: null, waitingInput: null, name: `worker-${i}` } as FileEntry));
  const tasks: PlacedTask[] = Array.from({ length: Math.ceil(count / 4) }, (_, i) => ({ id: `task-${i}`, project: "fixture", text: `Task ${i}`, status: "assigned", placement: "pinned", pos: { x: i * 300, y: 100 }, assignments: files.slice(i * 4, i * 4 + 4).map(file => ({ path: file.path, conversationId: file.conversationId!, panePid: null, state: "delivered", error: null, at: "2026-01-01T00:00:00Z" })), createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }));
  return { files, tasks };
}

test("overlaps reads a gap symmetrically", () => {
  expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 12, y: 0, w: 10, h: 10 })).toBe(false);
  expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 12, y: 0, w: 10, h: 10 }, 4)).toBe(true);
});

test("a pinned drop onto another pinned group is pushed clear of it", () => {
  const { tasks } = fixture(8);
  const groups: SchemeGroup[] = tasks.map((task, index) => ({ key: `group::task::${task.id}`, kind: "task", id: task.id, taskId: task.id, hue: 0, members: [], label: task.text, x: index * 820, y: task.pos.y, w: 800, h: 400 }));
  const pinned = new Set(tasks.map(task => task.id));
  const requested = { ...tasks[1]!.pos };
  const accepted = legalTaskDrop(tasks[0]!, requested, groups, pinned);
  expect(accepted).not.toEqual(requested);
  const moved = { ...groups[0]!, x: groups[0]!.x + accepted.x - tasks[0]!.pos.x, y: groups[0]!.y + accepted.y - tasks[0]!.pos.y };
  expect(overlaps(moved, groups[1]!)).toBe(false);
  const free = { x: 5000, y: 5000 };
  expect(legalTaskDrop(tasks[0]!, free, groups, pinned)).toEqual(free);
});

test("inverse-zoom rounding keeps the target boundary out of its own obstacle set", () => {
  const target = { x: 790.2439024390244, y: 463, w: 731, h: 829 };
  expect(edgeObstacles({ taskId: "fixture", x1: 317, y1: 264, x2: 790.2439024390243, y2: 598 }, [], [target])).toEqual([]);
});

test("one task's thousand assignments retain a bounded summary footprint", () => {
  const { tasks } = fixture(1000);
  const task = { ...tasks[0]!, displayScale: 1, assignments: tasks.flatMap(task => task.assignments) };
  expect(task.assignments.length).toBe(1000);
  expect(displayedTaskHeight(task)).toBeLessThan(500);
});
