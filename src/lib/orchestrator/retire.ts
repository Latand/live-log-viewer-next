import { applyConversationAction } from "@/lib/conversation/actions";

/**
 * Stopping the outgoing manager during a swap (#691 §3, §7.3).
 *
 * Lives here rather than beside the route it serves, and that is not a style
 * choice: a `route.ts` module may export ONLY the documented route fields — the
 * HTTP method handlers and the segment config. Next.js validates that list at
 * build time, so an extra export (a test seam, a helper, a type) fails
 * `next build` outright even though `tsc --noEmit` is perfectly happy with it.
 * Anything a route needs to share with a test therefore belongs in a module the
 * route imports, which is the same shape `scanCache` and `scanCoordinator` already
 * use for their own overrides.
 *
 * Seamed at all because the route's contract is about an ORDER — retire the
 * predecessor, and only then seat the successor — and a test that proves the order
 * must be able to fail the retirement without killing a real agent.
 */

export type RetireManager = (conversationId: string, transcriptPath: string) => Promise<string>;

/**
 * The real thing: kill the conversation through the same action surface the board's
 * own controls use. A refusal is raised rather than returned, because the caller's
 * only correct response to "it is still running" is to abandon the swap.
 */
export const productionRetireManager: RetireManager = async (conversationId, transcriptPath) => {
  const outcome = await applyConversationAction({ conversationId, transcriptPath, action: "kill" });
  if (outcome && typeof outcome === "object" && "error" in outcome) {
    throw new Error(String((outcome as { error: unknown }).error));
  }
  return "killed";
};

let retireManager: RetireManager = productionRetireManager;

/** How the outgoing manager is stopped right now. */
export function retireOutgoingManager(conversationId: string, transcriptPath: string): Promise<string> {
  return retireManager(conversationId, transcriptPath);
}

/** Tests only; `null` restores the production path. Production never calls this. */
export function setRetireManagerForTests(retire: RetireManager | null): void {
  retireManager = retire ?? productionRetireManager;
}
