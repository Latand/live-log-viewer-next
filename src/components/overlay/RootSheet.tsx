"use client";

import { useCallback, useRef } from "react";

import type { TFunction } from "@/lib/i18n";
import {
  nextSnap,
  sheetHeights,
  type SheetGesture,
  type SheetSnap,
} from "@/lib/overlay/layout";

import { RootOverlay, type RootOverlayProps } from "./RootOverlay";

/**
 * The mobile rendering (#691): a resizable sheet over a live Viewer.
 *
 * The operator's priority governs everything here — what is happening in the
 * Viewer above must stay visible. This is a controllable cover over live work,
 * never a full-screen chat app, which is why even Full leaves a peek and why
 * nothing arriving in the timeline ever changes the snap point by itself.
 *
 * The mobile arrangement is not the desktop one scaled down: on desktop the
 * window floats beside the work, and on a phone there is one screen, so the
 * sheet has to give height back.
 */

export interface RootSheetProps extends Omit<RootOverlayProps, "surface" | "height" | "density"> {
  snap: SheetSnap;
  onSnapChange: (snap: SheetSnap) => void;
  /** Visual viewport height minus the bottom inset. */
  usableHeight: number;
  t: TFunction;
}

/** Below this a drag is a scroll, not a snap change. */
const DRAG_THRESHOLD = 24;

export function RootSheet({ snap, onSnapChange, usableHeight, ...overlay }: RootSheetProps) {
  const heights = sheetHeights(usableHeight);
  const height = heights[snap];
  const dragOrigin = useRef<number | null>(null);
  const t = overlay.t;

  const apply = useCallback((gesture: SheetGesture) => {
    /* Every movement goes through the shared model, which is what guarantees a
       gesture never jumps two snaps — two-snap moves come only from an explicit
       control calling `onSnapChange` directly. */
    onSnapChange(nextSnap(snap, gesture));
  }, [snap, onSnapChange]);

  return (
    <div
      data-testid="root-sheet"
      data-snap={snap}
      className="fixed inset-x-0 bottom-0 z-40 flex flex-col rounded-t-[14px] border-t border-border bg-card shadow-2"
      style={{ height }}
      role="dialog"
      aria-label={t("overlay.title")}
    >
      {/* The grabber and the state row are one target: tapping toggles
          Rail↔Half, dragging moves one snap. */}
      <button
        type="button"
        data-testid="sheet-grabber"
        /* The snap state is announced as a NAMED state rather than a
           percentage, and it rides in the accessible name so the control needs
           no slider semantics it does not otherwise have. */
        aria-label={`${t("overlay.snapAria")}: ${t(`overlay.snap.${snap}` as "overlay.snap.rail")}`}
        className="mx-auto flex h-4 w-full shrink-0 items-center justify-center"
        onClick={() => apply("tap-state-row")}
        onPointerDown={(event) => { dragOrigin.current = event.clientY; }}
        onPointerUp={(event) => {
          const origin = dragOrigin.current;
          dragOrigin.current = null;
          if (origin === null) return;
          const delta = event.clientY - origin;
          if (Math.abs(delta) < DRAG_THRESHOLD) return;
          apply(delta > 0 ? "drag-down" : "drag-up");
        }}
      >
        <span className="h-1 w-9 rounded-full bg-strong" aria-hidden />
      </button>

      <RootOverlay
        {...overlay}
        surface="sheet"
        /* The grabber sits above the overlay's own bands, so the component gets
           what is left. */
        height={Math.max(0, height - 16)}
        density={snap === "rail" ? "rail" : "expanded"}
      />
    </div>
  );
}
