import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";

import { statePath } from "@/lib/configDir";
import { structuredHostsEnabled } from "@/lib/runtime/flags";
import {
  acknowledgeHotStateFence,
  completeHotStatePreparation,
  hotStateWriterRevision,
  markHotStateActivationReady,
  markViewerReleaseReady,
  publishHotStateAuthority,
  readHotStateAuthority,
  type HotStateAuthority,
  type HotStateCheckpoint,
} from "@/lib/state/hotStateAuthority";
import { initializeStateCollections, markStateSqliteCutoverReady } from "@/lib/state/sqliteStateStore";
import { markStructuredHostStartupFailed, markStructuredHostStartupReady } from "@/lib/runtime/startupStatus";
import { StructuredRuntimeRequirementError } from "@/lib/proc/darwinIdentity";
import {
  discardWakatimeEnvironmentCredential,
  withoutWakatimeCredential,
} from "@/lib/wakatime/credential";

/*
 * The Viewer's node-side startup runtime. This module (and everything it pulls
 * in — node: builtins included) must stay OUT of `src/instrumentation.ts`:
 * Next's dev fallback compiler builds that entry without node:-scheme support,
 * so any node: import reachable from it fails the compile and 500s every
 * request (the local QA `/api/files` regression). `register()` reaches this
 * module only through a dynamic import inside a statically-pruned
 * `NEXT_RUNTIME === "nodejs"` branch.
 */

const RELEASE_ACTIVATION_POLL_MS = 250;
const HOT_STATE_CUTOVER_STABLE_POLLS = 3;
const HOT_STATE_CUTOVER_MAX_POLLS = 12;
const WAKATIME_WORKER_RESTART_MS = 1_000;
const wakatimeWorkerStore = globalThis as typeof globalThis & {
  __llvWakatimeWorker?: ChildProcess;
  __llvWakatimeWorkerRestart?: ReturnType<typeof setTimeout>;
};

interface ActivationTimer {
  unref?(): unknown;
}

interface StructuredHostStartupOptions {
  schedule?: (callback: () => void, delayMs: number) => ActivationTimer;
  initialRetryMs?: number;
  maxRetryMs?: number;
  jitterRatio?: number;
  random?: () => number;
  waitUntilReady?: boolean;
}

interface ViewerReleaseActivationOptions {
  pollMs?: number;
  schedule?: (callback: () => void, delayMs: number) => ActivationTimer;
  log?: (...args: unknown[]) => void;
  fenceRequest?: () => HotStateAuthority | null;
  onFenceRequested?: (request: HotStateAuthority) => void | Promise<void>;
  onDemoted?: (context: { fenced: boolean }) => void | Promise<void>;
}

interface HotStateCutoverOptions {
  pollMs?: number;
  stablePolls?: number;
  maxPolls?: number;
  schedule?: (callback: () => void, delayMs: number) => ActivationTimer;
  legacySignature?: () => string;
}

export interface HotStateCutoverBoundary {
  authority: HotStateAuthority | null;
  reimportLegacy: boolean;
}

interface CurrentReleaseControllerLoaders {
  loadFlowPipelineController: () => Promise<{ startFlowPipelineController: () => void }>;
  loadAccountMigrationController: () => Promise<{ startAccountMigrationController: () => Promise<void> }>;
  /** Optional so a test can supply the two controllers it exercises and get
      nothing else. Production always passes it. */
  loadTelegramReportScheduler?: () => Promise<{ ensureTelegramReportScheduler: () => void }>;
}

interface ViewerRuntimeActivationSteps {
  initializeOperatorCapability: () => Promise<void>;
  startWakatime: () => Promise<void>;
  startStructuredHosts: (() => void) | null;
  startControllers: () => Promise<void>;
  publishHotStateActivation: () => void;
  publishViewerReleaseReady: () => void;
}

/** Candidate containers share production state while their health gate runs.
 * The durable proxy target grants authority to the endpoint currently serving
 * traffic. A missing target keeps local development and first boot active. */
