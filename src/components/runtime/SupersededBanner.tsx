"use client";

import { useState } from "react";

import { ArrowRight, History } from "lucide-react";
import { Loader2, Play } from "@/components/icons";
import { useLocale, type TFunction } from "@/lib/i18n";
import { fmtAge } from "@/components/utils";
import type { FileEntry } from "@/lib/types";

export interface SupersededBannerViewProps {
  t: TFunction;
  sinceLabel: string;
  onOpenSuccessor: () => void;
  onResumeHere: () => void;
  resumeBusy?: boolean;
  /** Set when the last resume-here fork failed — never silently swallowed. */
  resumeError?: string | null;
}

/**
 * The pane-level banner of a terminally superseded round (issue #383). It
 * replaces the dead-host recovery affordances: the primary action navigates to
 * the live successor, and "resume here" is an explicit operator fork that
 * clears the durable edge (invariant 5). Pure so both actions are DOM-tested;
 * sits in the `MigrationRibbon`/`DeadHostBanner` slot family between the
 * header and the feed, on desktop and inside `MobileFocusView` alike.
 */
export function SupersededBannerView({
  t,
  sinceLabel,
  onOpenSuccessor,
  onResumeHere,
  resumeBusy = false,
  resumeError = null,
}: SupersededBannerViewProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-superseded-banner
      className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-sunken px-2.5 py-2"
    >
      <div className="flex items-center gap-1.5 text-label font-bold text-secondary">
        <History className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{t("superseded.title", { since: sinceLabel })}</span>
      </div>
      <p className="text-caption font-semibold text-muted">{t("superseded.body")}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={onOpenSuccessor}
          className="inline-flex min-h-11 items-center gap-1 rounded-control border border-accent bg-accent px-2.5 text-label font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:min-h-8"
        >
          {t("superseded.open")} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onResumeHere}
          disabled={resumeBusy}
          className="inline-flex min-h-11 items-center gap-1 rounded-control border border-border bg-canvas px-2.5 text-label font-semibold text-muted hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 sm:min-h-8"
        >
          {resumeBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
          {t("superseded.resumeHere")}
        </button>
      </div>
      {resumeError ? (
        <p role="alert" className="text-caption font-semibold text-danger">{resumeError}</p>
      ) : null}
    </div>
  );
}

/** Primary navigation target of a superseded round (issue #383): the LIVE end
    of the chain (A→B→C opens C), falling back to the immediate successor for
    read models that predate the tail projection. The immediate edge itself
    stays untouched — it is the round history, not the destination. */
export function supersededNavigationTarget(
  superseded: NonNullable<FileEntry["supersededBy"]>,
): string {
  return superseded.tailConversationId ?? superseded.conversationId;
}

/** Container wiring the superseded-round actions for a conversation. */
export function SupersededBanner({ file }: { file: FileEntry }) {
  const { t } = useLocale();
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const superseded = file.supersededBy;
  if (!superseded) return null;
  const supersededAtSeconds = Date.parse(superseded.at) / 1000;
  const sinceLabel = fmtAge(Number.isFinite(supersededAtSeconds) ? supersededAtSeconds : file.mtime);

  const openSuccessor = () => {
    // The chain tail's stable id is the durable target; #c= survives path
    // rotation and resolves through conversation aliases.
    window.location.hash = "#c=" + encodeURIComponent(supersededNavigationTarget(superseded));
  };

  const resumeHere = async () => {
    if (resumeBusy) return;
    // An explicit operator fork (invariant 5): confirm, then clear the durable
    // edge. The card then falls back to its dead/resume surface, where the
    // ordinary recovery affordances take over.
    if (!window.confirm(t("superseded.resumeConfirm"))) return;
    setResumeBusy(true);
    setResumeError(null);
    try {
      const res = await fetch("/api/session/supersedence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: file.conversationId, action: "clear" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setResumeError(body.error ?? t("superseded.resumeFailed"));
      }
    } catch {
      setResumeError(t("superseded.resumeFailed"));
    } finally {
      setResumeBusy(false);
    }
  };

  return (
    <SupersededBannerView
      t={t}
      sinceLabel={sinceLabel}
      onOpenSuccessor={openSuccessor}
      onResumeHere={() => void resumeHere()}
      resumeBusy={resumeBusy}
      resumeError={resumeError}
    />
  );
}
