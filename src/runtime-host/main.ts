import { discardWakatimeEnvironmentCredential } from "@/lib/wakatime/credential";

discardWakatimeEnvironmentCredential();

const { stateDir, statePath } = await import("@/lib/configDir");
const { agentRegistry } = await import("@/lib/agent/registry");
const { procBackend } = await import("@/lib/proc");
const { once } = await import("node:events");
const { createServerRuntimeConsumers } = await import("@/lib/runtime/serverConsumers");
const { requestPipelineTick } = await import("@/lib/pipelines/controllerSignal");
const { RuntimeHost, RuntimeHostFence } = await import("./host");
const { RuntimeJournal } = await import("./journal");
const { McpHealthProbeAdmissions } = await import("./mcpHealthProbeAdmission");
const { createLegacyRuntimeScheduler } = await import("./legacyScheduler");
const { serveRuntimeHost } = await import("./socket");
const { ViewerDeploymentCoordinator } = await import("./deployment");
const { HostCommandViewerDeploymentAdapter } = await import("./deploymentAdapter");
const { serveViewerDeploymentProxy } = await import("./deploymentProxy");
const { ReceiptSweepReporter, receiptSweepDebugEnabled } = await import("./receiptSweep");
const { registryConversationRetentionStates } = await import("./journalRetention");
const {
  inspectRuntimeJournalFreelist,
  runtimeJournalVacuumDue,
  spawnRuntimeJournalVacuum,
} = await import("./journalVacuum");
const {
  clearRuntimeHostRollbackIntent,
  clearRuntimeHostRollbackTarget,
  currentRuntimeHostGeneration,
  readRuntimeHostRollbackIntent,
  RUNTIME_HOST_CONTAINER_ENV,
  RUNTIME_HOST_IMAGE_ENV,
  RUNTIME_HOST_REVISION_ENV,
  runtimeHostRollbackIntentFile,
  runtimeHostRollbackTargetFile,
} = await import("./hostRelease");
const { acquireRuntimeHostFence, runtimeHostFenceWaitPlan } = await import("./fenceWait");
const {
  runtimeHostGenerationFromEnvironment,
  RuntimeHostStartupStore,
} = await import("./runtimeHostStartup");
const {
  completeRuntimeHostRollback,
  resumeRuntimeHostRollback,
  runtimeHostRollbackDeploymentUpdate,
} = await import("./hostRollback");

const { runtimeHostActivationRefusal } = await import("@/lib/runtime/flags");

const { defaultRuntimeHostEndpoint, runtimeHostFencePath } = await import("@/lib/runtime/localEndpoint");
/* One local endpoint: a Unix socket path on POSIX, a named pipe on Windows.
   The fence is a real file on both, so on Windows it cannot be derived from the
   endpoint by appending `.lock` — the CLI hands it over explicitly, and a host
   started without one falls back to the state directory. */
const defaultEndpoint = defaultRuntimeHostEndpoint(stateDir());
const socketPath = process.env.LLV_RUNTIME_HOST_SOCKET || defaultEndpoint.socketPath;
/* A started runtime-host is always an events host. The guard survives; it keys
   on the same reader the viewer uses, so a deployment that merely drops the
   variable no longer gets a viewer that believes events are live and a host
   that exits at boot. Only the explicit rollback refuses. */
const activationRefusal = runtimeHostActivationRefusal();
if (activationRefusal) throw new Error(activationRefusal);
if (process.env.LLV_RUNTIME_LEGACY_SCHEDULER === "1" && process.env.LLV_ACCOUNT_CONTROLLER_DISABLED !== "1") {
  throw new Error("runtime legacy scheduler requires LLV_ACCOUNT_CONTROLLER_DISABLED=1 to preserve single-writer reconciliation");
}
const fence = new RuntimeHostFence(
  process.env.LLV_RUNTIME_HOST_FENCE?.trim() || runtimeHostFencePath(socketPath, stateDir()),
);
const bootGeneration = currentRuntimeHostGeneration();
const bootContainer = process.env[RUNTIME_HOST_CONTAINER_ENV];
const processStartIdentity = procBackend.processIdentity(process.pid);
if (!processStartIdentity) throw new Error("runtime-host process start identity is unavailable");
const trackedStartupGeneration = process.env[RUNTIME_HOST_IMAGE_ENV]
  && process.env[RUNTIME_HOST_REVISION_ENV]
  && bootContainer
  ? runtimeHostGenerationFromEnvironment(process.env)
  : {
    image: "legacy-untracked",
    revision: "legacy-untracked",
    container: `legacy-runtime-host-${process.pid}`,
  };
