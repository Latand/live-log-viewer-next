import { formatConversationHash } from "@/lib/accounts/identity";

/**
 * Per-tab browser history over deliberate card focus (issue #866).
 *
 * Every deliberate conversation-card navigation — a scheme card, a list row, an
 * attention jump, a sub-agent badge, a focus handoff — records ONE typed
 * same-document history entry here, keyed primarily by the stable
 * `conversationId` (the #40 identity contract), with the project and the
 * current transcript path as bounded supporting identity. Browser and mouse
 * Back/Forward then replay those entries through the existing in-app resolver
 * (`pendingHash` → `resolveConversationTarget` → `openPinnedFile` in Viewer):
 * the same camera glide and reveal a live click uses, with no document reload,
 * no route remount and no board rescan. Next's router integrates native
 * `history.pushState`/`replaceState` (see
 * node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md
 * §"Native History API"), so a same-document push never re-renders the route.
 *
 * The anti-loop discipline is structural rather than a fence: every write goes
 * through {@link decideFocusAction}, and every RESOLVER-driven open (initial
 * deep link, hashchange, popstate replay) records with `restore: true`, which
 * can only ever `replaceState`. A replay therefore re-types the entry it landed
 * on and cannot push, so popstate → resolve → record terminates; only a live
 * gesture on a NEW target pushes, and the browser owns forward-branch
 * truncation from there. Ambient movements (pan, zoom, hover, lasso, scan
 * refresh, transcript polls) never reach this module at all.
 */

export const FOCUS_HISTORY_STATE_KEY = "llvFocus";

/** Identity fields are ids, paths and project keys — never content. Anything
    longer than this is not an identity and is refused wholesale. */
const MAX_FIELD_LENGTH = 1024;

export interface FocusHistoryEntry {
  v: 1;
  /** Stable ViewerConversationId — the primary key. Null only for a transcript
      that has not adopted an id (then `path` carries identity). */
  conversationId: string | null;
  /** Transcript path at record time: bounded support so the replay resolver can
      pin the exact file into the next poll. Never authoritative — a migrated
      conversation resolves by `conversationId`. */
  path: string | null;
  /** Project key at record time: replay selects it before resolving, so a
      cross-project entry lands in the right board. */
  project: string;
}

export type FocusHistoryAction = "push" | "replace";

function boundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

function boundedOrNull(value: unknown): value is string | null {
  return value === null || boundedString(value);
}

/** The typed entry inside a history state, or null for untyped/foreign/malformed
    states. Rebuilds the entry field-by-field so replay never carries fields this
    version does not speak. */
export function parseFocusHistoryState(state: unknown): FocusHistoryEntry | null {
  if (typeof state !== "object" || state === null) return null;
  const carried = (state as Record<string, unknown>)[FOCUS_HISTORY_STATE_KEY];
  if (typeof carried !== "object" || carried === null) return null;
  const raw = carried as Record<string, unknown>;
  if (raw.v !== 1) return null;
  if (!boundedOrNull(raw.conversationId) || !boundedOrNull(raw.path) || !boundedString(raw.project)) return null;
  if (raw.conversationId === null && raw.path === null) return null;
  return { v: 1, conversationId: raw.conversationId, path: raw.path, project: raw.project };
}

/** What a record call needs to know about a card: its identity fields only. */
export type FocusNavigationFile = { conversationId?: string | null; path: string };

export function focusEntryFor(file: FocusNavigationFile, project: string): FocusHistoryEntry {
  return { v: 1, conversationId: file.conversationId ?? null, path: file.path, project };
}

/** Whether two entries name the same card: conversation-id equality first (the
    canonical identity), path equality as the pre-adoption fallback — so a
    provisional-id adoption or a migration re-record coalesces instead of
    stacking a second entry for the same card. */
export function sameFocusTarget(a: FocusHistoryEntry, b: FocusHistoryEntry): boolean {
  if (a.conversationId && b.conversationId) return a.conversationId === b.conversationId;
  if (a.path && b.path) return a.path === b.path;
  return false;
}

/**
 * What a focus record does to the history stack. `restore` marks every
 * resolver-driven open — initial deep-link restoration, a manual hash edit, a
 * popstate replay — which must re-type the entry it is already standing on,
 * never add one. A live gesture pushes unless it re-focuses the current target,
 * which coalesces.
 */
export function decideFocusAction(
  current: FocusHistoryEntry | null,
  next: FocusHistoryEntry,
  restore: boolean,
): FocusHistoryAction {
  if (restore) return "replace";
  if (current && sameFocusTarget(current, next)) return "replace";
  return "push";
}

/** A deliberate project selection over a focused-card entry pushes, so the card
    entry stays reachable behind Back; over an untyped entry it replaces in
    place, which is the pre-#866 behavior. */
export function decideProjectAction(current: FocusHistoryEntry | null): FocusHistoryAction {
  return current ? "push" : "replace";
}

/** The typed entry the tab is currently standing on, if any. */
export function currentFocusEntry(): FocusHistoryEntry | null {
  if (typeof window === "undefined") return null;
  return parseFocusHistoryState(window.history.state);
}

function write(action: FocusHistoryAction, state: object | null, url: string): void {
  if (action === "push") window.history.pushState(state, "", url);
  else window.history.replaceState(state, "", url);
}

/**
 * Record a deliberate card focus. One call per gesture, from whichever surface
 * accepted it; the decision table above makes repeated and replayed calls
 * idempotent, so surfaces that layer (a catalog click that also arms the
 * resolver) may both record without stacking entries.
 */
export function recordFocusNavigation(
  file: FocusNavigationFile,
  project: string,
  { restore = false }: { restore?: boolean } = {},
): void {
  if (typeof window === "undefined") return;
  const entry = focusEntryFor(file, project);
  /* Refuse to record what could not replay: an unbounded or empty identity. */
  if (parseFocusHistoryState({ [FOCUS_HISTORY_STATE_KEY]: entry }) === null) return;
  const hash = formatConversationHash({ conversationId: file.conversationId ?? undefined, path: file.path });
  write(decideFocusAction(currentFocusEntry(), entry, restore), { [FOCUS_HISTORY_STATE_KEY]: entry }, hash);
}

/** Record a deliberate project selection (rail, overview). Untyped on purpose:
    replaying it is the hashchange path's job, exactly as before #866. */
export function recordProjectNavigation(url: string): void {
  if (typeof window === "undefined") return;
  write(decideProjectAction(currentFocusEntry()), null, url);
}

/** Project-alias canonicalization is a rename, not a navigation: a typed entry
    keeps its place and its hash and only re-labels the stored project; an
    untyped entry falls back to rewriting the project hash in place. */
export function retargetRecordedProject(project: string, fallbackUrl: string): void {
  if (typeof window === "undefined") return;
  const current = currentFocusEntry();
  if (current) {
    const entry: FocusHistoryEntry = { ...current, project };
    window.history.replaceState({ [FOCUS_HISTORY_STATE_KEY]: entry }, "", window.location.hash || window.location.pathname);
    return;
  }
  window.history.replaceState(null, "", fallbackUrl);
}

/**
 * The replay half: Back/Forward (button, keyboard, mouse side-buttons) lands on
 * an entry and the browser fires `popstate`. Typed entries go to the handler;
 * untyped ones are left for the legacy `hashchange` listener, which already
 * speaks `#p=`/`#f=`/`#c=` hashes.
 */
export function attachFocusPopstate(onEntry: (entry: FocusHistoryEntry) => void): () => void {
  const listener = (event: PopStateEvent) => {
    const entry = parseFocusHistoryState(event.state);
    if (entry) onEntry(entry);
  };
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}
