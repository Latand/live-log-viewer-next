import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  MCP_TOOL_NAMES,
  FileMcpReceiptStore,
  MemoryMcpReceiptStore,
  createViewerMcpServer,
  createMcpToolService,
  type McpToolBindings,
} from "./server";

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("MCP tool service", () => {
  test("each v1 tool returns structured ids and replays a duplicate clientRequestId", async () => {
    const calls = new Map<string, number>();
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [
      toolName,
      async () => {
        calls.set(toolName, (calls.get(toolName) ?? 0) + 1);
        return {
          conversationId: `conversation_${toolName}`,
          transcriptPath: `/sessions/${toolName}.jsonl`,
          pipelineId: `pipeline_${toolName}`,
          taskId: `task_${toolName}`,
          operationId: `operation_${toolName}`,
        };
      },
    ])) as unknown as McpToolBindings;
    const service = createMcpToolService(bindings, new MemoryMcpReceiptStore());

    for (const toolName of MCP_TOOL_NAMES) {
      const args = { clientRequestId: `request-${toolName}`, value: toolName };
      const first = await service.callTool(toolName, args);
      const replay = await service.callTool(toolName, args);

      expect(first).toMatchObject({ ok: true, toolName, clientRequestId: args.clientRequestId, replayed: false });
      expect(replay).toEqual({ ...first, replayed: true });
      expect(calls.get(toolName)).toBe(1);
    }
  });

  test("a receipt left pending across process restart becomes a structured retryable error", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-receipts-"));
    scratch.push(directory);
    const receiptPath = path.join(directory, "receipts.json");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    bindings.send_message = async () => {
      await held;
      return { operationId: "operation-after-restart" };
    };
    const args = { clientRequestId: "request-restart", conversationId: "conversation_a", text: "hello" };
    const first = createMcpToolService(bindings, new FileMcpReceiptStore(receiptPath)).callTool("send_message", args);
    await Bun.sleep(5);

    const restarted = createMcpToolService(bindings, new FileMcpReceiptStore(receiptPath));
    expect(await restarted.callTool("send_message", args)).toEqual({
      ok: false,
      toolName: "send_message",
      clientRequestId: "request-restart",
      replayed: true,
      error: "The previous MCP process ended before this call completed",
      code: "call_interrupted",
      retryable: true,
    });

    release();
    await first;
  });

  test("a concurrent duplicate waits for the active call and returns it as a replay", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    bindings.send_message = async () => {
      calls += 1;
      await held;
      return { operationId: "operation-concurrent" };
    };
    const service = createMcpToolService(bindings, new MemoryMcpReceiptStore());
    const args = { clientRequestId: "request-concurrent", conversationId: "conversation_a", text: "hello" };
    const first = service.callTool("send_message", args);
    await Bun.sleep(1);
    const second = service.callTool("send_message", args);
    release();

    expect(await first).toMatchObject({ ok: true, replayed: false, operationId: "operation-concurrent" });
    expect(await second).toMatchObject({ ok: true, replayed: true, operationId: "operation-concurrent" });
    expect(calls).toBe(1);
  });

  test("registers the complete v1 surface and returns structured content over MCP", async () => {
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({ operationId: `operation_${toolName}` })])) as unknown as McpToolBindings;
    const service = createMcpToolService(bindings, new MemoryMcpReceiptStore());
    const server = createViewerMcpServer(service);
    const client = new Client({ name: "viewer-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES]);
      const spawnSchema = listed.tools.find((tool) => tool.name === "spawn_agent")?.inputSchema;
      expect(spawnSchema?.properties).toHaveProperty("cwd");
      expect(spawnSchema?.properties).toHaveProperty("prompt");
      const deploySchema = listed.tools.find((tool) => tool.name === "deploy_exact_sha")?.inputSchema;
      expect(deploySchema?.properties).toHaveProperty("confirm");
      const called = await client.callTool({
        name: "send_message",
        arguments: { clientRequestId: "request-protocol", text: "hello" },
      });
      expect(called.structuredContent).toMatchObject({
        ok: true,
        toolName: "send_message",
        operationId: "operation_send_message",
        replayed: false,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
