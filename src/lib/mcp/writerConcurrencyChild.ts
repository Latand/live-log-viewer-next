import fs from "node:fs";
import path from "node:path";

import { NextRequest } from "next/server";

const stateDir = process.env.LLV_STATE_DIR;
const kind = process.env.LLV_WRITER_KIND ?? "task";
const writer = process.env.LLV_WRITER_INTERFACE;
const readyPath = process.env.LLV_WRITER_READY;
const releasePath = process.env.LLV_WRITER_RELEASE;

if (!stateDir || !writer || !readyPath || !releasePath) throw new Error("writer concurrency fixture is incomplete");

const stateFile = path.join(stateDir, `${kind}s.json`);
const originalReadFileSync = fs.readFileSync.bind(fs);
let gated = false;

fs.readFileSync = ((filePath: fs.PathOrFileDescriptor, ...args: unknown[]) => {
  if (gated || String(filePath) !== stateFile) {
    return originalReadFileSync(filePath, ...(args as Parameters<typeof fs.readFileSync> extends [unknown, ...infer Rest] ? Rest : never));
  }
  gated = true;
  const value = originalReadFileSync(filePath, ...(args as Parameters<typeof fs.readFileSync> extends [unknown, ...infer Rest] ? Rest : never));
  fs.writeFileSync(readyPath, "ready\n", "utf8");
  while (!fs.existsSync(releasePath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  return value;
}) as typeof fs.readFileSync;

if (kind === "task" && writer === "http") {
  const input = { project: "viewer", text: `${writer} task`, placement: "unplaced" as const, clientRequestId: `${writer}-task-request` };
  const { POST } = await import("@/app/api/tasks/route");
  const response = await POST(new NextRequest("http://127.0.0.1/api/tasks", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
  if (!response.ok) throw new Error(`HTTP task create failed: ${response.status} ${await response.text()}`);
} else if (kind === "task" && writer === "mcp") {
  const input = { project: "viewer", text: `${writer} task`, placement: "unplaced" as const, clientRequestId: `${writer}-task-request` };
  const { viewerMcpBindings } = await import("./bindings");
  await viewerMcpBindings().create_task(input);
} else if (kind === "pipeline" && writer === "http") {
  const input = { task: `${writer} pipeline`, repoDir: process.cwd(), autoStart: false, stages: [] };
  const { POST } = await import("@/app/api/pipelines/route");
  const response = await POST(new NextRequest("http://127.0.0.1/api/pipelines", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
  if (!response.ok) throw new Error(`HTTP pipeline create failed: ${response.status} ${await response.text()}`);
} else if (kind === "pipeline" && writer === "mcp") {
  const { viewerMcpBindings } = await import("./bindings");
  await viewerMcpBindings().create_pipeline({
    task: `${writer} pipeline`,
    repoDir: process.cwd(),
    autoStart: false,
    stages: [],
    clientRequestId: `${writer}-pipeline-request`,
  });
} else {
  throw new Error(`unknown writer: ${kind}/${writer}`);
}
