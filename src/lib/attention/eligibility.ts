import type { StoredViewSession, ViewFreshness, ViewMode } from "@/lib/view/types";

/**
 * The ONE statement of which presence sessions an attention handoff may move.
 *
 * Selection (the MCP server picking the view a directed request executes on)
 * and the host gate (the browser deciding whether AttentionHost holds a device
 * id at all) used to answer this question independently, and the gap between
 * them was a silent failure: a DESKTOP browser narrowed under the phone
 * breakpoint renders the mobile layout — which withholds the device id, so it
 * can never navigate — while its presence heartbeat still says `desktop`, so
 * selection happily directed the handoff at a view that would never move.
 * Both sides now read this module, so they cannot drift apart again.
 *
 * Pure and browser-safe on purpose: `useIsMobile` imports the breakpoint into
 * a media query, and the server-side selector passes freshness in rather than
 * having this module read a clock or the filesystem.
 */

/** The narrowest layout that still mounts the attention host with a device id.
    `useIsMobile` renders the phone layout strictly below this. */
export const ATTENTION_MIN_BOARD_WIDTH = 768;

/** The media query the shell's mobile switch watches — derived from the same
    number the selection predicate enforces, so the two are one fact. */
export const MOBILE_LAYOUT_QUERY = `(max-width: ${ATTENTION_MIN_BOARD_WIDTH - 1}px)`;

/**
 * Modes a desktop can actually BE moved in.
 *
 * A focus handoff needs a board controller, and only the scheme board and the
 * phone's focus view ever register one. A desktop sitting in the history list
 * has no camera and no anchors to select: the handoff finds no controller,
 * reports `lost`, and nothing on screen moves. `overview` stays eligible
 * because a handoff from the overview OPENS the target's project, which mounts
 * the board, and the handoff already waits for that board to publish.
 */
export const FOLLOWABLE_MODES: ReadonlySet<ViewMode> = new Set<ViewMode>([
  "overview",
  "scheme",
  "mobile-focus",
  "mobile-map",
]);

/** The presence facts the predicate reads. A narrow shape rather than the full
    session, so tests and the client gate can satisfy it without fabricating a
    heartbeat. */
export type AttentionPresenceFacts = Pick<StoredViewSession, "visibility" | "mode"> & {
  device: { kind: StoredViewSession["device"]["kind"] };
  viewport: { width: number };
  freshness: ViewFreshness;
};

/**
 * Whether this presence session can execute an attention handoff right now.
 *
 * - VISIBLE AND ACTIVE. A backgrounded tab neither renders an offer nor
 *   follows one, and a stale one may be a laptop that was shut hours ago.
 * - NOT A PHONE. Mobile is chat-only by design: it withholds its device id, so
 *   it can neither report the offer nor move its board.
 * - WIDE ENOUGH TO HOST. A desktop window narrowed under the phone breakpoint
 *   renders the mobile layout, whose host is disabled — its heartbeat still
 *   says `desktop`, so the width is the only fact that tells it apart.
 * - IN A MODE A BOARD CAN BE MOUNTED IN.
 */
export function attentionCapablePresence(facts: AttentionPresenceFacts): boolean {
  if (facts.device.kind === "mobile") return false;
  if (!FOLLOWABLE_MODES.has(facts.mode)) return false;
  if (facts.visibility !== "visible" || facts.freshness !== "active") return false;
  return facts.viewport.width >= ATTENTION_MIN_BOARD_WIDTH;
}
