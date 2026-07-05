"use client";

import { useMemo, useState } from "react";

import { X } from "@/components/icons";
import { fmtAge } from "@/components/utils";
import { useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";

import { TASK_TONES, taskTitle } from "./taskModel";

/** Freshest work first; done tasks sink to the bottom of the list. */
function panelOrder(a: BoardTask, b: BoardTask): number {
  const doneRank = (task: BoardTask) => (task.status === "done" ? 1 : 0);
  return doneRank(a) - doneRank(b) || b.updatedAt.localeCompare(a.updatedAt);
}

/**
 * The tracking list docked right of the board: rows across one project or
 * all of them, a click glides the board camera to the card (switching the
 * dashboard project first when the task lives elsewhere).
 */
export function TaskPanel({
  tasks,
  project,
  onOpenTask,
  onClose,
}: {
  /** Every project's tasks; the header toggle filters. */
  tasks: BoardTask[];
  project: string;
  onOpenTask: (task: BoardTask) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [scope, setScope] = useState<"project" | "all">("project");
  const rows = useMemo(
    () => (scope === "project" ? tasks.filter((task) => task.project === project) : [...tasks]).sort(panelOrder),
    [tasks, project, scope],
  );

  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-l border-line bg-panel" aria-label={t("tasks.panelTitle")}>
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-2.5">
        <span className="text-[12px] font-bold">{t("tasks.panelTitle")}</span>
        <div className="ml-1 flex items-center rounded-full border border-line p-0.5">
          {(["project", "all"] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={scope === key}
              className={`rounded-full px-2 py-0.5 text-[10px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                scope === key ? "bg-accent/10 text-accent" : "text-dim hover:text-ink"
              }`}
              onClick={() => setScope(key)}
            >
              {key === "project" ? t("tasks.panelThisProject") : t("tasks.panelAll")}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="ml-auto inline-flex shrink-0 items-center rounded-[8px] border border-line bg-bg px-1.5 py-0.5 text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label={t("tasks.panelClose")}
          onClick={onClose}
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
        {rows.length ? (
          rows.map((task) => {
            const tone = TASK_TONES[task.status];
            return (
              <button
                key={task.id}
                type="button"
                className={`flex w-full min-w-0 flex-col gap-0.5 rounded-[8px] border border-line bg-panel px-2 py-1.5 text-left shadow-card hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  task.status === "done" ? "opacity-60" : ""
                }`}
                title={task.text}
                onClick={() => onOpenTask(task)}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold"
                    style={{ backgroundColor: tone.soft, color: tone.color }}
                  >
                    {t(`tasks.status.${task.status}`)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold">
                    {taskTitle(task.text) || t("tasks.untitled")}
                  </span>
                </span>
                <span className="flex items-center gap-2 pl-0.5 text-[10px] text-dim">
                  {scope === "all" ? <span className="min-w-0 max-w-[110px] truncate">{task.project}</span> : null}
                  {task.assignments.length ? <span>⤷ {task.assignments.length}</span> : null}
                  <span>{fmtAge(new Date(task.updatedAt).getTime() / 1000)}</span>
                </span>
              </button>
            );
          })
        ) : (
          <div className="px-2 py-3 text-center text-[11px] text-dim">{t("tasks.panelEmpty")}</div>
        )}
      </div>
    </aside>
  );
}