export function viewerReleaseOwnsTraffic(
  env: Readonly<Record<string, string | undefined>> = process.env,
  readTarget: () => string = () => fs.readFileSync(statePath("viewer-release.json"), "utf8"),
): boolean {
  const port = env.PORT?.trim();
  if (!port) return true;
  let raw: string;
  try {
    raw = readTarget();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  try {
    const target = JSON.parse(raw) as { endpoint?: unknown };
    if (typeof target.endpoint !== "string") return false;
    return new URL(target.endpoint).port === port;
  } catch {
    return false;
  }
}

function legacyHotStateSignature(): string {
  return ["flows.json", "pipelines.json", "pipelines-archive.json", "workflows.json"].map((name) => {
    const filename = statePath(name);
    try {
      const stat = fs.statSync(filename, { bigint: true });
      return `${name}:${stat.mtimeNs}:${stat.size}`;
    } catch {
      return `${name}:missing`;
    }
  }).join("|");
}

/** A promoted first-SQLite release waits through the predecessor's demotion
 * poll and imports only after every legacy hot-state file is stable. */
export async function establishHotStateCutoverBoundary(
  isCurrent: () => boolean,
  options: HotStateCutoverOptions = {},
): Promise<HotStateCutoverBoundary> {
  const directory = path.dirname(statePath("state.sqlite"));
  const releaseRevision = hotStateWriterRevision(directory);
  const targetExists = releaseRevision !== null || fs.existsSync(statePath("viewer-release.json"));
  if (targetExists && releaseRevision === null) throw new Error("viewer release cannot publish hot-state authority");
  if (releaseRevision === null) {
    markStateSqliteCutoverReady(statePath("state.sqlite"));
    return { authority: null, reimportLegacy: false };
  }
  let authority = readHotStateAuthority(directory);
  if (authority?.mode === "sqlite" && authority.releaseRevision !== releaseRevision) {
    authority = publishHotStateAuthority(directory, "sqlite", releaseRevision);
    markStateSqliteCutoverReady(statePath("state.sqlite"));
    return { authority, reimportLegacy: false };
  }
  if (authority?.mode === "sqlite" && authority.releaseRevision === releaseRevision) {
    markStateSqliteCutoverReady(statePath("state.sqlite"));
    return { authority, reimportLegacy: false };
  }
  if (authority?.mode === "fencing") throw new Error("hot-state cutover cannot replace an active rollback fence");
  if (authority?.mode !== "preparing" || authority.releaseRevision !== releaseRevision) {
    authority = publishHotStateAuthority(directory, "preparing", releaseRevision);
  }
  const { hotStateMigrationApplied, hotStateMigrationDryRun } = await import("@/lib/state/hotStateMigration");
  if (hotStateMigrationApplied()) {
    markStateSqliteCutoverReady(statePath("state.sqlite"));
    return { authority, reimportLegacy: false };
  }
  const pollMs = options.pollMs ?? RELEASE_ACTIVATION_POLL_MS;
  const stablePolls = options.stablePolls ?? HOT_STATE_CUTOVER_STABLE_POLLS;
  const maxPolls = options.maxPolls ?? HOT_STATE_CUTOVER_MAX_POLLS;
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const signature = options.legacySignature ?? legacyHotStateSignature;
  let previous = signature();
  let stable = 0;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    await new Promise<void>((resolve) => schedule(resolve, pollMs).unref?.());
    if (!isCurrent()) throw new Error("viewer release lost traffic during hot-state cutover");
    const current = signature();
    stable = current === previous ? stable + 1 : 0;
    previous = current;
    if (stable >= stablePolls) {
      hotStateMigrationDryRun();
      markStateSqliteCutoverReady(statePath("state.sqlite"));
      return { authority, reimportLegacy: true };
    }
  }
  throw new Error("legacy hot-state files did not quiesce during release cutover");
}

/** Run stateful startup immediately for the current release. A deployment
 * candidate polls the durable target and activates once promotion appoints it. */
export async function activateViewerRuntimeWhenCurrent(
  activate: () => Promise<void>,
  isCurrent: () => boolean,
  options: ViewerReleaseActivationOptions = {},
): Promise<void> {
  const pollMs = options.pollMs ?? RELEASE_ACTIVATION_POLL_MS;
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const log = options.log ?? console.error;
  let started = false;
  let demoted = false;
  let fenceInProgress = false;
  let fencedEpoch: number | null = null;
  const monitor = () => {
    if (demoted) return;
    if (started && !isCurrent()) {
      demoted = true;
      void Promise.resolve(options.onDemoted?.({ fenced: fencedEpoch !== null })).catch((error) => {
        log("[viewer release] demotion checkpoint failed", error);
      });
      return;
    }
    const fence = started ? options.fenceRequest?.() ?? null : null;
    if (!fence || fence.mode !== "fencing") {
      if (!fenceInProgress) fencedEpoch = null;
    } else if (fencedEpoch !== fence.epoch && !fenceInProgress) {
      fenceInProgress = true;
      void Promise.resolve(options.onFenceRequested?.(fence)).then(() => {
        fencedEpoch = fence.epoch;
      }).catch((error) => {
        log("[viewer release] hot-state fence checkpoint failed", error);
      }).finally(() => {
        fenceInProgress = false;
      });
    }
    schedule(monitor, pollMs).unref?.();
  };
  const start = async () => {
    if (started) return;
    started = true;
    schedule(monitor, pollMs).unref?.();
    await activate();
  };
  if (isCurrent()) {
    await start();
    return;
  }
  const poll = () => {
    if (started) return;
    if (!isCurrent()) {
      schedule(poll, pollMs).unref?.();
      return;
    }
    void start().catch((error) => log("[viewer release] deferred runtime activation failed", error));
  };
  schedule(poll, pollMs).unref?.();
}

