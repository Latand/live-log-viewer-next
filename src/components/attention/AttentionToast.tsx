"use client";

import { X } from "lucide-react";
import { useEffect, useRef } from "react";

import { topScreen, useMobileNav } from "@/components/mobile/mobileNav";
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
 * into the badge. The phone renders the ARRIVAL BANNER of mobile v2 instead
 * (issue #1439, lane 8; README §2 rule 3, §4.2 `chat-arrival`, §4.6): the
 * shell's one banner slot, directly under the bar, reads «Needs you · <the
 * decision>» over the conversation's title, the body opens it, × dismisses,
 * and it collapses into the bar's badge on its own after ~6 s
 * (`ARRIVAL_COLLAPSE_MS`). The shell decides which screens get the slot (never
 * the board: its queue is the first section); this component adds the one
 * rule the shell cannot know — the conversation the banner announces is
 * already on screen, so announcing it there would repeat the question card
 * the feed is showing. Open and dismiss stay two separate targets in both.
 */

/** How long an arrival banner stays before it collapses into the badge. */
export const ARRIVAL_COLLAPSE_MS = 6_000;

export function AttentionToast({ file, mobile, onOpen, onDismiss, collapseMs = ARRIVAL_COLLAPSE_MS }: {
  file: FileEntry;
  mobile: boolean;
  onOpen: () => void;
  onDismiss: () => void;
  /** Test seam for the phone's collapse; production uses the design's ~6 s. */
  collapseMs?: number;
}) {
  const { t, locale } = useLocale();
  const title = decisionLine(t, locale, file) ?? t("viewer.agentWaiting");

  if (mobile) {
    return <ArrivalBanner file={file} decision={title} onOpen={onOpen} onDismiss={onDismiss} collapseMs={collapseMs} />;
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

function ArrivalBanner({ file, decision, onOpen, onDismiss, collapseMs }: {
  file: FileEntry;
  decision: string;
  onOpen: () => void;
  onDismiss: () => void;
  collapseMs: number;
}) {
  const { t } = useLocale();
  const navState = useMobileNav();
  const here = topScreen(navState);
  /* The collapse is armed ONCE per announced conversation and runs on its own
     clock: the host re-renders on every poll and hands down a fresh dismiss
     closure each time, and re-arming on either would keep the banner up for as
     long as anything on the page moved. The callback is read through a ref so
     the timer fires whatever the host has for it by then. */
  const dismissRef = useRef(onDismiss);
  useEffect(() => { dismissRef.current = onDismiss; }, [onDismiss]);
  useEffect(() => {
    const timer = window.setTimeout(() => dismissRef.current(), collapseMs);
    return () => window.clearTimeout(timer);
  }, [file.path, collapseMs]);

  /* The conversation is what the operator is reading: its question card is in
     the feed under this very bar, so the banner would only repeat it. The
     timer above keeps running, so the badge still takes over on schedule. */
  if (here.kind === "chat" && here.id === file.path) return null;

  const title = file.title;
  /* The root carries `data-mobile2-arrival` and NOT `data-attention-toast`:
     the shell's slot (`[data-mobile2-banner]`) is the one banner surface the
     capture's receipt gate measures, and a second receipt hook nested inside
     it would read its own open target as a control it covers. */
  return (
    <div
      data-mobile2-arrival={file.path}
      className="flex min-h-11 shrink-0 items-stretch gap-1 border-b border-warning/45 bg-warning-soft pl-3 pr-0.5"
    >
      <button
        type="button"
        data-attention-toast-open
        aria-label={t("mobile2.attention.open", { title })}
        className="flex min-h-11 min-w-0 flex-1 flex-col justify-center py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
        onClick={onOpen}
      >
        <span data-attention-toast-title className="block text-label font-bold leading-[1.2] text-warning">
          {t("mobile2.attention.arrival", { decision })}
        </span>
        <span className="truncate text-body font-semibold leading-[1.25] text-primary">{title}</span>
      </button>
      <button
        type="button"
        data-attention-toast-dismiss
        className="flex h-11 w-11 shrink-0 items-center justify-center self-center rounded-[8px] text-warning active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        aria-label={t("mobile2.attention.dismiss")}
        onClick={onDismiss}
      >
        <X className="h-5 w-5" aria-hidden />
      </button>
    </div>
  );
}
