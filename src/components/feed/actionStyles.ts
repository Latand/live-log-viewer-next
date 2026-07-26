/**
 * One treatment and one geometry for every feed action control (issue #698).
 *
 * The original defect had two halves that no single width fixed: the controls
 * were `opacity-0` until hover on a desktop, and `[@media(hover:none)]:opacity-60`
 * — permanently half-visible ON TOP of the text — on a phone. Both are gone.
 * Controls are legible at rest and the body reserves a gutter for them, so they
 * cover nothing at any width.
 */

/** Visible at rest, full strength on hover/focus. Never `opacity-0`. */
export const MESSAGE_ACTION =
  "opacity-70 transition-opacity motion-reduce:transition-none hover:opacity-100 focus-visible:opacity-100 group-hover/msg:opacity-100";

/* Copy-control geometry in px. `CopyButton` is `p-1` around a 12px icon on a
   fine pointer and a full 44px tap target on a coarse one, and it is pinned
   `ACTION_INSET_PX` from the body's right edge. The gutter has to clear the
   LARGER of the two, or the coarse-pointer button overhangs the content box —
   which is exactly what a 40px `pr-10` gutter did against a 44px button. */
export const ACTION_INSET_PX = 6;
export const ACTION_SIZE_FINE_PX = 22;
export const ACTION_SIZE_COARSE_PX = 44;

/** Where an absolutely-positioned action sits inside its body. */
export const ACTION_ANCHOR = "absolute right-[6px] top-[6px]";

/**
 * Right padding that keeps a body's content clear of its action control at both
 * pointer sizes. Applied unconditionally by every block that renders one, so
 * the gutter never shifts as the control appears or hides.
 */
export const ACTION_GUTTER = "pr-[28px] [@media(pointer:coarse)]:pr-[50px]";
