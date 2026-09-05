import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { canonicalProject } from "@/lib/projects/aliases";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";

import { snapshotTasks, stampTaskRevisions, taskRevision } from "./revision";
import { isTaskAttachment } from "./attachments";
import type { RecentCreate } from "./commands";
import type { AssignmentState, BoardTask, TaskAssignment, TaskPlacement, TaskSource, TaskStatus } from "./types";

export const TASKS_FILE = statePath("tasks.json");

// Keep untouched legacy rows exactly as stored, including extension fields and
// omitted placement/revision. Response coercion must not migrate other rows.
const persistedRows = new WeakMap<BoardTask, unknown>();
function committedRows(tasks: BoardTask[], before: ReturnType<typeof snapshotTasks>, replacements: boolean): unknown[] {
  for (const task of tasks) task.project = canonicalProject(task.project);
  stampTaskRevisions(tasks, before, replacements);
  return tasks.map(task => {
    const prior = before.get(task.id);
    return prior && taskRevision(task) === prior.revision && persistedRows.has(prior.ref)
      ? persistedRows.get(prior.ref) : task;
  });
}

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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
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
    (assignment.launchId === undefined || typeof assignment.launchId === "string" || assignment.launchId === null) &&
    (assignment.clientAttemptId === undefined || typeof assignment.clientAttemptId === "string" || assignment.clientAttemptId === null) &&
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
  const task: BoardTask = {
    ...raw,
    id: raw.id!,
    project: canonicalProject(raw.project!),
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
  if (!pinned) delete task.pos;
  try { Object.assign(task, { revision: taskRevision(task) }); } catch { return null; }
  return task;
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

/** Read without writes; malformed existing state refuses instead of dropping rows. */
export function loadTasksFile(filePath = TASKS_FILE): TasksFileState {
  const raw = readJson(filePath) as TasksFile | undefined;
  if (raw === undefined) return { tasks: [], recentCreates: [] };
  if (!raw || !Array.isArray(raw.tasks)) throw new Error("invalid persisted task state");
  const tasks = raw.tasks.map(value => {
    const task = coerceTask(value);
    if (!task) throw new Error("invalid persisted task row");
    persistedRows.set(task, value);
    return task;
  });
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error("duplicate persisted task id");
  if (raw.recentCreates !== undefined && (!Array.isArray(raw.recentCreates) || !raw.recentCreates.every(isRecentCreate))) {
    throw new Error("invalid persisted task receipts");
  }
  const recentCreates = (raw.recentCreates ?? []) as RecentCreate[];
  return { tasks, recentCreates };
}

export function saveTasks(tasks: BoardTask[], filePath = TASKS_FILE): void {
  withFileTransactionSync(filePath, "task state is busy", () => {
    /* Preserve the idempotency receipts a tasks-only save (patch/delete/send)
       doesn't touch, so a create replay still resolves after them. */
    const { tasks: current, recentCreates } = loadTasksFile(filePath);
    const rows = committedRows(tasks, snapshotTasks(current), false);
    atomicWriteJson(filePath, recentCreates.length ? { tasks: rows, recentCreates } : { tasks: rows });
  });
}

export function saveTasksFile(state: TasksFileState, filePath = TASKS_FILE): void {
  withFileTransactionSync(filePath, "task state is busy", () => {
    const rows = committedRows(state.tasks, snapshotTasks(loadTasksFile(filePath).tasks), false);
    atomicWriteJson(filePath, state.recentCreates.length ? { tasks: rows, recentCreates: state.recentCreates } : { tasks: rows });
  });
}

/**
 * Process-shared read-modify-write over the tasks file. The callback must stay
 * synchronous: complete slow async work first, then fold its result into the
 * fresh snapshot here. Return `tasks: undefined` to skip the write.
 */
export function mutateTasks<R>(
  mutate: (tasks: BoardTask[]) => { tasks: BoardTask[] | undefined; result: R },
  filePath = TASKS_FILE,
): R {
  return withFileTransactionSync(filePath, "task state is busy", () => {
    const current = loadTasksFile(filePath);
    const before = snapshotTasks(current.tasks);
    const outcome = mutate(current.tasks);
    if (outcome.tasks) {
      const rows = committedRows(outcome.tasks, before, true);
      atomicWriteJson(filePath, current.recentCreates.length
        ? { tasks: rows, recentCreates: current.recentCreates }
        : { tasks: rows });
    }
    return outcome.result;
  });
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
  return withFileTransactionSync(filePath, "task state is busy", () => {
    const current = loadTasksFile(filePath);
    const before = snapshotTasks(current.tasks);
    const outcome = mutate(current);
    if (outcome.state) {
      const rows = committedRows(outcome.state.tasks, before, true);
      atomicWriteJson(filePath, outcome.state.recentCreates.length
        ? { tasks: rows, recentCreates: outcome.state.recentCreates }
        : { tasks: rows });
    }
    return outcome.result;
  });
}
