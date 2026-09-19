"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { TASK_COLORS, type TaskColor, type TaskStatus } from "@/lib/tasks/types";

/* Menus and popovers of the kanban board, ported from the approved prototype
   (`prototypes/kanban-board/app.js` openMenu/openTray): fixed to the viewport
   beside their anchor, focus moves in on open and back to the anchor on close,
   arrows walk the items, Tab and Escape close. */

export type KanbanMenuItem =
  | { type: "head"; label: string }
  | { type: "sep" }
  /* The colour labels as a row of swatches, each a radio item; `null` is none. */
  | { type: "swatches"; label: string; value: TaskColor | null; names: (color: TaskColor | null) => string; hex: Record<TaskColor, string>; onPick: (color: TaskColor | null) => void }
  | {
    type: "item" | "radio";
    label: string;
    why?: string | null;
    kbd?: string;
    status?: TaskStatus;
    checked?: boolean;
    disabled?: boolean;
    /** The item moves focus itself (an editor opens, the card leaves): the
        menu closes without handing focus back to its anchor. */
    keepFocus?: boolean;
    /** A leading icon, the way the header's ⋯ rows carry one. */
    icon?: ReactNode;
    onSelect: () => void;
  };

function place(element: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  let left = rect.right - width;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = rect.top - height - 6;
  top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
  element.style.left = `${Math.round(left)}px`;
  element.style.top = `${Math.round(top)}px`;
}

function useDismiss(ref: React.RefObject<HTMLElement | null>, anchor: HTMLElement, onClose: (refocus: boolean) => void) {
  useEffect(() => {
    const down = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor.contains(target)) return;
      onClose(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose(true);
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [ref, anchor, onClose]);
}

const CheckGlyph = () => (
  <svg className="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 5 5L20 7" /></svg>
);

export function KanbanMenu({ anchor, label, items, onClose }: {
  anchor: HTMLElement;
  label: string;
  items: readonly KanbanMenuItem[];
  onClose: (refocus: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, anchor, onClose);
  useLayoutEffect(() => {
    if (!ref.current) return;
    place(ref.current, anchor);
    ref.current.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [anchor]);
  const focusables = () => [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
    .filter((item) => item.getAttribute("aria-disabled") !== "true");
  const onKeyDown = (event: React.KeyboardEvent) => {
    const list = focusables();
    const index = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowRight") { event.preventDefault(); list[(index + 1) % list.length]?.focus(); }
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") { event.preventDefault(); list[(index - 1 + list.length) % list.length]?.focus(); }
    else if (event.key === "Home") { event.preventDefault(); list[0]?.focus(); }
    else if (event.key === "End") { event.preventDefault(); list[list.length - 1]?.focus(); }
    else if (event.key === "Tab") { event.preventDefault(); onClose(true); }
  };
  return (
    <div ref={ref} className="menu" role="menu" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item, index) => {
        if (item.type === "sep") return <div key={`sep-${index}`} className="sep" role="separator" />;
        if (item.type === "head") return <div key={`head-${index}`} className="head">{item.label}</div>;
        if (item.type === "swatches") {
          return (
            <div key={`swatches-${index}`} className="swatches" role="group" aria-label={item.label}>
              {[null, ...TASK_COLORS].map((color) => (
                <button
                  key={color ?? "none"}
                  type="button"
                  className="swatch"
                  role="menuitemradio"
                  aria-checked={item.value === color}
                  aria-label={item.names(color)}
                  title={item.names(color)}
                  data-swatch={color ?? "none"}
                  data-none={color ? undefined : "1"}
                  style={color ? ({ "--c": item.hex[color] } as React.CSSProperties) : undefined}
                  onClick={() => {
                    onClose(true);
                    item.onPick(color);
                  }}
                />
              ))}
            </div>
          );
        }
        return (
          <button
            key={`${item.type}-${item.label}`}
            type="button"
            role={item.type === "radio" ? "menuitemradio" : "menuitem"}
            aria-checked={item.type === "radio" ? Boolean(item.checked) : undefined}
            aria-disabled={item.disabled ? true : undefined}
            onClick={() => {
              if (item.disabled) return;
              onClose(!item.keepFocus);
              item.onSelect();
            }}
          >
            {item.icon ?? null}
            {item.status ? <span className="st" data-status={item.status} /> : null}
            {item.type === "radio" ? <CheckGlyph /> : null}
            <span className="lbl">
              {item.label}
              {item.why ? <span className="why">{item.why}</span> : null}
            </span>
            {item.kbd ? <span className="kbd">{item.kbd}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function KanbanPopover({ anchor, label, onClose, children, initialFocus = "button", className }: {
  anchor: HTMLElement;
  label: string;
  onClose: (refocus: boolean) => void;
  children: ReactNode;
  /** Selector of what takes focus on open. */
  initialFocus?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, anchor, onClose);
  useLayoutEffect(() => {
    if (!ref.current) return;
    place(ref.current, anchor);
    ref.current.querySelector<HTMLElement>(initialFocus)?.focus();
  }, [anchor, initialFocus]);
  return (
    <div ref={ref} className={`popover${className ? ` ${className}` : ""}`} role="dialog" aria-label={label}>
      {children}
    </div>
  );
}

/** One open menu or popover at a time, closed with focus back on its anchor. */
export function useOverlay<T>() {
  const [open, setOpen] = useState<{ anchor: HTMLElement; value: T } | null>(null);
  const close = useCallback((refocus: boolean) => {
    setOpen((current) => {
      if (current && refocus && current.anchor.isConnected) {
        const anchor = current.anchor;
        queueMicrotask(() => anchor.focus());
      }
      return null;
    });
  }, []);
  /* One object while nothing opens or closes, so handlers that list the overlay among their inputs keep their
     identity and memoized cards and readers do not re-render on every board render. */
  return useMemo(() => ({ open, setOpen, close }), [open, close]);
}
