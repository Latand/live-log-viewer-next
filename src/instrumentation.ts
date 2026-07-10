export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "edge" || process.env.NEXT_PHASE?.includes("build")) return;
  const { startAccountMigrationController } = await import("@/lib/accounts/migration/controller");
  try { await startAccountMigrationController(); }
  catch { console.error("[account migration controller] initial durable reconciliation failed"); }
}
