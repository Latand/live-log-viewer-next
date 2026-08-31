import type { SpawnReceipt } from "@/lib/agent/registry";
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
  receipts: Record<string, { conversationId: string; state: SpawnReceipt["state"] }>;
  conversationAliases: Record<string, string>;
}

function canonicalConversationId(
  conversationId: string,
  aliases: Readonly<Record<string, string>>,
): string {
  const seen = new Set<string>();
  let current = conversationId;
  while (aliases[current] && !seen.has(current)) {
    seen.add(current);
    current = aliases[current]!;
  }
  return current;
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
  for (const receipt of Object.values(registry.receipts)) {
    const conversationId = canonicalConversationId(receipt.conversationId, registry.conversationAliases);
    const existing = states.get(conversationId);
    if (existing === "superseded") continue;
    const state: RuntimeRegistryConversationRetentionState = receipt.state === "failed" || receipt.state === "conflicted"
      ? "dead"
      : "current";
    if (state === "current" || existing === undefined) states.set(conversationId, state);
  }
  for (const [alias, canonical] of Object.entries(registry.conversationAliases)) {
    const state = states.get(canonical);
    if (state) states.set(alias, state);
  }
  return states;
}
