import { agentRegistry } from "@/lib/agent/registry";
import { listClaudeAccounts } from "@/lib/accounts/claude";
import { listCodexAccounts } from "@/lib/accounts/codex";
import { conversationProjectKey } from "@/lib/accounts/conversationProject";
import {
  AccountProjectBindingsUnreadableError,
  allowedAccountIdsForProject,
  projectAccountRefusalDetail,
} from "@/lib/accounts/projectBindings";
import { chooseProjectReseatTarget } from "@/lib/accounts/reseat";
import { headCwd } from "@/lib/agent/transcript";

import { advanceConversationMigration, drainHeldDeliveries } from "./coordinator";
import { createMigrationDeliveryPort } from "./deliveryPort";
import { authorizeCodexForkRetry, RegisteredSuccessorProvider } from "./provider";
import type { SuccessorProviderPort, ViewerConversationId } from "./contracts";

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

export interface ConversationMigrationCommandDependencies {
  registry?: typeof agentRegistry;
  provider?: () => SuccessorProviderPort;
  authorizeForkRetry?: typeof authorizeCodexForkRetry;
}

const deliveryPort = createMigrationDeliveryPort();
const IN_FLIGHT_PHASES = new Set(["requested", "waiting-turn", "preparing", "successor-starting", "verifying"]);

export async function applyConversationMigration(
  command: ConversationMigrationCommand,
  dependencies: ConversationMigrationCommandDependencies = {},
): Promise<ConversationMigrationCommandResult> {
  const registryForCommand = dependencies.registry ?? agentRegistry;
  const providerForCommand = dependencies.provider ?? (() => new RegisteredSuccessorProvider());
  const authorizeForkRetry = dependencies.authorizeForkRetry ?? authorizeCodexForkRetry;
  if (!command.conversationId.startsWith("conversation_")) {
    return { status: 400, body: { error: "invalid conversation id" } };
  }
  const conversationId = command.conversationId as ViewerConversationId;
  if (command.action === "reseat") {
    if (command.path !== undefined && typeof command.path !== "string") {
      return { status: 400, body: { error: "path must be a string" } };
    }
    const registry = registryForCommand();
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
    /* #1279: a reseat is a selection for this conversation's project's work, so
       it obeys the project's binding like every launch does. An unbound project
       answers null here and every branch below is what it always was; a bound
       project whose allowed accounts all lack headroom is REPORTED rather than
       reseated onto the idle account it forbids. */
    const project = conversationProjectKey(conversation.projectOwnership, source.launchProfile, {
      /* Same reason as the reconfigure seam: an adopted conversation has an
         empty profile, and its transcript head still names the cwd it runs in. */
      cwd: headCwd(source.path),
    });
    /* A record that cannot be read is this contract's own refusal, not an
       unhandled failure: the reseat has queued nothing, and the operator is
       told which record to repair. */
    let allowedAccountIds: string[] | null;
    try {
      allowedAccountIds = allowedAccountIdsForProject(project, conversation.engine);
    } catch (error) {
      if (!(error instanceof AccountProjectBindingsUnreadableError)) throw error;
      return { status: 409, body: { error: error.message, project } };
    }
    const selection = chooseProjectReseatTarget(
      source.accountId,
      registry.quotaObservations(conversation.engine),
      accounts,
      allowedAccountIds,
    );
    if (selection.kind === "none") {
      return { status: 409, body: { error: "no healthy account with fresh quota headroom is available" } };
    }
    if (selection.kind === "fenced") {
      return {
        status: 409,
        body: {
          error: projectAccountRefusalDetail(
            { kind: "exhausted", resetsAt: null, allowedAccountIds: selection.allowedAccountIds },
            conversation.engine,
            project ?? "",
          ),
          project,
          allowedAccountIds: selection.allowedAccountIds,
        },
      };
    }
    const target = selection.target;
    const requested = registry.requestConversationReseat(conversationId, target.accountId);
    let final = requested;
    if (requested.migration) {
      try {
        final = await advanceConversationMigration(conversationId, registry, providerForCommand());
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
      const registry = registryForCommand();
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
      const registry = registryForCommand();
      const failed = registry.conversation(conversationId);
      const migration = failed?.migration;
      if (!failed || !migration) throw new Error("conversation has no migration");
      if (migration.revision !== command.expectedRevision) throw new Error("migration revision is stale");
      if (failed.engine === "codex"
        && migration.phase === "failed-recoverable"
        && migration.errorCode === "codex-fork-outcome-unknown") {
        await authorizeForkRetry(migration.operationId, failed.id);
      }
      registry.retryConversationMigration(conversationId, command.expectedRevision);
      const conversation = await advanceConversationMigration(conversationId, registry, providerForCommand());
      if (conversation.migration?.phase === "committed") await drainHeldDeliveries(conversation.id, deliveryPort, registry);
      return { status: 200, body: conversation as unknown as Record<string, unknown> };
    } catch {
      return { status: 409, body: { error: "migration retry failed a recoverable preflight" } };
    }
  }
  return { status: 400, body: { error: "unsupported conversation migration action" } };
}