const startup = new RuntimeHostStartupStore(
  process.env.LLV_RUNTIME_HOST_STARTUP_TARGET
    || statePath("runtime-host-startup", `${trackedStartupGeneration.container}.json`),
  {
    generation: trackedStartupGeneration,
    pid: process.pid,
    startIdentity: processStartIdentity,
  },
);
startup.begin();
async function docker(argv: string[]): Promise<string> {
  const child = Bun.spawn(["docker", ...argv], { stdout: "pipe", stderr: "pipe", env: process.env });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error((stderr.trim() || "docker command failed").slice(0, 1_000));
  return stdout.trim();
}
async function dockerAbsentOkay(argv: string[]): Promise<void> {
  try { await docker(argv); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/No such container|No such object/i.test(message)) throw error;
  }
}
const rollbackIntent = readRuntimeHostRollbackIntent(runtimeHostRollbackIntentFile());
const rollbackGeneration = rollbackIntent
  ? runtimeHostGenerationFromEnvironment(process.env)
  : null;
const rollbackResumed = rollbackGeneration
  ? await resumeRuntimeHostRollback(rollbackGeneration, {
    readIntent: () => readRuntimeHostRollbackIntent(runtimeHostRollbackIntentFile()),
    disableActiveRestart: (container) => dockerAbsentOkay(["container", "update", "--restart", "no", container]),
    stopActive: (container) => dockerAbsentOkay(["container", "stop", "--time", "40", container]),
  })
  : false;
/* #518: a staged successor generation boots while its predecessor still holds
   the singleton fence, and must wait for the predecessor's graceful exit
   instead of failing its container. Ordinary boots keep the immediate throw.
   #1216: a successor parked by an operator bootstrap waits without a deadline,
   because nothing has asked its predecessor to exit yet. Either wait names
   what it is waiting for and how long it has waited. */
await acquireRuntimeHostFence({
  acquire: () => fence.acquire(),
  plan: runtimeHostFenceWaitPlan(process.env),
  container: process.env[RUNTIME_HOST_CONTAINER_ENV],
  report: (line) => console.error(line),
});
startup.record("fence-acquired");
const journalFilename = process.env.LLV_RUNTIME_JOURNAL || statePath("runtime-events.sqlite");
const journal = new RuntimeJournal(journalFilename);
if (rollbackResumed && !journal.isWritable()) {
  throw new Error("runtime-host rollback cannot complete while the deployment journal is read-only");
}
const hostEpoch = journal.isWritable() ? journal.claimHostEpoch() : journal.snapshot().runtime.hostEpoch;
startup.bindHostEpoch(hostEpoch);
startup.record("journal-open");
if (journal.isWritable() && rollbackResumed && rollbackIntent) {
  const activeDeployment = journal.activeViewerDeployment();
  if (activeDeployment) {
    const update = runtimeHostRollbackDeploymentUpdate(activeDeployment, rollbackIntent);
    if (update) journal.updateViewerDeployment(activeDeployment.deploymentId, update);
  }
}
if (rollbackResumed && rollbackGeneration) {
  await completeRuntimeHostRollback(rollbackGeneration, {
    readIntent: () => readRuntimeHostRollbackIntent(runtimeHostRollbackIntentFile()),
    removeFailed: (container) => dockerAbsentOkay(["container", "rm", "-f", container]),
    clearTarget: () => clearRuntimeHostRollbackTarget(runtimeHostRollbackTargetFile()),
    clearIntent: () => clearRuntimeHostRollbackIntent(runtimeHostRollbackIntentFile()),
  });
}
const deploymentsEnabled = process.env.LLV_VIEWER_DEPLOYMENTS === "1";
const deploymentAdapterPath = deploymentsEnabled
  ? process.env.LLV_VIEWER_DEPLOY_ADAPTER?.trim() || "/app/scripts/runtime-host-viewer-adapter.ts"
  : undefined;
