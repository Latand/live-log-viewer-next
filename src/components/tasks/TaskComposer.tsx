"use client";

import { CalendarClock, X } from "lucide-react";
import type { ReactNode } from "react";

import { ComposerBar } from "@/components/ComposerBar";
import type { UseTaskDraftReturn } from "@/hooks/useTaskDraft";
import { formatDue, fromDueInput, isOverdue, toDueInputValue } from "@/lib/tasks/helpers";
import { getLocale, useLocale } from "@/lib/i18n";

/** The deadline control: an "add deadline" pill that expands to a native
    datetime-local, and a formatted chip (overdue-tinted) with a clear button
    once set. The value is captured in the picker's zone and stored as a UTC
    instant + that zone. */
function DueChip({ draft }: { draft: UseTaskDraftReturn }) {
  const { t } = useLocale();
  const { dueAt, dueTz, setDue, clearDue } = draft;
  const overdue = dueAt ? isOverdue(dueAt) : false;

  return (
    <span className="inline-flex items-center gap-1">
      <label
        className={`inline-flex items-center gap-1 rounded-full px-1.5 py-1 text-[9.5px] font-semibold ${
          dueAt ? (overdue ? "bg-[#faeee9] text-[#a04a2e]" : "bg-chip text-[#555]") : "bg-chip text-[#555] hover:text-accent"
        }`}
        title={dueAt && dueTz ? t("tasks.dueTitle", { zone: dueTz }) : t("tasks.addDue")}
      >
        <CalendarClock className="h-3 w-3" aria-hidden />
        {dueAt && dueTz ? formatDue(dueAt, dueTz, getLocale()) : t("tasks.addDue")}
        <input
          type="datetime-local"
          aria-label={t("tasks.addDue")}
          value={dueAt ? toDueInputValue(dueAt) : ""}
          onChange={(event) => {
            const parsed = fromDueInput(event.target.value);
            if (parsed) setDue(parsed);
            else clearDue();
          }}
          /* The native control is the whole hit target but visually collapsed
             behind the chip label — a click anywhere on the pill opens it. */
          className="w-0 opacity-0"
        />
      </label>
      {dueAt ? (
        <button
          type="button"
          aria-label={t("tasks.clearDue")}
          onClick={clearDue}
          className="inline-flex h-4 w-4 items-center justify-center rounded-full text-dim hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <X className="h-2.5 w-2.5" aria-hidden />
        </button>
      ) : null}
    </span>
  );
}

/**
 * The one composer every rich task-creation entry point renders: the shared
 * `ComposerBar` (text, voice, images) plus a deadline chip. State lives in
 * `useTaskDraft`; the caller owns the commit (`submit` on the draft) and the
 * left-slot chrome (target count, a plain label, …).
 */
export function TaskComposer({
  draft,
  placeholder,
  createLabel,
  leftSlot,
}: {
  draft: UseTaskDraftReturn;
  placeholder: string;
  createLabel: string;
  /** Extra bottom-row left content (e.g. the target count on the sheet). */
  leftSlot?: ReactNode;
}) {
  const { t } = useLocale();
  return (
    <ComposerBar
      composer={draft.composer}
      placeholder={placeholder}
      textareaAriaLabel={t("tasks.editAria")}
      imageAriaLabel={t("composer.addImages")}
      sendLabelIdle={createLabel}
      sendLabelRecording={t("composer.stopAndSend")}
      sendIdleClassName="border-accent bg-accent hover:opacity-90"
      leftSlot={
        <span className="flex min-w-0 items-center gap-1">
          <DueChip draft={draft} />
          {leftSlot}
        </span>
      }
    />
  );
}
