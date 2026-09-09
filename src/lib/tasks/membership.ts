import crypto from "node:crypto";

import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { isoNow } from "./helpers";
import { mutateTasks } from "./store";
import type { BoardTask, TaskAssignment, TaskOrigin } from "./types";

/**
 * Canonical task membership (#1586, design slice A).
 *
 * Every conversation the board admits belongs to at least one task. This module
 * is the single writer of that fact: a launch, an import or a container without
 * a recorded task obtains a placeholder task and a `linked` assignment in one
 * task-file transaction, keyed by a durable admission origin so a replay after a
 * crash or a lost response converges on the same task. Membership is
 * descriptive: it grants no runtime authority and never starts an agent.
 */

export const UNTITLED_TASK_TEXT = "Untitled task";
/** Newly refined titles stay short; longer imported text is kept as is. */
export const PLACEHOLDER_TITLE_LIMIT = 80;

export interface MembershipIdentity {
  conversationId?: string | null;
  launchId?: string | null;
  clientAttemptId?: string | null;
  path?: string | null;
  engine?: "claude" | "codex" | null;
  accountId?: string | null;
}

export interface MembershipInput {
  /** Project of a placeholder to create; explicit targets carry their own. */
  project: string;
  /** Durable admission origin: the conversation, launch or container identity. */
  origin: Pick<TaskOrigin, "kind" | "key">;
  /** Human title for a placeholder created by this admission (first prompt, pipeline task, …). */
  title?: string | null;
  identity: MembershipIdentity;
  /** Explicit targets from a task-local launch: all must exist, none is created. */
  explicitTaskIds?: readonly string[];
}

export type MembershipResult =
  | { ok: true; tasks: BoardTask[]; taskIds: string[]; created: string[]; changed: boolean }
  | { ok: false; error: string; status: number };

function normalizeTitle(title: string | null | undefined): string {
  const first = (title ?? "").split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!first) return UNTITLED_TASK_TEXT;
  return first.length > PLACEHOLDER_TITLE_LIMIT ? `${first.slice(0, PLACEHOLDER_TITLE_LIMIT - 1).trimEnd()}…` : first;
}

function sameIdentity(assignment: TaskAssignment, identity: MembershipIdentity): boolean {
  if (identity.launchId && assignment.launchId) return assignment.launchId === identity.launchId;
  if (identity.clientAttemptId && assignment.clientAttemptId) return assignment.clientAttemptId === identity.clientAttemptId;
  if (identity.conversationId && assignment.conversationId) return assignment.conversationId === identity.conversationId;
  return Boolean(identity.path) && assignment.path === identity.path;
}

/** Upserts one assignment that carries the identity. An existing assignment
    (any state) keeps its state and gains the identifiers it lacked; a new one
    is `linked`, which claims membership only, never a delivery. */
function upsertLinked(task: BoardTask, identity: MembershipIdentity, now: string): { task: BoardTask; changed: boolean } {
  const index = task.assignments.findIndex((assignment) => sameIdentity(assignment, identity));
  if (index >= 0) {
    const current = task.assignments[index]!;
    const merged: TaskAssignment = {
      ...current,
      ...(identity.launchId && !current.launchId ? { launchId: identity.launchId } : {}),
      ...(identity.clientAttemptId && !current.clientAttemptId ? { clientAttemptId: identity.clientAttemptId } : {}),
      ...(identity.conversationId && !current.conversationId ? { conversationId: identity.conversationId } : {}),
      path: current.path ?? identity.path ?? null,
      ...(identity.engine && !current.engine ? { engine: identity.engine } : {}),
      ...(identity.accountId && !current.accountId ? { accountId: identity.accountId } : {}),
    };
    const changed = JSON.stringify(merged) !== JSON.stringify(current);
    if (!changed) return { task, changed: false };
    const assignments = task.assignments.slice();
    assignments[index] = merged;
    return { task: { ...task, assignments, updatedAt: now }, changed: true };
  }
  const assignment: TaskAssignment = {
    ...(identity.launchId ? { launchId: identity.launchId } : {}),
    ...(identity.clientAttemptId ? { clientAttemptId: identity.clientAttemptId } : {}),
    path: identity.path ?? null,
    ...(identity.conversationId ? { conversationId: identity.conversationId } : {}),
    panePid: null,
    state: "linked",
    error: null,
    at: now,
    ...(identity.engine ? { engine: identity.engine } : {}),
    ...(identity.accountId ? { accountId: identity.accountId } : {}),
  };
  const status = task.status === "inbox" ? "assigned" : task.status;
  return { task: { ...task, status, assignments: [...task.assignments, assignment], updatedAt: now }, changed: true };
}

