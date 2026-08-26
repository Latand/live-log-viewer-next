"use client";

import { X } from "lucide-react";

import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { decisionLine } from "./decision";

/**
 * The «this agent needs you» toast (issue #1167).
 *
 * It used to announce a wait — «Agent is waiting for a reply» — over every wait
 * there is, so a plan, a permission prompt, a rate-limit wall and a five-option
 * question all read identically and the only way to learn what an agent wanted
 * was to open it. The title is now the DECISION, from the one `decisionLine`
 * the island popover rows and the orchestrator dock badge also read.
 *
 * The generic wording survives as the fallback and nothing more: a toast the
 * operator has not dismissed can outlive its own signal (the question was
 * answered from another surface), and inventing a decision for a conversation
 * that no longer carries one is worse than saying nothing specific.
 *
 * Desktop floats it under the attention island so a new toast visually docks
 * into the badge; the phone hands it the full width of an in-flow banner above
 * the board, where it reserves its own space instead of covering the toolbar.
 * Open and dismiss stay two separate targets in both.
 */
export function AttentionToast({ file, mobile, onOpen, onDismiss }: {
  file: FileEntry;
  mobile: boolean;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const { t, locale } = useLocale();
  const title = decisionLine(t, locale, file) ?? t("viewer.agentWaiting");

  if (mobile) {
    return (
      <div className="flex shrink-0 items-stretch gap-2 border-b border-warning/45 bg-warning-soft pl-3 pr-1.5 py-1.5" data-attention-toast>
        <button
          data-attention-toast-open
          className="flex min-h-11 min-w-0 flex-1 flex-col justify-center text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onClick={onOpen}
        >
          <span data-attention-toast-title className="block text-[11px] font-bold text-warning">{title}</span>
          <span className="truncate text-[13px] font-semibold text-primary">{file.title}</span>
        </button>
        <button
          data-attention-toast-dismiss
          className="flex h-11 w-11 shrink-0 items-center justify-center self-center rounded-full border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label={t("viewer.closeNotification")}
          onClick={onDismiss}
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div
      data-attention-toast
      className="pointer-events-auto flex max-w-[360px] gap-2 rounded-[8px] border border-warning/45 bg-warning-soft px-4 py-3 text-[13px] font-semibold text-primary shadow-1"
    >
      <button
        data-attention-toast-open
        className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        onClick={onOpen}
      >
        <span data-attention-toast-title className="block text-[11px] font-bold text-warning">{title}</span>
        <span className="line-clamp-2">{file.title}</span>
      </button>
      <button
        data-attention-toast-dismiss
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        aria-label={t("viewer.closeNotification")}
        onClick={onDismiss}
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
