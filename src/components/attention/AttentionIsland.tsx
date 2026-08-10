"use client";

import { ChevronRight, Filter, TriangleAlert } from "lucide-react";

import { useLocale } from "@/lib/i18n";

interface Props {
  /** buildAttentionQueue's length, passed in so every surface shows one number. */
  count: number;
  mobile: boolean;
  queueOpen: boolean;
  filterActive: boolean;
  onToggleQueue: () => void;
  /** Advance the shared cycle; −1 (Shift-click) mirrors Shift-N. */
  onNext: (dir: 1 | -1) => void;
  onToggleFilter: () => void;
}

/**
 * The visible attention command island (issue #963): the needs-you count, the
 * Next step and the needs-me filter as one compact control. Pure presentation
 * over the queue the Viewer derives — `buildAttentionQueue`/`nextAttention`
 * stay the only attention authority, and every action here is a callback into
 * the Viewer's existing queue/cycle/filter state.
 *
 * The zero state stays present and quiet: a muted, inert count with no pulse
 * and no controls, so the corner always answers "what needs me?". No element
 * here animates, so there is no motion to reduce.
 */
export function AttentionIsland({ count, mobile, queueOpen, filterActive, onToggleQueue, onNext, onToggleFilter }: Props) {
  const { t } = useLocale();

  if (count === 0) {
    return (
      <div
        data-attention-island
        data-attention-zero
        role="status"
        aria-label={t("attention.badge", { count: 0 })}
        className="flex items-center rounded-full border border-border bg-card/95 px-3 py-1 text-[12px] font-bold text-muted shadow-1"
      >
        {mobile ? (
          <span className="inline-flex items-center gap-1">
            <TriangleAlert className="h-3 w-3" aria-hidden /> 0
          </span>
        ) : (
          <span>
            <span className="uppercase tracking-[0.08em]">{t("attention.needsYou")}</span> 0
          </span>
        )}
      </div>
    );
  }

  return (
    <div data-attention-island className="flex items-center overflow-hidden rounded-full border border-warning/45 bg-warning-soft shadow-1">
      <button
        type="button"
        data-attention-count
        className={`text-[12px] font-bold text-warning hover:bg-warning/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${
          mobile ? "inline-flex min-h-11 items-center px-3.5" : "px-3 py-1"
        }`}
        aria-expanded={queueOpen}
        aria-label={t("attention.badge", { count })}
        title={t("attention.openQueue")}
        onClick={onToggleQueue}
      >
        {mobile ? (
          <span className="inline-flex items-center gap-1">
            <TriangleAlert className="h-3 w-3" aria-hidden /> {count}
          </span>
        ) : (
          <span>
            <span className="uppercase tracking-[0.08em]">{t("attention.needsYou")}</span> {count}
          </span>
        )}
      </button>
      <div className="h-4 w-px shrink-0 bg-warning/45" aria-hidden />
      <button
        type="button"
        data-attention-next
        className={`text-[12px] font-bold text-warning hover:bg-warning/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${
          mobile ? "inline-flex min-h-11 items-center px-2.5" : "inline-flex items-center gap-0.5 py-1 pl-2 pr-1.5"
        }`}
        aria-label={t("attention.nextHint")}
        aria-keyshortcuts="n shift+n"
        title={t("attention.nextHint")}
        onClick={(event) => onNext(event.shiftKey ? -1 : 1)}
      >
        {mobile ? <ChevronRight className="h-4 w-4" aria-hidden /> : (
          <>
            {t("attention.next")}
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </>
        )}
      </button>
      {mobile ? null : (
        <>
          <div className="h-4 w-px shrink-0 bg-warning/45" aria-hidden />
          <button
            type="button"
            data-attention-filter
            className={`px-2 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${
              filterActive ? "bg-warning/30 text-warning" : "text-warning/70 hover:bg-warning/15 hover:text-warning"
            }`}
            aria-pressed={filterActive}
            title={filterActive ? t("attention.filterOff") : t("attention.filterOn")}
            aria-label={filterActive ? t("attention.filterOff") : t("attention.filterOn")}
            onClick={onToggleFilter}
          >
            <Filter className="h-3.5 w-3.5" aria-hidden />
          </button>
        </>
      )}
    </div>
  );
}
