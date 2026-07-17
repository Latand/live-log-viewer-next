"use client";

import { getLocale, translate } from "@/lib/i18n";
import type { BoardTask, TaskAttachment, TaskStatus } from "@/lib/tasks/types";

/** Fired after any successful task mutation so pollers refresh immediately. */
export const TASKS_CHANGED_EVENT = "llv:tasks-changed";

export function fireTasksChanged(): void {
  window.dispatchEvent(new Event(TASKS_CHANGED_EVENT));
}

/** Per-target delivery outcome of POST /api/tasks/:id/send. */
export interface TaskSendTargetOutcome {
  path: string;
  ok: boolean;
  target: string | null;
  error: string | null;
}

export interface TaskSendResult {
  task: BoardTask;
  results: TaskSendTargetOutcome[];
  delivered: number;
  failed: number;
}

export interface TaskSpawnResult {
  task: BoardTask;
  target: string | null;
  path: string | null;
  panePid: number | null;
  launchId: string;
  conversationId: string;
  initialMessage: "pending" | "queued" | "delivered" | "failed";
  state: "starting" | "path-pending" | "settled" | "failed" | "conflict";
  retrySafe: boolean;
  assignment: "delivered" | "failed" | "spawning" | "handoff";
  error?: string;
}

type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

async function request<T>(url: string, method: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok || !json) {
      return {
        ok: false,
        status: res.status,
        error: json?.error ?? translate(getLocale(), "tasks.failed", { status: res.status }),
      };
    }
    fireTasksChanged();
    return { ok: true, data: json };
  } catch {
    return { ok: false, status: 0, error: translate(getLocale(), "common.serverUnavailable") };
  }
}

/** A create fully described by the shared draft: text plus placement, optional
    deadline and attachment refs, and a `clientRequestId` so a double-tap or a
    retry-after-timeout resolves to one task instead of a twin. */
export interface CreateTaskInput {
  project: string;
  text: string;
  placement: "pinned" | "unplaced";
  pos?: { x: number; y: number };
  dueAt?: string;
  dueTz?: string;
  attachments?: TaskAttachment[];
  clientRequestId?: string;
}

/** A per-commit-gesture id: stable across retries of one gesture (so two rapid
    clicks dedup to one task server-side) and regenerated once a task lands.
    randomUUID needs a secure context; LAN http gets the fallback. */
