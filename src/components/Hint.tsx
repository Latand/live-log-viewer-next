"use client";

import type { ReactNode } from "react";

/**
 * A styled hover/focus tooltip bubble. Wraps exactly one interactive child;
 * the child keeps its own aria-label — the bubble is the visual counterpart
 * (native `title` is dropped where Hint is used, so hints never double up).
 *
 * `align` controls the horizontal anchor: "center" (default) centres the bubble
 * over the child; "right"/"left" pin the bubble's matching edge to the child so
 * a control hugging a container edge (e.g. the send button) doesn't overflow and
 * get clipped by an ancestor's `overflow`.
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
  const alignClass =
    align === "right" ? "right-0" : align === "left" ? "left-0" : "left-1/2 -translate-x-1/2";
  return (
    <span className="group/hint relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-[60] whitespace-nowrap rounded-[7px] bg-primary px-2 py-1 text-[10.5px] font-semibold text-white opacity-0 shadow-1 transition-opacity delay-150 duration-100 group-focus-within/hint:opacity-100 group-hover/hint:opacity-100 ${alignClass} ${
          side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5"
        }`}
      >
        {label}
      </span>
    </span>
  );
}
