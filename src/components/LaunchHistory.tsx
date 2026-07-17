"use client";

import { useState } from "react";

import { History, RotateCcw } from "lucide-react";

import { SectionHeader } from "@/components/ui/SectionHeader";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";
import { cleanTitle } from "@/lib/title";
import type { FileEntry } from "@/lib/types";

import { engineBadge, fmtAge } from "./utils";

/**
 * Compact launch-history strip for terminal structured spawn receipts (see
 * launchHistory.ts). Collapsed, it is one counted header line; expanded, each
 * pathless terminal receipt shows its state, its exact failure reason, and —
 * for a retry-safe failure — the retry affordance. Rows never open a board
 * pane: a pathless receipt has no transcript to show.
 */
export function LaunchHistory({
  items,
  onRetry,
}: {
  items: FileEntry[];
  /** Start a fresh attempt from this receipt's launch profile (a prefilled
      draft — nothing launches until the user sends it). */
  onRetry: (file: FileEntry) => void;
}) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  if (!items.length) return null;

  return (
    <div className="shrink-0 border-t border-border bg-canvas" data-testid="launch-history">
      <SectionHeader
        open={open}
        onToggle={() => setOpen((value) => !value)}
        label={t("launchHistory.title")}
        count={items.length}
        icon={<History className="h-3 w-3 shrink-0 text-muted" aria-hidden />}
        ariaLabel={t("launchHistory.aria")}
        mobile={isMobile}
      />
      {open ? (
        <ul className="flex max-h-52 flex-col gap-0.5 overflow-y-auto px-3 pb-2.5">
          {items.map((file) => {
            const badge = engineBadge(file);
            const spawn = file.spawn!;
            const failed = spawn.state === "failed";
            return (
              <li key={file.path} className={`flex min-w-0 items-center gap-1.5 rounded-[8px] px-2 text-[11px] text-primary ${isMobile ? "min-h-11" : "h-7"}`}>
                <span className="shrink-0 rounded-full px-1.5 text-[9px]" style={badge.style}>{badge.label}</span>
                <span className="min-w-0 shrink truncate font-semibold" title={cleanTitle(file.title)}>
                  {cleanTitle(file.title, 60)}
                </span>
                <span className={`shrink-0 rounded-full px-1.5 text-[10px] font-semibold ${failed ? "bg-danger-soft text-danger" : "bg-success-soft text-success"}`}>
                  {t(failed ? "launchHistory.failed" : "launchHistory.recovered")}
                </span>
                {failed && spawn.error ? (
                  <span className="min-w-0 flex-1 truncate text-danger" title={spawn.error}>
                    {spawn.error}
                  </span>
                ) : (
                  <span className="min-w-0 flex-1" aria-hidden />
                )}
                <span className="shrink-0 font-normal text-muted">{fmtAge(file.mtime)}</span>
                {failed && spawn.retrySafe ? (
                  <button
                    type="button"
                    aria-label={t("launchHistory.retry", { title: cleanTitle(file.title, 40) })}
                    title={t("launchHistory.retry", { title: cleanTitle(file.title, 40) })}
                    className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-card px-2 text-[10.5px] font-semibold text-primary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                      isMobile ? "min-h-9" : "h-5"
                    }`}
                    onClick={() => onRetry(file)}
                  >
                    <RotateCcw className="h-3 w-3" aria-hidden /> {t("launchHistory.retryLabel")}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
