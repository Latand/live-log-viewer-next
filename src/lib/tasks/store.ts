import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import type { AssignmentState, BoardTask, TaskAssignment, TaskStatus } from "./types";

export const TASKS_FILE = statePath("tasks.json");

type TasksFile = { tasks?: unknown };

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "inbox" || value === "assigned" || value === "blocked" || value === "done";
}

function isAssignmentState(value: unknown): value is AssignmentState {
  return value === "delivered" || value === "failed" || value === "spawning" || value === "handoff";
}

function isFinitePos(value: unknown): value is BoardTask["pos"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pos = value as Partial<BoardTask["pos"]>;
  return typeof pos.x === "number" && Number.isFinite(pos.x) && typeof pos.y === "number" && Number.isFinite(pos.y);
}

export function isTaskAssignment(value: unknown): value is TaskAssignment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const assignment = value as Partial<TaskAssignment>;
  return (
    (typeof assignment.path === "string" || assignment.path === null) &&
    (typeof assignment.panePid === "number" || assignment.panePid === null) &&
    (assignment.panePid === null || (Number.isInteger(assignment.panePid) && assignment.panePid > 0)) &&
    isAssignmentState(assignment.state) &&
    (typeof assignment.error === "string" || assignment.error === null) &&
    typeof assignment.at === "string"
  );
}

export function isTask(value: unknown): value is BoardTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const task = value as Partial<BoardTask>;
  return (
    typeof task.id === "string" &&
    typeof task.project === "string" &&
    isTaskStatus(task.status) &&
    typeof task.text === "string" &&
    isFinitePos(task.pos) &&
    Array.isArray(task.assignments) &&
    task.assignments.every(isTaskAssignment) &&
    typeof task.createdAt === "string" &&
    typeof task.updatedAt === "string"
  );
}

export function loadTasks(filePath = TASKS_FILE): BoardTask[] {
  const raw = readJson(filePath) as TasksFile | null;
  return Array.isArray(raw?.tasks) ? raw.tasks.filter(isTask) : [];
}

export function saveTasks(tasks: BoardTask[], filePath = TASKS_FILE): void {
  atomicWriteJson(filePath, { tasks });
}

/**
 * Serialized read-modify-write over the tasks file — the only sanctioned way
 * to persist a mutation. The whole load→transform→save runs in one
 * synchronous block, and Node yields to other request handlers only at await
 * points, so a handler can never save a snapshot that predates another
 * handler's write. Whole-file saves built on separate `loadTasks()` calls
 * could: files-route reconciliation racing a PATCH would resurrect the old
 * task list. The callback must stay synchronous — do the slow async work
 * (message delivery, agent spawn, fs scans) first, then fold its outcome
 * into the fresh snapshot here. Return `tasks: undefined` to skip the write
 * (validation failures, clean reconciles).
 */
export function mutateTasks<R>(
  mutate: (tasks: BoardTask[]) => { tasks: BoardTask[] | undefined; result: R },
  filePath = TASKS_FILE,
): R {
  const outcome = mutate(loadTasks(filePath));
  if (outcome.tasks) saveTasks(outcome.tasks, filePath);
  return outcome.result;
}
