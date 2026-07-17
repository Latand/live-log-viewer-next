import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { TASK_STATUS_CYCLE } from "@/components/tasks/taskModel";

/*
 * Compact default Kanban/status stacks for board task cards.
 *
 * A busy project accumulates dozens of placed task cards; mounting each as a
 * full sticky floods the canvas, its dashed edges, and the minimap. By default
 * a quiet card folds into ONE compact stack per status (the Kanban read:
 * inbox → assigned → blocked → done), leaving the active layout and minimap
 * entirely. Full size is reserved for the cards that need eyes now:
 *
 *  - ACTIVE: an assignment is spawning or its agent is live / mid-turn /
 *    waiting on input, or the card was touched within the recent horizon
 *    (a card just created or edited must not vanish under the user's cursor);
 *  - ATTENTION: a failed delivery, or an overdue deadline on an open task;
 *  - FOCUSED: the board's current focus/flash target;
 *  - EXPANDED: the user explicitly expanded it — a durable per-project pin
 *    that survives reloads.
 *
 * Every stacked task keeps its body, status, placement and assignments —
 * expanding restores the exact card at its stored position.
 */

/** Recent-touch horizon: a card created or edited within this window stays
    full-size, mirroring the worker-collapse idle window (issue #112). */
export const TASK_STACK_RECENT_MS = 15 * 60 * 1_000;

export interface TaskStackContext {
  /** Scanned entries, for judging an assignment's live activity. */
  files: readonly FileEntry[];
  nowMs: number;
  /** Board focus target (`task::<id>` flash) — a focused card stays full. */
  focusedTaskId?: string | null;
  /** Durable per-project explicit expansions. */
  expandedIds: ReadonlySet<string>;
}

function assignmentActive(task: BoardTask, byPath: ReadonlyMap<string, FileEntry>): boolean {
  for (const assignment of task.assignments) {
    if (assignment.state === "spawning") return true;
    const file = assignment.path ? byPath.get(assignment.path) : undefined;
    if (!file) continue;
    if (file.activity === "live" || file.activity === "stalled") return true;
    if (file.proc === "running" || file.pendingQuestion || file.waitingInput) return true;
  }
  return false;
}

function needsAttention(task: BoardTask, nowMs: number): boolean {
  if (task.assignments.some((assignment) => assignment.state === "failed")) return true;
  if (task.status !== "done" && task.dueAt) {
    const due = Date.parse(task.dueAt);
    if (Number.isFinite(due) && due <= nowMs) return true;
  }
  return false;
}

function recentlyTouched(task: BoardTask, nowMs: number): boolean {
  const touched = Date.parse(task.updatedAt || task.createdAt);
  return Number.isFinite(touched) && nowMs - touched < TASK_STACK_RECENT_MS;
}

/** Whether this card folds into its status stack by default. */
export function isTaskStackable(task: BoardTask, context: TaskStackContext, byPath?: ReadonlyMap<string, FileEntry>): boolean {
  if (context.expandedIds.has(task.id)) return false;
  if (context.focusedTaskId === task.id) return false;
  if (needsAttention(task, context.nowMs)) return false;
  if (recentlyTouched(task, context.nowMs)) return false;
  const index = byPath ?? new Map(context.files.map((file) => [file.path, file] as const));
  return !assignmentActive(task, index);
}

export interface TaskStatusStack {
  status: TaskStatus;
  /** Stacked cards, freshest first. */
  items: BoardTask[];
}

export interface TaskStackPartition {
  /** Cards the board still mounts full-size. */
  full: BoardTask[];
  /** One compact stack per status, in Kanban order; empty statuses omitted. */
  stacks: TaskStatusStack[];
}

export function partitionTaskStacks(tasks: readonly BoardTask[], context: TaskStackContext): TaskStackPartition {
  const byPath = new Map(context.files.map((file) => [file.path, file] as const));
  const full: BoardTask[] = [];
  const byStatus = new Map<TaskStatus, BoardTask[]>();
  for (const task of tasks) {
    if (!isTaskStackable(task, context, byPath)) {
      full.push(task);
      continue;
    }
    const list = byStatus.get(task.status) ?? [];
    list.push(task);
    byStatus.set(task.status, list);
  }
  const stacks: TaskStatusStack[] = [];
  for (const status of TASK_STATUS_CYCLE) {
    const items = byStatus.get(status);
    if (!items?.length) continue;
    items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : 1));
    stacks.push({ status, items });
  }
  return { full, stacks };
}

/* ── Durable explicit expansion (per project, survives reloads) ─────────── */

const expandKey = (project: string) => "llvTaskExpand:" + project;

export function loadExpandedTasks(project: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = JSON.parse(window.localStorage.getItem(expandKey(project)) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function persistExpandedTasks(project: string, ids: ReadonlySet<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(expandKey(project), JSON.stringify([...ids]));
  } catch {
    /* best-effort: a lost pin only re-folds a card */
  }
}
