import type { ConversationHash } from "@/lib/accounts/identity";

export interface ActiveConversationPin {
  value: string;
}

function intentValue(intent: ConversationHash | null): string | null {
  return intent?.filePath ?? intent?.conversationId ?? null;
}

export function resolvedConversationPin(intent: ConversationHash): ActiveConversationPin | null {
  const value = intentValue(intent);
  return value ? { value } : null;
}

export function filesRequestPin(
  pending: ConversationHash | null,
  active: ActiveConversationPin | null,
): string | null {
  return intentValue(pending) ?? active?.value ?? null;
}
