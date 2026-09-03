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
/* The composer UNIT's own chrome, measured on the rendered phone box (#1483):
   the tools row under the field (`data-mobile2-tools`, min-h-11 = 44px), the
   box's own padding and border (pt-1 + pb-0.5 + two 1px edges = 8px), and the
   bounded mobile composer form's padding and top border (py-1.5 + 1px = 13px).
   Every pixel of it lives INSIDE the composer's own scroll box, so a field
   taller than that box's budget minus this number pushes the tools row past
   the box's bottom edge, where reaching Stop costs a scroll. */
export const MOBILE_COMPOSER_UNIT_CHROME_PX = 65;
/* Mobile v2's one bar above the conversation (§3.2) — the same 52px
   `chatBudget.BAR_PX` publishes, kept here so this module stays free of any
   component-layer import. */
const MOBILE_BAR_PX = 52;
/* The mobile chrome that must share the keyboard-open visible area with the
   textarea: the one bar above it and the composer unit's own chrome around it.
   Re-derived for mobile v2 (#1483) — the #983 number reserved 156px for a
   docked focus strip, a separate conversation header and an always-visible
   44px runtime-picker row UNDER the input, and v2 renders none of the three:
   the strip and the header folded into the bar, and the picker became a cell
   of the tools row inside the box. The focus root clips its overflow, so
   whatever this chrome cannot fit is not scrolled to — it is gone. */
export const MOBILE_COMPOSER_CHROME_PX = MOBILE_BAR_PX + MOBILE_COMPOSER_UNIT_CHROME_PX;
/* The bounded mobile composer form's own maximum height —
   `max-h-[min(38dvh,20rem)]` — past which the FORM scrolls internally and the
   tools row leaves its visible box while the viewport still has room. The cap
   reads the LAYOUT viewport height because `dvh` ignores the on-screen
   keyboard: the keyboard shrinks the visual viewport alone (#983). */
const MOBILE_COMPOSER_UNIT_MAX_PX = 320; /* 20rem */
const MOBILE_COMPOSER_UNIT_MAX_VH = 0.38;
/** How tall the phone's composer box may render before it scrolls its own
    content, for a given LAYOUT viewport height. */
export function mobileComposerUnitMax(layoutHeight: number): number {
  return Math.min(MOBILE_COMPOSER_UNIT_MAX_PX, Math.round(layoutHeight * MOBILE_COMPOSER_UNIT_MAX_VH));
}
/* One comfortable row at the 44px tap-target height: on a visible viewport too
   small for chrome plus field, the field stays usable rather than collapsing
   to zero. */
const COMPOSER_CEILING_FLOOR_PX = 44;

/** The phone grow ceiling, from the VISIBLE viewport the operator can see
    (#983) and the LAYOUT viewport the composer box's own `dvh` cap is written
    against (#1483). The field grows to 40% of the visible area, floored at the
    shared cap while there is room, and yields to whichever bound binds first:

    - the composer box's own budget, so the tools row under the field — chip,
      attach, dictate, the send slot that holds Stop — always fits inside the
      box with it. Past it the box scrolls, and every dictated chunk undoes the
      scroll that reached Stop, which is the trap #1483 reports;
    - the visible area under the bar, so the whole unit clears the keyboard. A
      short rotated viewport drops the budget below the 160px cap; the field
      then scrolls internally sooner.

    Below the one-row floor neither bound can be honored, and a usable field
    outranks them: the ceiling stops there. */
export function mobileComposerCeiling(visibleHeight: number, layoutHeight: number): number {
  const grown = Math.max(COMPOSER_MAX_PX, Math.round(visibleHeight * COMPOSER_MAX_VH));
  const insideTheBox = mobileComposerUnitMax(layoutHeight) - MOBILE_COMPOSER_UNIT_CHROME_PX;
  const aboveTheKeyboard = visibleHeight - MOBILE_COMPOSER_CHROME_PX;
  return Math.max(COMPOSER_CEILING_FLOOR_PX, Math.min(grown, insideTheBox, aboveTheKeyboard));
}
