"use client";

import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { Z } from "@/components/layers";

const GAP = 6;
const EDGE = 8;

type Box = { top: number; bottom: number; left: number; right: number; width: number };

/**
 * Where a bubble of `size` goes against `anchor`: on the asked side when it
 * fits there, else on the other one, and always inside the window.
 */
export function tooltipPlacement(
  anchor: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  side: "top" | "bottom",
  align: "center" | "left" | "right",
): { left: number; top: number } {
  const wanted = align === "right" ? anchor.right - size.width : align === "left" ? anchor.left : anchor.left + anchor.width / 2 - size.width / 2;
  const left = Math.max(EDGE, Math.min(wanted, viewport.width - size.width - EDGE));
  const above = anchor.top - GAP - size.height;
  const below = anchor.bottom + GAP;
  const fitsAbove = above >= EDGE;
  const fitsBelow = below + size.height <= viewport.height - EDGE;
  const top = side === "top" ? (fitsAbove || !fitsBelow ? above : below) : fitsBelow || !fitsAbove ? below : above;
  return { left, top: Math.max(EDGE, top) };
}

/**
 * A hover or focus bubble portalled to the document at the tooltip layer and
 * placed from its anchor's box. Left inside its host, a bubble is cut by the
 * host's `overflow` whatever layer it carries: the composer's send hint was a
 * sliver in the orchestrator seat (#1858).
 */
export function TooltipBubble({
  anchorRef,
  side = "top",
  align = "center",
  className,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  side?: "top" | "bottom";
  align?: "center" | "left" | "right";
  className: string;
  children: ReactNode;
}) {
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const anchor = anchorRef.current;
      const bubble = bubbleRef.current;
      if (!anchor || !bubble) return;
      setPosition(
        tooltipPlacement(
          anchor.getBoundingClientRect(),
          { width: bubble.offsetWidth, height: bubble.offsetHeight },
          { width: window.innerWidth, height: window.innerHeight },
          side,
          align,
        ),
      );
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [anchorRef, side, align]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <span
      ref={bubbleRef}
      role="tooltip"
      style={position ?? { left: -9999, top: 0, visibility: "hidden" }}
      className={`pointer-events-none fixed ${Z.tooltip} ${className}`}
    >
      {children}
    </span>,
    document.body,
  );
}