export function newClientRequestId(): string {
  return typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export async function createTask(input: CreateTaskInput): Promise<{ task: BoardTask } | { error: string }> {
  const res = await request<{ task: BoardTask }>("/api/tasks", "POST", input);
  return res.ok ? { task: res.data.task } : { error: res.error };
}

/** The GET URL that serves a stored attachment's bytes — used for draft/card
    thumbnails that must survive reload from the durable ref alone. */
export function attachmentPreviewUrl(att: TaskAttachment): string {
  return `/api/task-attachments?sha=${encodeURIComponent(att.sha256)}&ext=${encodeURIComponent(att.ext)}`;
}

/** Uploads one image to the content-addressed store and returns its durable
    ref, which a later create attaches to the task (the task then owns the bytes
    for every delivery — no post-send hop that can silently drop them). */
export async function uploadTaskAttachment(file: File): Promise<{ attachment: TaskAttachment } | { error: string }> {
  const form = new FormData();
  form.set("file", file);
  try {
    const res = await fetch("/api/task-attachments", { method: "POST", body: form });
    const json = (await res.json().catch(() => null)) as { attachment?: TaskAttachment; error?: string } | null;
    if (!res.ok || !json?.attachment) {
      return { error: json?.error ?? translate(getLocale(), "tasks.failed", { status: res.status }) };
    }
    return { attachment: json.attachment };
  } catch {
    return { error: translate(getLocale(), "common.serverUnavailable") };
  }
}

/*
 * In-flight text saves per task. Deliveries (send/spawn) read the persisted
 * text on the server, so they must wait for the newest text PATCH to land —
 * and abort when it failed — or a send right after an edit would deliver the
 * previous body. Registered synchronously inside updateTask, so a blur-commit
 * fired just before a button click is already visible to that click's
 * delivery call.
 */
const pendingTextByTask = new Map<string, Promise<string | null>>();

async function pendingTextError(id: string): Promise<string | null> {
  const pending = pendingTextByTask.get(id);
  if (!pending) return null;
  if ((await pending) === null) return null;
  return translate(getLocale(), "tasks.textNotSaved");
}

/**
 * Partial update, last-write-wins. A 404 means DELETE won over this PATCH:
 * treated as success — the refetch fired here drops the card silently.
 */
export function updateTask(
  id: string,
  patch: {
    text?: string;
    status?: TaskStatus;
    placement?: "pinned" | "unplaced";
    pos?: { x: number; y: number };
    /** `null` clears the deadline; a value must come paired with `dueTz`. */
    dueAt?: string | null;
    dueTz?: string;
  },
): Promise<string | null> {
  /* Text patches chain behind the previous in-flight one: an autosave and a
     blur commit racing over two connections could otherwise reach the LWW
     server in reversed order and persist the older body. */
  const prev = patch.text !== undefined ? pendingTextByTask.get(id) : undefined;
  const run = (async () => {
    if (prev) await prev;
    const res = await request<{ task: BoardTask }>(`/api/tasks/${encodeURIComponent(id)}`, "PATCH", patch);
    if (!res.ok && res.status === 404) {
      fireTasksChanged();
      return null;
    }
    return res.ok ? null : res.error;
  })();
  if (patch.text !== undefined) {
    pendingTextByTask.set(id, run);
    void run.finally(() => {
      if (pendingTextByTask.get(id) === run) pendingTextByTask.delete(id);
    });
  }
  return run;
}

export async function deleteTask(id: string): Promise<string | null> {
  const res = await request<{ ok: true }>(`/api/tasks/${encodeURIComponent(id)}`, "DELETE");
  if (!res.ok && res.status === 404) {
    fireTasksChanged();
    return null;
  }
  return res.ok ? null : res.error;
}

/** Records a handoff link (task routed into an agent's composer, nothing
    delivered). Waits out an in-flight text save so the marker matches the
    body that landed in the composer. */
export async function handoffTask(id: string, path: string): Promise<{ task: BoardTask } | { error: string }> {
  const textError = await pendingTextError(id);
  if (textError) return { error: textError };
  const res = await request<{ task: BoardTask }>(`/api/tasks/${encodeURIComponent(id)}/assignment`, "POST", { path });
  return res.ok ? { task: res.data.task } : { error: res.error };
}

/** Detaches one assignment (the undo for a wrong handoff). A 404 means the
    task is already gone — treated as success, the refetch drops the card. */
export async function unassignTask(id: string, path: string): Promise<string | null> {
  const res = await request<{ task: BoardTask }>(`/api/tasks/${encodeURIComponent(id)}/assignment`, "DELETE", { path });
  if (!res.ok && res.status === 404) {
    fireTasksChanged();
    return null;
  }
  return res.ok ? null : res.error;
}

/** Delivers the task to each target; returns the per-target breakdown.
    Waits out any in-flight text save first — a failed save aborts the
    delivery so stale content is never reported as sent. */
export async function sendTask(id: string, paths: string[]): Promise<TaskSendResult | { error: string }> {
  const textError = await pendingTextError(id);
  if (textError) return { error: textError };
  const res = await request<TaskSendResult>(`/api/tasks/${encodeURIComponent(id)}/send`, "POST", { paths });
  return res.ok ? res.data : { error: res.error };
}

/** Everything a fresh task agent can be launched with; effort/fast omitted
    means the CLI keeps its own defaults. */
export interface SpawnAgentInput {
  engine: "claude" | "codex";
  model?: string;
  cwd: string;
  effort?: string;
  fast?: boolean;
  clientAttemptId: string;
}

/** Creates one launch identity for a user gesture. Keep the returned value
    through retries whose response may have been lost. */
export function createTaskSpawnGesture(input: Omit<SpawnAgentInput, "clientAttemptId">): SpawnAgentInput {
  return { ...input, clientAttemptId: newClientRequestId() };
}

/** Spawns an agent with the task text as the brief; same stale-text guard
    as sendTask, since the server reads the persisted text as the prompt. */
export async function spawnTaskAgent(id: string, input: SpawnAgentInput): Promise<TaskSpawnResult | { error: string }> {
  const textError = await pendingTextError(id);
  if (textError) return { error: textError };
  const res = await request<TaskSpawnResult>(`/api/tasks/${encodeURIComponent(id)}/spawn`, "POST", input);
  return res.ok ? res.data : { error: res.error };
}
