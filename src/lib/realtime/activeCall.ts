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

/**
 * Cached so `useSyncExternalStore` sees a stable identity between notifications.
 * Returning a fresh object per read would make every unrelated render look like a
 * store change and re-render the floater forever.
 */
let snapshot: ActiveCall | null = null;

function recompute(): void {
  let next: ActiveCall | null = null;
  for (const [conversationId, phase] of phases) {
    if (phase !== "idle") next = { conversationId, phase };
  }
  if (next?.conversationId === snapshot?.conversationId && next?.phase === snapshot?.phase) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

/** Called by the realtime client on every phase change. Not exported for general
    use — the phase's only author is the client that owns the transport. */
export function reportCallPhase(conversationId: string, phase: CodexRealtimePhase): void {
  if (phases.get(conversationId) === phase) return;
  phases.set(conversationId, phase);
  recompute();
}

export function subscribeActiveCall(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getActiveCall(): ActiveCall | null {
  return snapshot;
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
  snapshot = null;
  listeners.clear();
}
