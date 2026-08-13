/**
 * Pure layout decisions for the auto-growing composer textareas, factored out
 * of the hook so "how tall" and "scroll to the newest text or hold still" are
 * unit-testable without a DOM.
 *
 * The field grows with its content up to a cap, then scrolls inside itself.
 * The rule that keeps the latest dictated/typed words visible: pin the scroll
 * to the bottom whenever the text is being appended to — during live dictation
 * (unconditionally) or while typing with the caret at the very end — and leave
 * the scroll alone when the caret sits mid-text for editing.
 */

/** Clamp a measured `scrollHeight` into the field's [min, max] pixel range.
    The +2 covers the 1px top/bottom border the border-box measurement omits. */
export function clampHeight(scrollHeight: number, maxPx: number, minPx = 0): number {
  return Math.min(Math.max(scrollHeight + 2, minPx), maxPx);
}

/** Whether the caret spans nothing and sits at the end of the value. */
export function caretAtEnd(selectionStart: number, selectionEnd: number, length: number): boolean {
  return selectionStart === length && selectionEnd === length;
}

/** Pin the view to the newest text when appending: always while a live
    dictation drives the field, otherwise only when the caret is at the end. */
export function shouldPin({ pinned, caretAtEnd }: { pinned: boolean; caretAtEnd: boolean }): boolean {
  return pinned || caretAtEnd;
}

/** The slice of `window.visualViewport` the viewport budget reads. */
export interface VisualViewportSize {
  height: number;
  scale: number;
}

/** The height actually visible to the user, in layout px (#983). iOS Safari
    ignores interactive-widget=resizes-content: the on-screen keyboard leaves
    `window.innerHeight` at the full screen height and shrinks only the visual
    viewport, so the visible budget must come from there when the browser
    reports one. Multiplying by `scale` cancels pinch zoom — zoomed in, the
    visual viewport narrows without any keyboard, and the layout budget must
    not shrink with it. Clamped to the layout height so rounding noise can
    never claim MORE than the layout viewport. */
export function visibleViewportHeight(layoutHeight: number, visual: VisualViewportSize | null | undefined): number {
  if (!visual) return layoutHeight;
  return Math.min(layoutHeight, Math.round(visual.height * visual.scale));
}

/** The on-screen keyboard's overlap with the layout viewport, in px — the
    bottom slice of a full-height (h-dvh / 100dvh) surface the keyboard covers.
    Zero with the keyboard closed, when the browser shrinks the layout viewport
    itself (interactive-widget=resizes-content honored), or with no
    visualViewport at all. */
export function keyboardInset(layoutHeight: number, visual: VisualViewportSize | null | undefined): number {
  return Math.max(0, layoutHeight - visibleViewportHeight(layoutHeight, visual));
}
