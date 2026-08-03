/* Issue #863 end-to-end phase profile: MCP entry → store read → filter/projection
   → redaction → receipt persistence → envelope serialization. Isolated state dir. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { seedPipelineCorpus } from "./corpus";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-863-e2e-"));
process.env.LLV_STATE_DIR = sandbox;

const registryBytes = seedPipelineCorpus(Number(process.env.COUNT ?? 500));

const { createMcpToolService, SqliteMcpReceiptStore, McpToolTimingAggregate } = await import("@/lib/mcp/server");
const { viewerMcpBindings } = await import("@/lib/mcp/bindings");

const timings = new McpToolTimingAggregate();
const service = createMcpToolService(
  viewerMcpBindings(),
  new SqliteMcpReceiptStore(path.join(sandbox, "mcp-receipts.sqlite")),
  undefined,
  { timings },
);

const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);
const started = performance.now();
const results = await Promise.all(Array.from({ length: CONCURRENCY }, (_value, index) =>
  service.callTool("list_pipelines", {
    clientRequestId: `profile-${index}-${Date.now()}`,
    project: "viewer",
    includeClosed: false,
    limit: 100,
  }, { deadlineAt: Date.now() + 30_000 })));
const wallMs = performance.now() - started;

const snapshot = timings.snapshot().find((entry) => entry.toolName === "list_pipelines");
console.log(`registry ${(registryBytes / 1e6).toFixed(1)} MB · concurrency ${CONCURRENCY}`);
console.log(`wall ${wallMs.toFixed(0)} ms · rss ${(process.memoryUsage.rss() / 1e6).toFixed(0)} MB`);
for (const result of results) {
  const payload = result as unknown as { count?: number; ok: boolean };
  console.log(`  ok=${payload.ok} count=${payload.count}`);
}
if (snapshot) {
  for (const [phase, measure] of Object.entries(snapshot.phases)) {
    if (measure.samples === 0) continue;
    console.log(`  ${phase.padEnd(16)} n=${measure.samples} p95=${measure.p95.toFixed(1)} ms max=${measure.max.toFixed(1)} ms total=${measure.total.toFixed(1)} ms`);
  }
  console.log(`  resultSizeBytes    max=${(snapshot.resultSizeBytes.max / 1e6).toFixed(2)} MB`);
}
fs.rmSync(sandbox, { recursive: true, force: true });
