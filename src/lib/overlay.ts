/** Propagation-safe Escape seam for an overlay stacked inside another overlay.

    On mobile the Codex account sheet opens inside the project drawer, and each
    overlay closes itself on Escape. Both once listened on `window`, so a single
    Escape ran both handlers: the sheet closed, the drawer unmounted underneath
    it, and focus returned to a trigger that no longer existed. The open sheet
    sits at the top of the stack, so it owns Escape — it closes itself, returns
    focus to its trigger (via `close`), and stops the event before an ancestor's
    handler can act. The drawer stays open; a later Escape, with the sheet gone,
    reaches the drawer's own listener. Handling this on the dialog subtree
    (instead of a second global listener that races the drawer's) is what makes
    "top overlay only" hold without coordinating listener registration order. */
export interface OverlayKeyEvent {
  readonly key: string;
  stopPropagation(): void;
}

/** Consumes an Escape keypress for the top overlay: stops propagation so an
    ancestor overlay's handler never runs, then invokes `close` (expected to hide
    the overlay and restore trigger focus). Returns whether it handled the event.
    Any other key passes through untouched so typing and navigation still bubble. */
export function handleOverlayEscape(event: OverlayKeyEvent, close: () => void): boolean {
  if (event.key !== "Escape") return false;
  event.stopPropagation();
  close();
  return true;
}
