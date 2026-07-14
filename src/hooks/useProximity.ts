"use client";

import { useEffect, useState } from "react";

/** True when the point (px, py) lies within `radius` screen-pixels of the
    rectangle — distance to the nearest edge, so a point inside the rect is
    always near. Pure and screen-space, so it works unchanged under the
    board's camera zoom (both the rect and the pointer are in client coords). */
export function pointerNearRect(
  rect: { left: number; top: number; right: number; bottom: number },
  px: number,
  py: number,
  radius: number,
): boolean {
  const dx = Math.max(rect.left - px, 0, px - rect.right);
  const dy = Math.max(rect.top - py, 0, py - rect.bottom);
  return dx * dx + dy * dy <= radius * radius;
}

interface Sub {
  el: HTMLElement;
  radius: number;
  near: boolean;
  notify: (near: boolean) => void;
}

/* One window pointer listener drives every crown: subscribers each hold their
   own rect + threshold and flip only when the pointer crosses their proximity
   boundary, so a card re-renders on enter/leave rather than on every move. The
   distance sweep is rAF-throttled to at most one layout read per frame. */
const subscribers = new Set<Sub>();
let pointerX = Number.NEGATIVE_INFINITY;
let pointerY = Number.NEGATIVE_INFINITY;
let frame = 0;
let listening = false;

function evaluate(): void {
  frame = 0;
  for (const sub of subscribers) {
    const near = pointerNearRect(sub.el.getBoundingClientRect(), pointerX, pointerY, sub.radius);
    if (near !== sub.near) {
      sub.near = near;
      sub.notify(near);
    }
  }
}

function onPointerMove(event: PointerEvent): void {
  pointerX = event.clientX;
  pointerY = event.clientY;
  if (frame === 0) frame = requestAnimationFrame(evaluate);
}

function ensureListening(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("pointermove", onPointerMove, { passive: true });
}

function stopListeningIfIdle(): void {
  if (subscribers.size > 0 || !listening) return;
  listening = false;
  window.removeEventListener("pointermove", onPointerMove);
  if (frame !== 0) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
}

/** Reveal-by-proximity: true once the pointer comes within `radius` px of the
    element, false again when it leaves. A null ref (offscreen pane, disabled)
    opts out and always reports false, so favorited/always-visible callers never
    pay for a listener. */
export function useProximity(
  ref: React.RefObject<HTMLElement | null>,
  radius: number,
  enabled = true,
): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = enabled ? ref.current : null;
    if (!el) {
      setNear(false);
      return;
    }
    const sub: Sub = { el, radius, near: false, notify: setNear };
    subscribers.add(sub);
    ensureListening();
    return () => {
      subscribers.delete(sub);
      stopListeningIfIdle();
    };
  }, [ref, radius, enabled]);
  return near;
}
