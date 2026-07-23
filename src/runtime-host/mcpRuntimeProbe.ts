import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { ViewerMcpRuntimeHealthEvidence, ViewerMcpRuntimeIdentity } from "@/lib/runtime/contracts";

const REQUIRED_TOOLS = [
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
] as const;

export interface McpRuntimeProbeOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  runtime: ViewerMcpRuntimeIdentity;
  timeoutMs?: number;
  onProcessReady?: (pid: number) => void;
}

function successfulToolCall(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as { isError?: unknown; structuredContent?: unknown };
  if (result.isError === true || !result.structuredContent || typeof result.structuredContent !== "object") return false;
  return (result.structuredContent as { ok?: unknown }).ok === true;
}

export async function probeMcpRuntime(options: McpRuntimeProbeOptions): Promise<ViewerMcpRuntimeHealthEvidence> {
  const checkedAt = new Date().toISOString();
  const timeout = Math.max(1, options.timeoutMs ?? 15_000);
  const transport = new StdioClientTransport({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
    stderr: "pipe",
  });
  const client = new Client({ name: "viewer-deployment-mcp-probe", version: "1.0.0" });
  let processReady = false;
  let tools: string[] = [];
  let deploymentStatus = false;
  let boardSnapshot = false;
  try {
    await client.connect(transport);
    processReady = true;
    if (transport.pid !== null) options.onProcessReady?.(transport.pid);
    const listed = await client.listTools(undefined, { timeout });
    tools = listed.tools.map((tool) => tool.name).sort();
    const requestId = randomUUID();
    const deployment = await client.callTool({
      name: "deployment_status",
      arguments: { clientRequestId: `deployment-probe-${requestId}`, limit: 1 },
    }, undefined, { timeout });
    deploymentStatus = successfulToolCall(deployment);
    const board = await client.callTool({
      name: "board_snapshot",
      arguments: { clientRequestId: `board-probe-${requestId}`, limit: 1 },
    }, undefined, { timeout });
    boardSnapshot = successfulToolCall(board);
    const missing = REQUIRED_TOOLS.filter((tool) => !tools.includes(tool));
    const ok = missing.length === 0 && deploymentStatus && boardSnapshot;
    return {
      checkedAt,
      revision: options.runtime.revision,
      artifactDigest: options.runtime.artifactDigest,
      processReady,
      tools,
      calls: { deploymentStatus, boardSnapshot },
      ok,
      ...(ok ? {} : {
        detail: missing.length
          ? `MCP runtime is missing tools: ${missing.join(", ")}`
          : "MCP runtime read probes failed",
      }),
    };
  } catch (error) {
    return {
      checkedAt,
      revision: options.runtime.revision,
      artifactDigest: options.runtime.artifactDigest,
      processReady,
      tools,
      calls: { deploymentStatus, boardSnapshot },
      ok: false,
      detail: (error instanceof Error ? error.message : "MCP runtime probe failed").replace(/[\r\n]+/g, " ").slice(0, 500),
    };
  } finally {
    await client.close().catch(() => transport.close().catch(() => {}));
  }
}
