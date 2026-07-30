"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Camera } from "./Minimap";
import { dragRect, nodesInRect, screenRectToWorld } from "./lasso";
import type { SchemeLayout, SchemeRect } from "./layout";
import { planBackgroundPress } from "./selectionGesture";

/* Movement below this is a click, not a marquee — matches the camera's own
   stationary-tap threshold closely enough that the two never fight. */
const DRAG_MIN = 4;

/**
 * Drop whatever the browser had highlighted. A background press is the gesture
 * that clears a text selection natively — but we suppress its compatibility
 * mousedown to stop a new selection from being anchored, which suppresses that
 * clearing too. Without this an older highlight would stay lit under the
 * marquee and read as the stray selection the lasso is supposed to avoid.
 */
function dropNativeSelection(): void {
  if (typeof window === "undefined") return;
  const selection = window.getSelection?.();
  if (selection && selection.rangeCount > 0) selection.removeAllRanges();
}

export interface MarqueeState {
  /** Viewport-local rect of the drag, for the screen-space overlay. */
  rect: SchemeRect;
  /** Paths the rect currently intersects — the live candidate highlight. */
  candidates: string[];
  additive: boolean;
}

interface LassoOptions {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  cam: Camera;
  layout: SchemeLayout;
  /** Marquee only exists for the mouse in select mode outside the map. */
  enabled: boolean;
  /** Selection session active: touch presses are claimed so the camera's
      press-time clear does not eat the set before the tap resolves. */
  session: boolean;
  onCommit: (paths: string[], additive: boolean) => void;
}

/**
 * The marquee gesture on the select-mode background: claims the press through
 * the camera's `onBackgroundDown`, tracks the drag on window listeners, and
 * commits the intersected node set on release. Only this hook's small state
 * changes per pointermove — the memoized node/edge layers never see the drag.
 */
export function useLasso({ viewportRef, cam, layout, enabled, session, onCommit }: LassoOptions) {
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  const pendingRef = useRef<{ sx: number; sy: number; additive: boolean; active: boolean; suppressSelection: boolean } | null>(null);
  const camRef = useRef(cam);
  const layoutRef = useRef(layout);
  const commitRef = useRef(onCommit);
  useEffect(() => {
    camRef.current = cam;
    layoutRef.current = layout;
    commitRef.current = onCommit;
  });

  const localPoint = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const rect = viewportRef.current?.getBoundingClientRect();
      return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: event.clientX, y: event.clientY };
    },
    [viewportRef],
  );

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const pending = pendingRef.current;
      if (!pending) return;
      const point = localPoint(event);
      if (!pending.active && Math.hypot(point.x - pending.sx, point.y - pending.sy) < DRAG_MIN) return;
      pending.active = true;
      const rect = dragRect(pending.sx, pending.sy, point.x, point.y);
      const candidates = nodesInRect(layoutRef.current.nodes, screenRectToWorld(rect, camRef.current));
      setMarquee({ rect, candidates, additive: pending.additive });
    };
    const finish = (commit: boolean) => {
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (!pending?.active) return;
      setMarquee((current) => {
        if (commit && current) commitRef.current(current.candidates, current.additive);
        return null;
      });
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && pendingRef.current?.active) finish(false);
    };
    /* The gesture's own lifetime, not the transcript's: while a claimed press is
       pending the browser may neither start a selection nor a native drag under
       the rect. The listeners see nothing once the press resolves, so deliberate
       selection inside conversation content is untouched. */
    const guard = (event: Event) => {
      if (pendingRef.current?.suppressSelection) event.preventDefault();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    window.addEventListener("selectstart", guard);
    window.addEventListener("dragstart", guard);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
      window.removeEventListener("selectstart", guard);
      window.removeEventListener("dragstart", guard);
    };
  }, [localPoint]);

  /* The camera calls this on every select-mode background press; the return
     value is the claim contract documented in CameraOptions. */
  const onBackgroundDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const plan = planBackgroundPress(event, { enabled, session });
      if (!plan.track) return plan.claim;
      const point = localPoint(event);
      pendingRef.current = {
        sx: point.x,
        sy: point.y,
        additive: event.shiftKey,
        active: false,
        suppressSelection: plan.suppressSelection,
      };
      /* Suppressing the compat mousedown is what keeps a drag across cards from
         highlighting their transcripts — the anchor is never set. */
      if (plan.suppressSelection) {
        event.preventDefault();
        dropNativeSelection();
        /* preventDefault also cancels the press's focus fixup, so take the focus
           the background press used to take: the board keeps its arrow-key
           target and a composer inside a pane still blurs. */
        viewportRef.current?.focus({ preventScroll: true });
      }
      return plan.claim;
    },
    [enabled, session, localPoint, viewportRef],
  );

  return { marquee, onBackgroundDown };
}
