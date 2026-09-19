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

import { runtimeHostClient } from "@/lib/runtime/client";
import type { RuntimeOperationResult } from "@/lib/runtime/contracts";
import { kickStructuredDeliveryQueue } from "@/lib/runtime/structuredDeliverySignal";
import { dispatchStructuredControl } from "@/lib/runtime/structuredControls";

import { advanceConversationMigration, drainHeldDeliveries, type HeldDeliveryPort } from "./coordinator";
import { createMigrationDeliveryPort } from "./deliveryPort";
import { authorizeCodexForkRetry, RegisteredSuccessorProvider } from "./provider";
import type { SuccessorProviderPort, ViewerConversationId } from "./contracts";

export type ConversationMigrationCommand = {
  conversationId: string;
  action: string;
  expectedRevision?: number;
  path?: string;
  /** `withdraw`: the queued reconfigure operation to withdraw. */
  operationId?: unknown;
};

export type ConversationMigrationCommandResult = {
  status: number;
  body: Record<string, unknown>;
};

export interface ConversationMigrationCommandDependencies {
  registry?: typeof agentRegistry;
  provider?: () => SuccessorProviderPort;
  authorizeForkRetry?: typeof authorizeCodexForkRetry;
  deliveryPort?: HeldDeliveryPort;
  /** The runtime journal's record of an operation; `unreadable` when the host could not be asked. */
  operationStatus?: (operationId: string) => Promise<RuntimeOperationResult | null | "unreadable">;
  /** Wakes the structured delivery queue so a cancelled reconfigure settles now. */
  kick?: () => void | Promise<void>;
  /** Records a structured conversation's intended account (#1846). */
  dispatchControl?: typeof dispatchStructuredControl;
}

/* Receipt statuses after which an operation is settled in the journal. */
const SETTLED_OPERATION_STATUSES = new Set(["turn-started", "steered", "delivered", "applied", "interrupted", "answered", "rejected", "failed", "uncertain"]);

async function readRuntimeOperation(operationId: string): Promise<RuntimeOperationResult | null | "unreadable"> {
  const client = runtimeHostClient();
  if (!client) return "unreadable";
  try {
    return await client.operationStatus(operationId);
  } catch {
    return "unreadable";
  }
}

