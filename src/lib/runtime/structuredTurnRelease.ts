import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";

/** Migration phases whose only exit is the source turn ending. Once the
    coordinator has a provider receipt the switch is already executing and the
    source turn no longer gates anything. */
const AWAITING_SOURCE_TURN = new Set(["waiting-turn", "requested"]);

export interface StructuredTurnReleaseDependencies {
  registry?: AgentRegistry;
  now?: () => string;
}

/**
 * Record a structured host's own turn-end evidence for a conversation whose
 * account switch is still waiting on it (issue #1028).
 *
 * A structured host owns its turn lifecycle directly: the broker and the
 * app-server both report the terminal event, and for Claude that event is the
 * ONLY evidence there is — the CLI never writes a `result` record into the
 * session transcript, and a pane-less host has no composer for the scanner to
 * observe either. The migration coordinator's authoritative transcript
 * projection therefore reads a finished structured turn as busy forever, which
 * left "Account switch pending — after current turn" up after the turn ended
 * and every queued send stranded behind it.
 *
 * The release is durable and fenced twice over: it is written only while a
 * switch is pending, and only on top of the turn observation it was derived
 * from, so a turn that started again in the meantime keeps its busy
 * projection. Returns whether the release landed — the caller decides whether
 * to wake the migration controller.
 */
export function releaseStructuredTurnForPendingSwitch(
  conversationId: string,
  dependencies: StructuredTurnReleaseDependencies = {},
): boolean {
  if (!conversationId.startsWith("conversation_")) return false;
  const registry = dependencies.registry ?? agentRegistry();
  const conversation = registry.conversation(registry.canonicalConversationId(conversationId as ViewerConversationId));
  const migration = conversation?.migration;
  if (!conversation || !migration || !AWAITING_SOURCE_TURN.has(migration.phase)) return false;
  const source = conversation.generations.find((generation) => generation.id === migration.sourceGenerationId)
    ?? conversation.generations.at(-1);
  if (!source) return false;
  const observedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  registry.reconcileConversations([{
    engine: conversation.engine,
    path: source.path,
    accountId: source.accountId,
    launchProfile: source.launchProfile,
    turn: { state: "terminal", source: "lifecycle", terminalAt: observedAt },
    expectedTurnObservedAt: conversation.turn.observedAt,
    observedAt,
  }]);
  const released = registry.conversation(conversation.id);
  return released?.turn.state === "terminal" && released.turn.source === "lifecycle";
}
