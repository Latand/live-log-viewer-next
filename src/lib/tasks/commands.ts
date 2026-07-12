import crypto from "node:crypto";

import { isTaskAttachment } from "./attachments";
import { isoNow } from "./helpers";
import type { BoardTask, TaskAttachment, TaskAssignment, TaskSource, TaskStatus } from "./types";

export const TASK_TEXT_LIMIT = 6000;
export const TASKS_PER_PROJECT_LIMIT = 300;
/** How many recent create receipts are kept for `clientRequestId` replay. Sized
    to the double-tap / retry-after-timeout window; a replay older than the cap
    can mint a twin (documented, durability beyond the cap is deferred). */
export const RECENT_CREATES_CAP = 100;

export type TaskCommandResult =
  | { ok: true; tasks: BoardTask[]; task: BoardTask }
  | { ok: false; error: string; status: number };

/** A `clientRequestId → taskId` receipt, persisted in `tasks.json` so a replay
    survives a server restart. Oldest entries evict past {@link RECENT_CREATES_CAP}. */
export interface RecentCreate {
  clientRequestId: string;
  taskId: string;
}

export type CreateTaskResult =
  | { ok: true; tasks: BoardTask[]; task: BoardTask; recentCreates: RecentCreate[]; replay: boolean }
  | { ok: false; error: string; status: number };

export interface CreateTaskInput {
  project?: unknown;
  text?: unknown;
  placement?: unknown;
  pos?: unknown;
  dueAt?: unknown;
  dueTz?: unknown;
  attachments?: unknown;
  clientRequestId?: unknown;
  source?: unknown;
}

export interface PatchTaskInput {
  text?: unknown;
  status?: unknown;
  placement?: unknown;
  pos?: unknown;
  dueAt?: unknown;
  dueTz?: unknown;
}

/** Injected so the pure command can ask the store whether an attachment ref's
    bytes actually exist; defaults to "trust the ref" for unit tests. */
