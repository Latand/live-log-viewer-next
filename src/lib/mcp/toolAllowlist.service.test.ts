import { expect, test } from "bun:test";

import {
  createMcpToolService,
  MCP_TOOL_NAMES,
  MemoryMcpReceiptStore,
  type McpToolBindings,
  type McpToolName,
} from "./server";
import { MANAGER_ONLY_TOOLS, mcpCallerIdentity, mcpToolPolicy, type ManagerTarget } from "./toolAllowlist";

/**
 * The fence at the seam it actually runs on. `toolAllowlist.test.ts` proves the
 * policy; this proves the service consults it — that a refused tool never reaches
 * its binding, and that the refusal comes back as a normal MCP failure rather than
 * a thrown error the agent sees as a crash.
 */

const MANAGER: ManagerTarget = { conversationId: "conversation_manager", path: null };

function service(identity: "gateway" | "worker" | "manager") {
  const calls: string[] = [];
  const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [
    toolName,
    async (): Promise<Record<string, unknown>> => {
      calls.push(toolName);
      return { ran: toolName };
    },
  ])) as unknown as McpToolBindings;

  const authority = identity === "gateway"
    ? { kind: "root" as const, conversationId: "conversation_root" }
    : identity === "manager"
      ? { kind: "worker" as const, conversationId: MANAGER.conversationId!, role: "orchestrator" }
      : { kind: "worker" as const, conversationId: "conversation_builder", role: "builder" };
  const policy = mcpToolPolicy(() => mcpCallerIdentity(authority, MANAGER), () => MANAGER);
  return { calls, service: createMcpToolService(bindings, new MemoryMcpReceiptStore(), policy) };
}

test("a refused tool never reaches its binding", async () => {
  const { calls, service: tools } = service("gateway");
  const result = await tools.callTool("spawn_agent", { clientRequestId: "r1", project: "viewer" });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe("tool_not_permitted");
    expect(result.retryable).toBe(false);
  }
  expect(calls).toEqual([]);
});

test("a refusal does not spend the clientRequestId, so a later grant still works", async () => {
  const calls: string[] = [];
  const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [
    toolName,
    async (): Promise<Record<string, unknown>> => {
      calls.push(toolName);
      return {};
    },
  ])) as unknown as McpToolBindings;

  let fenced = true;
  const policy = mcpToolPolicy(
    () => (fenced ? { kind: "restricted", reason: "gateway" } : { kind: "unrestricted", reason: "worker" }),
    () => MANAGER,
  );
  const tools = createMcpToolService(bindings, new MemoryMcpReceiptStore(), policy);

  const refused = await tools.callTool("create_task", { clientRequestId: "same-id", project: "viewer", text: "x" });
  expect(refused.ok).toBe(false);

  /* The operator grants the tool. The identical call must now run — a receipt
     burned by the refusal would answer it with the stale no forever. */
  fenced = false;
  const granted = await tools.callTool("create_task", { clientRequestId: "same-id", project: "viewer", text: "x" });
  expect(granted.ok).toBe(true);
  expect(calls).toEqual(["create_task"]);
});

test("the gateway's permitted tools still run normally", async () => {
  const { calls, service: tools } = service("gateway");
  const sent = await tools.callTool("send_message", {
    clientRequestId: "r1",
    conversationId: MANAGER.conversationId,
    text: "start a reviewer on the auth branch",
  });
  expect(sent.ok).toBe(true);

  const attention = await tools.callTool("request_attention", { clientRequestId: "r2" });
  expect(attention.ok).toBe(true);
  expect(calls).toEqual(["send_message", "request_attention"]);
});

test("a message to anyone but the manager is refused at the service", async () => {
  const { calls, service: tools } = service("gateway");
  const result = await tools.callTool("send_message", {
    clientRequestId: "r1",
    conversationId: "conversation_worker",
    text: "do it yourself",
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe("recipient_not_permitted");
  expect(calls).toEqual([]);
});

test("without a policy the service behaves exactly as it did before", async () => {
  const calls: string[] = [];
  const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [
    toolName,
    async (): Promise<Record<string, unknown>> => {
      calls.push(toolName);
      return {};
    },
  ])) as unknown as McpToolBindings;
  const tools = createMcpToolService(bindings, new MemoryMcpReceiptStore());

  for (const toolName of ["spawn_agent", "deploy_exact_sha"] as McpToolName[]) {
    expect((await tools.callTool(toolName, { clientRequestId: toolName })).ok).toBe(true);
  }
  expect(calls).toEqual(["spawn_agent", "deploy_exact_sha"]);
});

test("an ordinary worker reaches every tool except the manager's own channel", async () => {
  const { calls, service: tools } = service("worker");
  const reachable = MCP_TOOL_NAMES.filter((name) => !MANAGER_ONLY_TOOLS.includes(name));
  for (const toolName of reachable) {
    expect((await tools.callTool(toolName, { clientRequestId: `r-${toolName}` })).ok).toBe(true);
  }
  expect(calls).toEqual([...reachable]);

  /* And the manager-only channel is refused at the service, not merely in policy. */
  for (const toolName of MANAGER_ONLY_TOOLS) {
    const result = await tools.callTool(toolName, { clientRequestId: `r-${toolName}` });
    expect(result.ok).toBe(false);
  }
  expect(calls).toEqual([...reachable]);
});

test("the designated manager reaches every tool, including its own channel", async () => {
  const { calls, service: tools } = service("manager");
  for (const toolName of MCP_TOOL_NAMES) {
    expect((await tools.callTool(toolName, { clientRequestId: `r-${toolName}` })).ok).toBe(true);
  }
  expect(calls).toEqual([...MCP_TOOL_NAMES]);
});
