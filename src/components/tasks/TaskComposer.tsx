"use client";

import { CalendarClock, X } from "lucide-react";
import type { ReactNode } from "react";

import { ComposerBar } from "@/components/ComposerBar";
import { attachmentPreviewUrl } from "@/components/tasks/taskApi";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { UseTaskDraftReturn } from "@/hooks/useTaskDraft";
import { formatDue, fromDueInput, isOverdue, toDueInputValue } from "@/lib/tasks/helpers";
import { getLocale, useLocale } from "@/lib/i18n";

/** The deadline control: an "add deadline" pill that expands to a native
    datetime-local, and a formatted chip (overdue-tinted) with a clear button
    once set. The value is captured in the picker's zone and stored as a UTC
    instant + that zone. */
function DueChip({ draft }: { draft: UseTaskDraftReturn }) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const { dueAt, dueTz, setDue, clearDue } = draft;
  const overdue = dueAt ? isOverdue(dueAt) : false;

  return (
    <span className="inline-flex items-center gap-1">
      <label
        className={`inline-flex items-center gap-1 rounded-full font-semibold ${
          isMobile ? "min-h-11 px-3 text-[12px]" : "px-1.5 py-1 text-[9.5px]"
        } ${dueAt ? (overdue ? "bg-[#faeee9] text-[#a04a2e]" : "bg-chip text-[#555]") : "bg-chip text-[#555] hover:text-accent"}`}
        title={dueAt && dueTz ? t("tasks.dueTitle", { zone: dueTz }) : t("tasks.addDue")}
      >
        <CalendarClock className={isMobile ? "h-4 w-4" : "h-3 w-3"} aria-hidden />
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
          className={`inline-flex items-center justify-center rounded-full text-dim hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
            isMobile ? "h-11 w-11" : "h-4 w-4"
          }`}
        >
          <X className={isMobile ? "h-4 w-4" : "h-2.5 w-2.5"} aria-hidden />
        </button>
      ) : null}
    </span>
  );
}

/** Thumbnails of the staged (already-uploaded) attachments, served from their
    durable refs so they render after reload. Read-only apart from remove. */
function StagedAttachments({ draft }: { draft: UseTaskDraftReturn }) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  if (!draft.attachments.length) return null;
  /* Touch has no hover, so the phone shows each attachment as a row with a
     persistent 44px remove target beside the thumbnail (finding 4); desktop
     keeps the compact hover-to-remove grid. */
  if (isMobile) {
    return (
      <div className="flex flex-col gap-1.5">
        {draft.attachments.map((att, idx) => (
          <div key={att.id} className="flex items-center gap-2 rounded-[8px] border border-line bg-panel p-1.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={attachmentPreviewUrl(att)} alt={t("img.previewAlt", { n: idx + 1 })} className="h-11 w-11 shrink-0 rounded border border-line object-cover" />
            <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-dim">{t("img.previewAlt", { n: idx + 1 })}</span>
            <button
              type="button"
              onClick={() => draft.removeAttachment(att.id)}
              aria-label={t("img.removeAria", { n: idx + 1 })}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line bg-bg text-dim hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {draft.attachments.map((att, idx) => (
        <div key={att.id} className="group/att relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={attachmentPreviewUrl(att)} alt={t("img.previewAlt", { n: idx + 1 })} className="h-10 w-10 rounded border border-line object-cover" />
          <button
            type="button"
            onClick={() => draft.removeAttachment(att.id)}
            aria-label={t("img.removeAria", { n: idx + 1 })}
            className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full border border-line bg-panel text-dim shadow-card hover:text-err group-hover/att:flex focus-visible:flex focus-visible:outline-none"
          >
            <X className="h-2.5 w-2.5" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * The one composer every rich task-creation entry point renders: the shared
 * `ComposerBar` (text, voice, images) plus a deadline chip. Images are routed
 * to the draft's durable, upload-on-add store (`onImageFiles`) so staged refs
 * survive reload. State lives in `useTaskDraft`; the caller owns the commit
 * (`submit` on the draft) and the left-slot chrome (target count, a label, …).
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
    <>
      <ComposerBar
        composer={draft.composer}
        placeholder={placeholder}
        textareaAriaLabel={t("tasks.editAria")}
        imageAriaLabel={t("composer.addImages")}
        sendLabelIdle={createLabel}
        sendLabelRecording={t("composer.stopAndSend")}
        sendIdleClassName="border-accent bg-accent hover:opacity-90"
        onImageFiles={(files) => void draft.addFiles(files)}
        leftSlot={
          <span className="flex min-w-0 items-center gap-1">
            <DueChip draft={draft} />
            {leftSlot}
          </span>
        }
      />
      <StagedAttachments draft={draft} />
    </>
  );
}
