import type { CanonicalSeatConversationId } from "./types";

/**
 * ONE resolver for every seat identity the bridge compares (#1168).
 *
 * A report records the seat it was routed to at write time; the relay and the
 * attention projection both read it back later, against whatever the registry
 * calls that conversation NOW. An account migration rekeys a conversation, so
 * those two strings stop matching — and a surface that canonicalizes on one
 * side while comparing raw ids on the other is worse than one that does neither:
 * the ask moves onto the live card and the directive that answers it can no
 * longer reach the row, leaving an item in the queue nothing in the log can
 * retire.
 *
 * So both sides take their identities through this, over the registry's own
 * alias chain. The prefix guard is here rather than at each call site because
 * the registry's resolver is typed on `conversation_`-prefixed ids while the
 * log holds plain strings, including rows written before that shape was
 * enforced: a seat id the registry could not have minted resolves to itself
 * rather than being handed to a resolver that cannot answer for it.
 */
export function seatIdentityResolver(
  canonicalConversationId: (id: `conversation_${string}`) => string,
): CanonicalSeatConversationId {
  return (conversationId) => (conversationId.startsWith("conversation_")
    ? canonicalConversationId(conversationId as `conversation_${string}`)
    : conversationId);
}
