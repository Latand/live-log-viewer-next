import fs from "node:fs";

import { Database } from "bun:sqlite";

import { AgentRegistry } from "./registry";

const [action, filename, ready, release, label = "writer", countText = "0", resultFile] = process.argv.slice(2);
if (!action || !filename || !ready || !release) throw new Error("registry child arguments are required");

function waitFor(pathname: string): void {
  while (!fs.existsSync(pathname)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
}

if (action === "dual-startup") {
  new AgentRegistry(filename, undefined, undefined, {
    sqliteMode: "dual-write",
    beforeDualWriteStartupReplace: () => {
      fs.writeFileSync(ready, "ready");
      waitFor(release);
    },
  });
  process.exit(0);
}

if (action === "transition-writer") {
  const registry = new AgentRegistry(filename, undefined, undefined, {
    sqliteMode: label as "read" | "sqlite",
  });
  fs.writeFileSync(ready, "ready");
  waitFor(release);
  if (resultFile) fs.writeFileSync(resultFile, "attempted");
  registry.ensureConversation("codex", `/sessions/${label}.jsonl`, label);
  if (resultFile) fs.writeFileSync(`${resultFile}.done`, "done");
  process.exit(0);
}

if (action === "dual-writer") {
  fs.writeFileSync(ready, "ready");
  waitFor(release);
  if (resultFile) fs.writeFileSync(resultFile, "attempted");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "dual-write" });
  registry.ensureConversation("codex", `/sessions/${label}.jsonl`, label);
  if (resultFile) fs.writeFileSync(`${resultFile}.done`, "done");
  process.exit(0);
}

if (action === "writer" || action === "writer-json" || action === "writer-sqlite" || action === "writer-mixed") {
  const sqliteMode = action === "writer-json" ? "off"
    : action === "writer-sqlite" || action === "writer-mixed" ? "sqlite"
    : "read";
  const writerWaits: number[] = [];
  const registry = new AgentRegistry(filename, undefined, undefined, {
    sqliteMode,
    onSqliteWriterWait: (durationMs) => writerWaits.push(durationMs),
  });
  fs.writeFileSync(ready, "ready");
  waitFor(release);
  const durations: number[] = [];
  const key = { engine: "codex" as const, sessionId: label };
  const baseHost = {
    kind: "codex-app-server" as const,
    endpoint: `stdio:${label}`,
    process: { pid: process.pid, startIdentity: `${process.pid}:${label}` },
    eventCursor: 0,
    protocolVersion: "1",
    writerClaimEpoch: 0,
    activeTurnRef: null,
    pendingAttention: [],
    activeFlags: [],
  };
  let claim: ReturnType<AgentRegistry["claimStructuredHost"]> = null;
  if (action === "writer-mixed") {
    registry.upsert({
      key, artifactPath: `/sessions/${label}.jsonl`, cwd: "/repo", accountId: "work",
      status: "unhosted", host: null, structuredHost: baseHost, claimEpoch: 0, claimOwner: null, pendingAction: null,
    });
    claim = registry.claimStructuredHost(key, { pid: process.pid, startIdentity: `${process.pid}:${label}` }, { allowUnhosted: true });
    if (!claim?.claimOwner) throw new Error("mixed writer claim is required");
  }
  for (let index = 0; index < Number(countText); index += 1) {
    const suffix = `${label}-${String(index).padStart(3, "0")}`;
    const startedAt = performance.now();
    if (action === "writer-mixed") {
      const material = index % 4 === 3;
      const released = index === Number(countText) - 1;
      const updated = registry.setStructuredHostClaimed(key, {
        ...baseHost,
        writerClaimEpoch: claim!.claimEpoch,
        eventCursor: index + 1,
        activeTurnRef: material && !released ? `turn-${index}` : null,
        pendingAttention: material && !released ? [`attention-${index}`] : [],
        endpoint: released ? "stdio:released" : baseHost.endpoint,
        process: released ? null : baseHost.process,
      }, released ? "unhosted" : "live", claim!.claimOwner!, claim!.claimEpoch, released);
      if (!updated) throw new Error("mixed writer lost its claim");
    } else registry.ensureConversation("codex", `/sessions/${suffix}.jsonl`, label);
    durations.push(performance.now() - startedAt);
  }
  if (resultFile) fs.writeFileSync(resultFile, JSON.stringify({ durations, writerWaits }));
  process.exit(0);
}

if (action === "reader-sqlite") {
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  fs.writeFileSync(ready, "ready");
  waitFor(release);
  const durations: number[] = [];
  for (let index = 0; index < Number(countText); index += 1) {
    const startedAt = performance.now();
    registry.readOnlySnapshot();
    durations.push(performance.now() - startedAt);
  }
  if (resultFile) fs.writeFileSync(resultFile, JSON.stringify({ durations }));
  process.exit(0);
}

const sqliteFilename = filename.endsWith(".json") ? `${filename.slice(0, -5)}.sqlite` : `${filename}.sqlite`;
const db = new Database(sqliteFilename, { strict: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
const source = db.query<{ value_json: string }, []>(
  "SELECT value_json FROM registry_rows WHERE collection = 'conversations' LIMIT 1",
).get();
if (!source) throw new Error("a source conversation is required");
const injected = JSON.parse(source.value_json) as { id: string; generations: Array<{ path: string }> };
injected.id = "conversation_crash_mid_write";
for (const generation of injected.generations) generation.path = "/sessions/crash-mid-write.jsonl";
db.query(`
  INSERT INTO registry_rows(collection, row_key, value_json, row_order)
  SELECT 'conversations', ?, ?, COALESCE(MAX(row_order) + 1, 0)
  FROM registry_rows WHERE collection = 'conversations'
`).run(injected.id, JSON.stringify(injected));
fs.writeFileSync(ready, "ready");

if (action === "crash") process.exit(73);
if (action === "commit-crash") {
  db.query("UPDATE registry_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'").run();
  db.exec("COMMIT");
  process.exit(74);
}
waitFor(release);
db.exec("COMMIT");
db.close();
