import { activeClaudeAccountId, setActiveClaudeAccount } from "@/lib/accounts/claude";
import { activeCodexAccountId, codexAccountsMutationLocked, codexLoginPaneStatus, listCodexAccounts, setActiveCodexAccount, setCodexAccountLoginPane } from "@/lib/accounts/codex";
import { managedCodexRuntime } from "@/lib/accounts/codexRuntime";
import { withAccountMutationLock } from "@/lib/accounts/accountMutation";
import { agentRegistry, conversationLookupFromSnapshot, type AgentRegistry } from "@/lib/agent/registry";
import { readTranscriptHosts } from "@/lib/agent/transcriptHost";
import { deliverConversationMessage, migrationDeliveryOutcome } from "@/lib/delivery";
import { reconcileFlowConversationOwnership } from "@/lib/flows/store";
import { reconcileHandoffConversationOwnership } from "@/lib/handoffLineage";
import { listFilesWithProjectCatalog, reconcileFileControllers } from "@/lib/scanner";
import { pidAlive, readPpid } from "@/lib/scanner/process";
import { runReaperCycle } from "@/lib/reaperRuntime";
import { pathForPanePid, reconcileTasks } from "@/lib/tasks/reconcile";
import { mutateTasks } from "@/lib/tasks/store";
import { reconcileWorkflowConversationOwnership } from "@/lib/workflows/store";
import { paneInfo } from "@/lib/tmux";

import { drainHeldDeliveries, reconcileMigrationInventory, reconcileMigrations, type HeldDeliveryPort } from "./coordinator";
import { registerAccountMigrationTick } from "./controllerSignal";
import type { SuccessorProviderPort } from "./contracts";
import { RegisteredSuccessorProvider } from "./provider";
import { QuotaController } from "./quotaController";

const CONTROLLER_INTERVAL_MS = 60_000;
const INITIAL_INVENTORY_DELAY_MS = 1_000;

