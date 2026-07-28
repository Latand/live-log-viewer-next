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

/* Adoption can now happen mid-session (the operator pastes the link into the
   voice gate), so controls that stand down without the credential subscribe
   here instead of reading a render-time constant. */
const listeners = new Set<() => void>();

function notifyCredentialChanged(): void {
  for (const listener of listeners) listener();
}

export function subscribeOperatorCredential(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The server render never holds a credential; the first client render must
    match it, and adoption re-renders the subscribers right after. */
export function getServerHasOperatorCredential(): false {
  return false;
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
  /* A link in the address bar wins over anything already held: the credential is
     minted per server process, so after a restart the freshly printed link is
     exactly how a tab with a stale value recovers. Without a link this stays the
     idempotent per-render read it always was. */
  if (!claimed && capability) return;
  if (claimed) {
    capability = claimed;
    store(claimed);
    /* Out of the address bar immediately: a fragment that stays put ends up in
       history, in a screenshot, and in whatever the operator pastes next. */
    fragment.delete(OPERATOR_CREDENTIAL_FRAGMENT);
    const remaining = fragment.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ""}`);
    notifyCredentialChanged();
    return;
  }
  capability = readStored();
  if (capability) notifyCredentialChanged();
}

/**
 * Adopt a credential the operator pasted into the in-app gate: the whole
 * operator link, just its fragment, or the bare value.
 *
 * The delivery analysis above still holds — this adds no fetchable surface and
 * no new persistence. The secret goes exactly where the link route puts it
 * (module state plus this tab's `sessionStorage`), the paste field is masked,
 * and nothing echoes the value anywhere. What it buys is a legitimate route for
 * a tab that was opened by plain navigation, and a recovery route after a server
 * restart mints a new credential: the operator copies the freshly printed link
 * and pastes it here instead of re-opening the tab.
 *
 * No client-side validation beyond shape — the server is the only judge of the
 * value, and a wrong paste fails closed there with the localized notice.
 */
export function adoptOperatorCredentialFromPaste(raw: string): boolean {
  const value = extractPastedCredential(raw);
  if (!value) return false;
  capability = value;
  store(value);
  notifyCredentialChanged();
  return true;
}

function extractPastedCredential(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const marker = text.indexOf(`${OPERATOR_CREDENTIAL_FRAGMENT}=`);
  if (marker >= 0) {
    const tail = text.slice(marker + OPERATOR_CREDENTIAL_FRAGMENT.length + 1);
    const end = tail.search(/[&\s#]/);
    const encoded = end === -1 ? tail : tail.slice(0, end);
    try {
      return decodeURIComponent(encoded).trim() || null;
    } catch {
      return encoded.trim() || null;
    }
  }
  /* A bare value: one token, no whitespace. A pasted sentence is a mistake, and
     adopting it would just move the failure to the server. */
  if (/\s/.test(text)) return null;
  return text;
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
