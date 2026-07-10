import { statePath } from "@/lib/configDir";

import { RuntimeHost, RuntimeHostFence } from "./host";
import { RuntimeJournal } from "./journal";
import { createLegacyRuntimeScheduler } from "./legacyScheduler";
import { serveRuntimeHost } from "./socket";

const socketPath = process.env.LLV_RUNTIME_HOST_SOCKET || statePath("runtime-host.sock");
if (process.env.LLV_RUNTIME_EVENTS !== "1") throw new Error("runtime host activation requires LLV_RUNTIME_EVENTS=1");
const fence = new RuntimeHostFence(`${socketPath}.lock`);
fence.acquire();
const journal = new RuntimeJournal(process.env.LLV_RUNTIME_JOURNAL || statePath("runtime-events.sqlite"));
const server = serveRuntimeHost(socketPath, new RuntimeHost(journal));
const legacyScheduler = process.env.LLV_RUNTIME_LEGACY_SCHEDULER === "1" ? createLegacyRuntimeScheduler() : null;
const legacyTimer = legacyScheduler ? setInterval(() => void legacyScheduler.runDue(), 1_000) : null;

function stop(): void {
  if (legacyTimer) clearInterval(legacyTimer);
  server.close(() => journal.close());
  fence.release();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
