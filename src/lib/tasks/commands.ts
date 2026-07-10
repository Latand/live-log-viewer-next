import crypto from "node:crypto";

import { isoNow } from "./helpers";
import type { BoardTask, TaskAssignment, TaskSource, TaskStatus } from "./types";

export const TASK_TEXT_LIMIT = 6000;
export const TASKS_PER_PROJECT_LIMIT = 300;

export type TaskCommandResult =
  | { ok: true; tasks: BoardTask[]; task: BoardTask }
  | { ok: false; error: string; status: number };

export interface CreateTaskInput {
  project?: unknown;
  text?: unknown;
  pos?: unknown;
  source?: unknown;
}

export interface PatchTaskInput {
  text?: unknown;
  status?: unknown;
  pos?: unknown;
}

export type SpawnEngine = "claude" | "codex";

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

function normalizeProject(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const project = value.trim();
  return project ? project : null;
}

function normalizePos(value: unknown): BoardTask["pos"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pos = value as Partial<BoardTask["pos"]>;
  if (typeof pos.x !== "number" || !Number.isFinite(pos.x)) return null;
  if (typeof pos.y !== "number" || !Number.isFinite(pos.y)) return null;
  return { x: pos.x, y: pos.y };
}

function normalizeStatus(value: unknown): TaskStatus | null {
  return value === "inbox" || value === "assigned" || value === "blocked" || value === "done" ? value : null;
}

function normalizeSource(value: unknown): TaskSource | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Partial<TaskSource>;
  if (typeof source.path !== "string" || !source.path.trim()) return null;
  if (source.ts !== null && typeof source.ts !== "string") return null;
  if (typeof source.text !== "string" || !source.text.trim()) return null;
  if (typeof source.fingerprint !== "string" || !source.fingerprint.trim()) return null;
  if (source.engine !== "claude" && source.engine !== "codex") return null;
  return {
    path: source.path,
    ts: source.ts,
    text: source.text,
    fingerprint: source.fingerprint,
    engine: source.engine,
  };
}

function textLimitError(): TaskCommandResult {
  return { ok: false, error: `Task text must be no longer than ${TASK_TEXT_LIMIT} characters`, status: 400 };
}

export function createTask(
  existing: BoardTask[],
  input: CreateTaskInput,
  deps: { now?: () => string; id?: () => string } = {},
): TaskCommandResult {
  const project = normalizeProject(input.project);
  if (!project) return { ok: false, error: "project is required", status: 400 };
  const text = normalizeText(input.text);
  if (!text) return { ok: false, error: "task text is required", status: 400 };
  if (text.length > TASK_TEXT_LIMIT) return textLimitError();
  const pos = normalizePos(input.pos);
  if (!pos) return { ok: false, error: "task position is required", status: 400 };
  const source = normalizeSource(input.source);
  if (source === null) return { ok: false, error: "invalid task source", status: 400 };
  const count = existing.filter((task) => task.project === project).length;
  if (count >= TASKS_PER_PROJECT_LIMIT) {
    return { ok: false, error: `The project already has ${TASKS_PER_PROJECT_LIMIT} tasks. Close or delete extra tasks.`, status: 409 };
  }

  const now = deps.now?.() ?? isoNow();
  const task: BoardTask = {
    id: deps.id?.() ?? crypto.randomUUID(),
    project,
    status: "inbox",
    text,
    pos,
    assignments: [],
    ...(source ? { source } : {}),
    createdAt: now,
    updatedAt: now,
  };
  return { ok: true, tasks: [...existing, task], task };
}

