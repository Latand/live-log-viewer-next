import type { TaskStatus } from "@/lib/tasks/types";

/** Text/background pair per task status (flows tones + Claude coral). */
export interface TaskTone {
  color: string;
  soft: string;
}

export const TASK_TONES: Record<TaskStatus, TaskTone> = {
  inbox: { color: "var(--color-warning)", soft: "var(--color-warning-soft)" },
  assigned: { color: "var(--color-accent)", soft: "var(--color-accent-soft)" },
  blocked: { color: "var(--color-danger)", soft: "var(--color-danger-soft)" },
  done: { color: "var(--color-success)", soft: "var(--color-success-soft)" },
};

/** Chip-click cycle order; statuses move manually in v1. */
export const TASK_STATUS_CYCLE: readonly TaskStatus[] = ["inbox", "assigned", "blocked", "done"];

export function nextTaskStatus(status: TaskStatus): TaskStatus {
  const idx = TASK_STATUS_CYCLE.indexOf(status);
  return TASK_STATUS_CYCLE[(idx + 1) % TASK_STATUS_CYCLE.length]!;
}

/** First line of the task text — the title everywhere a compact label fits.
    Returns "" for an effectively empty text; callers substitute the
    localized «untitled». */
export function taskTitle(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
}
