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

/* The composer surfaces' shared grow cap (~6 rows): the fixed desktop ceiling,
   and the phone ceiling's grow floor while the visible viewport has room for
   it alongside the chrome below. */
export const COMPOSER_MAX_PX = 160;
/* On the phone the field grows further — up to ~40% of the visible viewport
   (issue #177 item 3) — so a multi-line prompt is comfortable to read while
   typing, past which it scrolls internally. */
const COMPOSER_MAX_VH = 0.4;
/* The mobile chrome that must share the keyboard-open visible area with the
   textarea (#983 round 2): the docked focus strip (~52px), the conversation
   header (~52px), and the always-visible 44px runtime-picker row under the
   input, with the row gaps and field border riding in the strips' slack. The
   focus root clips its overflow, so whatever this chrome cannot fit is not
   scrolled to — it is gone. */
export const MOBILE_COMPOSER_CHROME_PX = 156;
/* One comfortable row at the 44px tap-target height: on a visible viewport too
   small for chrome plus field, the field stays usable rather than collapsing
   to zero. */
const COMPOSER_CEILING_FLOOR_PX = 44;

/** The phone grow ceiling for a given VISIBLE viewport height (#983): 40% of
    what the user can see, floored at the shared cap while there is room — but
    never more than what leaves the mandatory chrome visible. A short rotated
    viewport with the keyboard open drops the budget below the 160px cap; the
    field then scrolls internally sooner instead of pushing the picker and send
    controls out of the clipped focus root. */
export function mobileComposerCeiling(visibleHeight: number): number {
  const grown = Math.max(COMPOSER_MAX_PX, Math.round(visibleHeight * COMPOSER_MAX_VH));
  return Math.max(COMPOSER_CEILING_FLOOR_PX, Math.min(grown, visibleHeight - MOBILE_COMPOSER_CHROME_PX));
}
