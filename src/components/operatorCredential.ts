"use client";

import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";

/**
 * The operator capability, as the browser holds it (#691 rounds 6–7).
 *
 * Three deliveries have been tried on this feature and two were broken in the same
 * way, so the reasoning is worth keeping:
 *
 * 1. Trust the ROUTE's caller — a claim, and claims are free.
 * 2. Trust the HEADER SHAPE (`sec-fetch-site: same-origin`) — forbidden to page
 *    JavaScript, trivially written by a local process.
 * 3. SERVE it in the page — worst of the three: the page is fetched anonymously over
 *    loopback, so any local process could GET it and become the operator. A sound
 *    credential leaked by its delivery is worse than none, because it looks
 *    authenticated.
 *
 * What survives is the constraint all three failed: the credential must never appear
 * in anything a local process can request. So it arrives in the URL FRAGMENT of a
 * one-time link the server prints to the terminal the operator launched it from.
 * Fragments are never transmitted to the server, never appear in a response body, and
 * never land in request logs — there is nothing to fetch and nothing to replay.
 *
 * The fragment is stripped from the address bar the moment it is read, so it does not
 * linger in history, and the value is kept in `sessionStorage`: per-tab, gone when the
 * tab closes, and reachable only by script on this origin — which an agent, being a
 * separate process rather than a page, is not running.
 *
 * This does NOT defend against a process reading the capability file directly. Nothing
 * in this app does; agents run as the operator's own uid. That is the repo's standing
 * boundary, and it is a different question from the one this file answers.
 */

/** The fragment key the startup link uses. */
export const OPERATOR_CREDENTIAL_FRAGMENT = "llv-operator";
const STORAGE_KEY = "llv.operator.capability";

let capability: string | null = null;

function readStored(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    /* Private mode or disabled storage: the credential simply lives for this
       render tree, which still covers the tab that opened the link. */
    return null;
  }
}

function store(value: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* see readStored */
  }
}

/**
 * Take the credential out of the URL fragment, if this is the one-time link, and
 * remember it for the tab.
 *
 * Idempotent and safe to call during render: it touches no React state, and the
 * history rewrite happens at most once because the fragment is gone afterwards.
 */
export function adoptOperatorCredentialFromLocation(): void {
  if (typeof window === "undefined") return;

  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  const fragment = new URLSearchParams(hash);
  const claimed = fragment.get(OPERATOR_CREDENTIAL_FRAGMENT)?.trim();
  /* A link in the address bar wins over anything already held. The credential is
     minted per server process, so after a restart the freshly printed link is how
     a tab recovers — and the stage launch flow opens that link into a tab that
     may already exist, as a same-document hash navigation with no reload. The
     old value must not shadow the new one there, and the fragment must still be
     stripped. Without a link this stays the idempotent per-render read. */
  if (!claimed && capability) return;
  if (claimed) {
    capability = claimed;
    store(claimed);
    /* Out of the address bar immediately: a fragment that stays put ends up in
       history, in a screenshot, and in whatever the operator pastes next. */
    fragment.delete(OPERATOR_CREDENTIAL_FRAGMENT);
    const remaining = fragment.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ""}`);
    return;
  }
  capability = readStored();
}

export function operatorCredential(): string | null {
  return capability;
}

/** Whether operator-only controls can work at all in this tab. */
export function hasOperatorCredential(): boolean {
  return capability !== null;
}

/**
 * Headers for an operator-only request.
 *
 * Empty when the credential is absent, so the call fails closed at the server with a
 * clear refusal rather than appearing to work.
 */
export function operatorHeaders(): Record<string, string> {
  return capability ? { [VIEWER_SPAWN_CAPABILITY_HEADER]: capability } : {};
}

/** Tests only. */
export function resetOperatorCredentialForTests(): void {
  capability = null;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing stored */
  }
}
