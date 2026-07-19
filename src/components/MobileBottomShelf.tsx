"use client";

import { Layers, X } from "@/components/icons";
import { useLocale } from "@/lib/i18n";

/**
 * Phone-only handoff/hidden/readiness overlay (issue #177 item 5; chat-first
 * #419 reopened). The focused chat reserves ZERO bottom rows for it: a compact
 * header trigger opens this bottom sheet on demand, folding the focused
 * conversation's handoff control (`leading`) and the collapsed-worker / quiet /
 * readiness strips behind one disclosure. Closed, it renders nothing. Desktop
 * renders the two strips directly and never mounts this wrapper.
 */
export function MobileBottomShelf({
  open,
  onClose,
  total,
  leading,
  children,
}: {
  open: boolean;
  onClose: () => void;
  total: number;
  leading?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { t } = useLocale();
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/40"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        data-testid="mobile-bottom-shelf"
        role="dialog"
        aria-label={t("dash.hiddenShelf")}
        className="max-h-[80dvh] overflow-y-auto rounded-t-[16px] border-t border-border bg-card pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-2"
      >
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-card px-4 py-2">
          <Layers className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-ui font-bold text-primary">
            {t("dash.hiddenShelf")}
            {total > 0 ? <span className="ml-1 tabular-nums text-muted">{total}</span> : null}
          </span>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={onClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        {/* Handoff first — the conversation action the operator reaches for —
            then the folded worker / quiet / readiness strips. */}
        {leading ? <div className="border-b border-border px-2 py-1.5">{leading}</div> : null}
        {total > 0 ? <div>{children}</div> : null}
      </div>
    </div>
  );
}
