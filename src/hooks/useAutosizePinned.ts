"use client";

import { useLayoutEffect } from "react";

import { caretAtEnd, clampHeight, shouldPin } from "@/lib/composerScroll";

export interface AutosizePinnedOptions {
  /** Maximum field height in pixels; beyond it the field scrolls internally. */
  maxPx: number;
  /** Minimum field height in pixels (a multi-line default before any text). */
  minPx?: number;
  /** True while a live dictation drives the field: pin to the newest words on
      every update regardless of the (readOnly) caret position. */
  pinned: boolean;
}

/**
 * Grows a textarea to fit its content up to `maxPx`, then pins the scroll to
 * the newest text so live dictation and end-of-field typing never scroll the
 * latest words out of view — while leaving the scroll untouched when the caret
 * is parked mid-text for editing. Re-measures on every `value` change (covers
 * restored drafts, dictation inserts, and typing).
 *
 * The shared seam behind every composer surface (`useComposer` for the pane /
 * draft / bulk / task-create composers, and the task edit field directly), so
 * the grow-and-pin behavior is identical everywhere the mic lives.
 */
export function useAutosizePinned(
  ref: React.RefObject<HTMLTextAreaElement | null>,
  value: string,
  { maxPx, minPx = 0, pinned }: AutosizePinnedOptions,
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    /* Collapsing to 0 before measuring lets the field shrink back when text is
       deleted; it also resets scrollTop, so a mid-text edit's position is
       captured first and restored after. */
    const prevTop = el.scrollTop;
    const atEnd = caretAtEnd(el.selectionStart, el.selectionEnd, el.value.length);
    el.style.height = "0px";
    el.style.height = clampHeight(el.scrollHeight, maxPx, minPx) + "px";
    if (shouldPin({ pinned, caretAtEnd: atEnd })) {
      el.scrollTop = el.scrollHeight;
    } else {
      el.scrollTop = prevTop;
    }
  }, [ref, value, maxPx, minPx, pinned]);
}
