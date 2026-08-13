"use client";

/**
 * WHICH conversation holds the current project's active manager seat.
 *
 * The viewer-context prelude exists for exactly one agent per project: the
 * conversation named by that project's active seat. Every other hosted worker
 * gets ordinary turns. The first version keyed that on `voiceEnabled` — "this
 * conversation could hold a voice call" — which is a capability every hosted
 * codex-app-server conversation has, so the operator's current project, focused
 * conversation and selection were prepended to unrelated workers' turns.
 *
 * The browser reads the same per-project seat route as the orchestrator panel.
 * This resolver authorizes and mutates nothing; it only scopes the prelude.
 *
 * Cached per project with a short TTL and one shared in-flight promise per
 * project. A burst of sends costs one GET, and a rotation is picked up within
 * the window without an invalidation channel.
 *
 * FAILS CLOSED. An unreachable or unreadable seat produces a plain turn, keeping
 * the operator's view out of any conversation whose designation is uncertain.
 */

/** Long enough that a burst of sends costs one GET; short enough that a manager
    swap needs no invalidation from anywhere else in the app. */
export const MANAGER_IDENTITY_TTL_MS = 30_000;

interface ManagerStatusBody {
  seat?: { conversationId?: unknown } | null;
  exists?: unknown;
}

interface CachedManagerIdentity {
  conversationId: string | null;
  cachedAt: number;
}

const cachedByProject = new Map<string, CachedManagerIdentity>();
const inFlightByProject = new Map<string, Promise<string | null>>();

/** The designated manager's conversation id, or null when none is designated (or
    the project seat cannot be read right now). */
export async function designatedManagerConversationId(
  project: string,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<string | null> {
  const scopedProject = project.trim();
  if (!scopedProject) return null;
  const cached = cachedByProject.get(scopedProject);
  if (cached && now() - cached.cachedAt < MANAGER_IDENTITY_TTL_MS) return cached.conversationId;
  const existing = inFlightByProject.get(scopedProject);
  if (existing) return existing;
  const request = (async () => {
    try {
      const response = await fetchFn("/api/orchestrator/seat?project=" + encodeURIComponent(scopedProject));
      if (!response.ok) return null;
      const body = await response.json() as ManagerStatusBody;
      /* A seat whose transcript is gone names no live manager for the composer;
         the panel returns to its draft state until the operator seats a live
         conversation. */
      const conversationId = body.exists === true && typeof body.seat?.conversationId === "string"
        ? body.seat.conversationId
        : null;
      cachedByProject.set(scopedProject, { conversationId, cachedAt: now() });
      return conversationId;
    } catch {
      /* Left uncached: a transient network failure must not pin "no manager" for
         the whole TTL. */
      return null;
    } finally {
      inFlightByProject.delete(scopedProject);
    }
  })();
  inFlightByProject.set(scopedProject, request);
  return request;
}

/** Whether this conversation identity IS the designated manager's. */
export async function isDesignatedManagerConversation(
  conversationId: string,
  project: string,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<boolean> {
  if (!conversationId.startsWith("conversation_")) return false;
  return await designatedManagerConversationId(project, fetchFn, now) === conversationId;
}

/** Tests only. */
export function resetManagerIdentityForTest(): void {
  cachedByProject.clear();
  inFlightByProject.clear();
}
