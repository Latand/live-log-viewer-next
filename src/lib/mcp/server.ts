import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { statePath } from "@/lib/configDir";

export const MCP_SERVER_NAME = "viewer";

export const MCP_TOOL_NAMES = [
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

export type McpToolName = typeof MCP_TOOL_NAMES[number];
export type McpToolArgs = Record<string, unknown> & { clientRequestId?: unknown };
export type McpToolPayload = Record<string, unknown>;
export type McpToolBinding = (args: McpToolArgs) => Promise<McpToolPayload>;
export type McpToolBindings = Record<McpToolName, McpToolBinding>;

export type McpToolSuccess = McpToolPayload & {
  ok: true;
  toolName: McpToolName;
  clientRequestId: string;
  replayed: boolean;
};

export type McpToolFailure = {
  ok: false;
  toolName: string;
  clientRequestId: string | null;
  replayed: boolean;
  error: string;
  code: string;
  retryable: boolean;
};

export type McpToolResult = McpToolSuccess | McpToolFailure;

type Receipt = {
  digest: string;
  result?: McpToolResult;
};

export type ReceiptClaim =
  | { kind: "fresh" }
  | { kind: "pending" }
  | { kind: "replay"; result: McpToolResult }
  | { kind: "conflict" };

export interface McpReceiptStore {
  claim(key: string, digest: string): ReceiptClaim;
  complete(key: string, digest: string, result: McpToolResult): void;
}

export class MemoryMcpReceiptStore implements McpReceiptStore {
  private readonly receipts = new Map<string, Receipt>();

  claim(key: string, digest: string): ReceiptClaim {
    const receipt = this.receipts.get(key);
    if (!receipt) {
      this.receipts.set(key, { digest });
      return { kind: "fresh" };
    }
    if (receipt.digest !== digest) return { kind: "conflict" };
    return receipt.result ? { kind: "replay", result: receipt.result } : { kind: "pending" };
  }

  complete(key: string, digest: string, result: McpToolResult): void {
    const receipt = this.receipts.get(key);
    if (!receipt || receipt.digest !== digest) throw new Error("MCP receipt ownership changed");
    this.receipts.set(key, { digest, result });
  }
}

type ReceiptFile = {
  version: 1;
  receipts: Record<string, Receipt>;
};

const FILE_RECEIPT_CAP = 500;
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function staleLock(lockPath: string): boolean {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) return true;
    const owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown };
    return typeof owner.pid === "number" && !processAlive(owner.pid);
  } catch {
    return false;
  }
}

function withFileLock<T>(filePath: string, operation: () => T): T {
  const lockPath = `${filePath}.lock`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
        return operation();
      } finally {
        fs.closeSync(fd);
        try { fs.unlinkSync(lockPath); } catch { /* a recovered owner may already have cleared it */ }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (staleLock(lockPath)) {
        try { fs.unlinkSync(lockPath); } catch { /* another waiter recovered it first */ }
        continue;
      }
      if (Date.now() >= deadline) throw new Error("MCP receipt store is busy");
      Atomics.wait(sleepCell, 0, 0, 10);
    }
  }
}

function readReceiptFile(filePath: string): ReceiptFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ReceiptFile>;
    if (parsed.version === 1 && parsed.receipts && typeof parsed.receipts === "object" && !Array.isArray(parsed.receipts)) {
      return { version: 1, receipts: parsed.receipts as Record<string, Receipt> };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { version: 1, receipts: {} };
}

function writeReceiptFile(filePath: string, state: ReceiptFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

export class FileMcpReceiptStore implements McpReceiptStore {
  constructor(private readonly filePath: string) {}

  claim(key: string, digest: string): ReceiptClaim {
    return withFileLock(this.filePath, () => {
      const state = readReceiptFile(this.filePath);
      const receipt = state.receipts[key];
      if (receipt) {
        if (receipt.digest !== digest) return { kind: "conflict" };
        return receipt.result ? { kind: "replay", result: receipt.result } : { kind: "pending" };
      }
      state.receipts[key] = { digest };
      const keys = Object.keys(state.receipts);
      for (const expired of keys.slice(0, Math.max(0, keys.length - FILE_RECEIPT_CAP))) delete state.receipts[expired];
      writeReceiptFile(this.filePath, state);
      return { kind: "fresh" };
    });
  }

  complete(key: string, digest: string, result: McpToolResult): void {
    withFileLock(this.filePath, () => {
      const state = readReceiptFile(this.filePath);
      const receipt = state.receipts[key];
      if (!receipt || receipt.digest !== digest) throw new Error("MCP receipt ownership changed");
      state.receipts[key] = { digest, result };
      writeReceiptFile(this.filePath, state);
    });
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stable(child)]));
}