/** Work after a committed write: its failure is left to the next queue or migration pass. */
async function settleAfterCommit(work: () => unknown): Promise<void> {
  try {
    await work();
  } catch {
    // The committed answer stands.
  }
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
      Date.now(),
      source.launchProfile.model,
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
    /* #1846: a structured conversation's reseat is the same account pick the operator makes. It records the
       intended account, and the conversation moves when it is next engaged, through the same rebind. */
    const profile = source.launchProfile;
    const intended = profile.model && profile.effort
      ? await (dependencies.dispatchControl ?? dispatchStructuredControl)({
          path: source.path,
          conversationId,
          action: "reconfigure",
          reconfiguration: { model: profile.model, effort: profile.effort, fast: profile.fast, accountId: target.accountId },
        }, { registry })
      : null;
    if (intended) {
      if (intended.status >= 400) return { status: intended.status, body: intended.body as Record<string, unknown> };
      return {
        status: 200,
        body: {
          reseat: "intended",
          targetId: target.accountId,
          targetLabel: target.label,
          operationId: "operationId" in intended.body ? intended.body.operationId : null,
          conversation: registry.conversation(conversationId) ?? conversation,
        },
      };
    }
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

  if (command.action === "withdraw") {
    /* #1705: a switch the queue has not claimed. Never accepted without the operation, and never touches a migration. */
    if (typeof command.operationId !== "string" || !command.operationId.trim()) {
      return { status: 400, body: { error: "operationId must be a non-empty string" } };
    }
    const operationId = command.operationId.trim();
    const registry = registryForCommand();
    const conversation = registry.conversation(conversationId);
    if (!conversation) return { status: 404, body: { error: "viewer conversation is unknown" } };
    const read = await (dependencies.operationStatus ?? readRuntimeOperation)(operationId);
    if (read === "unreadable") {
      return { status: 503, body: { error: "the runtime host could not be read; nothing was withdrawn", code: "RUNTIME_UNREADABLE" } };
    }
    if (!read
      || read.receipt.kind !== "reconfigure"
      || registry.canonicalConversationId(read.receipt.conversationId as ViewerConversationId) !== conversation.id) {
      return { status: 404, body: { error: "reconfigure operation is unknown for this conversation", code: "OPERATION_UNKNOWN" } };
    }
    if (SETTLED_OPERATION_STATUSES.has(read.receipt.status)) {
      /* The same withdrawal again, after the queue failed the operation it withdrew: the switch is cancelled. */
      if (registry.reconfigureCancelled(conversationId, operationId)) {
        return { status: 200, body: { withdraw: "replayed", conversation: registry.conversation(conversationId) } };
      }
      return { status: 409, body: { error: "the reconfigure has already settled", code: "SWITCH_SETTLED", status: read.receipt.status } };
    }
    const withdrawal = registry.withdrawConversationReconfigure(conversationId, operationId);
    if (withdrawal.kind === "claimed") {
      /* The revision to cancel by exists only once this switch's own migration does. */
      const owned = withdrawal.conversation.reconfigure?.operationId === operationId
        && registry.reconfigureOwnedCancellableSwitch(conversationId);
      return {
        status: 409,
        body: {
          error: "the queue has already claimed this switch; cancel it with the migration's revision",
          code: "SWITCH_CLAIMED",
          expectedRevision: owned ? withdrawal.conversation.migration?.revision ?? null : null,
        },
      };
    }
    if (withdrawal.kind === "settled") {
      return { status: 409, body: { error: "the reconfigure has already settled", code: "SWITCH_SETTLED" } };
    }
    /* The withdrawal is durable; the queue notices it on its next pass even if this kick fails. */
    await settleAfterCommit(() => (dependencies.kick ?? kickStructuredDeliveryQueue)());
    return { status: 200, body: { withdraw: withdrawal.kind, conversation: withdrawal.conversation } };
  }

  if (command.action === "keep-current") {
    /* #1846: messages a failed account switch held go out on the account the conversation runs on. */
    const registry = registryForCommand();
    if (!registry.conversation(conversationId)) return { status: 404, body: { error: "viewer conversation is unknown" } };
    const { released, conversation } = registry.releaseSwitchHold(conversationId);
    await settleAfterCommit(() => (dependencies.kick ?? kickStructuredDeliveryQueue)());
    return { status: 200, body: { keepCurrent: released ? "released" : "nothing-held", conversation } };
  }

  if (!Number.isInteger(command.expectedRevision) || (command.expectedRevision as number) < 0) {
    return { status: 400, body: { error: "expectedRevision must be a non-negative integer" } };
  }
  if (command.action === "cancel"
    || (command.action === "rollback" && registryForCommand().reconfigureOwnedCancellableSwitch(conversationId))) {
    /* #1705: a claimed switch, guarded by revision and phase. A rollback of a reconfigure-owned switch still
       waiting for its turn is this cancel, so the queue cannot request the switch again. */
    const registry = registryForCommand();
    let cancelled;
    try {
      cancelled = registry.cancelConversationSwitch(conversationId, command.expectedRevision as number);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("revision")) return { status: 409, body: { error: "migration revision is stale", code: "MIGRATION_STALE" } };
      if (message.includes("started")) return { status: 409, body: { error: "the switch has already started", code: "SWITCH_STARTED" } };
      if (message.includes("no longer pending")) return { status: 409, body: { error: "the switch is no longer pending", code: "SWITCH_NOT_PENDING" } };
      return { status: 404, body: { error: "conversation has no switch to cancel" } };
    }
    /* The cancel is committed. Kicking the queue and delivering what it re-armed are follow-ups: a failure
       there leaves them to the next pass, and never turns the cancel into a refusal. */
    await settleAfterCommit(() => (dependencies.kick ?? kickStructuredDeliveryQueue)());
    await settleAfterCommit(() => drainHeldDeliveries(cancelled.conversation.id, dependencies.deliveryPort ?? deliveryPort, registry));
    return { status: 200, body: { cancel: cancelled.kind, conversation: cancelled.conversation } };
  }
  if (command.action === "rollback") {
    try {
      const registry = registryForCommand();
      const conversation = registry.rollbackConversationMigration(conversationId, command.expectedRevision);
      await drainHeldDeliveries(conversation.id, dependencies.deliveryPort ?? deliveryPort, registry);
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
