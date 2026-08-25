/**
 * Cross-surface request to open the rail's existing create-project form
 * (issue #1162). The first-run overview's «Create a project» button dispatches
 * it; the rail answers by opening the form it already owns. No second creation
 * path is introduced — this only steers the existing one.
 *
 * Desktop: the rail is always mounted, so the window event lands immediately.
 * Mobile: the rail mounts only once the project drawer opens, so the request is
 * also retained briefly and claimed by that late-mounting rail.
 */

const EVENT = "llv:create-project";
/** How long a request stays claimable by a late-mounting rail. */
const PENDING_TTL_MS = 5_000;

let pending: { at: number } | null = null;

/** Ask the rail to open its create-project form. */
export function requestProjectCreateForm(): void {
  pending = { at: Date.now() };
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

/** Claim a request dispatched just before the rail mounted (mobile drawer).
    Returns true once, and only while the request is still fresh. */
export function consumePendingProjectCreateForm(): boolean {
  if (!pending) return false;
  const fresh = Date.now() - pending.at <= PENDING_TTL_MS;
  pending = null;
  return fresh;
}

/** Subscribe to open requests. Returns an unsubscribe function. */
export function onProjectCreateFormRequest(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = () => handler();
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