/** The durable admission key of a launch: its launch id or client attempt id. */
function sameKey(assignment: TaskAssignment, identity: MembershipIdentity): boolean {
  if (identity.launchId && assignment.launchId) return assignment.launchId === identity.launchId;
  return Boolean(identity.clientAttemptId) && assignment.clientAttemptId === identity.clientAttemptId;
}

function hasIdentity(identity: MembershipIdentity): boolean {
  return Boolean(identity.launchId || identity.clientAttemptId || identity.conversationId || identity.path);
}

/**
 * Resolve or create the task(s) a conversation/launch belongs to and record the
 * assignment, purely over a task snapshot. Resolution order: explicit targets;
 * the task whose origin key matches; a task already holding a canonical
 * assignment for the identity; otherwise one new placeholder. The placeholder
 * is exempt from the user-facing per-project task limit: membership is
 * mandatory, and refusing it would leave an agent outside every task.
 */
export function ensureTaskMembership(existing: readonly BoardTask[], input: MembershipInput, deps: { now?: () => string; id?: () => string } = {}): MembershipResult {
  const project = input.project.trim();
  if (!project && !input.explicitTaskIds?.length) return { ok: false, error: "project is required", status: 400 };
  if (!input.origin.key.trim()) return { ok: false, error: "membership origin key is required", status: 400 };
  if (!hasIdentity(input.identity)) return { ok: false, error: "membership needs a launch, conversation or path identity", status: 400 };
  const now = deps.now?.() ?? isoNow();
  let tasks = existing.slice();
  let changed = false;
  const commit = (index: number, next: { task: BoardTask; changed: boolean }) => {
    if (!next.changed) return;
    tasks[index] = next.task;
    changed = true;
  };

  /* A retry keeps its original target set: the tasks already holding this
     attempt/launch key are the admission's recorded targets, and a placeholder
     minted for this key means the original had no explicit target at all. */
  const keyed = tasks.filter((task) => task.assignments.some((assignment) => assignment.state !== "failed" && sameKey(assignment, input.identity)));
  const placeholderForKey = tasks.find((task) => task.project === (project || task.project) && task.origin?.kind === input.origin.kind && task.origin.key === input.origin.key);
  if (input.explicitTaskIds?.length) {
    const unique = [...new Set(input.explicitTaskIds)];
    if (placeholderForKey && !unique.includes(placeholderForKey.id)) {
      return { ok: false, error: "this launch was admitted without a task target; a retry cannot add one", status: 409 };
    }
    if (keyed.length && (keyed.length !== unique.length || keyed.some((task) => !unique.includes(task.id)))) {
      return { ok: false, error: "this launch was admitted with a different task target set; a retry keeps the original", status: 409 };
    }
    const indexes = unique.map((id) => tasks.findIndex((task) => task.id === id));
    const missing = indexes.findIndex((index) => index < 0);
    if (missing >= 0) return { ok: false, error: `task ${unique[missing]} is not available`, status: 404 };
    const projects = new Set(indexes.map((index) => tasks[index]!.project));
    if (projects.size > 1 || (project && !projects.has(project))) return { ok: false, error: "explicit tasks must belong to the launch's project", status: 409 };
    for (const index of indexes) commit(index, upsertLinked(tasks[index]!, input.identity, now));
    return { ok: true, tasks: changed ? tasks : existing.slice(), taskIds: unique, created: [], changed };
  }

  const byOrigin = tasks.findIndex((task) => task.project === project && task.origin?.kind === input.origin.kind && task.origin.key === input.origin.key);
  if (byOrigin >= 0) {
    commit(byOrigin, upsertLinked(tasks[byOrigin]!, input.identity, now));
    return { ok: true, tasks: changed ? tasks : existing.slice(), taskIds: [tasks[byOrigin]!.id], created: [], changed };
  }

  const held = tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task.project === project && task.assignments.some((assignment) => assignment.state !== "failed" && sameIdentity(assignment, input.identity)));
  if (held.length) {
    for (const { index } of held) commit(index, upsertLinked(tasks[index]!, input.identity, now));
    return { ok: true, tasks: changed ? tasks : existing.slice(), taskIds: held.map(({ task }) => task.id), created: [], changed };
  }

  const id = deps.id?.() ?? crypto.randomUUID();
  const placeholder: BoardTask = {
    id,
    project,
    status: "inbox",
    text: normalizeTitle(input.title),
    placement: "unplaced",
    origin: { kind: input.origin.kind, key: input.origin.key, refinement: input.title?.trim() ? "titled" : "pending" },
    assignments: [],
    createdAt: now,
    updatedAt: now,
  };
  const bound = upsertLinked(placeholder, input.identity, now);
  tasks = [...tasks, bound.task];
  return { ok: true, tasks, taskIds: [id], created: [id], changed: true };
}

