"use client";

import { useEffect, useRef } from "react";

/* Open overlays, oldest first. One capture listener on the window hands
   Escape to the newest, so a menu opened over the preview closes before the
   preview does. */
const stack: { current: () => void }[] = [];

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  event.preventDefault();
  event.stopPropagation();
  top.current();
}

/**
 * Escape closes this overlay and nothing under it. Portalled menus and the
 * image preview never take focus, so the key's target is the page body and a
 * surface below (the expanded conversation) would otherwise close on the same
 * press (#1858). The window's capture phase runs before any of their
 * listeners; the key is claimed there and marked handled.
 */
export function useOverlayEscape(onEscape: () => void, enabled = true): void {
  const handler = useRef(onEscape);
  useEffect(() => {
    handler.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!enabled) return;
    const entry = { current: () => handler.current() };
    stack.push(entry);
    if (stack.length === 1) window.addEventListener("keydown", onKeyDown, true);
    return () => {
      stack.splice(stack.indexOf(entry), 1);
      if (stack.length === 0) window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [enabled]);
}
