import { activeClaudeAccountId, setActiveClaudeAccount } from "@/lib/accounts/claude";
import { activeCodexAccountId, codexAccountsMutationLocked, codexLoginPaneStatus, listCodexAccounts, setActiveCodexAccount, setCodexAccountLoginPane } from "@/lib/accounts/codex";
import { managedCodexRuntime } from "@/lib/accounts/codexRuntime";
import { withAccountMutationLock } from "@/lib/accounts/accountMutation";
import { agentRegistry, conversationLookupFromSnapshot, type AgentRegistry } from "@/lib/agent/registry";
import { readTranscriptHosts } from "@/lib/agent/transcriptHost";
import { forEachCooperatively, yieldToRuntime } from "@/lib/cooperative";
import { deliverConversationMessage, migrationDeliveryOutcome } from "@/lib/delivery";
import { loadFlows, reconcileFlowConversationOwnershipCooperatively } from "@/lib/flows/store";
import { reconcileHandoffConversationOwnershipCooperatively } from "@/lib/handoffLineage";
import { listFilesWithProjectCatalog, reconcileFileControllers } from "@/lib/scanner";
import { pidAlive, readPpid } from "@/lib/scanner/process";
import { runReaperCycle } from "@/lib/reaperRuntime";
import { runHeadlessProcessReaper } from "@/lib/headlessProcessReaper";
import { deliverHeldStructuredMessage, type HeldStructuredMessageOutcome } from "@/lib/runtime/structuredMessageDelivery";
import { pathForPanePid, reconcileTasks } from "@/lib/tasks/reconcile";
import { mutateTasks } from "@/lib/tasks/store";
import { reconcileWorkflowConversationOwnershipCooperatively } from "@/lib/workflows/store";
import { paneInfo } from "@/lib/tmux";

import { drainHeldDeliveries, reconcileMigrationInventory, reconcileMigrations, type HeldDeliveryPort } from "./coordinator";
import { registerAccountMigrationTick } from "./controllerSignal";
import type { SuccessorProviderPort } from "./contracts";
import { RegisteredSuccessorProvider } from "./provider";
import { QuotaController } from "./quotaController";

const CONTROLLER_INTERVAL_MS = 60_000;
const INITIAL_INVENTORY_DELAY_MS = 1_000;

type HeldDeliveryInput = Parameters<HeldDeliveryPort["deliver"]>[0];

export interface MigrationDeliveryPortDependencies {
  structuredDelivery?: typeof deliverHeldStructuredMessage;
  legacyDelivery?: (input: HeldDeliveryInput) => Promise<Exclude<HeldStructuredMessageOutcome, null> | "held">;
}

export function createMigrationDeliveryPort(
  dependencies: MigrationDeliveryPortDependencies = {},
): HeldDeliveryPort {
  const structuredDelivery = dependencies.structuredDelivery ?? deliverHeldStructuredMessage;
  const legacyDelivery = dependencies.legacyDelivery ?? (async ({ delivery, path, clientMessageId }) => {
    const result = await deliverConversationMessage({ pid: null, path, text: delivery.text, images: [], clientMessageId, reservedDeliveryId: delivery.id });
    return migrationDeliveryOutcome(result);
  });
  const deliverStructured = ({ delivery, path, clientMessageId }: HeldDeliveryInput) => structuredDelivery({
    conversationId: delivery.conversationId,
    path,
    deliveryId: delivery.id,
    clientMessageId,
    text: delivery.text,
  });
  return {
    async deliver(input) {
      const outcome = await deliverStructured(input);
      return outcome ?? legacyDelivery(input);
    },
    async reconcileUncertain(input) {
      return await deliverStructured(input) ?? "delivery-uncertain";
    },
  };
}

const deliveryPort = createMigrationDeliveryPort();

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
  await forEachCooperatively(Object.values(registry.snapshot().conversations), async (conversation) => {
    if (conversation.migration?.phase === "rolled-back") await drainHeldDeliveries(conversation.id, delivery, registry);
  });
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

type InventorySnapshot = Awaited<ReturnType<typeof reconcileMigrationInventory>>;
type ConversationLookup = ReturnType<typeof conversationLookupFromSnapshot>;
type ControllerScan = Awaited<ReturnType<typeof listFilesWithProjectCatalog>>;

