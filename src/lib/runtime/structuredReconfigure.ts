import { accountManager } from "@/lib/accounts/manager";
import { advanceConversationMigration } from "@/lib/accounts/migration/coordinator";
import { RegisteredSuccessorProvider } from "@/lib/accounts/migration/provider";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { agentRegistry, type AgentRegistry, type RegistryConversation } from "@/lib/agent/registry";
import type { SessionKey } from "@/lib/agent/sessionKey";

import type { StructuredReconfigureEffect } from "./structuredDeliveryQueue";
import { recoverDeadStructuredConversation } from "./structuredRecovery";

export type StructuredReconfigureOutcome = "applied" | "pending";

class StructuredReconfigureSupersededError extends Error {
  constructor() {
    super("superseded");
    this.name = "StructuredReconfigureSupersededError";
  }
}

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
  ownsOperation?: () => Promise<boolean>;
  migrate?: (
    conversationId: ViewerConversationId,
    targetAccountId: string,
    registry: AgentRegistry,
    ownsOperation: () => Promise<boolean>,
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
  ownsOperation: () => Promise<boolean>,
): Promise<RegistryConversation> {
  /* The established provider keeps one Viewer conversation identity while it
     creates an account-owned resume artifact. Codex forks the rollout under
     the target sessions root; Claude resumes the same native session id under
     the target config root. Registry continuity paths keep scanner output on
     the existing card, lineage edge, and task assignments. */
  return await advanceConversationMigration(
    conversationId,
    registry,
    new RegisteredSuccessorProvider(),
    { ownsOperation },
  );
}

