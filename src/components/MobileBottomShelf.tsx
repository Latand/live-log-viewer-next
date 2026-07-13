"use client";

import { useState } from "react";

import { ChevronRight, Layers } from "@/components/icons";
import { useLocale } from "@/lib/i18n";

/**
 * Phone-only footer that carries all three bottom concerns on one row (issue
 * #177 item 5): the focused conversation's handoff control (`leading`) sits
 * beside a single disclosure that folds the collapsed-worker and quiet strips
 * behind one compact "Hidden" toggle. Expanding reveals those two sections,
 * each with its own sub-disclosure. Desktop renders the two strips directly and
 * never mounts this wrapper.
 */
export function MobileBottomShelf({ total, leading, children }: { total: number; leading?: React.ReactNode; children: React.ReactNode }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  if (total === 0 && !leading) return null;
  return (
    <div className="shrink-0 border-t border-border bg-card" data-testid="mobile-bottom-shelf">
      <div className="flex items-center gap-1.5 pr-1.5">
        {leading ? <div className="shrink-0">{leading}</div> : null}
        {total > 0 ? (
          <button
            type="button"
            className="flex min-h-11 flex-1 items-center gap-2 px-4 text-[10px] font-bold uppercase tracking-[.6px] text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
            <Layers className="h-3 w-3 shrink-0" aria-hidden />
            {t("dash.hiddenShelf")}
            <span className="font-semibold normal-case tracking-normal">{total}</span>
          </button>
        ) : (
          <span className="min-h-11 flex-1" aria-hidden />
        )}
      </div>
      {open && total > 0 ? <div>{children}</div> : null}
    </div>
  );
}
