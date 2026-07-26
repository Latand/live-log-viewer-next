import type { FocusFrame, FocusRect } from "./types";

/**
 * Whether a request's frame is a real reading of a board (#688 D7).
 *
 * The anchor/frame split exists so a vanished anchor still leaves a usable
 * destination — but only when the frame was read off a board in the first
 * place. A request raised through the agent's tool has no board in front of it:
 * the server knows which project the target lives in and nothing about where it
 * sits, so the frame it records is deliberately empty.
 *
 * Standing in for a vanished anchor with an empty frame would take the operator
 * to the world origin and call it "where it was", which is exactly the silent
 * arbitrary landing the design refuses. One predicate, shared by whoever writes
 * such a frame and whoever would otherwise navigate to it, so the two cannot
 * drift.
 */

/** The frame recorded when the raiser could not read the board. */
export const UNREAD_FRAME_RECT: FocusRect = { x: 0, y: 0, w: 0, h: 0 };

export function frameWasRead(frame: FocusFrame | null | undefined): boolean {
  return Boolean(frame && frame.project.length > 0 && frame.rect.w > 0 && frame.rect.h > 0);
}
