"use client";

import { useState } from "react";

import { ListTodo } from "lucide-react";

import { SectionHeader } from "@/components/ui/SectionHeader";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";

import { FlipRow } from "./FlipRow";
import { TASK_TONES, taskTitle } from "./tasks/taskModel";
import type { TaskStatusStack } from "./scheme/taskStacks";
import { cleanTitle } from "./utils";

function StatusRow({
  stack,
  onOpen,
}: {
  stack: TaskStatusStack;
  onOpen: (task: BoardTask) => void;
}) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const tone = TASK_TONES[stack.status];
  return (
    <div className="min-w-0">
      <button
        className={`flex w-full items-center gap-2 rounded-[8px] px-2 text-left text-[11px] font-semibold text-primary hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
          isMobile ? "min-h-11" : "h-7"
        }`}
        aria-expanded={open}
        aria-label={t("taskStacks.statusAria", { status: t(`tasks.status.${stack.status}`), count: stack.items.length })}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: tone.color }} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t(`tasks.status.${stack.status}`)}</span>
        <span className="shrink-0 text-[10px] font-normal tabular-nums text-muted">{stack.items.length}</span>
      </button>
      {open ? (
        <FlipRow className="mt-1 flex flex-wrap items-start gap-1.5 pb-1 pl-5">
          {stack.items.map((task) => {
            const title = cleanTitle(taskTitle(task.text), 60) || t("tasks.untitled");
            return (
              <button
                key={task.id}
                data-flip-key={task.id}
                className={`inline-flex max-w-[340px] items-center gap-1.5 rounded-full border border-transparent text-[11px] font-semibold text-primary hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  isMobile ? "min-h-11 px-3" : "h-7 px-2"
                }`}
                style={{ backgroundColor: tone.soft }}
                title={t("taskStacks.open", { title })}
                aria-label={t("taskStacks.open", { title })}
                onClick={() => onOpen(task)}
              >
                <span className="truncate">{title}</span>
                {task.assignments.length ? (
                  <span className="shrink-0 rounded-full bg-card px-1.5 text-[9px] font-bold text-muted" aria-label={t("taskStacks.assignments", { count: task.assignments.length })}>
                    {task.assignments.length}
                  </span>
                ) : null}
              </button>
            );
          })}
        </FlipRow>
      ) : null}
    </div>
  );
}

/**
 * Compact Kanban strip of the board's stacked task cards (taskStacks.ts): one
 * counted row per status; a row expands into chips, and a chip expands its
 * card back onto the board at its stored placement (a durable per-project
 * pin) and glides the camera to it. Everything a card carries — body, status,
 * placement, assignments — reappears on the expanded full card.
 */
export function TaskStacksStrip({
  stacks,
  onOpen,
}: {
  stacks: TaskStatusStack[];
  onOpen: (task: BoardTask) => void;
}) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const total = stacks.reduce((sum, stack) => sum + stack.items.length, 0);
  if (!total) return null;
  return (
    <div className="shrink-0 border-t border-border bg-canvas" data-testid="task-stacks">
      <SectionHeader
        open={open}
        onToggle={() => setOpen((value) => !value)}
        label={t("taskStacks.title")}
        count={total}
        icon={<ListTodo className="h-3 w-3 shrink-0 text-muted" aria-hidden />}
        ariaLabel={t("taskStacks.aria")}
        mobile={isMobile}
      />
      {open ? (
        <div className="flex max-h-52 flex-col gap-0.5 overflow-y-auto px-3 pb-2.5">
          {stacks.map((stack) => (
            <StatusRow key={stack.status} stack={stack} onOpen={onOpen} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
