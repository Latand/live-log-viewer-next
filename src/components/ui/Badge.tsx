import type { CSSProperties, ReactNode } from "react";

/* The one textual-status-chip recipe (design doc §3.7). Every status pill in the
   app — process state, rate limit, delivery receipt, ctx%, verdict — renders
   through this so the whole surface speaks in six role tones instead of ~30 ad
   hoc hex pairs. Soft-role background + role text + caption/600, pill, 20px
   visual height. Counters are NOT badges (rule 5): they stay plain muted text. */

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "accent" | "info";

const TONE: Record<BadgeTone, string> = {
  neutral: "bg-sunken text-muted",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  accent: "bg-accent-soft text-accent",
  info: "bg-info-soft text-info",
};

export function Badge({
  tone = "neutral",
  className = "",
  style,
  title,
  ariaLabel,
  dataAttr,
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  /** Inline colors for the engine/model tints, which are computed, not roles. */
  style?: CSSProperties;
  title?: string;
  ariaLabel?: string;
  /** Passes through a bare data-* flag (e.g. `data-rate-limited`) some callers key on. */
  dataAttr?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex min-h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none tabular-nums ${
        style ? "" : TONE[tone]
      } ${className}`}
      style={style}
      title={title}
      aria-label={ariaLabel}
      {...(dataAttr ? { [dataAttr]: "" } : {})}
    >
      {children}
    </span>
  );
}