/** {@link ensureTaskMembership} inside the serialized task-file transaction. */
export function commitTaskMembership(input: MembershipInput, filePath?: string): MembershipResult {
  return mutateTasks((tasks) => {
    const result = ensureTaskMembership(tasks, input);
    return { tasks: result.ok && result.changed ? result.tasks : undefined, result };
  }, filePath);
}

/** Fills in the identifiers a launch learned after its receipt (launch id,
    conversation id) on the assignment the admission recorded under the client
    attempt key. Idempotent; a missing task or assignment is a no-op. */
export function recordLaunchIdentity(existing: readonly BoardTask[], taskIds: readonly string[], identity: MembershipIdentity, now = isoNow()): { tasks: BoardTask[]; changed: boolean } {
  const tasks = existing.slice();
  let changed = false;
  for (const taskId of taskIds) {
    const index = tasks.findIndex((task) => task.id === taskId);
    if (index < 0) continue;
    const next = upsertLinked(tasks[index]!, identity, now);
    if (next.changed) {
      tasks[index] = next.task;
      changed = true;
    }
  }
  return { tasks, changed };
}

/* ------------------------------------------------------------------------- */
/* Import of scanned conversations                                            */
/* ------------------------------------------------------------------------- */

export const ADMISSION_BATCH = 50;

/** Root transcripts the board would draw: real files (never a launch
    placeholder), no parent, and a project to belong to. Children inherit their
    parent's band, so they need no task of their own. */
export function admissibleConversation(entry: FileEntry): boolean {
  if (!entry.project || !entry.path || entry.path.startsWith("spawn:")) return false;
  if (entry.parent) return false;
  if (entry.root !== "claude-projects" && entry.root !== "codex-sessions") return false;
  return !entry.path.includes("/subagents/");
}

interface CoveredIndex {
  conversationIds: Set<string>;
  paths: Set<string>;
  /** Launch id / client attempt id → tasks holding that launch's assignment. */
  launches: Map<string, string[]>;
}

function coveredBy(tasks: readonly BoardTask[]): CoveredIndex {
  const index: CoveredIndex = { conversationIds: new Set(), paths: new Set(), launches: new Map() };
  for (const task of tasks) {
    for (const assignment of task.assignments) {
      if (assignment.state === "failed") continue;
      if (assignment.conversationId) index.conversationIds.add(assignment.conversationId);
      if (assignment.path) index.paths.add(assignment.path);
      for (const key of [assignment.launchId, assignment.clientAttemptId]) {
        if (!key) continue;
        const list = index.launches.get(key) ?? [];
        if (!list.includes(task.id)) list.push(task.id);
        index.launches.set(key, list);
      }
    }
  }
  return index;
}

/** A launch whose membership was committed but whose identity write was lost
    still holds the receipt's attempt/launch key; the transcript's spawn card
    carries the same keys, so the assignment is repaired instead of duplicated. */
function launchTasksFor(index: CoveredIndex, entry: FileEntry): string[] {
  const keys = [entry.spawn?.launchId, entry.spawn?.clientAttemptId].filter((key): key is string => Boolean(key));
  const tasks = new Set<string>();
  for (const key of keys) for (const id of index.launches.get(key) ?? []) tasks.add(id);
  return [...tasks];
}

const isCovered = (index: CoveredIndex, entry: Pick<FileEntry, "path" | "conversationId">) =>
  Boolean(entry.conversationId && index.conversationIds.has(entry.conversationId)) || index.paths.has(entry.path);

