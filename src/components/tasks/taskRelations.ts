import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

export type TaskRelationKind = "assignment" | "source";

/** One conversation-side relation control: a board task reachable from a pane. */
export interface TaskRelation {
  task: BoardTask;
  relation: TaskRelationKind;
}

/**
 * Conversation-side view of the task graph (issue #292): for every transcript in
 * `files`, the open board tasks related to it — tasks assigned into the
 * conversation and tasks captured from it. Each task appears at most once per
 * pane, an assignment outranking a source pointing at the same conversation, and
 * every pane lists its assignments ahead of its captures. Assignment matching
 * prefers the durable conversation id and falls back to the transcript path, so
 * a succession keeps the relation on the live generation. Done tasks and
 * relations whose transcript is absent from `files` resolve to nothing — the
 * pane never advertises a control it cannot honor.
 */
export function taskRelationsByPath(
  files: readonly FileEntry[],
  tasks: readonly BoardTask[],
): Map<string, TaskRelation[]> {
  const pathByConversationId = new Map<string, string>();
  const knownPaths = new Set<string>();
  for (const file of files) {
    knownPaths.add(file.path);
    if (file.conversationId) pathByConversationId.set(file.conversationId, file.path);
  }
  const out = new Map<string, TaskRelation[]>();
  const push = (path: string, relation: TaskRelation) => {
    const list = out.get(path);
    if (list) list.push(relation);
    else out.set(path, [relation]);
  };
  for (const task of tasks) {
    if (task.status === "done") continue;
    /* One chip per pane per task: several assignments (or an assignment plus the
       capture source) can resolve to the same conversation. */
    const seen = new Set<string>();
    for (const assignment of task.assignments) {
      const path =
        (assignment.conversationId ? pathByConversationId.get(assignment.conversationId) : undefined) ??
        (assignment.path && knownPaths.has(assignment.path) ? assignment.path : undefined);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      push(path, { task, relation: "assignment" });
    }
    if (task.source && knownPaths.has(task.source.path) && !seen.has(task.source.path)) {
      push(task.source.path, { task, relation: "source" });
    }
  }
  /* Assignments lead the strip; the sort is stable, so task order is kept. */
  for (const list of out.values()) {
    list.sort((a, b) => (a.relation === b.relation ? 0 : a.relation === "assignment" ? -1 : 1));
  }
  return out;
}