export function accountControllerDelayMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const configured = Number(env.LLV_ACCOUNT_CONTROLLER_DELAY_MS ?? 0);
  return Number.isFinite(configured) ? Math.max(0, configured) : 0;
}

export function scheduleAccountMigrationController(start: () => Promise<void>, delayMs: number): void {
  const run = () => {
    start().catch((error) => { console.error("[account migration controller] initial durable reconciliation failed", error); });
  };
  const timer = setTimeout(() => {
    if (delayMs > 0) run();
    // A second zero-delay timer gives already queued readiness probes a turn.
    else setTimeout(run, 0).unref?.();
  }, delayMs);
  timer.unref?.();
}

export async function completeViewerReleaseDemotion(
  checkpoint: () => void | Promise<void>,
  exit: (code: number) => unknown = (code) => process.exit(code),
  log: (...args: unknown[]) => void = console.error,
): Promise<void> {
  try {
    await checkpoint();
    exit(0);
  } catch (error) {
    log("[viewer release] demotion checkpoint failed", error);
    exit(1);
  }
}

export async function checkpointHotStateRollbackMirrorsForDemotion(): Promise<HotStateCheckpoint["revisions"]> {
  const [flows, pipelines, workflows] = await Promise.all([
    import("@/lib/flows/store"),
    import("@/lib/pipelines/store"),
    import("@/lib/workflows/store"),
  ]);
  const flowRevision = flows.checkpointFlowRollbackMirrorForDemotion();
  const pipelineRevisions = pipelines.checkpointPipelineRollbackMirrorsForDemotion();
  const workflowRevision = workflows.checkpointWorkflowRollbackMirrorForDemotion();
  return {
    flows: flowRevision,
    pipelines: pipelineRevisions.pipelines,
    pipelinesArchive: pipelineRevisions.pipelinesArchive,
    workflows: workflowRevision,
  };
}

export async function initializeHotStateStoresAtStartup(
  boundary: HotStateCutoverBoundary = { authority: null, reimportLegacy: false },
  options: { afterCollectionImport?: (collection: string) => void } = {},
): Promise<HotStateAuthority | null> {
  const [flows, pipelines, workflows] = await Promise.all([
    import("@/lib/flows/store"),
    import("@/lib/pipelines/store"),
    import("@/lib/workflows/store"),
  ]);
  initializeStateCollections(statePath("state.sqlite"), [
    flows.flowStateCollectionSeed(),
    ...pipelines.pipelineStateCollectionSeeds(),
    workflows.workflowStateCollectionSeed(),
  ], {
    reimportExisting: boundary.reimportLegacy,
    ...(options.afterCollectionImport ? { afterCollectionImport: options.afterCollectionImport } : {}),
  });
  flows.loadFlows();
  pipelines.loadPipelines();
  pipelines.loadArchivedPipelines();
  workflows.loadWorkflows();
  if (boundary.authority?.mode === "preparing") {
    return completeHotStatePreparation(path.dirname(statePath("state.sqlite")), boundary.authority);
  }
  return boundary.authority;
}

export async function startCurrentReleaseControllers(
  env: Readonly<Record<string, string | undefined>> = process.env,
  loaders: CurrentReleaseControllerLoaders = {
    loadFlowPipelineController: () => import("@/lib/pipelines/controller"),
    loadAccountMigrationController: () => import("@/lib/accounts/migration/controller"),
    loadTelegramReportScheduler: () => import("@/lib/telegram/reportRunner"),
  },
): Promise<void> {
  const { startFlowPipelineController } = await loaders.loadFlowPipelineController();
  startFlowPipelineController();
  /* The Daily Report timer (#1086) belongs to the release that owns traffic,
     like every other controller here. Starting it from the Telegram route
     alone would mean a standalone Viewer nobody has opened in a browser runs
     no report and catches up no missed slot. It is idempotent per process, and
     a failure to start it must not take the other controllers down with it. */
  try {
    const telegram = await loaders.loadTelegramReportScheduler?.();
    telegram?.ensureTelegramReportScheduler();
  } catch (error) {
    console.error("[telegram report] scheduler start failed", error instanceof Error ? error.name : "unknown");
  }
  if (env.LLV_ACCOUNT_CONTROLLER_DISABLED === "1") return;
  const { startAccountMigrationController } = await loaders.loadAccountMigrationController();
  scheduleAccountMigrationController(startAccountMigrationController, accountControllerDelayMs(env));
}

