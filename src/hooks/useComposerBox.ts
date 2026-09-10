"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** The box a composer's budget is a share of: the conversation it is laid out
    in. The card composer's own `max-height` is written as a percentage, so the
    browser resolves it against exactly this element — its containing block —
    and the code that has to know how much room is left INSIDE that budget
    reads the same number from the same element.

    The walk skips ancestors that generate no box: a card publishes its composer
    place as a `display: contents` mount, which has no height of its own and is
    not what the percentage resolves against either. */
function conversationBox(node: HTMLElement): HTMLElement | null {
  let parent = node.parentElement;
  while (parent && parent.clientHeight === 0) parent = parent.parentElement;
  return parent;
}

/** Measure the conversation box a composer form sits in, live.

    Returns the ref to put on the form and the box's height in px — 0 until it
    has been measured, and 0 in an environment with no `ResizeObserver`, which
    is the "not measured" the ceiling falls back to the fixed cap on. The
    element is held in state rather than a ref so a form that remounts — column
    reshuffles, a dock hand-over, a dormant view coming back — re-measures the
    box it landed in. */
export function useComposerBox(active: boolean): { ref: (node: HTMLFormElement | null) => void; height: number } {
  const [form, setForm] = useState<HTMLElement | null>(null);
  const [height, setHeight] = useState(0);
  const latest = useRef(0);
  const ref = useCallback((node: HTMLFormElement | null) => { setForm(node); }, []);
  useEffect(() => {
    if (!active || !form || typeof ResizeObserver === "undefined") return;
    const box = conversationBox(form);
    if (!box) return;
    const read = () => {
      const next = box.clientHeight;
      if (next === latest.current) return;
      latest.current = next;
      setHeight(next);
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(box);
    return () => observer.disconnect();
  }, [active, form]);
  return { ref, height };
}
