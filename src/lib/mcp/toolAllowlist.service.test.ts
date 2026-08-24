import { expect, test } from "bun:test";

import {
  createMcpToolService,
  MCP_TOOL_NAMES,
  MemoryMcpReceiptStore,
  type McpToolBindings,
  type McpToolName,
} from "./server";
import { mcpCallerIdentity, mcpToolPolicy, type ManagerTarget } from "./toolAllowlist";

/**
 * The policy at the seam it actually runs on. `toolAllowlist.test.ts` proves the
 * policy; this proves the service consults it — that a refused operation never
 * reaches its binding, and that the refusal comes back as a normal MCP failure
 * rather than a thrown error the agent sees as a crash.
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
  const policy = mcpToolPolicy(() => mcpCallerIdentity(authority, MANAGER));
  return { calls, service: createMcpToolService(bindings, new MemoryMcpReceiptStore(), policy) };
}

test("every session classification reaches every tool through the service (B+ item 1)", async () => {
  for (const identity of ["gateway", "worker", "manager"] as const) {
    const { calls, service: tools } = service(identity);
    for (const toolName of MCP_TOOL_NAMES) {
      expect((await tools.callTool(toolName, { clientRequestId: `r-${toolName}` })).ok).toBe(true);
    }
    expect(calls).toEqual([...MCP_TOOL_NAMES]);
  }
});

test("a refused tool never reaches its binding", async () => {
  /* The health-probe credential is the one identity the policy still bounds. */
  const calls: string[] = [];
  const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [
    toolName,
    async (): Promise<Record<string, unknown>> => {
      calls.push(toolName);
      return { ran: toolName };
    },
  ])) as unknown as McpToolBindings;
  const tools = createMcpToolService(
    bindings,
    new MemoryMcpReceiptStore(),
    mcpToolPolicy(() => ({ kind: "health-probe" })),
  );

  const result = await tools.callTool("spawn_agent", { clientRequestId: "r1", cwd: "/repo", prompt: "go" });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe("tool_not_permitted");
    expect(result.retryable).toBe(false);
  }
  expect(calls).toEqual([]);

  /* And the reads it is admitted for do run. */
  expect((await tools.callTool("deployment_status", { clientRequestId: "r2" })).ok).toBe(true);
  expect(calls).toEqual(["deployment_status"]);
});

test("a worker archive receives the standard permission failure without reaching board mutation", async () => {
  const { calls, service: tools } = service("worker");
  const result = await tools.callTool("conversation_action", {
    clientRequestId: "worker-archive",
    conversationId: "conversation_target",
    action: "archive",
  });

  expect(result).toMatchObject({
    ok: false,
    code: "tool_not_permitted",
    retryable: false,
  });
  expect(calls).toEqual([]);
});

test("a refusal does not spend the clientRequestId, so a later designation still works", async () => {
  const calls: string[] = [];
  const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [
    toolName,
    async (): Promise<Record<string, unknown>> => {
      calls.push(toolName);
      return {};
    },
  ])) as unknown as McpToolBindings;

  let designated = false;
  const policy = mcpToolPolicy(
    () => (designated ? { kind: "unrestricted", reason: "manager" } : { kind: "health-probe" }),
  );
  const tools = createMcpToolService(bindings, new MemoryMcpReceiptStore(), policy);

  const refused = await tools.callTool("bridge_report", { clientRequestId: "same-id", key: "k", class: "status", body: "fyi" });
  expect(refused.ok).toBe(false);

  /* The operator seats this conversation. The identical call must now run — a
     receipt burned by the refusal would answer it with the stale no forever. */
  designated = true;
  const granted = await tools.callTool("bridge_report", { clientRequestId: "same-id", key: "k", class: "status", body: "fyi" });
  expect(granted.ok).toBe(true);
  expect(calls).toEqual(["bridge_report"]);
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
