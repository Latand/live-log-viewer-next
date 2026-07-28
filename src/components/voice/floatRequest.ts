"use client";

/**
 * "Float this call again" — one edge, consumed once (#691 §5).
 *
 * The floater auto-opens once per call (U4). After the operator closes it, the call
 * is still live, so a host that simply re-opened whenever "a call is up and no window
 * is open" would put the window straight back and the close button would do nothing.
 * Re-floating therefore has to be a distinct, explicit event.
 *
 * Shaped as a consumable edge for the reason `focusRequestEdge` is: a nonce carried in
 * state gets re-read by effects that depend on values reallocated every poll, and the
 * request fires again on renders nobody asked for. A monotonic counter that the host
 * compares against what it has already handled makes replays and re-renders no-ops by
 * construction.
 */

const listeners = new Set<() => void>();
let requested = 0;

/** Bumped by the card's float control. Requires a user gesture at the call site —
    the PiP API needs transient activation and this is what carries it. */
export function requestVoiceFloat(): void {
  requested += 1;
  for (const listener of listeners) listener();
}

export function subscribeVoiceFloatRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getVoiceFloatRequest(): number {
  return requested;
}

/** Server renders have no gestures and no windows; a non-zero value here would make
    the first client render look like a pending request. */
export function getServerVoiceFloatRequest(): number {
  return 0;
}

/** Tests only. */
export function resetVoiceFloatRequestForTest(): void {
  requested = 0;
  listeners.clear();
}
