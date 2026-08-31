import { sessionKeyId } from "@/lib/agent/sessionKey";

import type { RuntimeRegistryConversationRetentionState } from "./journal";

interface RegistryRetentionSnapshot {
  conversations: Record<string, {
    id: string;
    engine: "codex" | "claude";
    generations: Array<{ id: string }>;
    supersededBy: unknown | null;
  }>;
  entries: Record<string, { status: string }>;
  conversationAliases: Record<string, string>;
}

export function registryConversationRetentionStates(
  registry: RegistryRetentionSnapshot,
): ReadonlyMap<string, RuntimeRegistryConversationRetentionState> {
  const states = new Map<string, RuntimeRegistryConversationRetentionState>();
  for (const conversation of Object.values(registry.conversations)) {
    const generation = conversation.generations.at(-1);
    const entry = generation
      ? registry.entries[sessionKeyId({ engine: conversation.engine, sessionId: generation.id })]
      : undefined;
    let state: RuntimeRegistryConversationRetentionState = "current";
    if (conversation.supersededBy) state = "superseded";
    else if (entry?.status === "dead" || entry?.status === "unhosted") state = "dead";
    states.set(conversation.id, state);
  }
  for (const [alias, canonical] of Object.entries(registry.conversationAliases)) {
    const state = states.get(canonical);
    if (state) states.set(alias, state);
  }
  return states;
}
