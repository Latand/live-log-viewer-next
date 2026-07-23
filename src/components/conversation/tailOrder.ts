/**
 * Canonical order of the conversation-window feed tail (round-1 P1#3), extracted
 * as a pure helper so the prompt → reply chronology is enforced and provable
 * without a leaky module-mocked LogFeed render.
 *
 * After the flushed transcript items, the window tail renders — in this exact
 * order — the launch/delivery status chips, then the operator's own pending
 * user bubbles (the PROMPT), then the streaming assistant delta (the REPLY).
 * Rendering the delta after the pending prompt keeps prompt→reply order even
 * during launch, when the file path is still `spawn:<launchId>` and the
 * transcript has not flushed a single item.
 */

export const CONVERSATION_TAIL_ORDER = ["launch", "outbox", "delta"] as const;

export type ConversationTailSection = (typeof CONVERSATION_TAIL_ORDER)[number];

/** The tail sections that are present, in canonical chronological order. */
export function orderedConversationTail(
  present: Record<ConversationTailSection, boolean>,
): ConversationTailSection[] {
  return CONVERSATION_TAIL_ORDER.filter((section) => present[section]);
}
