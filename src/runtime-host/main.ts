import { discardWakatimeEnvironmentCredential } from "@/lib/wakatime/credential";

discardWakatimeEnvironmentCredential();

const { statePath } = await import("@/lib/configDir");
const { procBackend } = await import("@/lib/proc");
const { createServerRuntimeConsumers } = await import("@/lib/runtime/serverConsumers");
const { requestPipelineTick } = await import("@/lib/pipelines/controllerSignal");
const { RuntimeHost, RuntimeHostFence } = await import("./host");
const { RuntimeJournal } = await import("./journal");
const { createLegacyRuntimeScheduler } = await import("./legacyScheduler");
const { serveRuntimeHost } = await import("./socket");
const { ViewerDeploymentCoordinator } = await import("./deployment");
const { HostCommandViewerDeploymentAdapter } = await import("./deploymentAdapter");
const { serveViewerDeploymentProxy } = await import("./deploymentProxy");
const {
  currentRuntimeHostGeneration,
  RUNTIME_HOST_CONTAINER_ENV,
} = await import("./hostRelease");

const socketPath = process.env.LLV_RUNTIME_HOST_SOCKET || statePath("runtime-host.sock");
if (process.env.LLV_RUNTIME_EVENTS !== "1") throw new Error("runtime host activation requires LLV_RUNTIME_EVENTS=1");
if (process.env.LLV_RUNTIME_LEGACY_SCHEDULER === "1" && process.env.LLV_ACCOUNT_CONTROLLER_DISABLED !== "1") {
  throw new Error("runtime legacy scheduler requires LLV_ACCOUNT_CONTROLLER_DISABLED=1 to preserve single-writer reconciliation");
}
const fence = new RuntimeHostFence(`${socketPath}.lock`);
/* #518: a staged successor generation boots while its predecessor still holds
   the singleton fence, and must wait for the predecessor's graceful exit
   instead of failing its container. Ordinary boots keep the immediate throw. */
const fenceWaitMs = Number(process.env.LLV_RUNTIME_HOST_FENCE_WAIT_MS || 0);
const fenceDeadline = Date.now() + (Number.isFinite(fenceWaitMs) && fenceWaitMs > 0 ? fenceWaitMs : 0);
for (;;) {
  try {
    fence.acquire();
    break;
  } catch (error) {
    if (Date.now() >= fenceDeadline) throw error;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
const journal = new RuntimeJournal(process.env.LLV_RUNTIME_JOURNAL || statePath("runtime-events.sqlite"));
if (journal.isWritable()) journal.claimHostEpoch();
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
const bootGeneration = currentRuntimeHostGeneration();
const deploymentAdapter = deploymentAdapterPath
  ? HostCommandViewerDeploymentAdapter.fromExecutable(deploymentAdapterPath)
  : undefined;
const bootContainer = process.env[RUNTIME_HOST_CONTAINER_ENV];
if (deploymentAdapter && bootGeneration.image && bootGeneration.revision && bootContainer) {
  await deploymentAdapter.completeRuntimeHostHandoff({
    image: bootGeneration.image,
    revision: bootGeneration.revision,
    container: bootContainer,
  });
}
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
const host = new RuntimeHost(journal, createServerRuntimeConsumers(), deployments, undefined, requestPipelineTick);
const deploymentProxy = deployments
  ? serveViewerDeploymentProxy(
    process.env.LLV_VIEWER_DEPLOY_TARGET || statePath("viewer-release.json"),
    Number(process.env.LLV_VIEWER_PORT || 8898),
  )
  : null;
if (journal.isWritable()) await host.recoverConsumers();
if (journal.isWritable() && deployments) await deployments.recover();
const server = serveRuntimeHost(socketPath, host);
const legacyScheduler = process.env.LLV_RUNTIME_LEGACY_SCHEDULER === "1" ? createLegacyRuntimeScheduler(journal) : null;
const legacyTimer = legacyScheduler ? setInterval(() => {
  void legacyScheduler.runDue().catch(() => console.error("[runtime scheduler] tick failed; next tick will retry"));
}, 1_000) : null;

function stop(): void {
  if (legacyTimer) clearInterval(legacyTimer);
  deploymentProxy?.close();
  server.close(() => {
    journal.close();
    fence.release();
  });
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

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
