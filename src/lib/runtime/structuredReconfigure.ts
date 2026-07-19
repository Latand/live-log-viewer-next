import { accountManager } from "@/lib/accounts/manager";
import { advanceConversationMigration } from "@/lib/accounts/migration/coordinator";
import { RegisteredSuccessorProvider } from "@/lib/accounts/migration/provider";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { agentRegistry, type AgentRegistry, type RegistryConversation } from "@/lib/agent/registry";
import type { SessionKey } from "@/lib/agent/sessionKey";

import type { StructuredReconfigureEffect } from "./structuredDeliveryQueue";
import { recoverDeadStructuredConversation } from "./structuredRecovery";

export type StructuredReconfigureOutcome = "applied" | "pending";

async function releaseStructuredHost(key: SessionKey): Promise<boolean> {
  const { releaseStructuredDeliveryHost } = await import("./structuredDeliveryController");
  return await releaseStructuredDeliveryHost(key);
}

interface StructuredReconfigureDependencies {
  registry?: AgentRegistry;
  validateAccount?: (engine: "claude" | "codex", accountId: string) => Promise<void>;
  resolveAccount?: typeof accountManager.resolveSpawn;
  releaseHost?: (key: SessionKey) => Promise<boolean>;
  recover?: typeof recoverDeadStructuredConversation;
  migrate?: (
    conversationId: ViewerConversationId,
    targetAccountId: string,
    registry: AgentRegistry,
  ) => Promise<RegistryConversation>;
}

async function validateAccountAuthentication(engine: "claude" | "codex", accountId: string): Promise<void> {
  const account = await accountManager.status(engine, accountId, true);
  if (account.auth.state !== "authenticated") throw new Error(`${engine} account requires authentication`);
}

async function migrateConversation(
  conversationId: ViewerConversationId,
  targetAccountId: string,
  registry: AgentRegistry,
): Promise<RegistryConversation> {
  registry.requestConversationReseat(conversationId, targetAccountId);
  /* The established provider keeps one Viewer conversation identity while it
     creates an account-owned resume artifact. Codex forks the rollout under
     the target sessions root; Claude resumes the same native session id under
     the target config root. Registry continuity paths keep scanner output on
     the existing card, lineage edge, and task assignments. */
  return await advanceConversationMigration(
    conversationId,
    registry,
    new RegisteredSuccessorProvider(),
  );
}

function profilePatch(effect: StructuredReconfigureEffect) {
  return { model: effect.model, effort: effect.effort, fast: effect.fast };
}

export async function applyStructuredReconfigure(
  effect: StructuredReconfigureEffect,
  dependencies: StructuredReconfigureDependencies = {},
): Promise<StructuredReconfigureOutcome> {
  const registry = dependencies.registry ?? agentRegistry();
  const conversationId = effect.conversationId as ViewerConversationId;
  const conversation = registry.conversation(conversationId);
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) throw new Error("viewer conversation is unknown");
  const key = { engine: conversation.engine, sessionId: generation.id } as const;
  const previousProfile = effect.previousProfile
    ? { ...generation.launchProfile, ...effect.previousProfile }
    : generation.launchProfile;
  const targetAccountId = effect.accountId ?? generation.accountId;
  const switchingAccount = Boolean(effect.accountId && effect.accountId !== generation.accountId);

  if (switchingAccount) {
    await (dependencies.validateAccount ?? validateAccountAuthentication)(conversation.engine, targetAccountId!);
    (dependencies.resolveAccount ?? accountManager.resolveSpawn)(conversation.engine, targetAccountId);
  }
  registry.updateConversationLaunchProfile(conversationId, profilePatch(effect));

  if (effect.accountId
    && effect.accountId === generation.accountId
    && conversation.migration?.phase === "committed") {
    const predecessor = conversation.generations.at(-2);
    if (predecessor) {
      const predecessorKey = { engine: conversation.engine, sessionId: predecessor.id } as const;
      await (dependencies.releaseHost ?? releaseStructuredHost)(predecessorKey);
      registry.terminateStructuredHost(predecessorKey);
    }
    return "applied";
  }

  if (switchingAccount) {
    let migrated: RegistryConversation;
    try {
      migrated = await (dependencies.migrate ?? migrateConversation)(
        conversationId,
        targetAccountId!,
        registry,
      );
    } catch (error) {
      registry.updateConversationLaunchProfile(conversationId, previousProfile);
      throw error;
    }
    const current = migrated.generations.at(-1);
    if (migrated.migration?.phase === "failed-recoverable") {
      registry.updateConversationLaunchProfile(conversationId, previousProfile);
      throw new Error(migrated.migration.error ?? "account switch failed");
    }
    if (current?.accountId !== targetAccountId || migrated.migration?.phase !== "committed") {
      return "pending";
    }
    await (dependencies.releaseHost ?? releaseStructuredHost)(key);
    registry.terminateStructuredHost(key);
    return "applied";
  }

  const release = dependencies.releaseHost ?? releaseStructuredHost;
  const recover = dependencies.recover ?? recoverDeadStructuredConversation;
  await release(key);
  registry.terminateStructuredHost(key);
  try {
    const recovered = await recover({ path: generation.path, conversationId }, { registry });
    if (!recovered) throw new Error("structured conversation recovery is unavailable");
    return "applied";
  } catch (error) {
    registry.updateConversationLaunchProfile(conversationId, previousProfile);
    await recover({ path: generation.path, conversationId }, { registry }).catch(() => null);
    throw error;
  }
}
