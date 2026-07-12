import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import { isTaskAttachment } from "./attachments";
import type { RecentCreate } from "./commands";
import type { AssignmentState, BoardTask, TaskAssignment, TaskPlacement, TaskSource, TaskStatus } from "./types";

export const TASKS_FILE = statePath("tasks.json");

type TasksFile = { tasks?: unknown; recentCreates?: unknown };

/** The whole persisted state: the task list plus the create-idempotency map. */
export interface TasksFileState {
  tasks: BoardTask[];
  recentCreates: RecentCreate[];
}

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

function isFinitePos(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pos = value as { x?: unknown; y?: unknown };
  return typeof pos.x === "number" && Number.isFinite(pos.x) && typeof pos.y === "number" && Number.isFinite(pos.y);
}

export function isTaskAssignment(value: unknown): value is TaskAssignment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const assignment = value as Partial<TaskAssignment>;
  return (
    (typeof assignment.path === "string" || assignment.path === null) &&
    (assignment.conversationId === undefined || typeof assignment.conversationId === "string" || assignment.conversationId === null) &&
    (typeof assignment.panePid === "number" || assignment.panePid === null) &&
    (assignment.panePid === null || (Number.isInteger(assignment.panePid) && assignment.panePid > 0)) &&
    isAssignmentState(assignment.state) &&
    (typeof assignment.error === "string" || assignment.error === null) &&
    typeof assignment.at === "string"
  );
}

export function isTaskSource(value: unknown): value is TaskSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Partial<TaskSource>;
  return (
    typeof source.path === "string" &&
    (typeof source.ts === "string" || source.ts === null) &&
    typeof source.text === "string" &&
    typeof source.fingerprint === "string" &&
    (source.engine === "claude" || source.engine === "codex")
  );
}

function isPlacement(value: unknown): value is TaskPlacement {
  return value === "pinned" || value === "unplaced" || value === "auto";
}

/** Optional deadline is both-or-neither and both strings. */
function validDue(task: Partial<BoardTask>): boolean {
  const hasAt = task.dueAt !== undefined;
  const hasTz = task.dueTz !== undefined;
  if (!hasAt && !hasTz) return true;
  return typeof task.dueAt === "string" && typeof task.dueTz === "string";
}

function validAttachments(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isTaskAttachment));
}

/**
 * Validates a raw row and coerces it into a {@link BoardTask}, filling the
 * placement a legacy row (a `pos`, no `placement`) lacks: it loads as `pinned`.
 * A pinned row with no usable position is downgraded to `unplaced` so the board
 * never tries to render a positionless card. Returns null for unusable rows.
 */
function coerceTask(value: unknown): BoardTask | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<BoardTask>;
  const structural =
    typeof raw.id === "string" &&
    typeof raw.project === "string" &&
    isTaskStatus(raw.status) &&
    typeof raw.text === "string" &&
    (raw.placement === undefined || isPlacement(raw.placement)) &&
    (raw.pos === undefined || isFinitePos(raw.pos)) &&
    validDue(raw) &&
    validAttachments(raw.attachments) &&
    Array.isArray(raw.assignments) &&
    raw.assignments.every(isTaskAssignment) &&
    (raw.source === undefined || isTaskSource(raw.source)) &&
    typeof raw.createdAt === "string" &&
    typeof raw.updatedAt === "string";
  if (!structural) return null;

  const hasPos = isFinitePos(raw.pos);
  const placement: TaskPlacement = isPlacement(raw.placement) ? raw.placement : hasPos ? "pinned" : "unplaced";
  const pinned = placement === "pinned" && hasPos;
  return {
    id: raw.id!,
    project: raw.project!,
    status: raw.status!,
    text: raw.text!,
    placement: placement === "pinned" && !hasPos ? "unplaced" : placement,
    ...(pinned ? { pos: raw.pos } : {}),
    ...(raw.dueAt !== undefined ? { dueAt: raw.dueAt, dueTz: raw.dueTz } : {}),
    ...(raw.attachments !== undefined ? { attachments: raw.attachments } : {}),
    assignments: raw.assignments!,
    ...(raw.source !== undefined ? { source: raw.source } : {}),
    createdAt: raw.createdAt!,
    updatedAt: raw.updatedAt!,
  };
}

export function isTask(value: unknown): value is BoardTask {
  return coerceTask(value) !== null;
}

function isRecentCreate(value: unknown): value is RecentCreate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<RecentCreate>;
  return typeof entry.clientRequestId === "string" && typeof entry.taskId === "string";
}

export function loadTasks(filePath = TASKS_FILE): BoardTask[] {
  return loadTasksFile(filePath).tasks;
}

/** The whole persisted file, with legacy rows coerced and receipts filtered. */
export function loadTasksFile(filePath = TASKS_FILE): TasksFileState {
  const raw = readJson(filePath) as TasksFile | null;
  const tasks = Array.isArray(raw?.tasks)
    ? raw.tasks.map(coerceTask).filter((task): task is BoardTask => task !== null)
    : [];
  const recentCreates = Array.isArray(raw?.recentCreates) ? raw.recentCreates.filter(isRecentCreate) : [];
  return { tasks, recentCreates };
}

export function saveTasks(tasks: BoardTask[], filePath = TASKS_FILE): void {
  /* Preserve the idempotency receipts a tasks-only save (patch/delete/send)
     doesn't touch, so a create replay still resolves after them. */
  const { recentCreates } = loadTasksFile(filePath);
  saveTasksFile({ tasks, recentCreates }, filePath);
}

export function saveTasksFile(state: TasksFileState, filePath = TASKS_FILE): void {
  atomicWriteJson(filePath, state.recentCreates.length ? { tasks: state.tasks, recentCreates: state.recentCreates } : { tasks: state.tasks });
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

/**
 * The create-path variant of {@link mutateTasks} that carries the idempotency
 * receipts through the same serialized read-modify-write, so a `clientRequestId`
 * replay is resolved against the freshest persisted map. Return `state: undefined`
 * to skip the write (validation failures, and replays that changed nothing).
 */
export function mutateTasksFile<R>(
  mutate: (state: TasksFileState) => { state: TasksFileState | undefined; result: R },
  filePath = TASKS_FILE,
): R {
  const outcome = mutate(loadTasksFile(filePath));
  if (outcome.state) saveTasksFile(outcome.state, filePath);
  return outcome.result;
}