export async function initializeOperatorSpawnCapabilityAtStartup(
  env: Readonly<Record<string, string | undefined>> = process.env,
  log: (line: string) => void = (line) => console.error(line),
): Promise<void> {
  const { ensureOperatorSpawnCapability, rotateOperatorSpawnCapability } = await import("@/lib/agent/operatorCapability");
  if (env.LLV_ROTATE_OPERATOR_SPAWN_CAPABILITY === "1") rotateOperatorSpawnCapability();
  else ensureOperatorSpawnCapability();

  /* NO KEY IS EMITTED, because none exists to emit. Rounds 9–10 printed an operator
     session secret here — to `/dev/tty` or an inherited descriptor, never to captured
     output — and the operator pasted it into the tab to unlock designation and voice.
     That ceremony was rejected after use: it broke one-click manager and one-click
     voice, and a reload put the tab back behind it. Same-origin is now the operator
     (see `operatorAuthority`), so startup has nothing secret to hand anyone.

     What remains is the AGENT capability on disk, ensured above: it identifies
     workers, and identifying a worker is the one distinction still made. */
  const port = env.PORT?.trim() || "8898";
  log(`[viewer] Open http://127.0.0.1:${port}.`);
}

export async function startWakatimeIntegrationIfEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
  start: () => Promise<void> = startWakatimeWorker,
  log: (event: string, fields: Readonly<Record<string, never>>) => void = (event, fields) => console.error(event, fields),
): Promise<void> {
  if (env.LLV_WAKATIME_ENABLED !== "1") return;
  try {
    await start();
  } catch {
    log("[wakatime] startup_failed", {});
  }
}

async function startWakatimeWorker(): Promise<void> {
  if (wakatimeWorkerStore.__llvWakatimeWorker) return;
  const cwd = process.cwd();
  const source = path.join(cwd, "src/lib/wakatimeSync.worker.ts");
  const bundled = path.join(cwd, ".next/server/wakatime-sync-worker.js");
  const bunContainer = "/usr/local/bin/bun-container";
  const launch = fs.existsSync(source) && fs.existsSync(bunContainer)
    ? { executable: bunContainer, workerPath: source }
    : fs.existsSync(bundled)
      ? { executable: process.execPath, workerPath: bundled }
      : { executable: process.execPath, workerPath: source };
  const { spawn } = await import("node:child_process");
  const useNice = fs.existsSync("/usr/bin/nice");
  const child = spawn(useNice ? "/usr/bin/nice" : launch.executable, [
    ...(useNice ? ["-n", "10", launch.executable] : []),
    launch.workerPath,
  ], {
    cwd,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...withoutWakatimeCredential(process.env),
      LLV_WAKATIME_SYNC_WORKER: "1",
    },
  });
  wakatimeWorkerStore.__llvWakatimeWorker = child;
  child.once("error", (error) => {
    console.error("[wakatime] worker_start_failed", { message: error.message });
  });
  child.once("exit", (code, signal) => {
    if (wakatimeWorkerStore.__llvWakatimeWorker === child) {
      wakatimeWorkerStore.__llvWakatimeWorker = undefined;
    }
    if (wakatimeWorkerStore.__llvWakatimeWorkerRestart) return;
    console.error("[wakatime] worker_exited", { code, signal });
    const timer = setTimeout(() => {
      wakatimeWorkerStore.__llvWakatimeWorkerRestart = undefined;
      void startWakatimeWorker();
    }, WAKATIME_WORKER_RESTART_MS);
    timer.unref?.();
    wakatimeWorkerStore.__llvWakatimeWorkerRestart = timer;
  });
}

