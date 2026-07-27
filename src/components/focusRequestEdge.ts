/**
 * One-shot consumption of a focus request (the sticky-focus defect).
 *
 * A focus request is an EDGE — "this explicit event asks the view to move once"
 * — but it is carried in React state that stays set long after the move, and it
 * is read by an effect whose other dependencies (`files`, `pipelines`,
 * `deckFlows`, …) get fresh identities on every scanner poll. Level-reading it
 * there re-armed the board's pending-focus channel on each poll, and because the
 * highlight that drives the camera self-clears after ~1.8s, the camera's own
 * "already handled this" guard had reset by the time the next poll re-armed it.
 * The result was a view that pulled the operator back to the target every few
 * seconds, forever, after they had panned or selected somewhere else.
 *
 * The nonce was always the identity of the edge; nothing compared it. This gate
 * consumes it: an edge is applied at most once, and re-reads — renders,
 * heartbeats, scanner refreshes, and idempotent replays of the SAME event —
 * observe an already-consumed nonce and do nothing. A genuinely new event
 * carries a new nonce and applies once in its turn.
 *
 * Deliberately NOT a render-phase hook. Consumption is a mutation, so it belongs
 * in the effect that also performs the move; that also makes a development
 * double-invoked effect correct rather than a second focus.
 */

export interface FocusRequestEdge {
  path: string;
  /** Identity of the edge. Repeated requests for the same path still move the
      view, so this — not the path — is what distinguishes one event from the
      next. */
  nonce: number;
}

export interface FocusEdgeGate {
  /**
   * Whether this call should apply `request`, consuming it if so.
   *
   * True exactly once per distinct nonce. Safe to call on every effect run:
   * that is the point — the effect may re-run for reasons that have nothing to
   * do with the request, and every one of those re-runs must be a no-op.
   */
  consume(request: FocusRequestEdge | null): boolean;
  /** What the gate has already applied, for assertions and diagnostics. */
  appliedNonce(): number | null;
}

export function createFocusEdgeGate(): FocusEdgeGate {
  /* Null rather than a number, so nonce 0 — the first edge a fresh mount can
     see — is not mistaken for "already applied". */
  let applied: number | null = null;
  return {
    consume(request) {
      if (!request) return false;
      if (applied === request.nonce) return false;
      applied = request.nonce;
      return true;
    },
    appliedNonce: () => applied,
  };
}
