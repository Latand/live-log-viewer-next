/**
 * The two decisions the board's one selection model is built on, kept pure so
 * they can be tested without a canvas: what a select-mode background press does
 * (issue #771 gap 1) and how a single path enters or leaves the canonical set
 * (gap 2). Both the marquee and the hover-revealed check route through here, so
 * there is exactly one place that decides membership.
 */

/** What the camera's `onBackgroundDown` consultation resolves to. */
export interface BackgroundPressPlan {
  /** Claim the press from the camera — the CameraOptions contract. */
  claim: boolean;
  /** Begin tracking a marquee drag from this press. */
  track: boolean;
  /**
   * Suppress the native text selection this press would otherwise anchor. A
   * background drag is a lasso, never a text drag: without this the compat
   * mousedown sets a selection anchor on the canvas and the rect crossing a
   * card highlights the transcript underneath it.
   */
  suppressSelection: boolean;
}

const IGNORED: BackgroundPressPlan = { claim: false, track: false, suppressSelection: false };

/**
 * Mouse and pen: every primary left press on the select-mode background starts
 * the lasso and owns the native selection for the whole gesture.
 *
 * Touch: claimed only inside a running session, and never suppressed — the
 * finger keeps panning the canvas and a tap still resolves through the camera,
 * so preventing the default here would break scrolling. Touch does not begin a
 * text selection on a press anyway; the hover check is its selection path.
 */
export function planBackgroundPress(
  event: { pointerType: string; isPrimary: boolean; button: number },
  options: { enabled: boolean; session: boolean },
): BackgroundPressPlan {
  if (!options.enabled) return IGNORED;
  if (event.pointerType === "touch") return { claim: options.session, track: false, suppressSelection: false };
  if (!event.isPrimary || event.button !== 0) return IGNORED;
  return { claim: true, track: true, suppressSelection: true };
}

/**
 * The toggle reducer behind every single-card selection gesture — the hover
 * check, the stationary background tap, Shift+click. Always returns a new set
 * (membership always changes), so the board's state write always commits and
 * the view slice republishes `selectedPaths` immediately.
 */
export function toggleSelected(paths: ReadonlySet<string>, path: string): ReadonlySet<string> {
  const next = new Set(paths);
  if (!next.delete(path)) next.add(path);
  return next;
}
