import { expect, test } from "bun:test";

import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { partitionTaskStacks, TASK_STACK_RECENT_MS, type TaskStackContext } from "./taskStacks";

const NOW = Date.parse("2026-07-17T12:00:00.000Z");
const OLD = new Date(NOW - 2 * TASK_STACK_RECENT_MS).toISOString();

function task(overrides: Partial<BoardTask> & { id: string }): BoardTask {
  return {
    project: "-agents-tools-live-log-viewer-next",
    status: "inbox",
    text: "task " + overrides.id,
    placement: "pinned",
    pos: { x: 740, y: 120 },
    assignments: [],
    createdAt: OLD,
    updatedAt: OLD,
    ...overrides,
  } as BoardTask;
}

function agent(path: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path,
    root: "codex-sessions",
    name: path,
    project: "-agents-tools-live-log-viewer-next",
    title: "agent",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: NOW / 1000,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  } as FileEntry;
}

function context(overrides: Partial<TaskStackContext> = {}): TaskStackContext {
  return { files: [], nowMs: NOW, expandedIds: new Set(), focusedTaskId: null, ...overrides };
}

test("quiet cards fold into one stack per status in Kanban order, freshest first", () => {
  const tasks = [
    task({ id: "d1", status: "done" }),
    task({ id: "i1", status: "inbox", updatedAt: new Date(NOW - 3 * TASK_STACK_RECENT_MS).toISOString() }),
    task({ id: "i2", status: "inbox" }),
    task({ id: "b1", status: "blocked" }),
    task({ id: "a1", status: "assigned" }),
  ];
  const { full, stacks } = partitionTaskStacks(tasks, context());
  expect(full).toEqual([]);
  expect(stacks.map((stack) => stack.status)).toEqual(["inbox", "assigned", "blocked", "done"]);
  expect(stacks[0]!.items.map((item) => item.id)).toEqual(["i2", "i1"]);
});

test("active, attention, focused and explicitly expanded cards stay full-size", () => {
  const files = [agent("/live.jsonl", { activity: "live" })];
  const tasks = [
    task({ id: "live", assignments: [{ path: "/live.jsonl", panePid: null, state: "delivered", error: null, at: OLD }] }),
    task({ id: "spawning", assignments: [{ path: null, panePid: null, state: "spawning", error: null, at: OLD }] }),
    task({ id: "failed", assignments: [{ path: "/gone.jsonl", panePid: null, state: "failed", error: "delivery failed", at: OLD }] }),
    task({ id: "overdue", dueAt: new Date(NOW - 60_000).toISOString() }),
    task({ id: "focused" }),
    task({ id: "expanded" }),
    task({ id: "quiet" }),
  ];
  const { full, stacks } = partitionTaskStacks(tasks, context({
    files,
    focusedTaskId: "focused",
    expandedIds: new Set(["expanded"]),
  }));
  expect(full.map((item) => item.id).sort()).toEqual(["expanded", "failed", "focused", "live", "overdue", "spawning"]);
  expect(stacks.flatMap((stack) => stack.items.map((item) => item.id))).toEqual(["quiet"]);
});

test("a card touched within the recent horizon never folds under the cursor", () => {
  const fresh = task({ id: "fresh", updatedAt: new Date(NOW - 60_000).toISOString() });
  const { full } = partitionTaskStacks([fresh], context());
  expect(full.map((item) => item.id)).toEqual(["fresh"]);
});

test("an overdue DONE card is history, never attention", () => {
  const done = task({ id: "done-late", status: "done", dueAt: new Date(NOW - 60_000).toISOString() });
  const { full, stacks } = partitionTaskStacks([done], context());
  expect(full).toEqual([]);
  expect(stacks[0]!.status).toBe("done");
});

test("stacked cards keep body, status, placement and assignments intact", () => {
  const source = task({
    id: "rich",
    status: "assigned",
    text: "title line\nbody line",
    pos: { x: 1040, y: 360 },
    assignments: [{ path: "/idle.jsonl", panePid: null, state: "delivered", error: null, at: OLD }],
  });
  const { stacks } = partitionTaskStacks([source], context({ files: [agent("/idle.jsonl")] }));
  const stacked = stacks[0]!.items[0]!;
  expect(stacked).toBe(source);
  expect(stacked.pos).toEqual({ x: 1040, y: 360 });
  expect(stacked.assignments).toHaveLength(1);
});
