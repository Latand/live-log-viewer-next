import { expect, test } from "bun:test";

import type { AttentionCallerAuthority } from "@/lib/attention/callerAuthority";

import { MCP_TOOL_NAMES, type McpToolName } from "./server";
import {
  GATEWAY_ALLOWED_TOOLS,
  mcpCallerIdentity,
  permitMcpTool,
  type ManagerTarget,
} from "./toolAllowlist";

const MANAGER_CONVERSATION = "conversation_manager";
const MANAGER: ManagerTarget = {
  conversationId: MANAGER_CONVERSATION,
  path: "/srv/agents/sessions/manager.jsonl",
};

const GATEWAY = mcpCallerIdentity({ kind: "root", conversationId: "conversation_root" });

function permit(toolName: McpToolName, args: Record<string, unknown> = {}) {
  return permitMcpTool(GATEWAY, toolName, { clientRequestId: "r1", ...args }, MANAGER);
}

test("the gateway's whole surface is send_message and request_attention, and nothing else (AC21)", () => {
  expect([...GATEWAY_ALLOWED_TOOLS].sort()).toEqual(["request_attention", "send_message"]);

  /* Enumerated over the real tool list rather than a sample, so a tool added
     later is denied to the gateway by default instead of quietly inheriting the
     full surface. */
  const permitted = MCP_TOOL_NAMES.filter((toolName) =>
    permit(toolName, { conversationId: MANAGER.conversationId, text: "go", target: "x", sha: "a".repeat(40) }).allowed);
  expect([...permitted].sort()).toEqual(["request_attention", "send_message"]);
});

test("the gateway cannot reach any worker, task, pipeline, flow or deploy tool (AC21, AC20)", () => {
  const forbidden: McpToolName[] = [
    "spawn_agent",
    "create_task",
    "update_task",
    "create_pipeline",
    "pipeline_action",
    "link_task_to_pipeline",
    "flow_action",
    "conversation_action",
    "conversation_migration",
    "deploy_exact_sha",
  ];
  for (const toolName of forbidden) {
    const verdict = permit(toolName, { sha: "a".repeat(40), confirm: "deploy" });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.code).toBe("tool_not_permitted");
      expect(verdict.error).toContain("manager");
    }
  }
});

test("the gateway cannot read the board either — it relays, it does not survey", () => {
  for (const toolName of ["board_snapshot", "operator_snapshot", "list_tasks", "lifecycle_events"] as McpToolName[]) {
    expect(permit(toolName).allowed).toBe(false);
  }
});

test("the gateway may message the manager and only the manager", () => {
  expect(permit("send_message", { conversationId: MANAGER.conversationId, text: "start a reviewer" }).allowed).toBe(true);
  expect(permit("send_message", { transcriptPath: MANAGER.path, text: "start a reviewer" }).allowed).toBe(true);

  const toWorker = permit("send_message", { conversationId: "conversation_worker", text: "do it yourself" });
  expect(toWorker.allowed).toBe(false);
  if (!toWorker.allowed) {
    expect(toWorker.code).toBe("recipient_not_permitted");
    expect(toWorker.error).toContain("manager");
  }
  expect(permit("send_message", { transcriptPath: "/srv/agents/sessions/worker.jsonl", text: "hi" }).allowed).toBe(false);
});

test("an unaddressed send_message is refused rather than defaulted to the manager", () => {
  /* Defaulting would make a missing recipient look like intent. The gateway has
     exactly one correspondent, so naming it is free — and the alternative is a
     tool that silently redirects messages. */
  expect(permit("send_message", { text: "hello" }).allowed).toBe(false);
});

test("with no manager designated, the gateway can raise attention but cannot message anyone", () => {
  const identity = mcpCallerIdentity({ kind: "root", conversationId: "conversation_root" });
  expect(permitMcpTool(identity, "request_attention", { clientRequestId: "r1" }, null).allowed).toBe(true);

  const verdict = permitMcpTool(
    identity,
    "send_message",
    { clientRequestId: "r1", conversationId: "conversation_anything", text: "hi" },
    null,
  );
  expect(verdict.allowed).toBe(false);
  if (!verdict.allowed) expect(verdict.code).toBe("recipient_not_permitted");
});

test("the manager keeps the full surface with today's gates (§6)", () => {
  const manager = mcpCallerIdentity({ kind: "worker", conversationId: MANAGER_CONVERSATION, role: "orchestrator" });
  expect(manager).toEqual({ kind: "unrestricted", reason: "manager" });
  for (const toolName of MCP_TOOL_NAMES) {
    expect(permitMcpTool(manager, toolName, { clientRequestId: "r1" }, MANAGER).allowed).toBe(true);
  }
});

test("ordinary workers are unchanged by this fence", () => {
  const worker = mcpCallerIdentity({ kind: "worker", conversationId: "conversation_builder", role: "builder" });
  expect(worker).toEqual({ kind: "unrestricted", reason: "worker" });
  for (const toolName of MCP_TOOL_NAMES) {
    expect(permitMcpTool(worker, toolName, { clientRequestId: "r1" }, MANAGER).allowed).toBe(true);
  }
});

test("an unidentifiable caller keeps the full surface rather than being locked out", () => {
  /* `attentionCallerAuthority` documents why `unidentified` exists: a root the
     Viewer observes rather than launched has no host evidence. Treating that as
     the gateway would strip the operator's own terminal session of every tool it
     has today, to fence an agent the registry cannot even name. */
  const unknown = mcpCallerIdentity({ kind: "unidentified" });
  expect(unknown).toEqual({ kind: "unrestricted", reason: "unidentified" });
  expect(permitMcpTool(unknown, "spawn_agent", { clientRequestId: "r1" }, MANAGER).allowed).toBe(true);
});

test("the identity mapping reads only the authority, never anything the caller states", () => {
  const authorities: AttentionCallerAuthority[] = [
    { kind: "root", conversationId: "conversation_root" },
    { kind: "root", conversationId: null },
    { kind: "worker", conversationId: "conversation_x", role: null },
    { kind: "unidentified" },
  ];
  expect(authorities.map((authority) => mcpCallerIdentity(authority).kind)).toEqual([
    "gateway",
    "gateway",
    "unrestricted",
    "unrestricted",
  ]);
});

test("the manager designation is recognized by record, so a manager is never mistaken for the gateway", () => {
  /* The manager is a worker-shaped caller as far as the attention authority is
     concerned; what makes it the manager is the designation record. Either way it
     is unrestricted, which is the property that matters here. */
  const asManager = mcpCallerIdentity({ kind: "worker", conversationId: MANAGER_CONVERSATION, role: "orchestrator" }, MANAGER);
  expect(asManager).toEqual({ kind: "unrestricted", reason: "manager" });
});
