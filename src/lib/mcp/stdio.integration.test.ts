import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