if (deploymentsEnabled && !deploymentAdapterPath) {
  throw new Error("LLV_VIEWER_DEPLOY_ADAPTER is required when Viewer deployments are enabled");
}
/* #518: the generation record staged with this process's own image, read once
   at boot. Bun loads modules exactly once, so a later deploy can only reach a
   successor process — a missing record is the legacy fixed-tag image and is
   never provably current. */
const mcpHealthProbeAdmissions = new McpHealthProbeAdmissions();
const deploymentAdapter = deploymentAdapterPath
  ? HostCommandViewerDeploymentAdapter.fromExecutable(deploymentAdapterPath, { mcpHealthProbeAdmissions })
  : undefined;
if (deploymentAdapter && bootGeneration.image && bootGeneration.revision && bootContainer) {
  await deploymentAdapter.completeRuntimeHostHandoff({
    image: bootGeneration.image,
    revision: bootGeneration.revision,
    container: bootContainer,
  });
}
startup.record("handoff-cleanup-complete");
const deployments = deploymentAdapter
  ? new ViewerDeploymentCoordinator(
    journal,
    deploymentAdapter,
    { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) },
    {
      hostGeneration: () => bootGeneration,
      onHostHandoff: (context) => handOffToStagedSuccessor(context),
    },
  )
  : undefined;
const host = new RuntimeHost(
  journal,
  createServerRuntimeConsumers(),
  deployments,
  undefined,
  requestPipelineTick,
  mcpHealthProbeAdmissions,
  () => startup.readyEvidence(),
);
const deploymentProxy = deployments
  ? serveViewerDeploymentProxy(
    process.env.LLV_VIEWER_DEPLOY_TARGET || statePath("viewer-release.json"),
    Number(process.env.LLV_VIEWER_PORT || 8898),
  )
  : null;
if (journal.isWritable()) await host.recoverConsumers();
startup.record("consumers-recovered");
const server = serveRuntimeHost(socketPath, host);
await once(server, "listening");
startup.record("socket-listening");
startup.record("ready");
if (journal.isWritable() && deployments) await deployments.recover();
const legacyScheduler = process.env.LLV_RUNTIME_LEGACY_SCHEDULER === "1" ? createLegacyRuntimeScheduler(journal) : null;
const legacyTimer = legacyScheduler ? setInterval(() => {
  void legacyScheduler.runDue().catch(() => console.error("[runtime scheduler] tick failed; next tick will retry"));
}, 1_000) : null;
/* Producer-receipt retention runs on wall clock, not on append traffic, so a
   quiet journal still drains its backlog. Each tick is bounded inside
   maintainProducerReceipts; the multi-week legacy accumulation drains across
   ticks while the sweep itself never blocks the socket loop noticeably. The
   reporter keeps the ten-second cadence out of the log stream (#1216). */
