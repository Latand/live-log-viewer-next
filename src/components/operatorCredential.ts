"use client";

import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";

/**
 * The operator capability, as the browser holds it (#691 round 9).
 *
 * WHAT ACTUALLY DISTINGUISHES THE BROWSER FROM A WORKER, which is the question five
 * rounds of this feature have been answering wrongly:
 *
 * Nothing about the browser's IDENTITY does. A worker runs as the operator's uid; it
 * can write any header, any `Origin`, any `User-Agent`, open the same loopback port,
 * read any file the operator can read, and read any environment it can ptrace. There
 * is no request a browser can make that a worker cannot make identically, and no place
 * a browser can put a value AT REST that a worker cannot read. Every delivery tried so
 * far failed on that single fact:
 *
 * 1. Trust the ROUTE's caller — a claim, and claims are free.
 * 2. Trust the HEADER SHAPE (`sec-fetch-site: same-origin`) — forbidden to page
 *    JavaScript, trivially written by a local process.
 * 3. SERVE it in the page — the page is fetched anonymously over loopback.
 * 4. A FILE — every worker runs as the operator's uid.
 * 5. `sessionStorage` — 4 again. Web storage is not a browser-private compartment; it
 *    is a LevelDB directory in the Chromium profile (`Session Storage/`,
 *    `Local Storage/leveldb`), owned by the operator's uid and readable by every
 *    worker. Cookies, IndexedDB and the History database are the same story.
 *
 * ONE thing does distinguish them, and it is not identity — it is REACHABILITY OF
 * VOLATILE MEMORY, seeded by a human. Under Linux `yama/ptrace_scope >= 1` a process
 * may read another's memory only if it is an ancestor of it. A worker is a DESCENDANT
 * of the Viewer, so the server's heap is closed to it; a worker is a stranger to the
 * browser, so the tab's JS heap is closed to it too. The credential is therefore a real
 * credential exactly while it exists in only those two heaps plus the operator's screen,
 * and it stops being one the instant it touches a file, a URL, an environment, a
 * response body, or any web-storage API.
 *
 * So this module keeps it in a module variable and NOWHERE ELSE. Not stored, not
 * mirrored, not recoverable. The consequence is deliberate and is the price of the
 * property: A RELOAD LOSES IT, and the operator pastes it again. Every mechanism that
 * would survive a reload is, by definition, a persistence mechanism, and every
 * persistence mechanism a browser has is a file in a directory a worker can read.
 *
 * The URL fragment is gone for the same reason, and it is worth being precise about why
 * round 7 was nearly right: fragments genuinely never reach the server, appear in no
 * response and no request log. But Chromium records the committed URL — fragment
 * included — in the History database on disk, and the `replaceState` that scrubbed the
 * address bar was racing that write, not preventing it. A printed clickable link is a
 * persistence channel. So the server prints the BARE key to the terminal it was
 * launched from, and the operator pastes it into the tab. That paste is the part a
 * worker cannot perform.
 *
 * Residual, stated plainly rather than papered over: if `ptrace_scope` is 0, or a
 * worker runs as root, or the browser was started with `--remote-debugging-port`, or
 * the terminal tees its scrollback to a file, the distinction collapses — and at that
 * point there is no credential to be had, because the attacker can read the server's
 * memory directly.
 */

/** The fragment the round-7 startup link used. Recognized only so it can be scrubbed. */
const LEGACY_FRAGMENT = "llv-operator";
/** Where round 8 mirrored the bearer. Recognized only so it can be deleted. */
const LEGACY_STORAGE_KEY = "llv.operator.capability";

/** What `operatorSessionSecret()` mints: 32 random bytes, base64url — 43 characters. */
const OPERATOR_KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/* The whole credential. Volatile by design: see above. */
let capability: string | null = null;

type Listener = () => void;
const listeners = new Set<Listener>();

/** Re-render operator-gated UI when the credential arrives or is dropped. */
export function subscribeOperatorCredential(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function announce(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * Take the key the operator pasted.
 *
 * Returns whether anything was adopted, so the caller can keep the field open on an
 * empty paste rather than silently appearing to have worked.
 */
export function adoptOperatorCredential(pasted: string): boolean {
  const value = pasted.trim();
  /* Shape-checked, so a stray paste — a URL, a log line, half a token — closes the
     gate on a value that cannot possibly work and then fails silently at every
     operator action. The server still decides; this only refuses what could never be
     a key. */
  if (!OPERATOR_KEY_SHAPE.test(value)) return false;
  capability = value;
  announce();
  return true;
}

/** Drop it for this tab. The server keeps its secret; only this browser forgets. */
export function forgetOperatorCredential(): void {
  if (capability === null) return;
  capability = null;
  announce();
}

/**
 * Erase what earlier rounds left behind on disk, and scrub a stale startup link.
 *
 * An upgrade does not clean the previous version's leavings: a profile that ever held
 * the round-8 bearer still has it in `Session Storage/`, and a bookmarked round-7 link
 * still carries one in the address bar. Neither is adopted — a value that has been
 * through a file or a URL is spent — but both are removed, so the fix does not ship
 * while the hole it closes is still sitting in the profile.
 *
 * Idempotent and safe to call during render: it touches no React state.
 */
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
  listeners.clear();
}