export async function runStructuredHostStartup(
  adopt: () => Promise<unknown>,
  log: (...args: unknown[]) => void = console.error,
  options: StructuredHostStartupOptions = {},
): Promise<void> {
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const maxRetryMs = options.maxRetryMs ?? 1_000;
  const jitterRatio = Math.min(Math.max(options.jitterRatio ?? 0.2, 0), 1);
  const random = options.random ?? Math.random;
  let retryMs = options.initialRetryMs ?? 100;
  let retryPending = false;
  let attempts = 0;
  let resolveReady: (() => void) | null = null;
  let rejectReady: ((error: unknown) => void) | null = null;
  const ready = options.waitUntilReady
    ? new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; })
    : null;

  const attempt = async (): Promise<void> => {
    attempts += 1;
    try {
      await adopt();
      markStructuredHostStartupReady();
      resolveReady?.();
      if (attempts > 1) log("[structured hosts] startup adoption recovered", { attempts });
    } catch (error) {
      markStructuredHostStartupFailed();
      if (error instanceof StructuredRuntimeRequirementError) {
        log("[structured hosts] startup adoption failed", error);
        rejectReady?.(error);
        throw error;
      }
      if (retryPending) return;
      const jitter = 1 + ((Math.min(Math.max(random(), 0), 1) * 2) - 1) * jitterRatio;
      const delayMs = Math.min(maxRetryMs, Math.max(0, Math.round(retryMs * jitter)));
      retryMs = Math.min(retryMs * 2, maxRetryMs);
      retryPending = true;
      if (attempts === 1) log("[structured hosts] startup adoption failed; retry scheduled", error);
      schedule(() => {
        retryPending = false;
        void attempt().catch((retryError) => {
          log("[structured hosts] startup adoption retry aborted", retryError);
        });
      }, delayMs).unref?.();
    }
  };

  await attempt();
  await ready;
}

export async function completeViewerRuntimeActivation(
  steps: ViewerRuntimeActivationSteps,
): Promise<void> {
  await steps.initializeOperatorCapability();
  await steps.startWakatime();
  steps.publishHotStateActivation();
  steps.startStructuredHosts?.();
  await steps.startControllers();
  steps.publishViewerReleaseReady();
}

/** The full node-runtime startup sequence `src/instrumentation.ts` defers to. */
export async function registerViewerRuntime(): Promise<void> {
  discardWakatimeEnvironmentCredential();
  const isCurrent = () => viewerReleaseOwnsTraffic();
  const hotStateDirectory = path.dirname(statePath("state.sqlite"));
  const releaseRevision = () => hotStateWriterRevision(hotStateDirectory);
  let activatedReleaseRevision: string | null = null;
  await activateViewerRuntimeWhenCurrent(async () => {
    const boundary = await establishHotStateCutoverBoundary(isCurrent);
    activatedReleaseRevision = boundary.authority?.releaseRevision ?? null;
    const authority = await initializeHotStateStoresAtStartup(boundary);
    let activatedAuthority: HotStateAuthority | null = null;
    await completeViewerRuntimeActivation({
      initializeOperatorCapability: initializeOperatorSpawnCapabilityAtStartup,
      startWakatime: startWakatimeIntegrationIfEnabled,
      startStructuredHosts: structuredHostsEnabled()
        ? () => {
            void (async () => {
              const { adoptStructuredHostsAtStartup } = await import("@/lib/runtime/startup");
              await runStructuredHostStartup(adoptStructuredHostsAtStartup, console.error, { waitUntilReady: true });
            })()
              .catch((error) => console.error("[structured hosts] background startup aborted", error));
          }
        : null,
      startControllers: startCurrentReleaseControllers,
      publishHotStateActivation: () => {
        if (authority) activatedAuthority = markHotStateActivationReady(hotStateDirectory, authority);
      },
      publishViewerReleaseReady: () => {
        if (activatedAuthority) markViewerReleaseReady(hotStateDirectory, activatedAuthority);
      },
    });
  }, isCurrent, {
    fenceRequest: () => {
      const revision = releaseRevision();
      const authority = readHotStateAuthority(hotStateDirectory);
      return revision !== null
        && authority?.mode === "fencing"
        && authority.releaseRevision === revision
        ? authority
        : null;
    },
    onFenceRequested: async (request) => {
      const revisions = await checkpointHotStateRollbackMirrorsForDemotion();
      const { agentRegistry } = await import("@/lib/agent/registry");
      agentRegistry().checkpointRollbackMirrorForDemotion();
      acknowledgeHotStateFence(hotStateDirectory, request, revisions);
    },
    onDemoted: ({ fenced }) => completeViewerReleaseDemotion(async () => {
      if (fenced) return;
      const authority = readHotStateAuthority(hotStateDirectory);
      if (!activatedReleaseRevision
        || authority?.releaseRevision !== activatedReleaseRevision
        || (authority.mode !== "sqlite" && authority.mode !== "fencing")) return;
      const { agentRegistry } = await import("@/lib/agent/registry");
      await checkpointHotStateRollbackMirrorsForDemotion();
      agentRegistry().checkpointRollbackMirrorForDemotion();
    }),
  });
}
