"use client";

import { Link2, StickyNote } from "lucide-react";

import { useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";

import { TASK_TONES, taskTitle } from "@/components/tasks/taskModel";

import type { TaskRelation } from "./taskRelations";

/**
 * The conversation-side half of bidirectional task↔agent navigation (issue
 * #292): one chip per related board task, sitting in reserved layout space
 * inside the pane's flex column — between the header and the transcript — so it
 * never overlays conversation content the way a floating chip layer would.
 * Chips are plain buttons (tab-reachable, Enter/Space activate) with titles and
 * screen-reader labels naming the task, and coarse-pointer viewports get a
 * 44px tap height.
 */
export function TaskRelationStrip({
  relations,
  onOpenTask,
}: {
  relations: readonly TaskRelation[];
  /** Opens/centers the task card on the board (the task-side chip's mirror). */
  onOpenTask: (task: BoardTask) => void;
}) {
  const { t } = useLocale();
  if (!relations.length) return null;
  return (
    <nav
      data-task-relations
      aria-label={t("tasks.relatedNav")}
      className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border bg-sunken/70 px-2 py-1"
    >
      {relations.map(({ task, relation }) => {
        const title = taskTitle(task.text) || t("tasks.untitled");
        return (
          <button
            key={`${relation}:${task.id}`}
            type="button"
            data-task-relation={task.id}
            className="inline-flex min-h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border bg-card px-2 text-[10.5px] font-semibold text-secondary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 pointer-coarse:min-h-11 pointer-coarse:px-3"
            aria-label={t("tasks.openTaskAria", { title })}
            title={`${title} — ${t(relation === "assignment" ? "tasks.relatedAssignedTitle" : "tasks.relatedSourceTitle")}`}
            onClick={() => onOpenTask(task)}
          >
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: TASK_TONES[task.status].color }} />
            {relation === "source" ? (
              <Link2 className="h-3 w-3 shrink-0 text-info" aria-hidden />
            ) : (
              <StickyNote className="h-3 w-3 shrink-0 text-muted" aria-hidden />
            )}
            <span className="min-w-0 truncate">{title}</span>
          </button>
        );
      })}
    </nav>
  );
}
