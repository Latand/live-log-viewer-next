"use client";

/**
 * WHICH conversation is the manager — asked of the designation record, never of a
 * capability.
 *
 * The viewer-context prelude exists for exactly one agent: the Viewer-global
 * orchestrator the operator carries around the board. Every other hosted worker
 * gets ordinary turns. The first version keyed that on `voiceEnabled` — "this
 * conversation could hold a voice call" — which is a CAPABILITY every hosted
 * codex-app-server conversation has, so the operator's current project, focused
 * conversation and selection were prepended to unrelated workers' turns.
 *
 * The only thing that answers "is this the manager" is `orchestrator.json`, the
 * single-instance designation record, read here through its own GET (which
 * authorizes nothing and mutates nothing — designation CHANGE keeps its operator
 * gate on POST, untouched).
 *
 * Cached with a short TTL and a shared in-flight promise, because the question is
 * asked on the send path: a burst of sends is one GET, and a manager swap is
 * picked up within the window without anything having to invalidate this.
 *
 * FAILS CLOSED. An unreachable or unreadable record answers "not the manager", so
 * a viewer that cannot resolve the designation sends plain turns rather than
 * leaking the operator's view into whatever conversation is at hand.
 */

/** Long enough that a burst of sends costs one GET; short enough that a manager
    swap needs no invalidation from anywhere else in the app. */
export const MANAGER_IDENTITY_TTL_MS = 30_000;

interface ManagerStatusBody {
  record?: { conversationId?: unknown } | null;
  exists?: unknown;
}

let cachedConversationId: string | null = null;
let cachedAt = 0;
let inFlight: Promise<string | null> | null = null;

/** The designated manager's conversation id, or null when none is designated (or
    the record cannot be read right now). */
export async function designatedManagerConversationId(
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<string | null> {
  if (cachedAt && now() - cachedAt < MANAGER_IDENTITY_TTL_MS) return cachedConversationId;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const response = await fetchFn("/api/orchestrator");
      if (!response.ok) return null;
      const body = await response.json() as ManagerStatusBody;
      /* A record whose transcript is gone names no live manager: the next click
         on the chat button spawns a successor, and until then nothing here is
         the manager. */
      const conversationId = body.exists === true && typeof body.record?.conversationId === "string"
        ? body.record.conversationId
        : null;
      cachedConversationId = conversationId;
      cachedAt = now();
      return conversationId;
    } catch {
      /* Left uncached: a transient network failure must not pin "no manager" for
         the whole TTL. */
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Whether this conversation identity IS the designated manager's. */
export async function isDesignatedManagerConversation(
  conversationId: string,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<boolean> {
  if (!conversationId.startsWith("conversation_")) return false;
  return await designatedManagerConversationId(fetchFn, now) === conversationId;
}

/** Tests only. */
export function resetManagerIdentityForTest(): void {
  cachedConversationId = null;
  cachedAt = 0;
  inFlight = null;
}
