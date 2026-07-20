import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import { RuntimeHostUnavailableError } from "@/lib/runtime/client";
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
}

interface ViewerReleaseActivationOptions {
  pollMs?: number;
  schedule?: (callback: () => void, delayMs: number) => ActivationTimer;
  log?: (...args: unknown[]) => void;
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
  const start = async () => {
    if (started) return;
    started = true;
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

export async function initializeOperatorSpawnCapabilityAtStartup(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const { ensureOperatorSpawnCapability, rotateOperatorSpawnCapability } = await import("@/lib/agent/operatorCapability");
  if (env.LLV_ROTATE_OPERATOR_SPAWN_CAPABILITY === "1") rotateOperatorSpawnCapability();
  else ensureOperatorSpawnCapability();
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
      if (!(error instanceof RuntimeHostUnavailableError)) {
        log("[structured hosts] startup adoption failed", error);
        return;
      }
      if (retryPending) return;
      const delayMs = retryMs;
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
    if (process.env.LLV_STRUCTURED_HOSTS === "1") {
      const { adoptStructuredHostsAtStartup } = await import("@/lib/runtime/startup");
      await runStructuredHostStartup(adoptStructuredHostsAtStartup);
    }
    if (process.env.LLV_ACCOUNT_CONTROLLER_DISABLED !== "1") {
      const { startAccountMigrationController } = await import("@/lib/accounts/migration/controller");
      scheduleAccountMigrationController(startAccountMigrationController, accountControllerDelayMs());
    }
  }, () => viewerReleaseOwnsTraffic());
}
