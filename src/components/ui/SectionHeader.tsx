import type { ReactNode } from "react";

import { ChevronRight } from "@/components/icons";

/* The one collapsible-section-header recipe (design doc §3.6). Chevron +
   sentence-case label (label/600 secondary) + `·` + muted tabular counter. No
   uppercase, no letter-spacing, no accent counter pill — the old 10px BOLD
   UPPERCASE +.6px tracking treatment was pure shout. Row height stays 44px on
   mobile / 32px desktop so #145/#146 touch acceptance holds. */

export const SECTION_LABEL_CLASS = "text-[11px] font-semibold text-secondary";

export function SectionHeader({
  open,
  onToggle,
  label,
  count,
  icon,
  ariaLabel,
  mobile,
}: {
  open: boolean;
  onToggle: () => void;
  label: ReactNode;
  count?: number;
  /** Optional glyph between chevron and label (e.g. the worker-stack layers icon). */
  icon?: ReactNode;
  ariaLabel?: string;
  mobile: boolean;
}) {
  return (
    <button
      className={`flex w-full items-center gap-2 px-4 ${SECTION_LABEL_CLASS} text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        mobile ? "min-h-11" : "h-8"
      }`}
      aria-expanded={open}
      aria-label={ariaLabel}
      onClick={onToggle}
    >
      <ChevronRight
        className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}
        aria-hidden
      />
      {icon}
      <span className="truncate">{label}</span>
      {count != null ? (
        <span className="text-[10px] font-normal tabular-nums text-muted">· {count}</span>
      ) : null}
    </button>
  );
}
