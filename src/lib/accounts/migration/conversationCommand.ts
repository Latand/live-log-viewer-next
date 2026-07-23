import { agentRegistry } from "@/lib/agent/registry";
import { listClaudeAccounts } from "@/lib/accounts/claude";
import { listCodexAccounts } from "@/lib/accounts/codex";
import { chooseReseatTarget } from "@/lib/accounts/reseat";

import { advanceConversationMigration, drainHeldDeliveries } from "./coordinator";
import { createMigrationDeliveryPort } from "./deliveryPort";
import { RegisteredSuccessorProvider } from "./provider";
import type { ViewerConversationId } from "./contracts";

export type ConversationMigrationCommand = {
  conversationId: string;
  action: string;
  expectedRevision?: number;
  path?: string;
};

export type ConversationMigrationCommandResult = {
  status: number;
  body: Record<string, unknown>;
};

const deliveryPort = createMigrationDeliveryPort();
const IN_FLIGHT_PHASES = new Set(["requested", "waiting-turn", "preparing", "successor-starting", "verifying"]);

export async function applyConversationMigration(
  command: ConversationMigrationCommand,
): Promise<ConversationMigrationCommandResult> {
  if (!command.conversationId.startsWith("conversation_")) {
    return { status: 400, body: { error: "invalid conversation id" } };
  }
  const conversationId = command.conversationId as ViewerConversationId;
  if (command.action === "reseat") {
    if (command.path !== undefined && typeof command.path !== "string") {
      return { status: 400, body: { error: "path must be a string" } };
    }
    const registry = agentRegistry();
    const conversation = registry.conversation(conversationId);
    if (!conversation) return { status: 404, body: { error: "viewer conversation is unknown" } };
    const source = conversation.generations.at(-1);
    if (!source?.accountId) {
      return { status: 409, body: { error: "conversation has no managed account to reseat from" } };
    }
    if (command.path && command.path !== source.path) {
      return { status: 409, body: { reseat: "already-reseated", error: "a successor already replaced this conversation" } };
    }
    if (conversation.migration && IN_FLIGHT_PHASES.has(conversation.migration.phase)) {
      return { status: 200, body: { reseat: "already-migrating", phase: conversation.migration.phase, conversation } };
    }
    const accounts = conversation.engine === "claude" ? listClaudeAccounts() : listCodexAccounts();
    const target = chooseReseatTarget(source.accountId, registry.quotaObservations(conversation.engine), accounts);
    if (!target) {
      return { status: 409, body: { error: "no healthy account with fresh quota headroom is available" } };
    }
    const requested = registry.requestConversationReseat(conversationId, target.accountId);
    let final = requested;
    if (requested.migration) {
      try {
        final = await advanceConversationMigration(conversationId, registry, new RegisteredSuccessorProvider());
        if (final.migration?.phase === "committed") await drainHeldDeliveries(final.id, deliveryPort, registry);
      } catch {
        final = registry.conversation(conversationId) ?? requested;
      }
    }
    return {
      status: 200,
      body: {
        reseat: "requested",
        phase: final.migration?.phase ?? null,
        targetId: target.accountId,
        targetLabel: target.label,
        conversation: final,
      },
    };
  }

  if (!Number.isInteger(command.expectedRevision) || (command.expectedRevision as number) < 0) {
    return { status: 400, body: { error: "expectedRevision must be a non-negative integer" } };
  }
  if (command.action === "rollback") {
    try {
      const registry = agentRegistry();
      const conversation = registry.rollbackConversationMigration(conversationId, command.expectedRevision);
      await drainHeldDeliveries(conversation.id, deliveryPort, registry);
      return { status: 200, body: conversation as unknown as Record<string, unknown> };
    } catch (error) {
      const conflict = error instanceof Error && error.message.includes("revision");
      return {
        status: conflict ? 409 : 404,
        body: { error: conflict ? "migration revision is stale" : "conversation migration rollback failed" },
      };
    }
  }
  if (command.action === "retry") {
    try {
      const registry = agentRegistry();
      registry.retryConversationMigration(conversationId, command.expectedRevision);
      const conversation = await advanceConversationMigration(conversationId, registry, new RegisteredSuccessorProvider());
      if (conversation.migration?.phase === "committed") await drainHeldDeliveries(conversation.id, deliveryPort, registry);
      return { status: 200, body: conversation as unknown as Record<string, unknown> };
    } catch {
      return { status: 409, body: { error: "migration retry failed a recoverable preflight" } };
    }
  }
  return { status: 400, body: { error: "unsupported conversation migration action" } };
}
