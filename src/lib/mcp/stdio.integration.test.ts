import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function spawnResult(label: string): Response {
  return Response.json({
    conversationId: `conversation_${label}`,
    path: `/fixture/${label}.jsonl`,
    launchId: `launch_${label}`,
    state: "running",
    initialMessage: null,
  });
}

async function callSpawn(client: Client, clientRequestId: string) {
  return client.callTool({
    name: "spawn_agent",
    arguments: {
      clientRequestId,
      cwd: process.cwd(),
      "prompt": "Run the restart fixture.",
      title: "Restart fixture",
    },
  });
}

test("the packaged stdio host publishes and invokes the expanded read surface", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-stdio-"));
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  environment.LLV_STATE_DIR = sandbox;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "bin", "mcp-server.mjs")],
    cwd: process.cwd(),
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({ name: "viewer-stdio-integration", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("board_snapshot");
    expect(tools.tools.map((tool) => tool.name)).toContain("conversation_migration");

    const first = await client.callTool({
      name: "list_flows",
      arguments: { clientRequestId: "stdio-list-flows", limit: 1 },
    });
    const replay = await client.callTool({
      name: "list_flows",
      arguments: { clientRequestId: "stdio-list-flows", limit: 1 },
    });
    const tasks = await client.callTool({
      name: "list_tasks",
      arguments: { clientRequestId: "stdio-list-tasks", limit: 1 },
    });

    expect(first.structuredContent).toMatchObject({ ok: true, toolName: "list_flows", replayed: false });
    expect(replay.structuredContent).toMatchObject({ ok: true, toolName: "list_flows", replayed: true });
    expect(tasks.structuredContent).toMatchObject({ ok: true, toolName: "list_tasks", replayed: false });
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("an already-running packaged MCP channel retries through a same-port Viewer restart and fails loudly when recovery exhausts", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-viewer-restart-"));
  const blockedRequest = { release: null as ((response: Response) => void) | null };
  let markBlockedRequestReached: (() => void) | null = null;
  const blockedRequestReached = new Promise<void>((resolve) => { markBlockedRequestReached = resolve; });
  let requests = 0;
  const firstViewer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests += 1;
      if (requests === 1) return spawnResult("before_restart");
      markBlockedRequestReached?.();
      return new Promise<Response>((resolve) => { blockedRequest.release = resolve; });
    },
  });
  const viewerPort = firstViewer.port;
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  environment.LLV_STATE_DIR = sandbox;
  environment.LLV_VIEWER_DEPLOY_TARGET = path.join(sandbox, "viewer-release.json");
  environment.LLV_VIEWER_CONTROL_URL = firstViewer.url.origin;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "bin", "mcp-server.mjs")],
    cwd: process.cwd(),
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({ name: "viewer-restart-integration", version: "1.0.0" });
  let mcpStderr = "";
  transport.stderr?.on("data", (chunk) => { mcpStderr += String(chunk); });
  let restartedViewer: ReturnType<typeof Bun.serve> | null = null;
  let restartedRequests = 0;
  let transientProxyFailures = 0;
  let breakResponseBody = false;
  try {
    await client.connect(transport);
    expect((await callSpawn(client, "restart-before")).structuredContent)
      .toMatchObject({ ok: true, conversationId: "conversation_before_restart" });

    const inFlight = callSpawn(client, "restart-during");
    await blockedRequestReached;
    void firstViewer.stop(false);
    restartedViewer = Bun.serve({
      hostname: "127.0.0.1",
      port: viewerPort,
      fetch: () => {
        restartedRequests += 1;
        if (transientProxyFailures > 0) {
          transientProxyFailures -= 1;
          return new Response(null, { status: 503 });
        }
        if (breakResponseBody) {
          breakResponseBody = false;
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"conversationId":'));
              setTimeout(() => controller.error(new Error("retired Viewer response")), 10);
            },
          }), { headers: { "content-type": "application/json" } });
        }
        return spawnResult("after_restart");
      },
    });
    expect(restartedViewer.port).toBe(viewerPort);
    expect((await fetch(restartedViewer.url, { method: "POST" })).status).toBe(200);

    const landed = await Promise.race([
      inFlight,
      Bun.sleep(7_000).then(() => { throw new Error(`MCP call did not reconnect to the restarted Viewer (new requests: ${restartedRequests})\n${mcpStderr}`); }),
    ]);
    expect(landed.structuredContent)
      .toMatchObject({ ok: true, conversationId: "conversation_after_restart" });
    expect(restartedRequests).toBe(2);

    transientProxyFailures = 1;
    expect((await callSpawn(client, "restart-proxy-gap")).structuredContent)
      .toMatchObject({ ok: true, conversationId: "conversation_after_restart" });
    expect(restartedRequests).toBe(4);

    breakResponseBody = true;
    expect((await callSpawn(client, "restart-cut-body")).structuredContent)
      .toMatchObject({ ok: true, conversationId: "conversation_after_restart" });
    expect(restartedRequests).toBe(6);

    await restartedViewer.stop(true);
    restartedViewer = null;
    const unavailable = await callSpawn(client, "restart-unavailable");
    expect(unavailable.isError).toBe(true);
    expect(unavailable.structuredContent).toMatchObject({
      ok: false,
      error: expect.stringContaining("Viewer control did not reconnect after"),
    });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("spawn_agent");
  } finally {
    blockedRequest.release?.(Response.json({ error: "retired Viewer generation" }, { status: 503 }));
    await Promise.race([
      Promise.all([
        transport.close().catch(() => {}),
        Promise.resolve(firstViewer.stop(true)).catch(() => {}),
        Promise.resolve(restartedViewer?.stop(true)).catch(() => {}),
      ]),
      Bun.sleep(1_000),
    ]);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}, 20_000);

test("a packaged MCP tool falls back from a retired launch port to the stable Viewer resolver", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-dead-launch-port-"));
  const retiredViewer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => spawnResult("retired"),
  });
  const retiredOrigin = retiredViewer.url.origin;
  await retiredViewer.stop(true);
  let stableRequests = 0;
  const stableViewer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      stableRequests += 1;
      return spawnResult("stable_resolver");
    },
  });
  const targetFile = path.join(sandbox, "viewer-release.json");
  fs.writeFileSync(targetFile, JSON.stringify({
    revision: "a".repeat(40),
    image: "viewer:fixture",
    container: "viewer-fixture",
    endpoint: stableViewer.url.origin,
  }));
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  environment.LLV_STATE_DIR = sandbox;
  environment.LLV_VIEWER_DEPLOY_TARGET = targetFile;
  environment.LLV_VIEWER_CONTROL_URL = retiredOrigin;
  environment.LLV_VIEWER_PORT = String(stableViewer.port);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "bin", "mcp-server.mjs")],
    cwd: process.cwd(),
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({ name: "viewer-dead-launch-port", version: "1.0.0" });
  try {
    await client.connect(transport);
    expect((await callSpawn(client, "dead-launch-port-fallback")).structuredContent)
      .toMatchObject({ ok: true, conversationId: "conversation_stable_resolver" });
    expect(stableRequests).toBe(1);
  } finally {
    await client.close().catch(() => {});
    await stableViewer.stop(true);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}, 12_000);
