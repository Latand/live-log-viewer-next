import path from "node:path";

import type { FileEntry } from "@/lib/types";

import type { BoardTask, TaskAssignment } from "./types";

const ANCESTRY_MAX_DEPTH = 15;
const DEAD_SPAWN_ERROR = "agent did not start";

export interface ReconcileEnv {
  successorForPath?: (pathname: string, files: FileEntry[]) => string | null;
  pathForPanePid?: (panePid: number, files: FileEntry[]) => string | null;
  panePidAlive?: (panePid: number) => boolean;
  conversationIdForPath?: (pathname: string) => string | null;
  canonicalConversationId?: (conversationId: string) => string | null;
  pathForConversationId?: (conversationId: string) => string | null;
  now?: () => string;
}

function isMainClaudeSession(entry: FileEntry): boolean {
  if (entry.root !== "claude-projects" || !entry.path.endsWith(".jsonl")) return false;
  if (entry.path.includes(path.sep + "subagents" + path.sep)) return false;
  return entry.name.split(path.sep).length === 2;
}

export function defaultSuccessorForPath(pathname: string, files: FileEntry[]): string | null {
  const byPath = new Map(files.map((file) => [file.path, file]));
  return successorFromIndex(pathname, byPath);
}

function successorFromIndex(pathname: string, byPath: ReadonlyMap<string, FileEntry>): string | null {
  const entry = byPath.get(pathname);
  if (!entry?.parent || entry.handoff) return null;
  const successor = byPath.get(entry.parent);
  if (!successor) return null;
  return isMainClaudeSession(entry) && isMainClaudeSession(successor) ? successor.path : null;
}

function terminalSuccessor(pathname: string, files: FileEntry[], successorForPath: ReconcileEnv["successorForPath"]): string | null {
  const nextFor = successorForPath ?? defaultSuccessorForPath;
  const seen = new Set<string>([pathname]);
  let current = pathname;
  let successor: string | null = null;
  for (;;) {
    const next = nextFor(current, files);
    if (!next || seen.has(next)) return successor;
    successor = next;
    current = next;
    seen.add(current);
  }
}

export function pathForPanePid(
  files: FileEntry[],
  panePid: number,
  parentPidOf: (pid: number) => number | null,
): string | null {
  if (!Number.isInteger(panePid) || panePid <= 0) return null;
  for (const file of files) {
    if (file.pid === null) continue;
    const seen = new Set<number>();
    for (let pid: number | null = file.pid; pid !== null && !seen.has(pid); pid = parentPidOf(pid)) {
      seen.add(pid);
      if (seen.size > ANCESTRY_MAX_DEPTH) break;
      if (pid === panePid) return file.path;
    }
  }
  return null;
}

function reconcileAssignment(
  assignment: TaskAssignment,
  files: FileEntry[],
  filesByPath: ReadonlyMap<string, FileEntry>,
  env: ReconcileEnv,
): { assignment: TaskAssignment; dirty: boolean } {
  let current = assignment;
  let dirty = false;
  if (current.conversationId) {
    const canonicalId = env.canonicalConversationId?.(current.conversationId) ?? current.conversationId;
    if (canonicalId !== current.conversationId) {
      current = { ...current, conversationId: canonicalId };
      dirty = true;
    }
  }
  if (current.path && !current.conversationId) {
    const conversationId = env.conversationIdForPath?.(current.path)
      ?? filesByPath.get(current.path)?.conversationId
      ?? null;
    if (conversationId) { current = { ...current, conversationId }; dirty = true; }
  }
  const at = env.now?.() ?? new Date().toISOString();
  if (current.path) {
    const ownedPath = current.conversationId ? env.pathForConversationId?.(current.conversationId) ?? null : null;
    const successor = ownedPath ?? terminalSuccessor(current.path, files, env.successorForPath);
    if (successor && successor !== current.path) {
      /* A handoff that follows its agent into a resumed transcript stays a
         handoff — the routing moved, but nothing was ever auto-delivered. */
      const state = current.state === "handoff" ? "handoff" : "delivered";
      return { assignment: { ...current, path: successor, state, error: null, at }, dirty: true };
    }
    return { assignment: current, dirty };
  }

  if (current.panePid !== null) {
    const attributed = env.pathForPanePid?.(current.panePid, files) ?? null;
    if (attributed) {
      const conversationId = env.conversationIdForPath?.(attributed)
        ?? filesByPath.get(attributed)?.conversationId
        ?? null;
      return {
        assignment: {
          ...current,
          path: attributed,
          ...(conversationId ? { conversationId } : {}),
          state: "delivered",
          error: null,
          at,
        },
        dirty: true,
      };
    }
    const alive = env.panePidAlive?.(current.panePid) ?? true;
    if (!alive && current.state !== "failed") {
      return { assignment: { ...current, state: "failed", error: DEAD_SPAWN_ERROR, at }, dirty: true };
    }
  }
  return { assignment: current, dirty };
}

export function reconcileTasks(files: FileEntry[], tasks: BoardTask[], env: ReconcileEnv = {}): { tasks: BoardTask[]; dirty: boolean } {
  let dirty = false;
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const indexedEnv: ReconcileEnv = env.successorForPath
    ? env
    : { ...env, successorForPath: (pathname) => successorFromIndex(pathname, filesByPath) };
  const reconciled = tasks.map((task) => {
    let taskDirty = false;
    const assignments = task.assignments.map((assignment) => {
      const result = reconcileAssignment(assignment, files, filesByPath, indexedEnv);
      if (result.dirty) taskDirty = true;
      return result.assignment;
    });
    if (!taskDirty) return task;
    dirty = true;
    return { ...task, assignments, updatedAt: indexedEnv.now?.() ?? new Date().toISOString() };
  });
  return { tasks: dirty ? reconciled : tasks, dirty };
}