function yieldToRuntime(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const deliveryPort: HeldDeliveryPort = {
  async deliver({ delivery, path, clientMessageId }) {
    const result = await deliverConversationMessage({ pid: null, path, text: delivery.text, images: [], clientMessageId, reservedDeliveryId: delivery.id });
    return migrationDeliveryOutcome(result);
  },
};

export async function reconcileAccountMigrationCycle(
  registry: AgentRegistry,
  quota: Pick<QuotaController, "tick">,
  provider: SuccessorProviderPort = new RegisteredSuccessorProvider(),
  delivery: HeldDeliveryPort = deliveryPort,
): Promise<void> {
  registry.compactDeliveryReservations();
  await yieldToRuntime();
  await reconcileMigrations(provider, delivery, registry);
  await yieldToRuntime();
  for (const conversation of Object.values(registry.snapshot().conversations)) {
    if (conversation.migration?.phase === "rolled-back") await drainHeldDeliveries(conversation.id, delivery, registry);
  }
  await yieldToRuntime();
  await Promise.all([quota.tick("claude"), quota.tick("codex")]);
}

export function syncCompatibilityRouting(registry: AgentRegistry): void {
  const current = registry.snapshot().engineRouting;
  const claudeNeedsSync = (() => {
    try { return Boolean(current.claude.activeAccountId && current.claude.activeAccountId !== activeClaudeAccountId()); }
    catch { return true; }
  })();
  const codexNeedsSync = (() => {
    try { return Boolean(current.codex.activeAccountId && current.codex.activeAccountId !== activeCodexAccountId()); }
    catch { return true; }
  })();
  if (!claudeNeedsSync && !codexNeedsSync) return;
  withAccountMutationLock(() => {
    const snapshot = registry.snapshot();
    const claude = snapshot.engineRouting.claude.activeAccountId;
    const codex = snapshot.engineRouting.codex.activeAccountId;
    try { if (claude && claude !== activeClaudeAccountId()) setActiveClaudeAccount(claude); } catch { /* registry routing stays authoritative */ }
    try { if (codex && codex !== activeCodexAccountId()) setActiveCodexAccount(codex); } catch { /* registry routing stays authoritative */ }
  });
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
  private trailingCycleRequested = false;

  constructor(
    private readonly registry: AgentRegistry = agentRegistry(),
    private readonly quota = new QuotaController(registry),
    private readonly cycle: (() => Promise<void>) | null = null,
  ) {}

  tick(): Promise<void> {
    if (this.running) {
      this.trailingCycleRequested = true;
      return this.running;
    }
    this.running = this.runRequestedCycles().finally(() => { this.running = null; });
    return this.running;
  }

  poll(): Promise<void> {
    if (this.running) return this.running;
    return this.tick();
  }

  private async runRequestedCycles(): Promise<void> {
    let failure: unknown = null;
    do {
      this.trailingCycleRequested = false;
      try { await (this.cycle?.() ?? this.run()); }
      catch (error) { failure ??= error; }
    } while (this.trailingCycleRequested);
    if (failure) throw failure;
  }

  private async run(): Promise<void> {
    const { files } = await listFilesWithProjectCatalog(undefined, { persist: true });
    await yieldToRuntime();
    const inventorySnapshot = await reconcileMigrationInventory(this.registry, files);
    await yieldToRuntime();
    const inventoryLookup = conversationLookupFromSnapshot(inventorySnapshot);
    reconcileFlowConversationOwnership(inventoryLookup);
    reconcileWorkflowConversationOwnership(inventoryLookup);
    reconcileHandoffConversationOwnership(inventoryLookup);
    await yieldToRuntime();
    await reconcileFileControllers(files);
    await yieldToRuntime();
    await reconcileAccountLogins();
    const transcriptHosts = await readTranscriptHosts(true);
    try {
      await runReaperCycle({ registry: this.registry, hosts: transcriptHosts.hosts, files });
    } catch {
      console.error("[agent reaper] lifecycle reconciliation failed");
    }
    await yieldToRuntime();
    const currentLookup = conversationLookupFromSnapshot(this.registry.snapshot());
    mutateTasks((current) => {
      const reconciled = reconcileTasks(files, current, {
        pathForPanePid: (panePid, entries) => pathForPanePid(entries, panePid, readPpid),
        panePidAlive: pidAlive,
        conversationIdForPath: (pathname) => currentLookup.conversationForPath(pathname)?.id ?? null,
        canonicalConversationId: (conversationId) => conversationId.startsWith("conversation_")
          ? currentLookup.canonicalConversationId(conversationId as `conversation_${string}`)
          : null,
        pathForConversationId: (conversationId) => conversationId.startsWith("conversation_")
          ? currentLookup.conversation(conversationId as `conversation_${string}`)?.generations.at(-1)?.path ?? null
          : null,
      });
      return { tasks: reconciled.dirty ? reconciled.tasks : undefined, result: undefined };
    });
    await yieldToRuntime();
    syncCompatibilityRouting(this.registry);
    await reconcileAccountMigrationCycle(this.registry, this.quota);
  }
}

const globalController = globalThis as unknown as {
  __llvAccountMigrationController?: AccountMigrationController;
  __llvAccountMigrationFastController?: AccountMigrationController;
  __llvAccountMigrationTimer?: ReturnType<typeof setInterval>;
  __llvAccountMigrationInitialTimer?: ReturnType<typeof setTimeout>;
  __llvAccountMigrationBootstrapStarted?: boolean;
};

export async function startAccountMigrationController(): Promise<void> {
  const registry = agentRegistry();
  const quota = new QuotaController(registry);
  const controller = globalController.__llvAccountMigrationController ??= new AccountMigrationController(registry, quota);
  const fastController = globalController.__llvAccountMigrationFastController ??= new AccountMigrationController(
    registry,
    quota,
    () => reconcileAccountMigrationCycle(registry, quota),
  );
  registerAccountMigrationTick(() => fastController.tick());
  if (!globalController.__llvAccountMigrationTimer) {
    const timer = setInterval(() => void controller.poll().catch(() => {
      console.error("[account migration controller] durable reconciliation tick failed");
    }), CONTROLLER_INTERVAL_MS);
    timer.unref?.();
    globalController.__llvAccountMigrationTimer = timer;
  }
  if (!globalController.__llvAccountMigrationBootstrapStarted) {
    globalController.__llvAccountMigrationBootstrapStarted = true;
    void fastController.tick().catch(() => {
      console.error("[account migration controller] initial durable reconciliation failed");
    }).finally(() => {
      const timer = setTimeout(() => {
        globalController.__llvAccountMigrationInitialTimer = undefined;
        void controller.poll().catch(() => {
          console.error("[account migration controller] initial inventory reconciliation failed");
        });
      }, INITIAL_INVENTORY_DELAY_MS);
      timer.unref?.();
      globalController.__llvAccountMigrationInitialTimer = timer;
    });
  }
}
