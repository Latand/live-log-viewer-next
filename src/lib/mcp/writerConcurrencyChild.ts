import fs from "node:fs";
import path from "node:path";

import { NextRequest } from "next/server";

const stateDir = process.env.LLV_STATE_DIR;
const kind = process.env.LLV_WRITER_KIND ?? "task";
const writer = process.env.LLV_WRITER_INTERFACE;
const operation = process.env.LLV_WRITER_OPERATION ?? "create";
const readyPath = process.env.LLV_WRITER_READY;
const releasePath = process.env.LLV_WRITER_RELEASE;

if (!stateDir || !writer || !readyPath || !releasePath) throw new Error("writer concurrency fixture is incomplete");

if (process.env.LLV_WRITER_NO_PROCESS_IDENTITY === "1") {
  const { procBackend } = await import("@/lib/proc");
  procBackend.processIdentity = () => null;
}

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

if (kind === "task" && operation === "create" && writer === "http") {
  const input = { project: "viewer", text: `${writer} task`, placement: "unplaced" as const, clientRequestId: `${writer}-task-request` };
  const { POST } = await import("@/app/api/tasks/route");
  const response = await POST(new NextRequest("http://127.0.0.1/api/tasks", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
  if (!response.ok) throw new Error(`HTTP task create failed: ${response.status} ${await response.text()}`);
} else if (kind === "task" && operation === "create" && writer === "mcp") {
  const input = { project: "viewer", text: `${writer} task`, placement: "unplaced" as const, clientRequestId: `${writer}-task-request` };
  const { viewerMcpBindings } = await import("./bindings");
  await viewerMcpBindings().create_task(input);
} else if (kind === "task" && operation === "update" && writer === "http") {
  const { PATCH } = await import("@/app/api/tasks/[id]/route");
  const response = await PATCH(new NextRequest("http://127.0.0.1/api/tasks/task-http", {
    method: "PATCH",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ text: "http updated task" }),
  }), { params: Promise.resolve({ id: "task-http" }) });
  if (!response.ok) throw new Error(`HTTP task update failed: ${response.status} ${await response.text()}`);
} else if (kind === "task" && operation === "update" && writer === "mcp") {
  const { viewerMcpBindings } = await import("./bindings");
  await viewerMcpBindings().update_task({
    taskId: "task-mcp",
    text: "mcp updated task",
    clientRequestId: "mcp-task-update-request",
  });
} else if (kind === "pipeline" && operation === "create" && writer === "http") {
  const input = { task: `${writer} pipeline`, repoDir: process.cwd(), autoStart: false, stages: [] };
  const { POST } = await import("@/app/api/pipelines/route");
  const response = await POST(new NextRequest("http://127.0.0.1/api/pipelines", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
  if (!response.ok) throw new Error(`HTTP pipeline create failed: ${response.status} ${await response.text()}`);
} else if (kind === "pipeline" && operation === "create" && writer === "mcp") {
  const { viewerMcpBindings } = await import("./bindings");
  await viewerMcpBindings().create_pipeline({
    task: `${writer} pipeline`,
    repoDir: process.cwd(),
    autoStart: false,
    stages: [],
    clientRequestId: `${writer}-pipeline-request`,
  });
} else if (kind === "pipeline" && operation === "transition" && writer === "http") {
  const { registerPipelineTick } = await import("@/lib/pipelines/controllerSignal");
  registerPipelineTick(async () => {});
  const { PATCH } = await import("@/app/api/pipelines/[id]/route");
  const response = await PATCH(new NextRequest("http://127.0.0.1/api/pipelines/pipeline-http", {
    method: "PATCH",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ action: "start" }),
  }), { params: Promise.resolve({ id: "pipeline-http" }) });
  if (!response.ok) throw new Error(`HTTP pipeline transition failed: ${response.status} ${await response.text()}`);
} else if (kind === "pipeline" && operation === "transition" && writer === "mcp") {
  const { registerPipelineTick } = await import("@/lib/pipelines/controllerSignal");
  registerPipelineTick(async () => {});
  const { viewerMcpBindings } = await import("./bindings");
  await viewerMcpBindings().pipeline_action({
    pipelineId: "pipeline-mcp",
    action: "start",
    clientRequestId: "mcp-pipeline-transition-request",
  });
} else {
  throw new Error(`unknown writer: ${kind}/${operation}/${writer}`);
}
