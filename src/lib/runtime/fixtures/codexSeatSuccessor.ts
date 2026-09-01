import fs from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type JsonObject = Record<string, unknown>;

const [mode, markerPath, transcriptPath] = process.argv.slice(2);
if ((mode !== "hold" && mode !== "probe") || !markerPath || !transcriptPath) {
  throw new Error("seat-successor fixture arguments are invalid");
}

const threadId = "seat-successor-thread";
let viewerServer: { command: string; args: string[] } | null = null;
let turn = 0;

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respond(id: number, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function notify(method: string, params: JsonObject): void {
  send({ jsonrpc: "2.0", method, params });
}

function writeMarker(value: unknown): void {
  const temporary = `${markerPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, markerPath);
}

function captureViewerServer(params: JsonObject | null): void {
  const config = record(params?.config);
  const servers = record(config?.mcp_servers);
  const viewer = record(servers?.viewer);
  if (!viewer || viewer.enabled !== true || typeof viewer.command !== "string"
    || !Array.isArray(viewer.args) || !viewer.args.every((argument) => typeof argument === "string")) {
    viewerServer = null;
    return;
  }
  viewerServer = { command: viewer.command, args: viewer.args as string[] };
}

async function exerciseViewerMcp(turnId: string): Promise<void> {
  let client: Client | null = null;
  try {
    if (!viewerServer) throw new Error("the resumed thread has no launchable Viewer MCP definition");
    const environment = Object.fromEntries(Object.entries(process.env)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const transport = new StdioClientTransport({
      command: viewerServer.command,
      args: viewerServer.args,
      cwd: process.cwd(),
      env: environment,
      stderr: "pipe",
    });
    client = new Client({ name: "seat-successor-fixture", version: "1.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    if (!toolNames.includes("deployment_status")) {
      throw new Error("deployment_status is absent from the Viewer MCP tool list");
    }
    const result = await client.callTool({
      name: "deployment_status",
      arguments: { clientRequestId: "seat-successor-deployment-status" },
    });
    if (result.isError) throw new Error("Viewer MCP deployment_status returned an error");
    writeMarker({
      enginePid: process.pid,
      toolNames,
      structuredContent: result.structuredContent,
    });
    notify("item/completed", {
      threadId,
      turnId,
      item: {
        id: "viewer-deployment-status",
        type: "mcpToolCall",
        server: "viewer",
        tool: "deployment_status",
        status: "completed",
        result: result.structuredContent,
      },
    });
    notify("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeMarker({ enginePid: process.pid, error: message });
    notify("item/completed", {
      threadId,
      turnId,
      item: {
        id: "viewer-deployment-status",
        type: "mcpToolCall",
        server: "viewer",
        tool: "deployment_status",
        status: "failed",
        error: message,
      },
    });
    notify("turn/completed", { threadId, turn: { id: turnId, status: "failed" } });
  } finally {
    await client?.close().catch(() => {});
  }
}

async function accept(message: JsonObject): Promise<void> {
  if (typeof message.id !== "number") return;
  const params = record(message.params);
  if (message.method === "initialize") {
    respond(message.id, { userAgent: "codex_seat_successor_fixture/1.0.0" });
    return;
  }
  if (message.method === "account/read") {
    respond(message.id, { account: { type: "chatgpt", planType: "fixture" }, requiresOpenaiAuth: false });
    return;
  }
  if (message.method === "model/list") {
    respond(message.id, { data: [{ id: "fixture-model", isDefault: true, inputModalities: ["text"] }] });
    return;
  }
  if (message.method === "config/read") {
    respond(message.id, { config: { mcp_servers: {} } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    captureViewerServer(params);
    respond(message.id, {
      thread: {
        id: threadId,
        path: transcriptPath,
        turns: [],
        status: { type: "idle", activeFlags: [] },
      },
    });
    return;
  }
  if (message.method === "thread/read") {
    respond(message.id, { thread: { id: threadId, path: transcriptPath, turns: [] } });
    return;
  }
  if (message.method === "thread/turns/list") {
    respond(message.id, { data: [], nextCursor: null, backwardsCursor: null });
    return;
  }
  if (message.method === "turn/start") {
    const turnId = `turn-${++turn}`;
    respond(message.id, { turn: { id: turnId } });
    notify("turn/started", { threadId, turn: { id: turnId } });
    if (typeof params?.clientUserMessageId === "string") {
      notify("item/completed", {
        threadId,
        turnId,
        item: {
          type: "userMessage",
          clientId: params.clientUserMessageId,
          content: params.input,
        },
      });
    }
    if (mode === "probe") await exerciseViewerMcp(turnId);
    return;
  }
  if (message.method === "turn/interrupt") {
    respond(message.id, {});
    return;
  }
  respond(message.id, {});
}

let buffer = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) await accept(JSON.parse(line) as JsonObject);
    newline = buffer.indexOf("\n");
  }
}
