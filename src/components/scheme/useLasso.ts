"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Camera } from "./Minimap";
import { dragRect, nodesInRect, screenRectToWorld } from "./lasso";
import type { SchemeLayout, SchemeRect } from "./layout";

/* Movement below this is a click, not a marquee — matches the camera's own
   stationary-tap threshold closely enough that the two never fight. */
const DRAG_MIN = 4;

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
  const pendingRef = useRef<{ sx: number; sy: number; additive: boolean; active: boolean } | null>(null);
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
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
    };
  }, [localPoint]);

  /* The camera calls this on every select-mode background press; the return
     value is the claim contract documented in CameraOptions. */
  const onBackgroundDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!enabled) return false;
      if (event.pointerType === "touch") return session;
      if (!event.isPrimary || event.button !== 0) return false;
      const point = localPoint(event);
      pendingRef.current = { sx: point.x, sy: point.y, additive: event.shiftKey, active: false };
      return true;
    },
    [enabled, session, localPoint],
  );

  return { marquee, onBackgroundDown };
}
