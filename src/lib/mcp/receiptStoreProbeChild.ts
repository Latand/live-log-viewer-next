import fs from "node:fs";

import {
  MCP_TOOL_NAMES,
  SqliteMcpReceiptStore,
  createMcpToolService,
  type McpToolBindings,
} from "./server";

function waitFor(filename: string): void {
  while (!fs.existsSync(filename)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

const filename = process.argv[2]!;
const readyPath = process.argv[3]!;
const startPath = process.argv[4]!;
const ownerReadyPath = process.argv[5]!;
const ownerReleasePath = process.argv[6]!;
const ownerCountPath = process.argv[7]!;
const resultPath = process.argv[8]!;
const index = Number(process.argv[9]!);

const store = new SqliteMcpReceiptStore(filename);
let peakRssBytes = process.memoryUsage().rss;
fs.writeFileSync(readyPath, JSON.stringify({ index, steadyRssBytes: peakRssBytes }));
waitFor(startPath);

const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
bindings.list_tasks = async () => {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  fs.appendFileSync(ownerCountPath, `${index}\n`);
  fs.writeFileSync(ownerReadyPath, String(index), { flag: "wx" });
  waitFor(ownerReleasePath);
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  return { ownerIndex: index, count: 1 };
};

const startedAt = performance.now();
const result = await createMcpToolService(bindings, store).callTool("list_tasks", {
  clientRequestId: "twenty-process-owner",
  limit: 1,
});
peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
store.close();
fs.writeFileSync(resultPath, JSON.stringify({
  index,
  durationMs: performance.now() - startedAt,
  peakRssBytes,
  result,
}));
