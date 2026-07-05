import crypto from "node:crypto";

import { isoNow } from "./helpers";
import type { BoardTask, TaskAssignment, TaskStatus } from "./types";

export const TASK_TEXT_LIMIT = 6000;
export const TASKS_PER_PROJECT_LIMIT = 300;

export type TaskCommandResult =
  | { ok: true; tasks: BoardTask[]; task: BoardTask }
  | { ok: false; error: string; status: number };

export interface CreateTaskInput {
  project?: unknown;
  text?: unknown;
  pos?: unknown;
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

function textLimitError(): TaskCommandResult {
  return { ok: false, error: `Текст задачі має бути не довший за ${TASK_TEXT_LIMIT} символів`, status: 400 };
}

export function createTask(
  existing: BoardTask[],
  input: CreateTaskInput,
  deps: { now?: () => string; id?: () => string } = {},
): TaskCommandResult {
  const project = normalizeProject(input.project);
  if (!project) return { ok: false, error: "потрібен project", status: 400 };
  const text = normalizeText(input.text);
  if (!text) return { ok: false, error: "потрібен текст задачі", status: 400 };
  if (text.length > TASK_TEXT_LIMIT) return textLimitError();
  const pos = normalizePos(input.pos);
  if (!pos) return { ok: false, error: "потрібна позиція задачі", status: 400 };
  const count = existing.filter((task) => task.project === project).length;
  if (count >= TASKS_PER_PROJECT_LIMIT) {
    return { ok: false, error: `У проєкті вже є ${TASKS_PER_PROJECT_LIMIT} задач. Закрийте або видаліть зайві задачі.`, status: 409 };
  }

  const now = deps.now?.() ?? isoNow();
  const task: BoardTask = {
    id: deps.id?.() ?? crypto.randomUUID(),
    project,
    status: "inbox",
    text,
    pos,
    assignments: [],
    createdAt: now,
    updatedAt: now,
  };
  return { ok: true, tasks: [...existing, task], task };
}

export function patchTask(existing: BoardTask[], id: string, input: PatchTaskInput, now = isoNow()): TaskCommandResult {
  const index = existing.findIndex((task) => task.id === id);
  if (index < 0) return { ok: false, error: "задачу не знайдено", status: 404 };
  const task = existing[index]!;
  const patch: Partial<BoardTask> = {};

  if (Object.hasOwn(input, "text")) {
    const text = normalizeText(input.text);
    if (!text) return { ok: false, error: "потрібен текст задачі", status: 400 };
    if (text.length > TASK_TEXT_LIMIT) return textLimitError();
    patch.text = text;
  }
  if (Object.hasOwn(input, "status")) {
    const status = normalizeStatus(input.status);
    if (!status) return { ok: false, error: "некоректний статус задачі", status: 400 };
    patch.status = status;
  }
  if (Object.hasOwn(input, "pos")) {
    const pos = normalizePos(input.pos);
    if (!pos) return { ok: false, error: "некоректна позиція задачі", status: 400 };
    patch.pos = pos;
  }

  const updated: BoardTask = { ...task, ...patch, updatedAt: now };
  const tasks = existing.slice();
  tasks[index] = updated;
  return { ok: true, tasks, task: updated };
}

export function deleteTask(existing: BoardTask[], id: string): { ok: true; tasks: BoardTask[] } | { ok: false; error: string; status: number } {
  const tasks = existing.filter((task) => task.id !== id);
  if (tasks.length === existing.length) return { ok: false, error: "задачу не знайдено", status: 404 };
  return { ok: true, tasks };
}

export interface AssignmentPatch {
  path: string | null;
  panePid: number | null;
  state: TaskAssignment["state"];
  error: string | null;
  at: string;
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
  if (index < 0) return { ok: false, error: "задачу не знайдено", status: 404 };
  const task = existing[index]!;
  const hasSuccess = patches.some((patch) => patch.state === "delivered" || patch.state === "spawning");
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
