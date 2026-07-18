import type { TaskAssignment } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

export type AssignmentAgentState = "spawning" | "failed" | "gone" | "migrating" | "killed" | "unhosted" | "live";

/** Classify one assignment against the currently resolved agent generation. */
export function assignmentAgentState(
  assignment: Pick<TaskAssignment, "state" | "path">,
  file: FileEntry | null,
): AssignmentAgentState {
  if (assignment.state === "failed") return "failed";
  if (assignment.state === "spawning" && !assignment.path) return "spawning";
  if (!file) return "gone";
  if (file.migration) return "migrating";
  if (file.proc === "killed") return "killed";
  if (file.proc === "running" || file.activity === "live" || file.activity === "recent") return "live";
  return "unhosted";
}

export function assignmentOpenable(state: AssignmentAgentState): boolean {
  return state === "live";
}
