import type { TaskStatus } from "@/lib/tasks/types";

/** Text/background pair per task status (flows tones + Claude coral). */
export interface TaskTone {
  color: string;
  soft: string;
}

export const TASK_TONES: Record<TaskStatus, TaskTone> = {
  inbox: { color: "#e0ae45", soft: "#fdf3dd" },
  assigned: { color: "#5a51e0", soft: "#efeefc" },
  blocked: { color: "#d97757", soft: "#faeee9" },
  done: { color: "#1a8a3e", soft: "#e7f4ea" },
};

/** Chip-click cycle order; statuses move manually in v1. */
export const TASK_STATUS_CYCLE: readonly TaskStatus[] = ["inbox", "assigned", "blocked", "done"];

export function nextTaskStatus(status: TaskStatus): TaskStatus {
  const idx = TASK_STATUS_CYCLE.indexOf(status);
  return TASK_STATUS_CYCLE[(idx + 1) % TASK_STATUS_CYCLE.length]!;
}

/** First line of the task text — the title everywhere a compact label fits.
    Returns "" for an effectively empty text; callers substitute the
    localized «без назви». */
export function taskTitle(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
}
