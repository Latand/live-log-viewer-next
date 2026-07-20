"use client";

import { useEffect, useRef } from "react";

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
export function MobileBottomShelf(props: {
  open: boolean;
  onClose: () => void;
  total: number;
  leading?: React.ReactNode;
  children: React.ReactNode;
}) {
  /* Gate before the modal body so its focus/scroll-lock effects run exactly on
     mount and unmount (the open transition), never while merely re-rendering
     closed. */
  if (!props.open) return null;
  return <BottomShelfSheet {...props} />;
}

function BottomShelfSheet({
  onClose,
  total,
  leading,
  children,
}: {
  onClose: () => void;
  total: number;
  leading?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { t } = useLocale();
  const sheetRef = useRef<HTMLDivElement>(null);

  /* Modal semantics matching MobilePipelineDockSheet (PR #431): focus moves into
     the sheet on open, the body scroll locks so the covered page can't pan under
     the overlay, and focus returns to the opener (the header shelf trigger) on
     close. Mount-only — this component mounts only while open, so the open
     transition is exactly this effect's lifecycle. */
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheetRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  /* Escape closes; Tab is trapped inside the sheet in both directions so
     keyboard and assistive-technology focus never reach the obscured page. The
     listener re-binds per `onClose` identity — a window listener has no focus
     side effects, so this stays quiet across re-renders. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const sheet = sheetRef.current;
      if (!sheet) return;
      const focusables = [...sheet.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )].filter((el) => !el.hasAttribute("disabled"));
      if (!focusables.length) {
        event.preventDefault();
        sheet.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && sheet.contains(active);
      if (event.shiftKey) {
        if (!inside || active === first || active === sheet) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/40"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={sheetRef}
        data-testid="mobile-bottom-shelf"
        role="dialog"
        aria-modal="true"
        aria-label={t("dash.hiddenShelf")}
        tabIndex={-1}
        className="max-h-[80dvh] overflow-y-auto rounded-t-[16px] border-t border-border bg-card pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-2 focus-visible:outline-none"
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
