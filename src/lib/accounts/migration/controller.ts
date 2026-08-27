import { activeClaudeAccountId, setActiveClaudeAccount } from "@/lib/accounts/claude";
import { activeCodexAccountId, codexAccountsMutationLocked, codexLoginPaneStatus, listCodexAccounts, setActiveCodexAccount, setCodexAccountLoginPane } from "@/lib/accounts/codex";
import { managedCodexRuntime } from "@/lib/accounts/codexRuntime";
import { withAccountMutationLock } from "@/lib/accounts/accountMutation";
import { agentRegistry, conversationLookupFromSnapshot, type AgentRegistry } from "@/lib/agent/registry";
import { readTranscriptHosts } from "@/lib/agent/transcriptHost";
import { yieldToRuntime } from "@/lib/cooperative";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadFlows, reconcileFlowConversationOwnershipCooperatively } from "@/lib/flows/store";
import { reconcileHandoffConversationOwnershipCooperatively } from "@/lib/handoffLineage";
import { listFilesWithProjectCatalog, reconcileFileControllers } from "@/lib/scanner";
import { persistedFileScanSnapshot } from "@/lib/scanner/scanCache";
import { coordinatedControllerScan } from "@/lib/scanner/scanCoordinator";
import { pidAlive, readPpid } from "@/lib/scanner/process";
import { runReaperCycle } from "@/lib/reaperRuntime";
import { runHeadlessProcessReaper } from "@/lib/headlessProcessReaper";
import { reconcileStructuredHostRetirement } from "@/lib/runtime/structuredHostRetirement";
import { pathForPanePid, reconcileTasks } from "@/lib/tasks/reconcile";
import { mutateTasks } from "@/lib/tasks/store";
import { reconcileWorkflowConversationOwnershipCooperatively } from "@/lib/workflows/store";
import { paneInfo } from "@/lib/tmux";
import { withoutWakatimeCredential } from "@/lib/wakatime/credential";

import { reconcileMigrationInventory, reconcileMigrations, type HeldDeliveryPort } from "./coordinator";
import { createMigrationDeliveryPort } from "./deliveryPort";
export { createMigrationDeliveryPort } from "./deliveryPort";
import { registerAccountMigrationTick } from "./controllerSignal";
import type { SuccessorProviderPort } from "./contracts";
import { RegisteredSuccessorProvider } from "./provider";
import { QuotaController } from "./quotaController";

const CONTROLLER_INTERVAL_MS = 60_000;
const INITIAL_INVENTORY_DELAY_MS = 1_000;
const INVENTORY_WORKER_RESTART_MS = 1_000;

const deliveryPort = createMigrationDeliveryPort();

export async function reconcileAccountMigrationCycle(
  registry: AgentRegistry,
  quota: Pick<QuotaController, "tick">,
  provider: SuccessorProviderPort = new RegisteredSuccessorProvider(),
  delivery: HeldDeliveryPort = deliveryPort,
): Promise<void> {
  registry.compactDeliveryReservations();
  await yieldToRuntime();
  /* Quota ticks run alongside migration reconciliation, not after it: a slow
     or stuck migration pass (lock contention, wedged provider) must never
     leave the account panel without fresh limits readings. Migration
     decisions already consume the previous tick's durable observations, so
     ordering between the two is immaterial. */
  const quotaTicks = Promise.all([quota.tick("claude"), quota.tick("codex")]);
  try {
    await reconcileMigrations(provider, delivery, registry);
  } finally {
    await quotaTicks;
  }
}

export function syncCompatibilityRouting(registry: AgentRegistry): void {
  const current = registry.readOnlySnapshot().engineRouting;
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
    const snapshot = registry.readOnlySnapshot();
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

const INCOMPLETE_CONTROLLER_SCAN: ControllerScan = {
  files: [],
  projectCatalog: [],
  complete: false,
};

export function accountControllerScan(
  env: Readonly<Record<string, string | undefined>> = process.env,
  persisted: () => ControllerScan | undefined = persistedFileScanSnapshot,
  live: () => Promise<ControllerScan> = coordinatedControllerScan,
): Promise<ControllerScan> {
  if (env.LLV_ACCOUNT_CONTROLLER_INVENTORY_WORKER !== "1") return live();
  return Promise.resolve(persisted() ?? INCOMPLETE_CONTROLLER_SCAN);
}

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
  const transcriptHosts = await readTranscriptHosts(true, files);
  try {
    await runReaperCycle({ registry, hosts: transcriptHosts.hosts, files });
  } catch (error) {
    console.error("[agent reaper] lifecycle reconciliation failed", error);
  }
  try {
    const report = await runHeadlessProcessReaper({ hosts: transcriptHosts.hosts, flows: loadFlows() });
    if (report.signaled > 0) console.warn(`[headless process reaper] terminated ${report.signaled} stale process group(s)`);
  } catch (error) {
    console.error("[headless process reaper] reconciliation failed", error);
  }
  /* Structured host retirement (#747). The headless reaper above excludes every
     engine owner unconditionally, so nothing here ever ended a host whose
     conversation had simply finished; this is the pass that does, under the
     full predicate and never by process group alone. Enablement and failure
     containment live with the sweep so the two cannot drift. */
  await reconcileStructuredHostRetirement();
}

