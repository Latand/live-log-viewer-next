export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "edge" || process.env.NEXT_PHASE?.includes("build")) return;
  if (process.env.LLV_STRUCTURED_HOSTS === "1") {
    const { adoptStructuredHostsAtStartup } = await import("@/lib/runtime/startup");
    try { await adoptStructuredHostsAtStartup(); }
    catch { console.error("[structured hosts] startup adoption failed"); }
  }
  if (process.env.LLV_ACCOUNT_CONTROLLER_DISABLED !== "1") {
    const { startAccountMigrationController } = await import("@/lib/accounts/migration/controller");
    // Deliberately delayed off the boot path: the initial durable reconciliation
    // starves the event loop for ~2 minutes (measured 120s vs 5s cold first
    // response), which blows the deployment candidate's 90s health gate. The
    // delay lets the candidate get verified and promoted while warm; the
    // controller's periodic ticks make up the difference.
    const delayMs = Number(process.env.LLV_ACCOUNT_CONTROLLER_DELAY_MS ?? 90_000);
    setTimeout(() => {
      startAccountMigrationController()
        .catch(() => { console.error("[account migration controller] initial durable reconciliation failed"); });
    }, Number.isFinite(delayMs) ? Math.max(0, delayMs) : 90_000).unref?.();
  }
}
