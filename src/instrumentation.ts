export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "edge" || process.env.NEXT_PHASE?.includes("build")) return;
  if (process.env.LLV_ACCOUNT_CONTROLLER_DISABLED === "1") return;
  const { startAccountMigrationController } = await import("@/lib/accounts/migration/controller");
  try { await startAccountMigrationController(); }
  catch { console.error("[account migration controller] initial durable reconciliation failed"); }
}