export interface TaskCommandDeps {
  now?: () => string;
  id?: () => string;
  attachmentExists?: (att: TaskAttachment) => boolean;
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

function normalizePos(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pos = value as { x?: unknown; y?: unknown };
  if (typeof pos.x !== "number" || !Number.isFinite(pos.x)) return null;
  if (typeof pos.y !== "number" || !Number.isFinite(pos.y)) return null;
  return { x: pos.x, y: pos.y };
}

function normalizeStatus(value: unknown): TaskStatus | null {
  return value === "inbox" || value === "assigned" || value === "blocked" || value === "done" ? value : null;
}

/** Client-writable placement values; `auto` is server-reserved (#17). */
function normalizePlacement(value: unknown): "pinned" | "unplaced" | null {
  return value === "pinned" || value === "unplaced" ? value : null;
}

/** True when the IANA zone is one `Intl` accepts without throwing. */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

type DueResult = { ok: true; dueAt?: string; dueTz?: string } | { ok: false; error: string };

/** `dueAt`/`dueTz` are both-or-neither. `dueAt` must round-trip `Date.parse`
    and `dueTz` must be a real IANA zone. Returns the canonical UTC instant. */
function normalizeDue(dueAt: unknown, dueTz: unknown): DueResult {
  const hasAt = dueAt !== undefined && dueAt !== null;
  const hasTz = dueTz !== undefined && dueTz !== null;
  if (!hasAt && !hasTz) return { ok: true };
  if (hasAt !== hasTz) return { ok: false, error: "dueAt and dueTz must be set together" };
  if (typeof dueAt !== "string" || typeof dueTz !== "string") return { ok: false, error: "invalid deadline" };
  const parsed = Date.parse(dueAt);
  if (!Number.isFinite(parsed)) return { ok: false, error: "invalid dueAt" };
  if (!isValidTimeZone(dueTz)) return { ok: false, error: "invalid dueTz" };
  return { ok: true, dueAt: new Date(parsed).toISOString(), dueTz };
}

type AttachmentsResult = { ok: true; attachments?: TaskAttachment[] } | { ok: false; error: string; status: number };

function normalizeAttachments(value: unknown, exists: (att: TaskAttachment) => boolean): AttachmentsResult {
  if (value === undefined || value === null) return { ok: true };
  if (!Array.isArray(value)) return { ok: false, error: "invalid attachments", status: 400 };
  if (value.length === 0) return { ok: true };
  const attachments: TaskAttachment[] = [];
  for (const item of value) {
    if (!isTaskAttachment(item)) return { ok: false, error: "invalid attachment ref", status: 400 };
    if (!exists(item)) return { ok: false, error: "attachment not found in store", status: 400 };
    attachments.push(item);
  }
  return { ok: true, attachments };
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

function textLimitError(): { ok: false; error: string; status: number } {
  return { ok: false, error: `Task text must be no longer than ${TASK_TEXT_LIMIT} characters`, status: 400 };
}

export function createTask(
  existing: BoardTask[],
  input: CreateTaskInput,
  recentCreates: RecentCreate[] = [],
  deps: TaskCommandDeps = {},
): CreateTaskResult {
  const project = normalizeProject(input.project);
  if (!project) return { ok: false, error: "project is required", status: 400 };
  const text = normalizeText(input.text);
  if (!text) return { ok: false, error: "task text is required", status: 400 };
  if (text.length > TASK_TEXT_LIMIT) return textLimitError();

  /* Idempotency: a replayed create (double-tap, retry after a lost response)
     returns the task the first attempt made instead of minting a twin. */
  const clientRequestId = typeof input.clientRequestId === "string" && input.clientRequestId.trim() ? input.clientRequestId.trim() : null;
  if (clientRequestId) {
    const prior = recentCreates.find((entry) => entry.clientRequestId === clientRequestId);
    if (prior) {
      const task = existing.find((item) => item.id === prior.taskId);
      /* The task may have been deleted since; a replay then behaves as a fresh
         create rather than resurrecting a phantom. */
      if (task) return { ok: true, tasks: existing, task, recentCreates, replay: true };
    }
  }

  const pos = normalizePos(input.pos);
  const posGiven = input.pos !== undefined && input.pos !== null;
  if (posGiven && !pos) return { ok: false, error: "invalid task position", status: 400 };
  /* Placement omitted stays back-compatible: a `pos` means `pinned`, none is an
     error (the legacy create path always sent a pos). */
  const placement = normalizePlacement(input.placement) ?? (pos ? "pinned" : null);
  if (input.placement !== undefined && placement === null) {
    return { ok: false, error: "invalid placement", status: 400 };
  }
  if (placement === "pinned" && !pos) return { ok: false, error: "task position is required", status: 400 };
  if (placement === "unplaced" && pos) return { ok: false, error: "unplaced task must not carry a position", status: 400 };
  if (placement === null) return { ok: false, error: "task position is required", status: 400 };

  const due = normalizeDue(input.dueAt, input.dueTz);
  if (!due.ok) return { ok: false, error: due.error, status: 400 };
  const attachments = normalizeAttachments(input.attachments, deps.attachmentExists ?? (() => true));
  if (!attachments.ok) return attachments;

  const source = normalizeSource(input.source);
  if (source === null) return { ok: false, error: "invalid task source", status: 400 };
  const count = existing.filter((task) => task.project === project).length;
  if (count >= TASKS_PER_PROJECT_LIMIT) {
    return { ok: false, error: `The project already has ${TASKS_PER_PROJECT_LIMIT} tasks. Close or delete extra tasks.`, status: 409 };
  }

  const now = deps.now?.() ?? isoNow();
  const id = deps.id?.() ?? crypto.randomUUID();
  const task: BoardTask = {
    id,
    project,
    status: "inbox",
    text,
    placement,
    ...(placement === "pinned" && pos ? { pos } : {}),
    ...(due.dueAt ? { dueAt: due.dueAt, dueTz: due.dueTz } : {}),
    ...(attachments.attachments ? { attachments: attachments.attachments } : {}),
    assignments: [],
    ...(source ? { source } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const nextRecent = clientRequestId
    ? [...recentCreates, { clientRequestId, taskId: id }].slice(-RECENT_CREATES_CAP)
    : recentCreates;
  return { ok: true, tasks: [...existing, task], task, recentCreates: nextRecent, replay: false };
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
    /* A pos always pins: place-on-map and free drags both land here, so an
       unplaced task that gets a position becomes pinned in the same PATCH. */
    patch.pos = pos;
    patch.placement = "pinned";
  }
  if (Object.hasOwn(input, "placement")) {
    const placement = normalizePlacement(input.placement);
    if (!placement) return { ok: false, error: "invalid placement", status: 400 };
    /* Pinned needs a position: either supplied in this PATCH or already held. */
    if (placement === "pinned" && !patch.pos && !task.pos) {
      return { ok: false, error: "task position is required", status: 400 };
    }
    patch.placement = placement;
  }
  /* Deadline: `{dueAt:null}` clears both fields; `{dueAt,dueTz}` sets them
     (both-or-neither, validated). Touching only one is a 400. */
  if (Object.hasOwn(input, "dueAt") || Object.hasOwn(input, "dueTz")) {
    if (input.dueAt === null && input.dueTz === undefined) {
      patch.dueAt = undefined;
      patch.dueTz = undefined;
    } else {
      const due = normalizeDue(input.dueAt, input.dueTz);
      if (!due.ok) return { ok: false, error: due.error, status: 400 };
      patch.dueAt = due.dueAt;
      patch.dueTz = due.dueTz;
    }
  }

  const updated: BoardTask = { ...task, ...patch, updatedAt: now };
  /* An explicit clear leaves `undefined` fields on the spread; drop them so the
     persisted row and its validator agree that the deadline is gone. */
  if (Object.hasOwn(patch, "dueAt") && patch.dueAt === undefined) {
    delete updated.dueAt;
    delete updated.dueTz;
  }
  if (updated.placement === "unplaced") delete updated.pos;
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
      ...(index >= 0 && next[index]?.conversationId ? { conversationId: next[index]?.conversationId } : {}),
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
