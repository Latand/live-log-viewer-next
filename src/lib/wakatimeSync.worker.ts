import { startWakatimeSync } from "./wakatime/sync";
import { startWorktimeController } from "./worktime/runtime";

startWakatimeSync();
startWorktimeController();

// The scheduler's own timers are unref'ed for the Viewer runtime. This
// sidecar owns the integration and stays alive with one lightweight handle.
setInterval(() => undefined, 60_000);
