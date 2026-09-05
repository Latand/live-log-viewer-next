import { createHash, randomUUID } from "node:crypto";
import type { BoardTask } from "./types";

export type TaskWithRevision = BoardTask & { revision: string };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]),
  );
  return value;
}

/** Full persisted content, including extension fields; revision is store-owned. */
export function taskFingerprint(task: BoardTask): string {
  const { revision: _revision, ...content } = task as TaskWithRevision;
  return createHash("sha256").update(JSON.stringify(canonical(content))).digest("hex");
}

export function taskRevision(task: BoardTask): string {
  const revision = (task as Partial<TaskWithRevision>).revision;
  if (revision === undefined) return `task-legacy:${taskFingerprint(task)}`;
  if (typeof revision !== "string" || !/^(task-v1:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|task-legacy:[0-9a-f]{64})$/.test(revision)) {
    throw new Error("invalid persisted task revision");
  }
  return revision;
}

export function snapshotTasks(tasks: BoardTask[]) {
  return new Map(tasks.map(task => [task.id, { ref: task, fingerprint: taskFingerprint(task), revision: taskRevision(task) }]));
}

/** Snapshot before the callback: writers can mutate nested assignments in place. */
export function stampTaskRevisions(tasks: BoardTask[], before: ReturnType<typeof snapshotTasks>, replacementsAreWrites: boolean): void {
  for (const task of tasks) {
    const prior = before.get(task.id);
    const changed = !prior || prior.fingerprint !== taskFingerprint(task)
      || (replacementsAreWrites && prior.ref !== task);
    (task as TaskWithRevision).revision = changed ? `task-v1:${randomUUID()}` : prior.revision;
  }
}
