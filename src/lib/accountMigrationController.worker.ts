import { startAccountMigrationController } from "./accounts/migration/controller";

await startAccountMigrationController();

// Controller timers are deliberately unref'ed in the Viewer process. This
// sidecar owns the periodic inventory, so it keeps one lightweight reference
// until its container generation exits.
setInterval(() => undefined, 60_000);
