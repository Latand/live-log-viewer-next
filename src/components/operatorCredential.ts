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
 *
 * THE BROWSER SESSION (`operatorBrowserSession.ts`) is the durable layer above all
 * of that: a tab that adopts the fragment trades it (once) for a browser-scoped
 * httpOnly cookie, so operator-only actions that DO require possession — manager
 * designation above all — work from every tab of the operator's browser and
 * survive server restarts. The cookie is invisible to this module by design.
 *
 * NONE of this gates voice. The voice transport is operator-by-construction for
 * the same-origin browser (final operator decision — see
 * `voiceTransportOperator`), so the voice button renders with no credential, no
 * cookie and no ceremony, and this module is consulted only for the actions that
 * genuinely need possession.
 */

/** The fragment key the startup link uses. */
export const OPERATOR_CREDENTIAL_FRAGMENT = "llv-operator";
const STORAGE_KEY = "llv.operator.capability";

let capability: string | null = null;

/* The credential value already traded for a cookie, so one adoption establishes
   once rather than on every render. */
let establishedFor: string | null = null;

/** Trade the adopted link credential for the browser-scoped cookie. Fire and
    forget: a failure (stale credential, offline) leaves this tab exactly where
    the pre-cookie design left it, and the next fresh link tries again. */
function establishBrowserSession(value: string): void {
  if (establishedFor === value) return;
  establishedFor = value;
  void fetch("/api/operator/session", {
    method: "POST",
    headers: { [VIEWER_SPAWN_CAPABILITY_HEADER]: value },
  }).catch(() => undefined);
}

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
    /* The link authorizes the BROWSER, not just this tab: trade the credential
       for the httpOnly session cookie so possession-gated actions (designation
       above all) work from every tab and survive restarts. */
    establishBrowserSession(claimed);
    return;
  }
  if (capability === null) capability = readStored();
  /* A tab that adopted earlier in this process's lifetime can still seed the
     browser session (e.g. the cookie era beginning after the link was opened). */
  if (capability) establishBrowserSession(capability);
}

export function operatorCredential(): string | null {
  return capability;
}

/** Whether this tab holds the adopted link credential. NOT a gate on any voice
    control — voice is ceremony-free — merely a hint for possession-gated flows. */
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
  establishedFor = null;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing stored */
  }
}