function profilePatch(effect: StructuredReconfigureEffect) {
  return { model: effect.model, effort: effect.effort, fast: effect.fast };
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const targetAccountId = effect.accountId ?? generation.accountId;
  const switchingAccount = Boolean(effect.accountId && effect.accountId !== generation.accountId);
  const ownsOperation = dependencies.ownsOperation ?? (async () => true);
  const release = dependencies.releaseHost ?? releaseStructuredHost;
  const recover = dependencies.recover ?? recoverDeadStructuredConversation;
  const inheritedApplyingOperation = conversation.reconfigure?.status === "applying";

  if (!await ownsOperation()) throw new StructuredReconfigureSupersededError();
  const claim = registry.claimConversationReconfigure(conversationId, {
    operationId: effect.operationId,
    revision: effect.eventSeq,
    profile: profilePatch(effect),
    ...(effect.previousProfile ? { previousProfile: effect.previousProfile } : {}),
    ...(effect.accountId ? { accountId: effect.accountId } : {}),
  });
  if (claim.kind === "stale") throw new StructuredReconfigureSupersededError();
  if (claim.state.status === "applied") return "applied";
  if (claim.state.status === "failed") throw new Error(claim.state.error ?? "structured reconfigure failed");

  const settle = async (status: "applied" | "failed", error: unknown = null): Promise<void> => {
    if (!await ownsOperation()) throw new StructuredReconfigureSupersededError();
    const settled = registry.settleConversationReconfigure(
      conversationId,
      effect.operationId,
      effect.eventSeq,
      status,
      status === "failed" ? failureMessage(error) : null,
    );
    if (settled.kind === "stale") throw new StructuredReconfigureSupersededError();
  };

  const ownsDurableReconfigure = async (status: "applying" | "failed"): Promise<boolean> => {
    if (!await ownsOperation()) return false;
    const owner = registry.conversation(conversationId)?.reconfigure;
    return owner?.operationId === effect.operationId
      && owner.revision === effect.eventSeq
      && owner.status === status;
  };

  const recoveryOwnership = (status: "applying" | "failed") => ({
    operationId: effect.operationId,
    revision: effect.eventSeq,
    owns: () => ownsDurableReconfigure(status),
    releaseHost: release,
  });

  if (switchingAccount) {
    try {
      await (dependencies.validateAccount ?? validateAccountAuthentication)(conversation.engine, targetAccountId!);
      (dependencies.resolveAccount ?? accountManager.resolveSpawn)(conversation.engine, targetAccountId);
    } catch (error) {
      await settle("failed", error);
      if (inheritedApplyingOperation) {
        const restored = await recover({ path: generation.path, conversationId }, {
          registry,
          ownership: recoveryOwnership("failed"),
        });
        if (!restored) throw new Error("structured conversation preflight rollback recovery is unavailable");
      }
      throw error;
    }
  }

  const restoreCommittedSuccessor = async (successorId: string): Promise<void> => {
    if (!await ownsDurableReconfigure("failed")) throw new StructuredReconfigureSupersededError();
    const latest = registry.conversation(conversationId);
    const successor = latest?.generations.at(-1);
    if (!latest || latest.migration?.phase !== "committed" || successor?.id !== successorId) {
      throw new Error("committed structured successor is unavailable for profile restoration");
    }
    const successorKey = { engine: latest.engine, sessionId: successor.id } as const;
    await release(successorKey);
    if (!await ownsDurableReconfigure("failed")) throw new StructuredReconfigureSupersededError();
    registry.terminateStructuredHost(successorKey);
    if (!await ownsDurableReconfigure("failed")) throw new StructuredReconfigureSupersededError();
    const restored = await recover({ path: successor.path, conversationId }, {
      registry,
      ownership: recoveryOwnership("failed"),
    });
    if (!restored) throw new Error("structured successor profile restoration is unavailable");
    if (!await ownsDurableReconfigure("failed")) throw new StructuredReconfigureSupersededError();
  };

  if (effect.accountId
    && effect.accountId === generation.accountId
    && conversation.migration?.phase === "committed") {
    try {
      const predecessor = conversation.generations.at(-2);
      if (predecessor) {
        const predecessorKey = { engine: conversation.engine, sessionId: predecessor.id } as const;
        await release(predecessorKey);
        registry.terminateStructuredHost(predecessorKey);
      }
      if (!await ownsDurableReconfigure("applying")) throw new StructuredReconfigureSupersededError();
      await release(key);
      if (!await ownsDurableReconfigure("applying")) throw new StructuredReconfigureSupersededError();
      registry.terminateStructuredHost(key);
      if (!await ownsDurableReconfigure("applying")) throw new StructuredReconfigureSupersededError();
      const recovered = await recover({ path: generation.path, conversationId }, {
        registry,
        ownership: recoveryOwnership("applying"),
      });
      if (!recovered) throw new Error("structured successor profile application is unavailable");
      if (!await ownsDurableReconfigure("applying")) throw new StructuredReconfigureSupersededError();
      await settle("applied");
      return "applied";
    } catch (error) {
      if (error instanceof StructuredReconfigureSupersededError) throw error;
      await settle("failed", error);
      await restoreCommittedSuccessor(generation.id);
      throw error;
    }
  }

  if (switchingAccount) {
    registry.requestConversationReseat(conversationId, targetAccountId!, {
      operationId: effect.operationId,
      revision: effect.eventSeq,
    });
    const committedSuccessorAfterCapturedPredecessor = (): RegistryConversation["generations"][number] | null => {
      const latest = registry.conversation(conversationId);
      if (!latest) return null;
      const predecessorIndex = latest.generations.findIndex((candidate) =>
        candidate.id === generation.id && candidate.path === generation.path);
      const predecessor = latest.generations[predecessorIndex];
      const successor = latest.generations[predecessorIndex + 1];
      const current = latest.generations.at(-1);
      if (predecessorIndex < 0
        || !predecessor
        || predecessor.archivedAt === null
        || !successor
        || successor.accountId !== targetAccountId
        || !current
        || (current.id === predecessor.id && current.path === predecessor.path)) return null;
      return successor;
    };
    const cleanupCommittedPredecessorAfterSupersedence = async (): Promise<void> => {
      const successor = committedSuccessorAfterCapturedPredecessor();
      if (!successor) return;
      await release(key);
      const confirmed = committedSuccessorAfterCapturedPredecessor();
      if (!confirmed || confirmed.id !== successor.id || confirmed.path !== successor.path) return;
      registry.terminateStructuredHost(key);
    };
    let committedSuccessorId: string | null = null;
    try {
      const migrated: RegistryConversation = await (dependencies.migrate ?? migrateConversation)(
        conversationId,
        targetAccountId!,
        registry,
        ownsOperation,
      );
      const owner = registry.conversation(conversationId)?.reconfigure;
      if (!await ownsOperation()
        || owner?.operationId !== effect.operationId || owner.revision !== effect.eventSeq) {
        await cleanupCommittedPredecessorAfterSupersedence();
        throw new StructuredReconfigureSupersededError();
      }
      const current = migrated.generations.at(-1);
      if (migrated.migration?.phase === "failed-recoverable") {
        throw new Error(migrated.migration.error ?? "account switch failed");
      }
      if (current?.accountId !== targetAccountId || migrated.migration?.phase !== "committed") {
        return "pending";
      }
      committedSuccessorId = current.id;
      await release(key);
      registry.terminateStructuredHost(key);
      await settle("applied");
      return "applied";
    } catch (error) {
      if (error instanceof StructuredReconfigureSupersededError) throw error;
      await settle("failed", error);
      if (committedSuccessorId) await restoreCommittedSuccessor(committedSuccessorId);
      throw error;
    }
  }

  try {
    if (!await ownsDurableReconfigure("applying")) throw new StructuredReconfigureSupersededError();
    await release(key);
    if (!await ownsDurableReconfigure("applying")) throw new StructuredReconfigureSupersededError();
    registry.terminateStructuredHost(key);
    if (!await ownsDurableReconfigure("applying")) throw new StructuredReconfigureSupersededError();
    const recovered = await recover({ path: generation.path, conversationId }, {
      registry,
      ownership: recoveryOwnership("applying"),
    });
    if (!recovered) throw new Error("structured conversation recovery is unavailable");
    if (!await ownsDurableReconfigure("applying")) throw new StructuredReconfigureSupersededError();
    await settle("applied");
    return "applied";
  } catch (error) {
    if (error instanceof StructuredReconfigureSupersededError) throw error;
    await settle("failed", error);
    await recover({ path: generation.path, conversationId }, {
      registry,
      ownership: recoveryOwnership("failed"),
    }).catch(() => null);
    throw error;
  }
}
