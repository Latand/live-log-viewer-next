import { statePath } from "@/lib/configDir";
import { createServerRuntimeConsumers } from "@/lib/runtime/serverConsumers";

import { RuntimeHost, RuntimeHostFence } from "./host";
import { RuntimeJournal } from "./journal";
import { createLegacyRuntimeScheduler } from "./legacyScheduler";
import { serveRuntimeHost } from "./socket";

const socketPath = process.env.LLV_RUNTIME_HOST_SOCKET || statePath("runtime-host.sock");
if (process.env.LLV_RUNTIME_EVENTS !== "1") throw new Error("runtime host activation requires LLV_RUNTIME_EVENTS=1");
if (process.env.LLV_RUNTIME_LEGACY_SCHEDULER === "1" && process.env.LLV_ACCOUNT_CONTROLLER_DISABLED !== "1") {
  throw new Error("runtime legacy scheduler requires LLV_ACCOUNT_CONTROLLER_DISABLED=1 to preserve single-writer reconciliation");
}
const fence = new RuntimeHostFence(`${socketPath}.lock`);
fence.acquire();
const journal = new RuntimeJournal(process.env.LLV_RUNTIME_JOURNAL || statePath("runtime-events.sqlite"));
if (journal.isWritable()) journal.claimHostEpoch();
const host = new RuntimeHost(journal, createServerRuntimeConsumers());
if (journal.isWritable()) await host.recoverConsumers();
const server = serveRuntimeHost(socketPath, host);
const legacyScheduler = process.env.LLV_RUNTIME_LEGACY_SCHEDULER === "1" ? createLegacyRuntimeScheduler(journal) : null;
const legacyTimer = legacyScheduler ? setInterval(() => {
  void legacyScheduler.runDue().catch(() => console.error("[runtime scheduler] tick failed; next tick will retry"));
}, 1_000) : null;

function stop(): void {
  if (legacyTimer) clearInterval(legacyTimer);
  server.close(() => {
    journal.close();
    fence.release();
  });
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