function requestDigest(toolName: McpToolName, args: McpToolArgs): string {
  return crypto.createHash("sha256").update(JSON.stringify(stable({ toolName, args }))).digest("hex");
}

function clientRequestId(args: McpToolArgs): string | null {
  return typeof args.clientRequestId === "string" && args.clientRequestId.trim() ? args.clientRequestId.trim() : null;
}

function failure(
  toolName: string,
  requestId: string | null,
  code: string,
  error: string,
  retryable: boolean,
  replayed = false,
): McpToolFailure {
  return { ok: false, toolName, clientRequestId: requestId, replayed, error, code, retryable };
}

export interface McpToolService {
  callTool(toolName: string, args: McpToolArgs): Promise<McpToolResult>;
}

export function createMcpToolService(
  bindings: McpToolBindings,
  receipts: McpReceiptStore,
): McpToolService {
  const inFlight = new Map<string, { digest: string; result: Promise<McpToolResult> }>();
  return {
    async callTool(toolName, args) {
      if (!(MCP_TOOL_NAMES as readonly string[]).includes(toolName)) {
        return failure(toolName, clientRequestId(args), "unknown_tool", `Unknown viewer tool: ${toolName}`, false);
      }
      const typedTool = toolName as McpToolName;
      const requestId = clientRequestId(args);
      if (!requestId) return failure(toolName, null, "invalid_request", "clientRequestId is required", false);

      const digest = requestDigest(typedTool, args);
      const key = `${typedTool}:${requestId}`;
      const active = inFlight.get(key);
      if (active) {
        if (active.digest !== digest) {
          return failure(toolName, requestId, "idempotency_conflict", "clientRequestId was already used with different arguments", false, true);
        }
        return { ...await active.result, replayed: true };
      }
      const claim = receipts.claim(key, digest);
      if (claim.kind === "conflict") {
        return failure(toolName, requestId, "idempotency_conflict", "clientRequestId was already used with different arguments", false, true);
      }
      if (claim.kind === "pending") {
        return failure(toolName, requestId, "call_interrupted", "The previous MCP process ended before this call completed", true, true);
      }
      if (claim.kind === "replay") return { ...claim.result, replayed: true };

      const result = (async (): Promise<McpToolResult> => {
        let settled: McpToolResult;
        try {
          const payload = await bindings[typedTool](args);
          settled = { ...payload, ok: true, toolName: typedTool, clientRequestId: requestId, replayed: false };
        } catch (error) {
          settled = failure(
            typedTool,
            requestId,
            "tool_failed",
            error instanceof Error ? error.message : String(error),
            true,
          );
        }
        receipts.complete(key, digest, settled);
        return settled;
      })();
      inFlight.set(key, { digest, result });
      try {
        return await result;
      } finally {
        if (inFlight.get(key)?.result === result) inFlight.delete(key);
      }
    },
  };
}

const TOOL_DESCRIPTIONS: Record<McpToolName, string> = {
  spawn_agent: "Create a Viewer-managed agent conversation and return its durable conversation and launch ids.",
  send_message: "Deliver a message to a Viewer conversation through its registered runtime host.",
  create_task: "Create a durable board task.",
  update_task: "Update a durable board task.",
  create_pipeline: "Create a Viewer pipeline through the pipeline engine.",
  pipeline_action: "Apply a supported action to an existing pipeline.",
  link_task_to_pipeline: "Attach a board task to a conversation owned by a pipeline.",
  list_conversations: "List scanned Viewer conversations with durable ids and transcript paths.",
  get_conversation: "Read a conversation summary and its recent messages and tools.",
  deploy_exact_sha: "Deploy one full commit SHA after the caller supplies confirm=deploy.",
  get_pipeline: "Read one pipeline by durable id.",
  board_snapshot: "Read a bounded, redacted snapshot of the Viewer board and durable placement.",
  list_flows: "List durable implement-review flows.",
  get_flow: "Read one implement-review flow by durable id.",
  flow_action: "Apply a supported action to an implement-review flow.",
  list_pipelines: "List durable pipelines.",
  conversation_action: "Interrupt, kill, resume, compact, or answer a dialog for a Viewer conversation.",
  operator_snapshot: "Read the bounded, secret-redacted Viewer state currently visible to the operator.",
  list_tasks: "List durable board tasks.",
  get_task: "Read one durable board task.",
  deployment_status: "Read Viewer deployment or runtime operation status, or list recent deployments.",
  resources: "Read system and Viewer-owned agent resource usage.",
  conversation_migration: "Reseat, retry, or roll back a conversation account migration.",
};

