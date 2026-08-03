/* Issue #863 RED proof. Runs the real MCP tool service against a 500-pipeline
   nested-history registry in an isolated LLV_STATE_DIR and asserts the four
   acceptance properties the repair must establish. Every assertion below fails
   on the current implementation; none of them touch live state.

   Kept as a script rather than a `.test.ts` so `bun test` on this branch stays
   green while the repair itself is fenced behind PR #859's ownership of
   src/lib/mcp/bindings.ts and src/lib/mcp/server.ts. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { seedPipelineCorpus } from "./corpus";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-863-red-"));
process.env.LLV_STATE_DIR = sandbox;

const PIPELINE_COUNT = Number(process.env.COUNT ?? 500);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 8);
/* A list row is a board card: identity, project, state, cursor, counts. Nested
   stage prompts, attempt inputs/outputs and specs belong to get_pipeline. 64 KB
   per row leaves generous headroom over that shape. */
const ROW_BUDGET_BYTES = 64 * 1024;
const LIST_DEADLINE_MS = 5_000;

const registryBytes = seedPipelineCorpus(PIPELINE_COUNT);

const { createMcpToolService, SqliteMcpReceiptStore, McpToolTimingAggregate } = await import("@/lib/mcp/server");
const { viewerMcpBindings } = await import("@/lib/mcp/bindings");

const timings = new McpToolTimingAggregate();
const service = createMcpToolService(
  viewerMcpBindings(),
  new SqliteMcpReceiptStore(path.join(sandbox, "mcp-receipts.sqlite")),
  undefined,
  { timings },
);

const failures: string[] = [];
const expect = (label: string, held: boolean, detail: string) => {
  console.log(`${held ? "PASS" : "RED "} ${label} — ${detail}`);
  if (!held) failures.push(label);
};

const call = (index: number, args: Record<string, unknown>, deadlineMs = 30_000) =>
  service.callTool("list_pipelines", {
    clientRequestId: `red-${index}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ...args,
  }, { deadlineAt: Date.now() + deadlineMs });

/* AC: list rows exclude nested prompts, transcript tails and attempt history. */
const single = await call(0, { project: "viewer", includeClosed: false, limit: 100 }) as unknown as {
  count: number;
  pipelines: { id: string; project: string; state: string; runs?: unknown; stages?: { prompt?: string }[]; spec?: string }[];
};
const rowBytes = Buffer.byteLength(JSON.stringify(single.pipelines)) / Math.max(1, single.pipelines.length);
expect(
  "bounded list rows",
  rowBytes <= ROW_BUDGET_BYTES,
  `${(rowBytes / 1024).toFixed(0)} KB per row (budget ${ROW_BUDGET_BYTES / 1024} KB)`,
);
const carriesHistory = single.pipelines.some((row) => Array.isArray((row as { runs?: unknown[] }).runs)
  && ((row as { runs: { attempts?: unknown[] }[] }).runs).some((run) => (run.attempts?.length ?? 0) > 0));
expect("no attempt history in list rows", !carriesHistory, carriesHistory ? "rows carry runs[].attempts[]" : "rows carry no attempts");
const carriesPrompts = single.pipelines.some((row) => (row.stages ?? []).some((stage) => typeof stage.prompt === "string"));
expect("no stage prompts in list rows", !carriesPrompts, carriesPrompts ? "rows carry stages[].prompt" : "rows carry no prompts");
const carriesSpec = single.pipelines.some((row) => typeof row.spec === "string");
expect("no spec body in list rows", !carriesSpec, carriesSpec ? "rows carry spec" : "rows carry no spec");

/* AC: HTTP and MCP agree on filters, ordering and count. */
const { getPipelines } = await import("@/lib/pipelines/engine");
const httpRows = getPipelines().pipelines
  .filter((pipeline) => pipeline.project === "viewer")
  .filter((pipeline) => pipeline.state !== "closed")
  .slice(0, 100);
expect(
  "HTTP/MCP count parity",
  httpRows.length === single.count,
  `http ${httpRows.length} vs mcp ${single.count}`,
);
expect(
  "HTTP/MCP ordering parity",
  httpRows.map((pipeline) => pipeline.id).join(",") === single.pipelines.map((row) => row.id).join(","),
  "id sequences compared",
);

/* AC: production-shaped concurrency stays inside a deadline without unbounded RSS. */
Bun.gc(true);
const rssBefore = process.memoryUsage.rss();
const started = performance.now();
const concurrent = await Promise.all(Array.from({ length: CONCURRENCY }, (_value, index) =>
  call(index + 1, { project: "viewer", includeClosed: false, limit: 100 })));
const wallMs = performance.now() - started;
const rssPeak = process.memoryUsage.rss();
expect(
  `concurrent x${CONCURRENCY} within ${LIST_DEADLINE_MS} ms`,
  wallMs <= LIST_DEADLINE_MS,
  `${wallMs.toFixed(0)} ms wall`,
);
expect(
  "bounded RSS growth under concurrency",
  rssPeak - rssBefore <= 256e6,
  `+${((rssPeak - rssBefore) / 1e6).toFixed(0)} MB (${(rssBefore / 1e6).toFixed(0)} → ${(rssPeak / 1e6).toFixed(0)} MB)`,
);
expect("all concurrent calls succeeded", concurrent.every((result) => result.ok), `${concurrent.filter((r) => r.ok).length}/${CONCURRENCY} ok`);

const summary = timings.snapshot().find((entry) => entry.toolName === "list_pipelines");
console.log(`\nregistry ${(registryBytes / 1e6).toFixed(1)} MB · ${PIPELINE_COUNT} pipelines · concurrency ${CONCURRENCY}`);
if (summary) {
  for (const [phase, measure] of Object.entries(summary.phases)) {
    if (measure.samples === 0) continue;
    console.log(`  ${phase.padEnd(14)} n=${measure.samples} p95=${measure.p95.toFixed(0)} ms max=${measure.max.toFixed(0)} ms`);
  }
  console.log(`  resultSize     max=${(summary.resultSizeBytes.max / 1e6).toFixed(2)} MB`);
}
fs.rmSync(sandbox, { recursive: true, force: true });

console.log(`\n${failures.length === 0 ? "GREEN" : `RED (${failures.length}): ${failures.join("; ")}`}`);
process.exit(failures.length === 0 ? 0 : 1);
