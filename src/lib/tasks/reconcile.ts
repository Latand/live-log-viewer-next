import path from "node:path";

import type { FileEntry } from "@/lib/types";

import type { BoardTask, TaskAssignment } from "./types";

const ANCESTRY_MAX_DEPTH = 15;
const DEAD_SPAWN_ERROR = "агент не запустився";

export interface ReconcileEnv {
  successorForPath?: (pathname: string, files: FileEntry[]) => string | null;
  pathForPanePid?: (panePid: number, files: FileEntry[]) => string | null;
  panePidAlive?: (panePid: number) => boolean;
  now?: () => string;
}

function isMainClaudeSession(entry: FileEntry): boolean {
  if (entry.root !== "claude-projects" || !entry.path.endsWith(".jsonl")) return false;
  if (entry.path.includes(path.sep + "subagents" + path.sep)) return false;
  return entry.name.split(path.sep).length === 2;
}

export function defaultSuccessorForPath(pathname: string, files: FileEntry[]): string | null {
  const byPath = new Map(files.map((file) => [file.path, file]));
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

function reconcileAssignment(assignment: TaskAssignment, files: FileEntry[], env: ReconcileEnv): { assignment: TaskAssignment; dirty: boolean } {
  const at = env.now?.() ?? new Date().toISOString();
  if (assignment.path) {
    const successor = terminalSuccessor(assignment.path, files, env.successorForPath);
    if (successor && successor !== assignment.path) {
      return { assignment: { ...assignment, path: successor, state: "delivered", error: null, at }, dirty: true };
    }
    return { assignment, dirty: false };
  }

  if (assignment.panePid !== null) {
    const attributed = env.pathForPanePid?.(assignment.panePid, files) ?? null;
    if (attributed) {
      return { assignment: { ...assignment, path: attributed, state: "delivered", error: null, at }, dirty: true };
    }
    const alive = env.panePidAlive?.(assignment.panePid) ?? true;
    if (!alive && assignment.state !== "failed") {
      return { assignment: { ...assignment, state: "failed", error: DEAD_SPAWN_ERROR, at }, dirty: true };
    }
  }
  return { assignment, dirty: false };
}

export function reconcileTasks(files: FileEntry[], tasks: BoardTask[], env: ReconcileEnv = {}): { tasks: BoardTask[]; dirty: boolean } {
  let dirty = false;
  const reconciled = tasks.map((task) => {
    let taskDirty = false;
    const assignments = task.assignments.map((assignment) => {
      const result = reconcileAssignment(assignment, files, env);
      if (result.dirty) taskDirty = true;
      return result.assignment;
    });
    if (!taskDirty) return task;
    dirty = true;
    return { ...task, assignments, updatedAt: env.now?.() ?? new Date().toISOString() };
  });
  return { tasks: dirty ? reconciled : tasks, dirty };
}
