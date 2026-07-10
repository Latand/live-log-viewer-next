import { activeClaudeAccountId, setActiveClaudeAccount } from "@/lib/accounts/claude";
import { activeCodexAccountId, codexAccountsMutationLocked, codexLoginPaneStatus, listCodexAccounts, setActiveCodexAccount, setCodexAccountLoginPane } from "@/lib/accounts/codex";
import { managedCodexRuntime } from "@/lib/accounts/codexRuntime";
import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { readTranscriptHosts } from "@/lib/agent/transcriptHost";
import { deliverConversationMessage } from "@/lib/delivery";
import { reconcileFlowConversationOwnership } from "@/lib/flows/store";
import { reconcileHandoffConversationOwnership } from "@/lib/handoffLineage";
import { listFilesWithProjectCatalog, reconcileFileControllers } from "@/lib/scanner";
import { pidAlive, readPpid } from "@/lib/scanner/process";
import { pathForPanePid, reconcileTasks } from "@/lib/tasks/reconcile";
import { mutateTasks } from "@/lib/tasks/store";
import { reconcileWorkflowConversationOwnership } from "@/lib/workflows/store";
import { paneInfo } from "@/lib/tmux";

import { drainHeldDeliveries, reconcileMigrationInventory, reconcileMigrations, type HeldDeliveryPort } from "./coordinator";
import { accountMigrationActivationEnabled, RegisteredSuccessorProvider } from "./provider";
import { autoBalanceActivationEnabled, QuotaController } from "./quotaController";

const CONTROLLER_INTERVAL_MS = 10_000;

const deliveryPort: HeldDeliveryPort = {
  async deliver({ delivery, path, clientMessageId }) {
    const result = await deliverConversationMessage({ pid: null, path, text: delivery.text, images: [], clientMessageId });
    if (!result.ok) return "failed";
    return "delivered";
  },
};

function syncCompatibilityRouting(registry: AgentRegistry): void {
  const snapshot = registry.snapshot();
  const claude = snapshot.engineRouting.claude.activeAccountId;
  const codex = snapshot.engineRouting.codex.activeAccountId;
  try { if (claude && claude !== activeClaudeAccountId()) setActiveClaudeAccount(claude); } catch { /* registry routing stays authoritative */ }
  try { if (codex && codex !== activeCodexAccountId()) setActiveCodexAccount(codex); } catch { /* registry routing stays authoritative */ }
}

async function reconcileAccountLogins(): Promise<void> {
  const mutationLocked = codexAccountsMutationLocked();
  await Promise.all(listCodexAccounts().map(async (account) => {
    if (account.kind === "managed") {
      if (account.loginPane && !mutationLocked) setCodexAccountLoginPane(account.id, null);
      if (managedCodexRuntime().peekLogin(account).attemptState) await managedCodexRuntime().loginSnapshot(account);
      return;
    }
    if (!account.loginPane) return;
    const pane = await paneInfo(account.loginPane.paneId);
    const status = codexLoginPaneStatus(account.authPresent, account.loginPane, pane);
    if (status.clear && !mutationLocked) setCodexAccountLoginPane(account.id, null);
  }));
}

export class AccountMigrationController {
  private running: Promise<void> | null = null;

  constructor(
    private readonly registry: AgentRegistry = agentRegistry(),
    private readonly quota = new QuotaController(registry),
  ) {}

  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }

  private async run(): Promise<void> {
    const { files } = await listFilesWithProjectCatalog(undefined, { persistCatalog: true });
    await reconcileMigrationInventory(this.registry, files);
    reconcileFlowConversationOwnership(this.registry);
    reconcileWorkflowConversationOwnership(this.registry);
    reconcileHandoffConversationOwnership(this.registry);
    await reconcileFileControllers(files);
    await reconcileAccountLogins();
    await readTranscriptHosts(true);
    mutateTasks((current) => {
      const reconciled = reconcileTasks(files, current, {
        pathForPanePid: (panePid, entries) => pathForPanePid(entries, panePid, readPpid),
        panePidAlive: pidAlive,
        conversationIdForPath: (pathname) => this.registry.conversationForPath(pathname)?.id ?? null,
        pathForConversationId: (conversationId) => conversationId.startsWith("conversation_")
          ? this.registry.conversation(conversationId as `conversation_${string}`)?.generations.at(-1)?.path ?? null
          : null,
      });
      return { tasks: reconciled.dirty ? reconciled.tasks : undefined, result: undefined };
    });
    syncCompatibilityRouting(this.registry);
    if (accountMigrationActivationEnabled()) {
      await reconcileMigrations(new RegisteredSuccessorProvider(), deliveryPort, this.registry);
      for (const conversation of Object.values(this.registry.snapshot().conversations)) {
        if (conversation.migration?.phase === "rolled-back") await drainHeldDeliveries(conversation.id, deliveryPort, this.registry);
      }
    }
    if (autoBalanceActivationEnabled()) await Promise.all([this.quota.tick("claude"), this.quota.tick("codex")]);
  }
}

const globalController = globalThis as unknown as {
  __llvAccountMigrationController?: AccountMigrationController;
  __llvAccountMigrationTimer?: ReturnType<typeof setInterval>;
};

export async function startAccountMigrationController(): Promise<void> {
  const controller = globalController.__llvAccountMigrationController ??= new AccountMigrationController();
  if (!globalController.__llvAccountMigrationTimer) {
    const timer = setInterval(() => void controller.tick().catch(() => {
      console.error("[account migration controller] durable reconciliation tick failed");
    }), CONTROLLER_INTERVAL_MS);
    timer.unref?.();
    globalController.__llvAccountMigrationTimer = timer;
  }
  await controller.tick();
}