const clientRequestIdSchema = z.string().min(1).describe("Stable idempotency key for this logical call.");
const entityIdSchema = z.string().min(1);

const TOOL_INPUT_SCHEMAS: Record<McpToolName, z.ZodObject> = {
  spawn_agent: z.object({
    clientRequestId: clientRequestIdSchema,
    cwd: z.string().min(1).describe("Existing working directory for the new agent."),
    "prompt": z.string().describe("First instruction sent to the agent."),
    engine: z.enum(["claude", "codex"]).optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    role: z.string().optional(),
    roleParams: z.record(z.string(), z.unknown()).optional(),
    reviews: z.string().optional(),
    parentConversationId: z.string().optional(),
    project: z.string().optional(),
    allowSubagents: z.boolean().optional(),
    mcpServers: z.array(z.string().regex(/^[^\s\u0000-\u001f\u007f]{1,128}$/u))
      .optional()
      .describe("Per-spawn MCP server allowlist. Viewer is always included; omission selects Viewer only."),
    images: z.array(z.unknown()).optional(),
  }).passthrough(),
  send_message: z.object({
    clientRequestId: clientRequestIdSchema,
    conversationId: z.string().optional(),
    transcriptPath: z.string().optional(),
    text: z.string().min(1),
  }).passthrough(),
  create_task: z.object({
    clientRequestId: clientRequestIdSchema,
    project: z.string().min(1),
    text: z.string().min(1),
    placement: z.enum(["pinned", "unplaced"]).optional(),
    dueAt: z.string().optional(),
    dueTz: z.string().optional(),
    attachments: z.array(z.unknown()).optional(),
  }).passthrough(),
  update_task: z.object({
    clientRequestId: clientRequestIdSchema,
    taskId: entityIdSchema,
    text: z.string().optional(),
    status: z.enum(["inbox", "assigned", "blocked", "done"]).optional(),
    placement: z.enum(["pinned", "unplaced"]).optional(),
    dueAt: z.string().nullable().optional(),
    dueTz: z.string().nullable().optional(),
  }).passthrough(),
  create_pipeline: z.object({
    clientRequestId: clientRequestIdSchema,
    task: z.string().min(1),
    spec: z.string().optional(),
    repoDir: z.string().min(1),
    baseBranch: z.string().optional(),
    baseRef: z.string().optional(),
    stages: z.array(z.record(z.string(), z.unknown())),
    src: z.string().optional(),
    autoStart: z.boolean().optional(),
  }).passthrough(),
  pipeline_action: z.object({
    clientRequestId: clientRequestIdSchema,
    pipelineId: entityIdSchema,
    action: z.string().min(1),
  }).passthrough(),
  link_task_to_pipeline: z.object({
    clientRequestId: clientRequestIdSchema,
    taskId: entityIdSchema,
    pipelineId: entityIdSchema,
  }).passthrough(),
  list_conversations: z.object({
    clientRequestId: clientRequestIdSchema,
    project: z.string().optional(),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).passthrough(),
  get_conversation: z.object({
    clientRequestId: clientRequestIdSchema,
    conversationId: z.string().optional(),
    transcriptPath: z.string().optional(),
    maxRecords: z.number().int().min(1).max(500).optional(),
  }).passthrough(),
  deploy_exact_sha: z.object({
    clientRequestId: clientRequestIdSchema,
    revision: z.string().regex(/^[0-9a-f]{40}$/i),
    confirm: z.literal("deploy"),
  }).passthrough(),
  get_pipeline: z.object({
    clientRequestId: clientRequestIdSchema,
    pipelineId: entityIdSchema,
  }).passthrough(),
  board_snapshot: z.object({
    clientRequestId: clientRequestIdSchema,
    project: z.string().optional(),
    activity: z.enum(["live", "stalled", "recent", "idle"]).optional(),
    liveOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }).passthrough(),
  list_flows: z.object({
    clientRequestId: clientRequestIdSchema,
    project: z.string().optional(),
    state: z.string().optional(),
    includeClosed: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }).passthrough(),
  get_flow: z.object({
    clientRequestId: clientRequestIdSchema,
    flowId: entityIdSchema,
  }).passthrough(),
  flow_action: z.object({
    clientRequestId: clientRequestIdSchema,
    flowId: entityIdSchema,
    action: z.enum(["pause", "resume", "set-mode", "advance", "retry-round", "cancel-round", "set-round-limit", "extend", "another-round", "set-roles", "close"]),
    mode: z.enum(["auto", "manual"]).optional(),
    rounds: z.number().int().min(0).max(50).optional(),
    note: z.string().optional(),
    roles: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
  list_pipelines: z.object({
    clientRequestId: clientRequestIdSchema,
    project: z.string().optional(),
    state: z.string().optional(),
    includeClosed: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }).passthrough(),
  conversation_action: z.object({
    clientRequestId: clientRequestIdSchema,
    conversationId: z.string().optional(),
    transcriptPath: z.string().optional(),
    action: z.enum(["interrupt", "kill", "resume", "compact", "dialog-key"]),
    key: z.enum(["1", "2", "3", "4", "5", "6", "7", "8", "9", "Tab", "Enter", "Escape"]).optional(),
    label: z.string().optional(),
    question: z.string().optional(),
  }).passthrough(),
  operator_snapshot: z.object({
    clientRequestId: clientRequestIdSchema,
    schemaVersion: z.literal(1).optional(),
    view: z.record(z.string(), z.unknown()).optional(),
    scope: z.record(z.string(), z.unknown()).optional(),
    text: z.record(z.string(), z.unknown()).optional(),
    caller: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
  list_tasks: z.object({
    clientRequestId: clientRequestIdSchema,
    project: z.string().optional(),
    status: z.enum(["inbox", "assigned", "blocked", "done"]).optional(),
    placement: z.enum(["pinned", "unplaced"]).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }).passthrough(),
  get_task: z.object({
    clientRequestId: clientRequestIdSchema,
    taskId: entityIdSchema,
  }).passthrough(),
  deployment_status: z.object({
    clientRequestId: clientRequestIdSchema,
    deploymentId: z.string().min(1).optional(),
    operationId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).passthrough(),
  resources: z.object({
    clientRequestId: clientRequestIdSchema,
    fresh: z.boolean().optional(),
  }).passthrough(),
  conversation_migration: z.object({
    clientRequestId: clientRequestIdSchema,
    conversationId: z.string().min(1),
    action: z.enum(["reseat", "retry", "rollback"]),
    expectedRevision: z.number().int().min(0).optional(),
    transcriptPath: z.string().optional(),
  }).passthrough(),
};

export function createViewerMcpServer(service: McpToolService): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: "1.0.0" }, {
    instructions: "Use clientRequestId on every call. Reuse it only when replaying the same logical operation. deploy_exact_sha requires confirm=deploy.",
  });
  for (const toolName of MCP_TOOL_NAMES) {
    server.registerTool(toolName, {
      description: TOOL_DESCRIPTIONS[toolName],
      inputSchema: TOOL_INPUT_SCHEMAS[toolName],
    }, async (args) => {
      const result = await service.callTool(toolName, args as McpToolArgs);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
        ...(result.ok ? {} : { isError: true }),
      };
    });
  }
  return server;
}

export async function startViewerMcpServer(): Promise<void> {
  const { viewerMcpBindings } = await import("./bindings");
  const service = createMcpToolService(
    viewerMcpBindings(),
    new FileMcpReceiptStore(statePath("mcp-receipts.json")),
  );
  const server = createViewerMcpServer(service);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
