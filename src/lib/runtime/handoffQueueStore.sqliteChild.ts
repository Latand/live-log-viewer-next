import fs from "node:fs";

import { HandoffQueue } from "./handoffQueue";
import { SqliteHandoffQueueStore } from "./handoffQueueStore";

const [filename, readyFile, releaseFile, action, value, delayText] = process.argv.slice(2);
if (!filename || !readyFile || !releaseFile || !action || !value) {
  throw new Error("handoff queue SQLite child arguments are incomplete");
}

const queue = new HandoffQueue(new SqliteHandoffQueueStore(filename));
fs.writeFileSync(readyFile, "ready");
while (!fs.existsSync(releaseFile)) Bun.sleepSync(5);
Bun.sleepSync(Number(delayText ?? "0"));

if (action === "claim") {
  const result = queue.claim("handoff_root_1", { fromGeneration: "gen-blue", toGeneration: value });
  process.stdout.write(JSON.stringify({ ok: result.ok, reason: result.reason ?? null }));
} else if (action === "admit") {
  const admitted = queue.admitMessage("handoff_unrelated", {
    deliveryId: value,
    clientMessageId: "client-unrelated",
    seq: 1,
  });
  process.stdout.write(JSON.stringify({ admitted }));
} else {
  throw new Error(`unknown handoff queue SQLite child action: ${action}`);
}
