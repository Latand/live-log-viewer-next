import type { RegistryConversation } from "@/lib/agent/registry";
import type { BoardTask, TaskAssignment } from "./types";

const CHAIN_LIMIT = 64;

interface SupersedenceLookup {
  conversation(id: string): Pick<RegistryConversation, "id" | "supersededBy" | "generations"> | null;
  canonicalConversationId(id: string): string;
}

/**
 * Task-deck absorption for supersedence chains (issue #383): every task that
 * holds an assignment for a superseded predecessor projects an additional
 * `handoff` assignment for the live chain end, so #325's task-keyed grouping
 * pulls the successor round into the same deck with zero new grouping code.
 *
 * Read-model overlay only: the durable task store is never mutated by a scan
 * (assignment history stays append-only and untouched), and tasks without
 * superseded assignments are returned as the same object.
 */
export function projectSupersededTaskHandoffs(
  tasks: BoardTask[],
  conversations: Record<string, Pick<RegistryConversation, "id" | "supersededBy" | "generations">>,
  canonicalConversationId: (id: string) => string,
): BoardTask[] {
  const lookup: SupersedenceLookup = {
    conversation: (id) => conversations[canonicalConversationId(id)] ?? null,
    canonicalConversationId,
  };
  let changed = false;
  const projected = tasks.map((task) => {
    const overlay = taskOverlay(task, lookup);
    if (overlay) changed = true;
    return overlay ?? task;
  });
  return changed ? projected : tasks;
}

function taskOverlay(task: BoardTask, lookup: SupersedenceLookup): BoardTask | null {
  const assignedIds = new Set(task.assignments
    .map((assignment) => assignment.conversationId)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .map((id) => lookup.canonicalConversationId(id)));
  if (!assignedIds.size) return null;
  const inherited: TaskAssignment[] = [];
  const inheritedIds = new Set<string>();
  for (const id of assignedIds) {
    const superseded = lookup.conversation(id)?.supersededBy;
    if (!superseded) continue;
    const tail = chainTail(id, lookup);
    if (!tail || assignedIds.has(tail.id) || inheritedIds.has(tail.id)) continue;
    inheritedIds.add(tail.id);
    inherited.push({
      path: tail.generations.at(-1)?.path ?? null,
      conversationId: tail.id,
      panePid: null,
      state: "handoff",
      error: null,
      at: superseded.at,
    });
  }
  if (!inherited.length) return null;
  return { ...task, assignments: [...task.assignments, ...inherited] };
}

function chainTail(
  id: string,
  lookup: SupersedenceLookup,
): Pick<RegistryConversation, "id" | "supersededBy" | "generations"> | null {
  const seen = new Set<string>();
  let current = lookup.conversation(id);
  while (current && current.supersededBy && !seen.has(current.id) && seen.size < CHAIN_LIMIT) {
    seen.add(current.id);
    const next = lookup.conversation(current.supersededBy.conversationId);
    if (!next) return null; // dangling successor: fail open, inherit nothing
    current = next;
  }
  return current && !current.supersededBy ? current : null;
}
