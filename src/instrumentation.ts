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

export async function runStructuredHostStartup(
  adopt: () => Promise<unknown>,
  log: (...args: unknown[]) => void = console.error,
): Promise<void> {
  try {
    await adopt();
  } catch (error) {
    log("[structured hosts] startup adoption failed", error);
  }
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "edge" || process.env.NEXT_PHASE?.includes("build")) return;
  await initializeOperatorSpawnCapabilityAtStartup();
  if (process.env.LLV_STRUCTURED_HOSTS === "1") {
    const { adoptStructuredHostsAtStartup } = await import("@/lib/runtime/startup");
    await runStructuredHostStartup(adoptStructuredHostsAtStartup);
  }
  if (process.env.LLV_ACCOUNT_CONTROLLER_DISABLED !== "1") {
    const { startAccountMigrationController } = await import("@/lib/accounts/migration/controller");
    scheduleAccountMigrationController(startAccountMigrationController, accountControllerDelayMs());
  }
}
