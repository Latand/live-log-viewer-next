"use client";

import { X } from "lucide-react";
import { useEffect, useRef } from "react";

import { createTask } from "@/components/tasks/taskApi";
import { TaskComposer } from "@/components/tasks/TaskComposer";
import { TASK_TONES } from "@/components/tasks/taskModel";
import { useTaskDraft } from "@/hooks/useTaskDraft";
import { useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";

import { TASK_W } from "./taskGeometry";

/**
 * The on-board inline composer the «task» tool and empty-canvas double-click
 * drop, and the desktop `+ Task` button lands in a free slot: the full shared
 * `TaskComposer` (text, voice, images, deadline) inside a world-positioned
 * sticky shell, committing a **pinned** task exactly at `pos`. It reuses the
 * per-project draft, so text started here shows up in the panel/sheet too.
 */
export function TaskStickyComposer({
  project,
  pos,
  onCreated,
  onCancel,
}: {
  project: string;
  pos: { x: number; y: number };
  onCreated: (task: BoardTask) => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const saveRef = useRef<(text?: string) => void | Promise<void>>(() => {});
  const draft = useTaskDraft(project, (overrideText) => saveRef.current(overrideText));
  const { composer } = draft;

  useEffect(() => {
    composer.inputRef.current?.focus();
  }, [composer.inputRef]);

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
        placement: "pinned",
        pos,
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
      onCreated(created.task);
    } finally {
      composer.setBusy(false);
    }
  };
  useEffect(() => {
    saveRef.current = save;
  });

  return (
    <div
      data-scheme-task="new"
      className="absolute z-30"
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)`, width: TASK_W }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void composer.submit();
        }}
        className="flex flex-col gap-1.5 overflow-hidden rounded-[8px] border border-line bg-panel p-2 shadow-card ring-2 ring-accent/50"
        style={{ backgroundColor: TASK_TONES.inbox.soft }}
      >
        <div className="flex items-center justify-between">
          <span className="text-[10.5px] font-bold text-dim">{t("tasks.newTask")}</span>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={onCancel}
            className="inline-flex h-5 w-5 items-center justify-center rounded-[6px] text-dim hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        </div>
        <TaskComposer draft={draft} placeholder={t("tasks.newPlaceholder")} createLabel={t("tasks.panelCreate")} />
      </form>
    </div>
  );
}
