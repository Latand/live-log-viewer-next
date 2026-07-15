import type { FileEntry } from "@/lib/types";
import type { TaskAssignment } from "@/lib/tasks/types";

/**
 * The user-visible state of one task assignment, derived truthfully from the
 * assignment record and the current generation of its agent (issue #292). The
 * old chip collapsed everything pathless into a spinner and read openability
 * straight off `FileEntry` presence; this separates the honest states so each
 * gets its own localized presentation and the open control is offered only for
 * an agent that can actually be jumped to.
 *
 *  - `spawning`  — a codex spawn awaiting scanner attribution (path still null).
 *  - `failed`    — the last delivery failed; shown as an error even before a
 *                  path is attributed, with no in-flight spinner.
 *  - `gone`      — delivered/handoff, but no current generation resolves: the
 *                  conversation left the list.
 *  - `migrating` — the resolved agent is mid account-migration; its pane is
 *                  moving, so it can't be opened yet.
 *  - `killed`    — the resolved agent's process was killed.
 *  - `unhosted`  — the agent resolves while no live pane hosts it (idle/stalled,
 *                  no running process), so it stays present and cannot be opened.
 *  - `live`      — a resolvable, current, running/active agent — the only state
 *                  whose open control is enabled.
 */
export type AssignmentAgentState = "spawning" | "failed" | "gone" | "migrating" | "killed" | "unhosted" | "live";

/**
 * Classify an assignment against the current generation of its agent. `file` is
 * the FileEntry the caller resolved for this assignment through the stable
 * conversation identity (id first, path fallback), or null when nothing in the
 * current list matches. Pure, so the whole state matrix is unit-testable.
 */
export function assignmentAgentState(
  assignment: Pick<TaskAssignment, "state" | "path">,
  file: FileEntry | null,
): AssignmentAgentState {
  /* A failed delivery is an error regardless of whether a path was ever
     attributed — it must never render as an in-flight spinner. */
  if (assignment.state === "failed") return "failed";
  /* Still spawning and unattributed: the only spinner state. */
  if (assignment.state === "spawning" && !assignment.path) return "spawning";
  if (!file) return "gone";
  if (file.migration) return "migrating";
  if (file.proc === "killed") return "killed";
  /* Live = a running process, or fresh transcript activity (a Claude session
     often carries no OS process yet is actively streaming). Everything else
     that still resolves is hosted but idle, so it stays present with no open
     control. */
  if (file.proc === "running" || file.activity === "live" || file.activity === "recent") return "live";
  return "unhosted";
}

/** The open-agent control is enabled only for a resolvable, live current agent —
    there is nothing to center and ring for a gone/killed/unhosted/migrating or
    failed/spawning assignment. */
export function assignmentOpenable(state: AssignmentAgentState): boolean {
  return state === "live";
}

/** Whether the chip shows an in-flight spinner: the sole spawning state. */
export function assignmentSpinning(state: AssignmentAgentState): boolean {
  return state === "spawning";
}
