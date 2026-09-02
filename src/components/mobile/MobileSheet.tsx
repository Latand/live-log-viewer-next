"use client";

import { X } from "lucide-react";
import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { useModalLayer } from "@/components/modalLayer";
import { useLocale } from "@/lib/i18n";

import { MobileReceipt, type ReceiptStore } from "./MobileReceipt";
import type { MobileSheetName } from "./mobileNav";

/*
 * The one sheet (docs/design/mobile-v2/README.md §2 rule 1, §3.3, §5): a
 * secondary surface opens over the current screen, takes at most 88 % of the
 * height, keeps the screen behind visible and dimmed, and closes with one tap
 * on the scrim, the ×, Escape, or a drag of its handle past 80 px — the handle
 * and the header follow the finger, and a shorter drag springs back over
 * 200 ms. It is modal in the sense `useModalLayer` already implements: Tab is
 * trapped, Escape answers, body scroll locks, focus returns to the opener.
 *
 * A sheet never creates a history entry; the navigation store (`mobileNav`)
 * says which one is open, and the shell renders it last. The receipt slot
 * inside a sheet sits between its body and its footer, the same slot the
 * screen's receipt takes between the body and the dock.
 */

/** A drag of the handle past this many pixels closes the sheet. */
export const SHEET_CLOSE_DRAG_PX = 80;

const CLOSE_BUTTON = "flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] text-secondary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

export function MobileSheet({
  name,
  title,
  extra,
  footer,
  full = false,
  onClose,
  children,
  receiptStore,
}: {
  name: MobileSheetName;
  title: string;
  /** A header control beside the title (the queue's «Next ›», the switcher's «Board ›»). */
  extra?: ReactNode;
  footer?: ReactNode;
  /** Fullscreen (the rotate / create draft): no handle, no rounded top. */
  full?: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Tests inject their own receipt store; the app uses the singleton. */
  receiptStore?: ReceiptStore;
}) {
  const { t } = useLocale();
  const sheetRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; dy: number } | null>(null);
  useModalLayer({ containerRef: sheetRef, onClose });

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (full) return;
    drag.current = { y: event.clientY, dy: 0 };
    const sheet = sheetRef.current;
    if (sheet) sheet.style.transition = "none";
    const target = event.currentTarget;
    if (typeof target.setPointerCapture === "function") {
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        /* A synthetic pointer without an id: the move and up still arrive here. */
      }
    }
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current) return;
    current.dy = Math.max(0, event.clientY - current.y);
    const sheet = sheetRef.current;
    if (sheet) sheet.style.transform = `translateY(${current.dy}px)`;
  };
  const settle = (close: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (close && current.dy > SHEET_CLOSE_DRAG_PX) {
      onClose();
      return;
    }
    const sheet = sheetRef.current;
    if (sheet) {
      sheet.style.transition = "transform 200ms cubic-bezier(0.2, 0, 0, 1)";
      sheet.style.transform = "";
    }
  };
  const onPointerUp = () => settle(true);
  const onPointerCancel = () => settle(false);
  const handle = { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/40"
      role="presentation"
      data-mobile2-scrim
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-mobile2-sheet={name}
        className={`flex flex-col bg-raised shadow-2 outline-none transition-[transform,opacity] duration-[320ms] ease-[cubic-bezier(0.2,0,0,1)] starting:translate-y-6 starting:opacity-0 motion-reduce:transition-none ${
          full ? "h-full max-h-full rounded-none" : "max-h-[88%] rounded-t-[16px]"
        } pb-[calc(6px+env(safe-area-inset-bottom))]`}
      >
        {full ? null : (
          <div className="shrink-0 touch-none px-6 pb-0.5 pt-2" data-mobile2-grab {...handle}>
            <div className="mx-auto h-1 w-9 rounded-sm bg-strong" aria-hidden />
          </div>
        )}
        <div className="flex min-h-12 shrink-0 touch-none items-center gap-1 pl-4 pr-1" data-mobile2-sheet-header {...handle}>
          <h2 className="min-w-0 flex-1 truncate text-title font-semibold text-primary">{title}</h2>
          {extra}
          <button type="button" className={CLOSE_BUTTON} aria-label={t("mobile2.sheet.close")} data-mobile2-close onClick={onClose}>
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto pb-1" data-mobile2-sheet-body>
          {children}
        </div>
        <MobileReceipt store={receiptStore} placement="sheet" />
        {footer ? <div className="flex shrink-0 gap-2 px-4 pt-2.5">{footer}</div> : null}
      </div>
    </div>
  );
}

/** A section header inside a sheet (the prototype's `.sh`). */
export function MobileSheetSection({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <div className="flex min-h-[34px] items-center gap-1.5 px-4 pt-1.5 text-label font-semibold text-secondary">
      {children}
      {count !== undefined ? <span className="text-caption font-semibold tabular-nums text-muted">{count}</span> : null}
    </div>
  );
}

export function MobileSheetDivider() {
  return <div className="my-1.5 h-px shrink-0 bg-border" aria-hidden />;
}

/** One 44 px row inside a sheet (the prototype's `.mrow`): an icon, a label,
    one trailing element. Rows are the only place a labelled control lives on
    the phone; the bar keeps four icons at most. */
export function MobileSheetRow({
  icon,
  label,
  trailing,
  onSelect,
  selected = false,
  danger = false,
  disabled = false,
  role,
  checked,
  testId,
  attrs,
  ariaLabel,
}: {
  icon?: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  onSelect?: () => void;
  /** The current item (the project the board shows, the conversation open). */
  selected?: boolean;
  danger?: boolean;
  disabled?: boolean;
  role?: string;
  /** A radio row announces which face is shown instead of only tinting it. */
  checked?: boolean;
  testId?: string;
  /** Harness hooks (`data-mobile2-*`) and any other data attribute. */
  attrs?: Record<`data-${string}`, string | undefined>;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role={role ?? (checked === undefined ? undefined : "menuitemradio")}
      aria-checked={checked}
      aria-current={selected ? "true" : undefined}
      aria-label={ariaLabel}
      disabled={disabled}
      data-testid={testId}
      {...attrs}
      onClick={onSelect}
      className={`flex min-h-11 w-full items-center gap-3 px-4 text-left text-body font-semibold active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45 ${
        danger ? "text-danger" : checked ? "text-accent" : "text-primary"
      }`}
    >
      {icon ? <span className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center ${danger ? "text-danger" : "text-secondary"}`}>{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing ? (
        <span className={`ml-auto inline-flex shrink-0 items-center gap-1.5 text-label font-medium ${selected ? "text-accent" : "text-muted"}`}>{trailing}</span>
      ) : null}
    </button>
  );
}
