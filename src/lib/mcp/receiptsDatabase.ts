import fs from "node:fs";

import type { Database as BunDatabase } from "bun:sqlite";

import { statePath } from "@/lib/configDir";

/** The durable receipt database every Viewer MCP process claims its calls in. */
export function mcpReceiptsDatabasePath(): string {
  return statePath("mcp-receipts.sqlite");
}

/** The tools whose receipts make up the operations feed (#1695 C5). Their claim
    row records the server-derived caller, so an operation is attributable while
    it is still running. */
export const MCP_OPERATION_TOOLS = ["create_pipeline", "update_task"] as const;
export type McpOperationTool = typeof MCP_OPERATION_TOOLS[number];

export function isMcpOperationTool(toolName: string): toolName is McpOperationTool {
  return (MCP_OPERATION_TOOLS as readonly string[]).includes(toolName);
}

/** Who made an operation, as the server resolved it when the call was claimed. */
export interface McpOperationCaller {
  kind: "root" | "worker" | "unidentified";
  conversationId: string | null;
  project: string | null;
}

/** Where an operation lands. At claim time it is the board task the call names,
    validated against the task store, with that task's project; a pipeline id
    is known only once a pipeline exists. */
export interface McpOperationTarget {
  project: string;
  taskId: string | null;
  pipelineId: string | null;
}

/** What an operations-feed claim records beside its idempotency key. */
export interface McpOperationClaim {
  caller: McpOperationCaller | null;
  target: McpOperationTarget | null;
}

/**
 * Opens the receipt database for reading only, or answers null while no MCP
 * process has created it. A reader never creates, migrates or writes it; the
 * MCP processes own its schema.
 */
export function openMcpReceiptsReadOnly(filename = mcpReceiptsDatabasePath()): BunDatabase | null {
  if (!fs.existsSync(filename)) return null;
  const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
  if (!sqlite) throw new Error("reading MCP receipts requires the Bun runtime");
  const db = new sqlite.Database(filename, { readonly: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout = 2000;");
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
