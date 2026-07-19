export type ConversationAvailabilitySnapshot = {
  loaded: boolean;
  ids: ReadonlySet<string>;
};

let snapshot: ConversationAvailabilitySnapshot = { loaded: false, ids: new Set() };
const listeners = new Set<(value: ConversationAvailabilitySnapshot) => void>();

export function conversationAvailabilitySnapshot(): ConversationAvailabilitySnapshot {
  return snapshot;
}

export function publishConversationAvailability(ids: ReadonlySet<string>): void {
  snapshot = { loaded: true, ids };
  for (const listener of listeners) listener(snapshot);
}

export function subscribeConversationAvailability(
  listener: (value: ConversationAvailabilitySnapshot) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
