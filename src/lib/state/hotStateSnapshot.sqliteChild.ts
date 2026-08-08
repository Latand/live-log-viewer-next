import fs from "node:fs";

import type { Flow } from "@/lib/flows/types";
import { SqliteStateCollection } from "./sqliteStateStore";

const [database, cachedFile, beginFile, snapshotFile, releaseFile, resultFile] = process.argv.slice(2);
if (!database || !cachedFile || !beginFile || !snapshotFile || !releaseFile || !resultFile) {
  throw new Error("snapshot child arguments are required");
}

function waitFor(filename: string): void {
  while (!fs.existsSync(filename)) Bun.sleepSync(5);
}

const store = new SqliteStateCollection<Flow>(database, {
  collection: "flows",
  schemaVersion: 3,
  busyMessage: "flow state is busy",
  key: (flow) => flow.id,
  decode: (value) => value as Flow,
  clone: (flow) => structuredClone(flow),
  onIncrementalReadSnapshot: () => {
    fs.writeFileSync(snapshotFile, "ready");
    waitFor(releaseFile);
  },
});

store.snapshot();
fs.writeFileSync(cachedFile, "ready");
waitFor(beginFile);
fs.writeFileSync(resultFile, JSON.stringify(store.snapshot()));
