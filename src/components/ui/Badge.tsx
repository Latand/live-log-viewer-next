import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from "react";

/* The one textual-status-chip recipe (design doc §3.7). Every status pill in the
   app — process state, rate limit, delivery receipt, ctx%, goal, verdict —
   renders through this so the whole surface speaks in six role tones instead of
   ~30 ad hoc hex pairs. Soft-role background + role text + caption/600, pill,
   20px visual height. Counters are NOT badges (rule 5): they stay plain muted
   text. Extra span attributes (data-*, role, aria-live, title) pass through. */

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
  children,
  ...rest
}: {
  tone?: BadgeTone;
  className?: string;
  /** Inline colors for the engine/model/verdict tints, which are computed, not roles. */
  style?: CSSProperties;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<"span">, "style" | "className" | "children">) {
  return (
    <span
      className={`inline-flex min-h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-caption font-semibold leading-none tabular-nums ${
        style ? "" : TONE[tone]
      } ${className}`}
      style={style}
      {...rest}
    >
      {children}
    </span>
  );
}
