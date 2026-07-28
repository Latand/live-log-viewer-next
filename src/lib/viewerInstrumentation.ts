import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import { structuredHostsEnabled } from "@/lib/runtime/flags";
import { markStructuredHostStartupFailed, markStructuredHostStartupReady } from "@/lib/runtime/startupStatus";
import { StructuredRuntimeRequirementError } from "@/lib/proc/darwinIdentity";
import { discardWakatimeEnvironmentCredential } from "@/lib/wakatime/credential";

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

interface ActivationTimer {
  unref?(): unknown;
}

interface StructuredHostStartupOptions {
  schedule?: (callback: () => void, delayMs: number) => ActivationTimer;
  initialRetryMs?: number;
  maxRetryMs?: number;
  jitterRatio?: number;
  random?: () => number;
}

interface ViewerReleaseActivationOptions {
  pollMs?: number;
  schedule?: (callback: () => void, delayMs: number) => ActivationTimer;
  log?: (...args: unknown[]) => void;
  onDemoted?: () => void | Promise<void>;
}

interface CurrentReleaseControllerLoaders {
  loadFlowPipelineController: () => Promise<{ startFlowPipelineController: () => void }>;
  loadAccountMigrationController: () => Promise<{ startAccountMigrationController: () => Promise<void> }>;
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
  const monitor = () => {
    if (demoted) return;
    if (started && !isCurrent()) {
      demoted = true;
      void Promise.resolve(options.onDemoted?.()).catch((error) => {
        log("[viewer release] demotion checkpoint failed", error);
      });
      return;
    }
    schedule(monitor, pollMs).unref?.();
  };
  const start = async () => {
    if (started) return;
    started = true;
    await activate();
    schedule(monitor, pollMs).unref?.();
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

export async function startCurrentReleaseControllers(
  env: Readonly<Record<string, string | undefined>> = process.env,
  loaders: CurrentReleaseControllerLoaders = {
    loadFlowPipelineController: () => import("@/lib/pipelines/controller"),
    loadAccountMigrationController: () => import("@/lib/accounts/migration/controller"),
  },
): Promise<void> {
  const { startFlowPipelineController } = await loaders.loadFlowPipelineController();
  startFlowPipelineController();
  if (env.LLV_ACCOUNT_CONTROLLER_DISABLED === "1") return;
  const { startAccountMigrationController } = await loaders.loadAccountMigrationController();
  scheduleAccountMigrationController(startAccountMigrationController, accountControllerDelayMs(env));
}

/**
 * Hand the operator key to a channel that is NOT captured output (#691 round 10).
 *
 * `console.error` is stderr, and under the managed/detached start stderr belongs to
 * the container logging driver, which writes it to a JSON file on disk. A bearer in a
 * log file is a bearer at rest, readable by every same-uid process — the same defect
 * as the served page and the state file, arriving through the one channel that looked
 * like it was only for humans.
 *
 * Two acceptable sinks, both of which vanish when the process ends:
 *
 * - the CONTROLLING TERMINAL (`/dev/tty`), which exists only for an interactive
 *   launch and is never the log stream, even when stdout and stderr are redirected;
 * - an inherited FILE DESCRIPTOR named by `LLV_OPERATOR_KEY_FD`, for a supervisor
 *   that wants to collect the key over a pipe without it touching a log.
 *
 * When neither exists — precisely the detached case — NOTHING IS EMITTED. The startup
 * says so in a line carrying no key material, and operator-only actions stay locked
 * until the operator starts the Viewer somewhere they can read it. Silence is the
 * correct behaviour: a key nobody can safely receive should not be broadcast.
 *
 * Returns where it went, so the caller can log THAT rather than the key.
 */
export function emitOperatorKey(
  capability: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  writeTo: (target: string | number, line: string) => void = (target, line) => {
    fs.writeFileSync(typeof target === "number" ? target : target, line);
  },
): "tty" | "fd" | "withheld" {
  const line = `${capability}\n`;

  const descriptor = Number.parseInt(env.LLV_OPERATOR_KEY_FD?.trim() ?? "", 10);
  if (Number.isInteger(descriptor) && descriptor > 2) {
    try {
      writeTo(descriptor, line);
      return "fd";
    } catch {
      /* The supervisor closed it; fall through rather than falling back to stderr. */
    }
  }

  try {
    writeTo("/dev/tty", line);
    return "tty";
  } catch {
    /* No controlling terminal: detached, containerised, or supervised. */
  }
  return "withheld";
}

export async function initializeOperatorSpawnCapabilityAtStartup(
  env: Readonly<Record<string, string | undefined>> = process.env,
  log: (line: string) => void = (line) => console.error(line),
  emit: typeof emitOperatorKey = emitOperatorKey,
): Promise<void> {
  const { ensureOperatorSpawnCapability, rotateOperatorSpawnCapability } = await import("@/lib/agent/operatorCapability");
  if (env.LLV_ROTATE_OPERATOR_SPAWN_CAPABILITY === "1") rotateOperatorSpawnCapability();
  else ensureOperatorSpawnCapability();

  /* The key is the in-memory session secret, never the on-disk spawn capability: a
     file every worker can read is not a credential. */
  const { operatorSessionSecret } = await import("@/lib/agent/operatorSession");
  const delivered = emit(operatorSessionSecret(), env);

  const port = env.PORT?.trim() || "8898";
  const origin = `http://127.0.0.1:${port}`;
  /* Every line below is key-free by construction. Nothing here may interpolate the
     capability: this function's output IS the captured log. */
  log(`[viewer] Open ${origin}.`);
  log(delivered === "withheld"
    ? "[viewer] operator key withheld: no controlling terminal and no LLV_OPERATOR_KEY_FD, so there is no channel that is not a log. Operator-only actions stay locked; start the Viewer from a terminal to receive one."
    : `[viewer] operator key written to ${delivered === "tty" ? "this terminal" : "the supervisor's descriptor"}; paste it into the Viewer to unlock operator-only actions.`);
  log("[viewer] Without the key everything still shows; designation and voice transport controls stand down.");
}

export async function startWakatimeIntegrationIfEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
  start: () => Promise<void> = async () => {
    const { startWakatimeSync } = await import("@/lib/wakatime/sync");
    startWakatimeSync();
  },
  log: (event: string, fields: Readonly<Record<string, never>>) => void = (event, fields) => console.error(event, fields),
): Promise<void> {
  if (env.LLV_WAKATIME_ENABLED !== "1") return;
  try {
    await start();
  } catch {
    log("[wakatime] startup_failed", {});
  }
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

  const attempt = async (): Promise<void> => {
    attempts += 1;
    try {
      await adopt();
      markStructuredHostStartupReady();
      if (attempts > 1) log("[structured hosts] startup adoption recovered", { attempts });
    } catch (error) {
      markStructuredHostStartupFailed();
      if (error instanceof StructuredRuntimeRequirementError) {
        log("[structured hosts] startup adoption failed", error);
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
}

/** The full node-runtime startup sequence `src/instrumentation.ts` defers to. */
export async function registerViewerRuntime(): Promise<void> {
  discardWakatimeEnvironmentCredential();
  await activateViewerRuntimeWhenCurrent(async () => {
    await initializeOperatorSpawnCapabilityAtStartup();
    await startWakatimeIntegrationIfEnabled();
    if (structuredHostsEnabled()) {
      const { adoptStructuredHostsAtStartup } = await import("@/lib/runtime/startup");
      await runStructuredHostStartup(adoptStructuredHostsAtStartup);
    }
    await startCurrentReleaseControllers();
  }, () => viewerReleaseOwnsTraffic(), {
    onDemoted: () => completeViewerReleaseDemotion(async () => {
        const { agentRegistry } = await import("@/lib/agent/registry");
        agentRegistry().checkpointRollbackMirrorForDemotion();
    }),
  });
}
