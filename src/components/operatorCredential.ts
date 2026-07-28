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
 * of that. Hosted acceptance showed the tab scope is wrong for the operator: the
 * link authorizes the tab that opened it, while the operator is looking at another
 * tab — and every restart re-mints the secret. So a tab that adopts the fragment
 * immediately trades it (once) for a browser-scoped httpOnly cookie, and every tab
 * — including ones that never saw a link — asks the server "is this browser the
 * operator's?" and renders the operator controls on a yes. The cookie is invisible
 * to this module by design; only the server's boolean answer is held here.
 */

/** The fragment key the startup link uses. */
export const OPERATOR_CREDENTIAL_FRAGMENT = "llv-operator";
const STORAGE_KEY = "llv.operator.capability";

let capability: string | null = null;

/* The server's answer to "does this browser hold the operator session cookie?".
   Page JavaScript cannot see the httpOnly cookie itself — that is the point — so
   the boolean is learned by probing and updated by establishment. */
let browserAuthorized = false;
let probeInFlight = false;
/* The credential value already traded for a cookie, so one adoption establishes
   once rather than on every render. */
let establishedFor: string | null = null;
let probeTriggersInstalled = false;
let probeTimer: ReturnType<typeof setInterval> | null = null;

const PROBE_INTERVAL_MS = 15_000;

/* A REACTIVE STORE, not a render-time read. The authority flips asynchronously —
   a probe resolves, an establishment lands, a session is revoked — and hosted
   acceptance proved the consumer cannot be assumed to re-render for unrelated
   reasons in time (or ever): the canonical voice button stayed hidden after the
   probe had long resolved true. So every consumer subscribes, and every
   transition notifies. */
const listeners = new Set<() => void>();

/* Deferred a microtask: fragment adoption runs inside the Viewer's render body,
   and notifying subscribers synchronously there would be an update-during-render.
   The async paths (probe, establish) tolerate the deferral trivially. */
let notifyQueued = false;
function notifyCredentialChanged(): void {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    for (const listener of listeners) listener();
  });
}

export function subscribeOperatorCredential(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The server render never holds a credential, and the first client render must
    match it; adoption and the probes re-render subscribers immediately after. */
export function getServerHasOperatorCredential(): false {
  return false;
}

function noteBrowserSession(authorized: boolean): void {
  if (browserAuthorized === authorized) return;
  browserAuthorized = authorized;
  notifyCredentialChanged();
  syncProbeTimer();
}

/** The probe interval runs exactly while unauthorized: its one job is noticing
    that another tab (or the launch flow) authorized this browser. No render
    cadence is assumed anywhere — this is a real timer. */
function syncProbeTimer(): void {
  if (browserAuthorized) {
    if (probeTimer !== null) {
      clearInterval(probeTimer);
      probeTimer = null;
    }
    return;
  }
  if (probeTimer === null) probeTimer = setInterval(probeBrowserSession, PROBE_INTERVAL_MS);
}

/** Trade the adopted link credential for the browser-scoped cookie. Fire and
    forget: a failure (stale credential, offline) leaves this tab exactly where
    the pre-cookie design left it, and the next fresh link tries again. */
function establishBrowserSession(value: string): void {
  if (establishedFor === value) return;
  establishedFor = value;
  void fetch("/api/operator/session", {
    method: "POST",
    headers: { [VIEWER_SPAWN_CAPABILITY_HEADER]: value },
  })
    .then((response) => {
      if (response.ok) noteBrowserSession(true);
    })
    .catch(() => undefined);
}

function probeBrowserSession(): void {
  if (probeInFlight) return;
  probeInFlight = true;
  void fetch("/api/operator/session", { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : null))
    .then((body: unknown) => {
      if (body && typeof body === "object" && typeof (body as { operator?: unknown }).operator === "boolean") {
        noteBrowserSession((body as { operator: boolean }).operator);
      }
    })
    .catch(() => undefined)
    .finally(() => {
      probeInFlight = false;
    });
}

/** The operator authorizes the browser from SOME tab; the tab they are looking
    at learns it here: one probe now, one on every focus/visibility return (which
    also notices a revoked session), and the timer above while unauthorized. */
function keepBrowserSessionFresh(): void {
  if (probeTriggersInstalled) return;
  probeTriggersInstalled = true;
  window.addEventListener("focus", probeBrowserSession);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) probeBrowserSession();
  });
  syncProbeTimer();
  probeBrowserSession();
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
    const changed = capability !== claimed;
    capability = claimed;
    store(claimed);
    /* Out of the address bar immediately: a fragment that stays put ends up in
       history, in a screenshot, and in whatever the operator pastes next. */
    fragment.delete(OPERATOR_CREDENTIAL_FRAGMENT);
    const remaining = fragment.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ""}`);
    if (changed) notifyCredentialChanged();
    /* The link authorizes the BROWSER, not just this tab: trade the credential
       for the httpOnly session cookie so every other tab — including the one the
       operator is actually looking at — picks the authority up on its next probe. */
    establishBrowserSession(claimed);
    keepBrowserSessionFresh();
    return;
  }
  if (capability === null) {
    capability = readStored();
    if (capability) notifyCredentialChanged();
  }
  /* A tab that adopted earlier in this process's lifetime can still seed the
     browser session (e.g. the cookie era beginning after the link was opened). */
  if (capability) establishBrowserSession(capability);
  keepBrowserSessionFresh();
}

export function operatorCredential(): string | null {
  return capability;
}

/** Whether operator-only controls can work at all in this tab: the tab's own
    adopted credential, or the browser-scoped session the server confirmed. */
export function hasOperatorCredential(): boolean {
  return capability !== null || browserAuthorized;
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
  browserAuthorized = false;
  probeInFlight = false;
  establishedFor = null;
  probeTriggersInstalled = false;
  if (probeTimer !== null) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing stored */
  }
}
