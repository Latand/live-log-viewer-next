"use client";

import { useState } from "react";

import { ChevronRight, Layers } from "@/components/icons";
import { useLocale } from "@/lib/i18n";

/**
 * Phone-only bottom disclosure that folds the collapsed-worker and quiet
 * conversation strips behind one compact row (issue #177 item 5). Closed, the
 * board footer is a single ~44px row showing the combined hidden count instead
 * of two stacked full-width strips; open, it reveals the two existing sections
 * (each with its own sub-disclosure) unchanged. Desktop keeps the two strips
 * side by side — this wrapper is never used there.
 */
export function MobileBottomShelf({ total, children }: { total: number; children: React.ReactNode }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  if (total === 0) return null;
  return (
    <div className="shrink-0 border-t border-line bg-panel" data-testid="mobile-bottom-shelf">
      <button
        type="button"
        className="flex min-h-11 w-full items-center gap-2 px-4 text-[10px] font-bold uppercase tracking-[.6px] text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
        <Layers className="h-3 w-3 shrink-0" aria-hidden />
        {t("dash.hiddenShelf")}
        <span className="font-semibold normal-case tracking-normal">{total}</span>
      </button>
      {open ? <div>{children}</div> : null}
    </div>
  );
}