const receiptSweepReporter = new ReceiptSweepReporter({ debug: receiptSweepDebugEnabled() });
const receiptSweepTimer = journal.isWritable() ? setInterval(() => {
  if (!journal.isWritable()) return;
  try {
    const line = receiptSweepReporter.record(journal.maintainProducerReceipts(), Date.now());
    if (line) console.error(line);
  } catch (error) {
    console.error(`[runtime journal] receipt sweep failed; next tick will retry: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 10_000) : null;

const JOURNAL_MAINTENANCE_INTERVAL_MS = 60_000;
const JOURNAL_VACUUM_RETRY_MS = 60 * 60 * 1_000;
let journalVacuumRunning = false;
let lastJournalVacuumAttemptAt = 0;
const journalMaintenanceTimer = journal.isWritable() ? setInterval(() => {
  if (!journal.isWritable()) return;
  try {
    const registry = agentRegistry().readOnlySnapshot();
    const effects = journal.settleStalePendingEffects(registryConversationRetentionStates(registry));
    if (effects.settled > 0) {
      console.error(`[runtime journal] stale effect sweep settled ${effects.settled} of ${effects.scanned} pending spawn/kill effects`);
    }
  } catch (error) {
    console.error(`[runtime journal] stale effect sweep failed closed; next tick will retry: ${error instanceof Error ? error.message : String(error)}`);
  }

  const now = Date.now();
  if (journalVacuumRunning || now - lastJournalVacuumAttemptAt < JOURNAL_VACUUM_RETRY_MS) return;
  try {
    const before = inspectRuntimeJournalFreelist(journalFilename);
    if (!runtimeJournalVacuumDue(before, now)) return;
    journalVacuumRunning = true;
    lastJournalVacuumAttemptAt = now;
    void spawnRuntimeJournalVacuum(journalFilename)
      .then(() => {
        const after = inspectRuntimeJournalFreelist(journalFilename);
        console.error(`[runtime journal] vacuum reclaimed ${Math.max(0, before.freelistPages - after.freelistPages)} pages; ${after.freelistPages} free pages remain`);
      })
      .catch((error: unknown) => {
        console.error(`[runtime journal] vacuum failed; next hourly attempt may retry: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => { journalVacuumRunning = false; });
  } catch (error) {
    lastJournalVacuumAttemptAt = now;
    console.error(`[runtime journal] freelist inspection failed; next hourly attempt may retry: ${error instanceof Error ? error.message : String(error)}`);
  }
}, JOURNAL_MAINTENANCE_INTERVAL_MS) : null;

function stop(): void {
  if (legacyTimer) clearInterval(legacyTimer);
  if (receiptSweepTimer) clearInterval(receiptSweepTimer);
  if (journalMaintenanceTimer) clearInterval(journalMaintenanceTimer);
  deploymentProxy?.close();
  server.close(() => {
    journal.close();
    fence.release();
  });
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

/* #618: a deployment driven by a predecessor adapter promotes this generation
   without publishing its matching MCP runtime, so this boot is the first
   process that can repair it. The probe runs against the socket server above,
   so it starts only once that is serving; staging copies a package tree, so it
   runs off the boot path rather than delaying the scheduler and the signal
   handlers. A failed reconcile restores the previous target adapter-side and
   leaves the host running on the runtime that is already published. */
if (deploymentAdapter && deployments && bootGeneration.revision) {
  const revision = bootGeneration.revision;
  void (async () => {
    const reconciliation = await deploymentAdapter.reconcileMcpRuntime(revision);
    if (reconciliation && journal.isWritable()) deployments.recordMcpRuntimeReconciliation(reconciliation);
  })().catch((error: unknown) => {
    console.error(`[runtime host] MCP runtime reconcile for ${revision} failed; the published runtime is unchanged: ${error instanceof Error ? error.message : String(error)}`);
  });
}

const HANDOFF_EXIT_GRACE_MS = 30_000;
let handoffStarted = false;
/* #518 generation handoff. Invoked only after the successor container from
   the deployed candidate image is durably staged: dockerd owns it with a
   restart policy, it is waiting on the singleton fence, and this container's
   restart policy is already disabled — so this exit cannot resurrect the
   stale image and is never a same-image self-restart. Draining the socket
   server first lets in-flight requests finish; the journal closes through the
   normal graceful path and the successor recovers the durable queue. Engine
   hosts live in Viewer processes and are never signalled. */
function handOffToStagedSuccessor(context: { deploymentId: string; revision: string; successor: { image: string } }): void {
  if (handoffStarted) return;
  handoffStarted = true;
  console.error(`[runtime host] deployment ${context.deploymentId} staged successor ${context.successor.image} (${context.revision}); handing off this generation`);
  if (legacyTimer) clearInterval(legacyTimer);
  if (receiptSweepTimer) clearInterval(receiptSweepTimer);
  if (journalMaintenanceTimer) clearInterval(journalMaintenanceTimer);
  deploymentProxy?.close();
  server.close(() => {
    journal.close();
    fence.release();
    process.exit(0);
  });
  const forcedExit = setTimeout(() => {
    try { journal.close(); } catch { /* crash-safe journal recovery owns this path */ }
    fence.release();
    process.exit(0);
  }, HANDOFF_EXIT_GRACE_MS);
  forcedExit.unref();
}