/**
 * Plan the admissions one reconcile pass should write: at most `batch`
 * conversations without any task membership. A pipeline or review flow without
 * a recorded task claims one fallback task for its container and binds every
 * stage conversation it materialized; a pipeline that already carries task ids
 * covers its stage conversations by that record. Everything else gets one
 * placeholder titled from its first prompt.
 */
export function planAdmissions(
  entries: readonly FileEntry[],
  tasks: readonly BoardTask[],
  pipelines: readonly Pipeline[],
  batch = ADMISSION_BATCH,
): MembershipInput[] {
  const covered = coveredBy(tasks);
  const plans: MembershipInput[] = [];
  const claimed = new Set<string>();
  const byPath = new Map(entries.map((entry) => [entry.path, entry] as const));
  const entryFor = (attempt: { agentPath: string | null; conversationId: string | null }) =>
    (attempt.agentPath ? byPath.get(attempt.agentPath) : undefined)
      ?? (attempt.conversationId ? entries.find((entry) => entry.conversationId === attempt.conversationId) : undefined);
  for (const pipeline of pipelines) {
    if (pipeline.hiddenAt) continue;
    const attempts = pipeline.runs.flatMap((run) => run.attempts);
    const members = attempts.map(entryFor).filter((entry): entry is FileEntry => Boolean(entry));
    for (const member of members) claimed.add(member.path);
    if (pipeline.taskIds.length) continue;
    for (const member of members) {
      if (isCovered(covered, member) || plans.length >= batch) continue;
      plans.push({
        project: member.project,
        origin: { kind: "pipeline", key: pipeline.id },
        title: pipeline.task,
        identity: { conversationId: member.conversationId ?? null, path: member.path, engine: member.engine === "claude" || member.engine === "codex" ? member.engine : null },
      });
      covered.paths.add(member.path);
      if (member.conversationId) covered.conversationIds.add(member.conversationId);
    }
  }
  for (const entry of entries) {
    if (plans.length >= batch) break;
    if (claimed.has(entry.path) || !admissibleConversation(entry) || isCovered(covered, entry)) continue;
    const repair = launchTasksFor(covered, entry);
    if (repair.length) {
      plans.push({
        project: entry.project,
        origin: { kind: "launch", key: entry.spawn?.clientAttemptId ?? entry.spawn?.launchId ?? entry.path },
        identity: { launchId: entry.spawn?.launchId ?? null, clientAttemptId: entry.spawn?.clientAttemptId ?? null, conversationId: entry.conversationId ?? null, path: entry.path },
        explicitTaskIds: repair,
      });
      covered.paths.add(entry.path);
      if (entry.conversationId) covered.conversationIds.add(entry.conversationId);
      continue;
    }
    plans.push({
      project: entry.project,
      origin: { kind: "conversation", key: entry.conversationId ?? entry.path },
      title: entry.title,
      identity: { conversationId: entry.conversationId ?? null, path: entry.path, engine: entry.engine === "claude" || entry.engine === "codex" ? entry.engine : null },
    });
    covered.paths.add(entry.path);
    if (entry.conversationId) covered.conversationIds.add(entry.conversationId);
  }
  return plans;
}

/** Apply one reconcile pass of admissions to a task snapshot. */
export function admitConversations(tasks: readonly BoardTask[], plans: readonly MembershipInput[], deps: { now?: () => string; id?: () => string } = {}): { tasks: BoardTask[]; admitted: number } {
  let current = tasks.slice();
  let admitted = 0;
  for (const plan of plans) {
    const result = ensureTaskMembership(current, plan, deps);
    if (!result.ok || !result.changed) continue;
    current = result.tasks;
    admitted += 1;
  }
  return { tasks: current, admitted };
}

/** Durable controller pass: bounded, serialized, never from a read-only GET. */
export function admitScannedConversations(entries: readonly FileEntry[], pipelines: readonly Pipeline[], filePath?: string): number {
  return mutateTasks((tasks) => {
    const plans = planAdmissions(entries, tasks, pipelines);
    if (!plans.length) return { tasks: undefined, result: 0 };
    const outcome = admitConversations(tasks, plans);
    return { tasks: outcome.admitted ? outcome.tasks : undefined, result: outcome.admitted };
  }, filePath);
}
