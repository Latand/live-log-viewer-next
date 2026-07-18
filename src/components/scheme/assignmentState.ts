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

/**
 * Whether the open-agent control navigates. Any state classified against a
 * resolved transcript that is still on the board — live, killed, unhosted
 * (stalled/idle/done hosts included) — has a pane to center on, so navigation
 * stays available (issue #292 fresh review: a stalled assigned agent is still
 * reachable board content). Unreachable states stay unavailable: gone (no
 * transcript resolves), spawning (nothing exists to open yet), failed, and
 * migrating (the pane is mid-move between accounts).
 */
export function assignmentOpenable(state: AssignmentAgentState): boolean {
  return state === "live" || state === "killed" || state === "unhosted";
}
