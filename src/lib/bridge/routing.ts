import { agentRegistry } from "@/lib/agent/registry";
import {
  authorizedManagerSeats,
  type ManagerAuthoritySources,
} from "@/lib/orchestrator/authority";
import {
  activeOrchestratorSeats,
  orchestratorRevocations,
} from "@/lib/orchestrator/seats";

import type { BridgeChannelScope } from "./types";

type BridgeScopeResolver = (conversationId: string) => BridgeChannelScope | null;

let scopeResolverForTests: BridgeScopeResolver | null = null;

function productionManagerAuthoritySources(): ManagerAuthoritySources {
  const registry = agentRegistry();
  return {
    activeSeats: activeOrchestratorSeats,
    revocations: orchestratorRevocations,
    conversationFacts: (conversationId) => {
      const conversation = registry.conversation(conversationId as `conversation_${string}`);
      if (!conversation) return null;
      return {
        superseded: conversation.supersededBy !== null,
        hasGeneration: conversation.generations.length > 0,
        project: conversation.projectOwnership?.project ?? null,
      };
    },
    resolveAlias: (conversationId) =>
      registry.conversation(conversationId as `conversation_${string}`)?.id ?? conversationId,
  };
}

/** Resolve a browser/live-gateway conversation to its validated project seat.
    The conversation id selects a durable lookup. Server-side records supply
    project identity and authority. */
export function bridgeChannelScopeForConversation(
  conversationId: string | null | undefined,
): BridgeChannelScope | null {
  const candidate = conversationId?.trim();
  if (!candidate) return null;
  if (scopeResolverForTests) return scopeResolverForTests(candidate);
  const canonical = agentRegistry()
    .conversation(candidate as `conversation_${string}`)?.id ?? candidate;
  const seat = authorizedManagerSeats(productionManagerAuthoritySources())
    .find((entry) => entry.conversationId === canonical && entry.project);
  return seat?.project
    ? { project: seat.project, seatConversationId: seat.conversationId }
    : null;
}

/** Tests only. Null restores production authority resolution. */
export function setBridgeScopeResolverForTests(resolver: BridgeScopeResolver | null): void {
  scopeResolverForTests = resolver;
}
