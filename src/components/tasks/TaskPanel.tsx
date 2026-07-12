"use client";

import { MapPin } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Link2, X } from "@/components/icons";
import { fmtAge } from "@/components/utils";
import { useTaskDraft } from "@/hooks/useTaskDraft";
import { getLocale, useLocale } from "@/lib/i18n";
import { formatDue, isOverdue } from "@/lib/tasks/helpers";
import type { BoardTask } from "@/lib/tasks/types";

import { createTask } from "./taskApi";
import { TaskComposer } from "./TaskComposer";
import { TASK_TONES, taskTitle } from "./taskModel";

/** Freshest work first; done tasks sink to the bottom of the list. */
function panelOrder(a: BoardTask, b: BoardTask): number {
  const doneRank = (task: BoardTask) => (task.status === "done" ? 1 : 0);
  return doneRank(a) - doneRank(b) || b.updatedAt.localeCompare(a.updatedAt);
}

/** Inline composer atop the panel — commits an `unplaced` task (no board
    position); it shows in the list at once and can be placed later. */
function PanelNewTask({ project, onDone }: { project: string; onDone: () => void }) {
  const { t } = useLocale();
  /* A ref (updated in an effect) bridges the composer's `submit`, needed at
     construction, to the later `save` without a forward reference. */
  const saveRef = useRef<(text?: string) => void | Promise<void>>(() => {});
  const draft = useTaskDraft(project, (overrideText) => saveRef.current(overrideText));
  const { composer } = draft;

  const save = async (overrideText?: string) => {
    const text = (overrideText ?? composer.textRef.current).trim();
    if (composer.busy || composer.voiceSending) return;
    if (!text) {
      composer.setStatus({ kind: "err", text: t("tasks.composerNeedsText") });
      return;
    }
    composer.setBusy(true);
    composer.setStatus(null);
    try {
      const created = await createTask({
        project,
        text,
        placement: "unplaced",
        dueAt: draft.dueAt,
        dueTz: draft.dueTz,
        attachments: draft.stagedAttachments(),
        clientRequestId: draft.getRequestId(),
      });
      if ("error" in created) {
        composer.setStatus({ kind: "err", text: created.error });
        return;
      }
      draft.reset();
      onDone();
    } finally {
      composer.setBusy(false);
    }
  };
  useEffect(() => {
    saveRef.current = save;
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void draft.composer.submit();
      }}
      className="flex flex-col gap-1.5 rounded-[10px] border border-line bg-panel p-1.5"
    >
      <TaskComposer draft={draft} placeholder={t("tasks.newPlaceholder")} createLabel={t("tasks.panelCreate")} />
      <button
        type="button"
        className="self-end text-[10px] font-semibold text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        onClick={onDone}
      >
        {t("common.close")}
      </button>
    </form>
  );
}

/**
 * The tracking list docked right of the board: rows across one project or
 * all of them, a click glides the board camera to the card (switching the
 * dashboard project first when the task lives elsewhere). Its top row creates
 * a task inline (`unplaced`); an unplaced row carries a `place on map` action.
 */
export function TaskPanel({
  tasks,
  project,
  onOpenTask,
  onPlaceOnMap,
  onClose,
}: {
  /** Every project's tasks; the header toggle filters. */
  tasks: BoardTask[];
  project: string;
  onOpenTask: (task: BoardTask) => void;
  /** Arms board placement mode for an unplaced task; absent hides the action. */
  onPlaceOnMap?: (task: BoardTask) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [scope, setScope] = useState<"project" | "all">("project");
  const [composing, setComposing] = useState(false);
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
        {composing ? (
          <PanelNewTask project={project} onDone={() => setComposing(false)} />
        ) : (
          <button
            type="button"
            className="mb-0.5 flex h-8 shrink-0 items-center justify-center gap-1 rounded-[8px] border border-dashed border-accent/50 text-[11.5px] font-bold text-accent hover:bg-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onClick={() => setComposing(true)}
          >
            + {t("tasks.newTask")}
          </button>
        )}
        {rows.length ? (
          rows.map((task) => {
            const tone = TASK_TONES[task.status];
            const unplaced = task.placement === "unplaced" || !task.pos;
            const dueOverdue = task.dueAt ? isOverdue(task.dueAt) : false;
            return (
              <div
                key={task.id}
                className={`flex w-full min-w-0 flex-col gap-0.5 rounded-[8px] border border-line bg-panel px-2 py-1.5 shadow-card hover:border-accent/40 ${
                  task.status === "done" ? "opacity-60" : ""
                }`}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-col gap-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
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
                  <span className="flex flex-wrap items-center gap-2 pl-0.5 text-[10px] text-dim">
                    {scope === "all" ? <span className="min-w-0 max-w-[110px] truncate">{task.project}</span> : null}
                    {task.dueAt && task.dueTz ? (
                      <span className={dueOverdue ? "font-semibold text-[#a04a2e]" : ""} title={t("tasks.dueTitle", { zone: task.dueTz })}>
                        ⏰ {formatDue(task.dueAt, task.dueTz, getLocale())}
                      </span>
                    ) : null}
                    {task.attachments?.length ? <span title={t("tasks.attachCount", { count: task.attachments.length })}>📎 {task.attachments.length}</span> : null}
                    {task.source ? (
                      <span className="inline-flex items-center gap-0.5 text-[#0d6f5f]" title={`${t("tasks.sourceTitle")}: ${task.source.text}`}>
                        <Link2 className="h-2.5 w-2.5" aria-hidden />
                        {t("tasks.source")}
                      </span>
                    ) : null}
                    {task.assignments.length ? <span>⤷ {task.assignments.length}</span> : null}
                    <span>{fmtAge(new Date(task.updatedAt).getTime() / 1000)}</span>
                  </span>
                </button>
                {unplaced ? (
                  <div className="flex items-center gap-1.5 pl-0.5">
                    <span className="rounded-full bg-chip px-1.5 py-0.5 text-[9px] font-bold text-[#7a5300]">{t("tasks.unplaced")}</span>
                    {onPlaceOnMap ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-0.5 rounded-[6px] border border-line px-1.5 py-0.5 text-[9.5px] font-bold text-accent hover:bg-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                        onClick={() => onPlaceOnMap(task)}
                      >
                        <MapPin className="h-2.5 w-2.5" aria-hidden /> {t("tasks.placeOnMap")}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        ) : (
          <div className="px-2 py-3 text-center text-[11px] text-dim">{t("tasks.panelEmpty")}</div>
        )}
      </div>
    </aside>
  );
}
