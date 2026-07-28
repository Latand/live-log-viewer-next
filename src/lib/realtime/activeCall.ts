import type { CodexRealtimePhase } from "./codexRealtimeClient";

/**
 * Which conversation currently has a call up (#691 §2.3).
 *
 * The floating rendering has to mount above the whole Viewer, because the card it
 * would otherwise live in unmounts the moment the operator scrolls it out of view
 * or opens another project — while the call, a module-scoped singleton, keeps
 * running. So something at Viewer level needs to know *which* conversation is on a
 * call, and it must learn that without holding any state of its own: the PiP window
 * adds zero domain state, and a host that tracked calls independently would be a
 * second answer to a question the realtime clients already answer.
 *
 * This is that seam and nothing more — a tiny observable projection of the client
 * registry that already exists. It stores no lines, no phase history, no session:
 * the conversation id and its current phase, which is exactly enough for the host
 * to resolve the one client and subscribe to it like any other consumer.
 *
 * Not a call manager. It cannot start, stop or mutate a call, and deliberately has
 * no API to try.
 */

export interface ActiveCall {
  conversationId: string;
  phase: CodexRealtimePhase;
}

const listeners = new Set<() => void>();
/** Insertion-ordered, so "the newest non-idle call" is a well-defined answer when
    the operator has somehow started a second one. */
const phases = new Map<string, CodexRealtimePhase>();
/** The conversation whose call most recently existed. The transcript outlives the
    call on purpose — the operator keeps reading it after a hangup — so the host
    that owns the panel must keep resolving this conversation once every phase has
    gone back to `idle`. */
let lastCallConversationId: string | null = null;

/**
 * Cached so `useSyncExternalStore` sees a stable identity between notifications.
 * Returning a fresh object per read would make every unrelated render look like a
 * store change and re-render the floater forever.
 */
let snapshot: ActiveCall | null = null;
/**
 * The same question WITHOUT the retention: a call that is actually up.
 *
 * `snapshot` deliberately survives the hangup so the ended transcript stays on
 * screen, and `lastCallConversationId` is never cleared — the operator keeps
 * reading it, possibly for the rest of the session. That retention is right for
 * the PANEL and wrong for anything that must END with the call: read through
 * `snapshot`, a composer parked for a call that finished hours ago stays mounted
 * and hidden forever, on a card the operator left long ago.
 *
 * So panel retention and call liveness are two projections rather than one:
 * whoever asks gets to say which of the two they meant.
 */
let liveSnapshot: ActiveCall | null = null;

function same(a: ActiveCall | null, b: ActiveCall | null): boolean {
  return a?.conversationId === b?.conversationId && a?.phase === b?.phase;
}

function recompute(): void {
  let live: ActiveCall | null = null;
  for (const [conversationId, phase] of phases) {
    if (phase !== "idle") live = { conversationId, phase };
  }
  /* No live call: the last conversation that had one keeps its (idle) panel, so
     the ended-call transcript stays on screen exactly as it did when the card
     rendered the panel itself. */
  let next = live;
  if (!next && lastCallConversationId) {
    next = { conversationId: lastCallConversationId, phase: phases.get(lastCallConversationId) ?? "idle" };
  }
  if (same(next, snapshot) && same(live, liveSnapshot)) return;
  snapshot = next;
  liveSnapshot = live;
  for (const listener of listeners) listener();
}

/** Called by the realtime client on every phase change. Not exported for general
    use — the phase's only author is the client that owns the transport. */
export function reportCallPhase(conversationId: string, phase: CodexRealtimePhase): void {
  if (phases.get(conversationId) === phase) return;
  phases.set(conversationId, phase);
  if (phase !== "idle") lastCallConversationId = conversationId;
  recompute();
}

export function subscribeActiveCall(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getActiveCall(): ActiveCall | null {
  return snapshot;
}

/** The call that is actually up, with no retention: null the moment every phase
    is back to `idle`. What machinery whose lifetime IS the call subscribes to. */
export function getLiveCall(): ActiveCall | null {
  return liveSnapshot;
}

export function getServerLiveCall(): ActiveCall | null {
  return null;
}

/** The server render has no calls, and must not invent one — a floater in the
    server HTML would hydrate against a window that does not exist. */
export function getServerActiveCall(): ActiveCall | null {
  return null;
}

/** Tests only: drop the registry between cases so one test's call cannot leak
    into the next. Production has no reason to forget a live call. */
export function resetActiveCallsForTest(): void {
  phases.clear();
  lastCallConversationId = null;
  snapshot = null;
  liveSnapshot = null;
  listeners.clear();
}
