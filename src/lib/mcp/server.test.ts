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

function rewriteReceiptFileAsV1(receiptPath: string): void {
  const current = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as {
    readReceipts: Record<string, unknown>;
    mutationReceipts: Record<string, unknown>;
  };
  fs.writeFileSync(receiptPath, JSON.stringify({
    version: 1,
    receipts: { ...current.readReceipts, ...current.mutationReceipts },
  }));
}

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

  test("mutations retain replay and conflict protection after read receipt churn and restart", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-receipts-"));
    scratch.push(directory);
    const receiptPath = path.join(directory, "receipts.json");
    const actionCalls = new Map<string, number>();
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    const cases = [
      {
        toolName: "flow_action" as const,
        args: { clientRequestId: "request-flow-acceptance", flowId: "flow_acceptance", action: "pause" },
        changedArgs: { clientRequestId: "request-flow-acceptance", flowId: "flow_acceptance", action: "resume" },
      },
      {
        toolName: "conversation_action" as const,
        args: { clientRequestId: "request-conversation-acceptance", conversationId: "conversation_acceptance", action: "interrupt" },
        changedArgs: { clientRequestId: "request-conversation-acceptance", conversationId: "conversation_acceptance", action: "kill" },
      },
      {
        toolName: "conversation_migration" as const,
        args: { clientRequestId: "request-migration-acceptance", conversationId: "conversation_acceptance", action: "rollback", expectedRevision: 1 },
        changedArgs: { clientRequestId: "request-migration-acceptance", conversationId: "conversation_acceptance", action: "retry", expectedRevision: 1 },
      },
    ];
    for (const mutation of cases) {
      bindings[mutation.toolName] = async () => {
        actionCalls.set(mutation.toolName, (actionCalls.get(mutation.toolName) ?? 0) + 1);
        return { operationId: `operation_${mutation.toolName}_acceptance` };
      };
    }
    const service = createMcpToolService(bindings, new FileMcpReceiptStore(receiptPath));
    const firstResults = new Map<string, Awaited<ReturnType<typeof service.callTool>>>();
    for (const mutation of cases) {
      firstResults.set(mutation.toolName, await service.callTool(mutation.toolName, mutation.args));
    }
    rewriteReceiptFileAsV1(receiptPath);
    for (let index = 0; index < 501; index += 1) {
      await service.callTool("list_flows", { clientRequestId: `request-read-${index}`, limit: 1 });
    }

    const restarted = createMcpToolService(bindings, new FileMcpReceiptStore(receiptPath));
    for (const mutation of cases) {
      const firstResult = firstResults.get(mutation.toolName);
      if (!firstResult) throw new Error(`missing first result for ${mutation.toolName}`);
      expect(await restarted.callTool(mutation.toolName, mutation.args)).toEqual({
        ...firstResult,
        replayed: true,
      });
      expect(await restarted.callTool(mutation.toolName, mutation.changedArgs)).toMatchObject({
        ok: false,
        code: "idempotency_conflict",
        replayed: true,
      });
      expect(actionCalls.get(mutation.toolName)).toBe(1);
    }
  });

  test("a pending mutation remains claimed while read receipts churn", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-receipts-"));
    scratch.push(directory);
    const receiptPath = path.join(directory, "receipts.json");
    let release!: () => void;
    let markStarted!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let actionCalls = 0;
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
    bindings.conversation_action = async () => {
      actionCalls += 1;
      markStarted();
      await held;
      return { operationId: "operation_pending_acceptance" };
    };
    const args = { clientRequestId: "request-pending-acceptance", conversationId: "conversation_acceptance", action: "interrupt" };
    const service = createMcpToolService(bindings, new FileMcpReceiptStore(receiptPath));
    const first = service.callTool("conversation_action", args);
    await started;
    rewriteReceiptFileAsV1(receiptPath);
    for (let index = 0; index < 501; index += 1) {
      await service.callTool("list_tasks", { clientRequestId: `request-pending-read-${index}`, limit: 1 });
    }

    const restarted = createMcpToolService(bindings, new FileMcpReceiptStore(receiptPath));
    expect(await restarted.callTool("conversation_action", args)).toMatchObject({
      ok: false,
      code: "call_interrupted",
      replayed: true,
    });
    expect(await restarted.callTool("conversation_action", { ...args, action: "kill" })).toMatchObject({
      ok: false,
      code: "idempotency_conflict",
      replayed: true,
    });
    expect(actionCalls).toBe(1);

    release();
    const completed = await first;
    const completedRestart = createMcpToolService(bindings, new FileMcpReceiptStore(receiptPath));
    expect(await completedRestart.callTool("conversation_action", args)).toEqual({ ...completed, replayed: true });
    expect(actionCalls).toBe(1);
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
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "spawn_agent",
        "send_message",
        "create_task",
        "update_task",
        "create_pipeline",
        "pipeline_action",
        "link_task_to_pipeline",
        "list_conversations",
        "get_conversation",
        "deploy_exact_sha",
        "get_pipeline",
        "board_snapshot",
        "list_flows",
        "get_flow",
        "flow_action",
        "list_pipelines",
        "conversation_action",
        "operator_snapshot",
        "list_tasks",
        "get_task",
        "deployment_status",
        "resources",
        "conversation_migration",
      ]);
      for (const tool of listed.tools) {
        expect(tool.inputSchema.required).toContain("clientRequestId");
      }
      const spawnSchema = listed.tools.find((tool) => tool.name === "spawn_agent")?.inputSchema;
      expect(spawnSchema?.properties).toHaveProperty("cwd");
      expect(spawnSchema?.properties).toHaveProperty("prompt");
      expect(spawnSchema?.properties).toHaveProperty("mcpServers");
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