function reconcileControllerTasks(registry: AgentRegistry, files: ControllerScan["files"]): void {
  const currentLookup = conversationLookupFromSnapshot(registry.readOnlySnapshot());
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
  // The inventory sidecar consumes the completed snapshot published by the
  // Viewer. Process-wide coordination cannot cover a separate OS process.
  scan: () => accountControllerScan(),
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
    const { files, complete } = await this.ports.scan();
    if (!complete) return;
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
  __llvAccountMigrationInventoryWorker?: ChildProcess;
  __llvAccountMigrationInventoryWorkerRestart?: ReturnType<typeof setTimeout>;
};

function startInventoryController(registry: AgentRegistry, quota: QuotaController): void {
  const controller = globalController.__llvAccountMigrationController ??= new AccountMigrationController(registry, quota);
  if (!globalController.__llvAccountMigrationTimer) {
    const timer = setInterval(() => void controller.poll().catch((error) => {
      console.error("[account migration controller] durable reconciliation tick failed", error);
    }), CONTROLLER_INTERVAL_MS);
    timer.unref?.();
    globalController.__llvAccountMigrationTimer = timer;
  }
  if (!globalController.__llvAccountMigrationBootstrapStarted) {
    globalController.__llvAccountMigrationBootstrapStarted = true;
    const timer = setTimeout(() => {
      globalController.__llvAccountMigrationInitialTimer = undefined;
      void controller.poll().catch((error) => {
        console.error("[account migration controller] initial inventory reconciliation failed", error);
      });
    }, INITIAL_INVENTORY_DELAY_MS);
    timer.unref?.();
    globalController.__llvAccountMigrationInitialTimer = timer;
  }
}

function inventoryWorkerLaunch(cwd = process.cwd()): { executable: string; workerPath: string } {
  const source = path.join(cwd, "src/lib/accountMigrationController.worker.ts");
  const bundled = path.join(cwd, ".next/server/account-migration-controller-worker.js");
  if (fs.existsSync(source) && fs.existsSync("/usr/local/bin/bun-container")) {
    return { executable: "/usr/local/bin/bun-container", workerPath: source };
  }
  if (fs.existsSync(bundled)) {
    const bun = process.versions.bun ? process.execPath : (process.env.LLV_BUN_EXECUTABLE || "bun");
    return { executable: bun, workerPath: bundled };
  }
  return { executable: process.execPath, workerPath: source };
}

function startInventoryControllerWorker(): void {
  if (globalController.__llvAccountMigrationInventoryWorker) return;
  const launch = inventoryWorkerLaunch();
  const useNice = fs.existsSync("/usr/bin/nice");
  const child = spawn(useNice ? "/usr/bin/nice" : launch.executable, [
    ...(useNice ? ["-n", "10", launch.executable] : []),
    launch.workerPath,
  ], {
    cwd: process.cwd(),
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...withoutWakatimeCredential(process.env),
      LLV_ACCOUNT_CONTROLLER_INVENTORY_WORKER: "1",
    },
  });
  globalController.__llvAccountMigrationInventoryWorker = child;
  child.once("error", (error) => {
    console.error("[account migration controller] inventory worker failed to start", error);
  });
  child.once("exit", (code, signal) => {
    if (globalController.__llvAccountMigrationInventoryWorker === child) {
      globalController.__llvAccountMigrationInventoryWorker = undefined;
    }
    if (globalController.__llvAccountMigrationInventoryWorkerRestart) return;
    console.error("[account migration controller] inventory worker exited", { code, signal });
    const timer = setTimeout(() => {
      globalController.__llvAccountMigrationInventoryWorkerRestart = undefined;
      startInventoryControllerWorker();
    }, INVENTORY_WORKER_RESTART_MS);
    timer.unref?.();
    globalController.__llvAccountMigrationInventoryWorkerRestart = timer;
  });
}

export async function startAccountMigrationController(): Promise<void> {
  await yieldToRuntime();
  const registry = agentRegistry();
  const quota = new QuotaController(registry);
  if (process.env.LLV_ACCOUNT_CONTROLLER_INVENTORY_WORKER === "1") {
    startInventoryController(registry, quota);
    return;
  }
  const fastController = globalController.__llvAccountMigrationFastController ??= new AccountMigrationController(
    registry,
    quota,
    () => reconcileAccountMigrationCycle(registry, quota),
  );
  registerAccountMigrationTick(() => fastController.tick());
  void fastController.tick().catch((error) => {
    console.error("[account migration controller] initial durable reconciliation failed", error);
  });
  startInventoryControllerWorker();
}