export interface AccountMigrationControllerCyclePorts {
  scan: () => ReturnType<typeof listFilesWithProjectCatalog>;
  reconcileInventory: (registry: AgentRegistry, files: ControllerScan["files"]) => Promise<InventorySnapshot>;
  reconcileFlowOwnership: (lookup: ConversationLookup) => Promise<void>;
  reconcileWorkflowOwnership: (lookup: ConversationLookup) => Promise<void>;
  reconcileHandoffOwnership: (lookup: ConversationLookup) => Promise<void>;
  reconcileFiles: typeof reconcileFileControllers;
  reconcileRuntime: (registry: AgentRegistry, files: ControllerScan["files"]) => Promise<void>;
  reconcileTaskStore: (registry: AgentRegistry, files: ControllerScan["files"]) => void | Promise<void>;
  syncRouting: (registry: AgentRegistry) => void | Promise<void>;
  reconcileMigrationCycle: (registry: AgentRegistry, quota: Pick<QuotaController, "tick">) => Promise<void>;
}

async function reconcileControllerRuntime(registry: AgentRegistry, files: ControllerScan["files"]): Promise<void> {
  await reconcileAccountLogins();
  const transcriptHosts = await readTranscriptHosts(true);
  try {
    await runReaperCycle({ registry, hosts: transcriptHosts.hosts, files });
  } catch {
    console.error("[agent reaper] lifecycle reconciliation failed");
  }
  try {
    const report = await runHeadlessProcessReaper({ hosts: transcriptHosts.hosts, flows: loadFlows() });
    if (report.signaled > 0) console.warn(`[headless process reaper] terminated ${report.signaled} stale process group(s)`);
  } catch {
    console.error("[headless process reaper] reconciliation failed");
  }
}

function reconcileControllerTasks(registry: AgentRegistry, files: ControllerScan["files"]): void {
  const currentLookup = conversationLookupFromSnapshot(registry.snapshot());
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
}

const DEFAULT_CONTROLLER_CYCLE_PORTS: AccountMigrationControllerCyclePorts = {
  scan: () => listFilesWithProjectCatalog(undefined, { persist: true }),
  reconcileInventory: reconcileMigrationInventory,
  reconcileFlowOwnership: reconcileFlowConversationOwnershipCooperatively,
  reconcileWorkflowOwnership: reconcileWorkflowConversationOwnershipCooperatively,
  reconcileHandoffOwnership: reconcileHandoffConversationOwnershipCooperatively,
  reconcileFiles: reconcileFileControllers,
  reconcileRuntime: reconcileControllerRuntime,
  reconcileTaskStore: reconcileControllerTasks,
  syncRouting: syncCompatibilityRouting,
  reconcileMigrationCycle: reconcileAccountMigrationCycle,
};

export class AccountMigrationController {
  private running: Promise<void> | null = null;
  private trailingCycleRequested = false;
  private readonly ports: AccountMigrationControllerCyclePorts;

  constructor(
    private readonly registry: AgentRegistry = agentRegistry(),
    private readonly quota: Pick<QuotaController, "tick"> = new QuotaController(registry),
    private readonly cycle: (() => Promise<void>) | null = null,
    ports: Partial<AccountMigrationControllerCyclePorts> = {},
  ) {
    this.ports = { ...DEFAULT_CONTROLLER_CYCLE_PORTS, ...ports };
  }

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
    const { files } = await this.ports.scan();
    await yieldToRuntime();
    const inventorySnapshot = await this.ports.reconcileInventory(this.registry, files);
    await yieldToRuntime();
    const inventoryLookup = conversationLookupFromSnapshot(inventorySnapshot);
    await this.ports.reconcileFlowOwnership(inventoryLookup);
    await this.ports.reconcileWorkflowOwnership(inventoryLookup);
    await this.ports.reconcileHandoffOwnership(inventoryLookup);
    await yieldToRuntime();
    await this.ports.reconcileFiles(files);
    await yieldToRuntime();
    await this.ports.reconcileRuntime(this.registry, files);
    await yieldToRuntime();
    await this.ports.reconcileTaskStore(this.registry, files);
    await yieldToRuntime();
    await this.ports.syncRouting(this.registry);
    await this.ports.reconcileMigrationCycle(this.registry, this.quota);
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
  await yieldToRuntime();
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