export function patchTask(existing: BoardTask[], id: string, input: PatchTaskInput, now = isoNow()): TaskCommandResult {
  const index = existing.findIndex((task) => task.id === id);
  if (index < 0) return { ok: false, error: "task not found", status: 404 };
  const task = existing[index]!;
  const patch: Partial<BoardTask> = {};

  if (Object.hasOwn(input, "text")) {
    const text = normalizeText(input.text);
    if (!text) return { ok: false, error: "task text is required", status: 400 };
    if (text.length > TASK_TEXT_LIMIT) return textLimitError();
    patch.text = text;
  }
  if (Object.hasOwn(input, "status")) {
    const status = normalizeStatus(input.status);
    if (!status) return { ok: false, error: "invalid task status", status: 400 };
    patch.status = status;
  }
  if (Object.hasOwn(input, "pos")) {
    const pos = normalizePos(input.pos);
    if (!pos) return { ok: false, error: "invalid task position", status: 400 };
    patch.pos = pos;
  }

  const updated: BoardTask = { ...task, ...patch, updatedAt: now };
  const tasks = existing.slice();
  tasks[index] = updated;
  return { ok: true, tasks, task: updated };
}

export function deleteTask(existing: BoardTask[], id: string): { ok: true; tasks: BoardTask[] } | { ok: false; error: string; status: number } {
  const tasks = existing.filter((task) => task.id !== id);
  if (tasks.length === existing.length) return { ok: false, error: "task not found", status: 404 };
  return { ok: true, tasks };
}

/**
 * Detaches one assignment from a task by its target path — the undo for a
 * wrong handoff. Idempotent: a path that is not assigned leaves the task
 * untouched but still succeeds, so a double-click never 404s.
 */
export function removeAssignment(existing: BoardTask[], id: string, path: string, now = isoNow()): TaskCommandResult {
  const index = existing.findIndex((task) => task.id === id);
  if (index < 0) return { ok: false, error: "task not found", status: 404 };
  const task = existing[index]!;
  const assignments = task.assignments.filter((assignment) => assignment.path !== path);
  if (assignments.length === task.assignments.length) return { ok: true, tasks: existing, task };
  const updated: BoardTask = { ...task, assignments, updatedAt: now };
  const tasks = existing.slice();
  tasks[index] = updated;
  return { ok: true, tasks, task: updated };
}

export interface AssignmentPatch {
  path: string | null;
  panePid: number | null;
  state: TaskAssignment["state"];
  error: string | null;
  at: string;
  accountId?: string | null;
  engine?: "claude" | "codex" | null;
}

/** A task can own the same textual account id once per engine. */
export function pinnedAccountId(assignments: TaskAssignment[], engine: "claude" | "codex"): string | null {
  return assignments.find((assignment) => assignment.engine === engine && typeof assignment.accountId === "string")?.accountId ?? null;
}

export function mergeAssignments(assignments: TaskAssignment[], patches: AssignmentPatch[]): TaskAssignment[] {
  let next = assignments.slice();
  for (const patch of patches) {
    const index = next.findIndex((assignment) => {
      if (patch.path !== null && assignment.path === patch.path) return true;
      return patch.path === null && patch.panePid !== null && assignment.path === null && assignment.panePid === patch.panePid;
    });
    const merged: TaskAssignment = {
      path: patch.path,
      panePid: patch.panePid,
      state: patch.state,
      error: patch.error,
      at: patch.at,
      ...(patch.accountId !== undefined ? { accountId: patch.accountId } : {}),
      ...(patch.engine !== undefined ? { engine: patch.engine } : {}),
    };
    if (index >= 0) {
      next = [...next.slice(0, index), merged, ...next.slice(index + 1)];
    } else {
      next = [...next, merged];
    }
  }
  return next;
}

export function applyAssignmentPatches(
  existing: BoardTask[],
  id: string,
  patches: AssignmentPatch[],
  now = isoNow(),
): TaskCommandResult {
  const index = existing.findIndex((task) => task.id === id);
  if (index < 0) return { ok: false, error: "task not found", status: 404 };
  const task = existing[index]!;
  /* A handoff routes the task into an agent's composer without delivering, but
     it still moves the card off «inbox» — the task now belongs to that agent. */
  const hasSuccess = patches.some(
    (patch) => patch.state === "delivered" || patch.state === "spawning" || patch.state === "handoff",
  );
  const updated: BoardTask = {
    ...task,
    status: task.status === "inbox" && hasSuccess ? "assigned" : task.status,
    assignments: mergeAssignments(task.assignments, patches),
    updatedAt: now,
  };
  const tasks = existing.slice();
  tasks[index] = updated;
  return { ok: true, tasks, task: updated };
}
