"use client";

/**
 * What is left of the operator credential: the eraser.
 *
 * There is no operator credential any more. Rounds 7–9 of #691 built one — a key
 * printed to the launching terminal, pasted into a gate, held in a single volatile
 * module slot, lost on reload — and the operator rejected it on stage for the
 * reason the design never weighed: it broke the two gestures the product is FOR.
 * A fresh tab could not open the manager and could not start a call from a card,
 * and every reload put it back in that state.
 *
 * The authority model that replaced it is in `@/lib/agent/operatorAuthority`: this
 * app is single-user and loopback-bound, its routes reject cross-origin first, and
 * a same-origin request is therefore the operator. Agents are refused on entirely
 * different grounds — they present the conversation capability the registry issued
 * them. Nothing is pasted, stored, unlocked or held anywhere in the browser.
 *
 * This function survives the removal because a profile that ran an earlier round
 * still has its leavings: the round-8 bearer in web storage, the round-7 key in a
 * bookmarked fragment (and so in Chromium's on-disk History database). Neither can
 * authorize anything now, and both are removed rather than left sitting in the
 * profile. Idempotent and safe during render — it touches no React state.
 */

/** The fragment the round-7 startup link used. Recognized only so it can be scrubbed. */
const LEGACY_FRAGMENT = "llv-operator";
/** Where round 8 mirrored the bearer. Recognized only so it can be deleted. */
const LEGACY_STORAGE_KEY = "llv.operator.capability";

export function purgeLegacyOperatorCredential(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(LEGACY_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* Private mode or disabled storage: there was nothing persisted to begin with. */
  }

  const raw = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  if (!raw.includes(LEGACY_FRAGMENT)) return;
  const fragment = new URLSearchParams(raw);
  if (!fragment.has(LEGACY_FRAGMENT)) return;
  fragment.delete(LEGACY_FRAGMENT);
  const remaining = fragment.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ""}`);
}
