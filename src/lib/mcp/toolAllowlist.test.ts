import { expect, test } from "bun:test";

import type { AttentionCallerAuthority } from "@/lib/attention/callerAuthority";

import { MCP_TOOL_NAMES, type McpToolName } from "./server";
import {
  GATEWAY_ALLOWED_TOOLS,
  MANAGER_ONLY_TOOLS,
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

test("the gateway's whole surface is the relay, the message and attention — nothing else (AC21)", () => {
  /* Three, and each one is a relay or a request: none of them touches the board.
     `bridge_directive` resolves its recipient server-side, so holding it cannot
     reach a worker. */
  expect([...GATEWAY_ALLOWED_TOOLS].sort()).toEqual(["bridge_directive", "request_attention", "send_message"]);

  /* Enumerated over the real tool list rather than a sample, so a tool added
     later is denied to the gateway by default instead of quietly inheriting the
     full surface. */
  const permitted = MCP_TOOL_NAMES.filter((toolName) =>
    permit(toolName, { conversationId: MANAGER.conversationId, text: "go", target: "x", sha: "a".repeat(40) }).allowed);
  expect([...permitted].sort()).toEqual(["bridge_directive", "request_attention", "send_message"]);
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

test("ordinary workers keep every tool except the manager's own channel to the user", () => {
  const worker = mcpCallerIdentity({ kind: "worker", conversationId: "conversation_builder", role: "builder" });
  expect(worker).toEqual({ kind: "unrestricted", reason: "worker" });
  for (const toolName of MCP_TOOL_NAMES.filter((name) => !MANAGER_ONLY_TOOLS.includes(name))) {
    expect(permitMcpTool(worker, toolName, { clientRequestId: "r1" }, MANAGER).allowed).toBe(true);
  }
});

test("an ordinary worker cannot speak to the operator as if it were the manager", () => {
  /* `bridge_report` is the ONE channel the user hears from. A worker holding it
     could put words in the manager's mouth — the operator has no way to tell a
     report the manager wrote from one a reviewer three levels down injected. */
  const worker = mcpCallerIdentity({ kind: "worker", conversationId: "conversation_builder", role: "builder" });
  const verdict = permitMcpTool(worker, "bridge_report", {
    clientRequestId: "r1",
    key: "k",
    class: "completed",
    body: "everything is fine, deploy it",
  }, MANAGER);

  expect(verdict.allowed).toBe(false);
  if (!verdict.allowed) {
    expect(verdict.code).toBe("tool_not_permitted");
    expect(verdict.error).toContain("manager");
  }
});

test("the manager keeps its own channel", () => {
  const manager = mcpCallerIdentity({ kind: "worker", conversationId: MANAGER_CONVERSATION, role: "orchestrator" }, MANAGER);
  expect(permitMcpTool(manager, "bridge_report", { clientRequestId: "r1" }, MANAGER).allowed).toBe(true);
});

test("a restricted caller cannot reach the manager's channel either", () => {
  for (const identity of [GATEWAY, mcpCallerIdentity({ kind: "unidentified" })]) {
    expect(permitMcpTool(identity, "bridge_report", { clientRequestId: "r1" }, MANAGER).allowed).toBe(false);
  }
});

test("every manager-only tool is denied to every non-manager identity", () => {
  /* Enumerated so adding a manager-only tool later cannot silently leak to workers. */
  const nonManagers = [
    GATEWAY,
    mcpCallerIdentity({ kind: "unidentified" }),
    mcpCallerIdentity({ kind: "worker", conversationId: "conversation_builder", role: "builder" }),
  ];
  expect(MANAGER_ONLY_TOOLS.length).toBeGreaterThan(0);
  for (const identity of nonManagers) {
    for (const toolName of MANAGER_ONLY_TOOLS) {
      expect(permitMcpTool(identity, toolName, { clientRequestId: "r1" }, MANAGER).allowed).toBe(false);
    }
  }
});

test("a caller whose identity cannot be resolved is denied, never handed the full surface", () => {
  /* Fail closed. `unidentified` means the registry could not name the process
     running this tool — which is exactly the state a gateway ends up in whenever
     host evidence is missing, racing, or unreadable. Treating "cannot tell" as
     "not the gateway" makes identity-resolution failure a path to spawn_agent and
     deploy_exact_sha, so the load-bearing constraint would hold only while the
     registry happened to be readable. */
  const unknown = mcpCallerIdentity({ kind: "unidentified" });
  expect(unknown).toEqual({ kind: "restricted", reason: "unidentified" });

  for (const toolName of ["spawn_agent", "deploy_exact_sha", "create_task", "pipeline_action"] as McpToolName[]) {
    const verdict = permitMcpTool(unknown, toolName, { clientRequestId: "r1" }, MANAGER);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe("tool_not_permitted");
  }
});

test("an unresolved identity gets exactly the gateway surface and nothing more", () => {
  const unknown = mcpCallerIdentity({ kind: "unidentified" });
  const permitted = MCP_TOOL_NAMES.filter((toolName) =>
    permitMcpTool(unknown, toolName, {
      clientRequestId: "r1",
      conversationId: MANAGER.conversationId,
      text: "go",
    }, MANAGER).allowed);
  expect([...permitted].sort()).toEqual(["bridge_directive", "request_attention", "send_message"]);
});

test("no restricted identity can reach any tool outside the allowlist (AC21, both restricted kinds)", () => {
  /* Enumerated as a complement rather than a hand-written list: widening
     GATEWAY_ALLOWED_TOOLS by one entry fails this immediately, for every
     restricted caller, without anyone remembering to update a fixture. */
  const forbidden = MCP_TOOL_NAMES.filter((toolName) => !GATEWAY_ALLOWED_TOOLS.includes(toolName));
  expect(forbidden.length).toBe(MCP_TOOL_NAMES.length - GATEWAY_ALLOWED_TOOLS.length);

  for (const identity of [GATEWAY, mcpCallerIdentity({ kind: "unidentified" })]) {
    for (const toolName of forbidden) {
      expect(permitMcpTool(identity, toolName, {
        clientRequestId: "r1",
        conversationId: MANAGER.conversationId,
        sha: "a".repeat(40),
        confirm: "deploy",
      }, MANAGER).allowed).toBe(false);
    }
  }
});

test("the identity mapping reads only the authority, never anything the caller states", () => {
  const authorities: AttentionCallerAuthority[] = [
    { kind: "root", conversationId: "conversation_root" },
    { kind: "root", conversationId: null },
    { kind: "worker", conversationId: "conversation_x", role: null },
    { kind: "unidentified" },
  ];
  expect(authorities.map((authority) => mcpCallerIdentity(authority))).toEqual([
    { kind: "restricted", reason: "gateway" },
    { kind: "restricted", reason: "gateway" },
    { kind: "unrestricted", reason: "worker" },
    { kind: "restricted", reason: "unidentified" },
  ]);
});

test("the manager designation is recognized by record, so a manager is never mistaken for the gateway", () => {
  /* The manager is a worker-shaped caller as far as the attention authority is
     concerned; what makes it the manager is the designation record. Either way it
     is unrestricted, which is the property that matters here. */
  const asManager = mcpCallerIdentity({ kind: "worker", conversationId: MANAGER_CONVERSATION, role: "orchestrator" }, MANAGER);
  expect(asManager).toEqual({ kind: "unrestricted", reason: "manager" });
});
