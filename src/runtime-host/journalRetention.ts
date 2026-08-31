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
  receipts: Record<string, {
    conversationId: string;
    state: SpawnReceipt["state"];
    artifactLifecycle: SpawnReceipt["artifactLifecycle"];
  }>;
  conversationAliases: Record<string, string>;
}

function canonicalConversationId(
  conversationId: string,
  aliases: Readonly<Record<string, string>>,
): string | null {
  const seen = new Set<string>();
  let current = conversationId;
  while (aliases[current]) {
    if (seen.has(current)) return null;
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
    else if (entry?.status === "dead") state = "dead";
    states.set(conversation.id, state);
  }
  for (const receipt of Object.values(registry.receipts)) {
    const conversationId = canonicalConversationId(receipt.conversationId, registry.conversationAliases);
    if (conversationId === null) continue;
    const existing = states.get(conversationId);
    if (existing === "superseded") continue;
    const state: RuntimeRegistryConversationRetentionState | undefined = receipt.state === "failed" || receipt.state === "conflicted"
      ? "dead"
      : receipt.state !== "completed" && receipt.artifactLifecycle === "pending"
        ? "current"
        : undefined;
    if (state === undefined) continue;
    if (state === "current" || existing === undefined) states.set(conversationId, state);
  }
  for (const alias of Object.keys(registry.conversationAliases)) {
    const canonical = canonicalConversationId(alias, registry.conversationAliases);
    if (canonical === null) {
      states.set(alias, "current");
      continue;
    }
    const state = states.get(canonical);
    if (state) states.set(alias, state);
  }
  return states;
}
