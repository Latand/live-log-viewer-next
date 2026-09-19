"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { TooltipBubble } from "@/components/TooltipBubble";

/** How long a pointer rests on the control before the bubble shows. */
const SHOW_DELAY_MS = 150;

/**
 * A styled hover/focus tooltip bubble. Wraps exactly one interactive child;
 * the child keeps its own aria-label — the bubble is the visual counterpart
 * (native `title` is dropped where Hint is used, so hints never double up).
 *
 * `align` controls the horizontal anchor: "center" (default) centres the bubble
 * over the child; "right"/"left" pin the bubble's matching edge to the child.
 * The bubble is portalled and kept inside the window, so a control hugging a
 * clipping container's edge (the send button in a composer) shows it whole.
 */
export function Hint({
  label,
  side = "top",
  align = "center",
  children,
}: {
  label: string;
  side?: "top" | "bottom";
  align?: "center" | "left" | "right";
  children: ReactNode;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [shown, setShown] = useState(false);
  const active = hovered || focused;

  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = window.setTimeout(() => setShown(true), SHOW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [active]);

  return (
    <span
      ref={anchorRef}
      className="relative inline-flex"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      {children}
      {shown ? (
        <TooltipBubble
          anchorRef={anchorRef}
          side={side}
          align={align}
          className="whitespace-nowrap rounded-[7px] bg-primary px-2 py-1 text-[10.5px] font-semibold text-white shadow-1"
        >
          {label}
        </TooltipBubble>
      ) : null}
    </span>
  );
}
