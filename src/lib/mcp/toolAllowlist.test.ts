import { expect, test } from "bun:test";

import type { AttentionCallerAuthority } from "@/lib/attention/callerAuthority";

import { MCP_TOOL_NAMES } from "./server";
import {
  HEALTH_PROBE_ALLOWED_TOOLS,
  mcpCallerIdentity,
  permitMcpTool,
  type ManagerTarget,
} from "./toolAllowlist";

/*
 * B+ item 1: the full Viewer MCP surface is present and callable in EVERY
 * agent session. Classification — gateway, worker, manager, unidentified —
 * labels origins; it never makes a tool disappear and it gates no operation
 * here. Deploy authority is derived in the deploy binding itself, from the
 * same server-attributed identity chain (#795).
 */

const MANAGER_CONVERSATION = "conversation_manager";
const MANAGER: ManagerTarget = {
  conversationId: MANAGER_CONVERSATION,
  path: "/srv/agents/sessions/manager.jsonl",
};

const EVERY_SESSION_IDENTITY = [
  mcpCallerIdentity({ kind: "root", conversationId: "conversation_root" }),
  mcpCallerIdentity({ kind: "root", conversationId: null }),
  mcpCallerIdentity({ kind: "unidentified" }),
  mcpCallerIdentity({ kind: "worker", conversationId: "conversation_builder", role: "builder" }),
  mcpCallerIdentity({ kind: "worker", conversationId: MANAGER_CONVERSATION, role: "orchestrator" }, MANAGER),
];

test("every session classification holds the FULL tool surface — enumerated over the real tool list", () => {
  for (const identity of EVERY_SESSION_IDENTITY) {
    for (const toolName of MCP_TOOL_NAMES) {
      const verdict = permitMcpTool(identity, toolName);
      expect(`${toolName}:${verdict.allowed}`).toBe(`${toolName}:true`);
    }
  }
});

test("the gateway may message ANY conversation — role no longer restricts recipients", () => {
  const gateway = mcpCallerIdentity({ kind: "root", conversationId: "conversation_root" });
  expect(permitMcpTool(gateway, "send_message").allowed).toBe(true);
});

test("host health admission reaches exactly the two deployment reads and no agent action", () => {
  const admitted = MCP_TOOL_NAMES.filter((toolName) =>
    permitMcpTool({ kind: "health-probe" }, toolName).allowed);

  expect([...HEALTH_PROBE_ALLOWED_TOOLS].sort()).toEqual(["board_snapshot", "deployment_status"]);
  expect([...admitted].sort()).toEqual(["board_snapshot", "deployment_status"]);
});

test("a plain report from any session is allowed — origin labeling, not refusal, is the control", () => {
  for (const identity of EVERY_SESSION_IDENTITY) {
    expect(permitMcpTool(identity, "bridge_report").allowed).toBe(true);
  }
});

/* ── Classification itself: labels from evidence the caller cannot restate ── */

test("a claimed orchestrator role grants nothing without matching the designation", () => {
  /* The role string comes off a launch profile, which a caller can be launched
     with. The manager label — and with it the manager voice on the bridge and
     deploy authority in the deploy binding — comes only from the durable
     designation naming the conversation. */
  const impostor = mcpCallerIdentity(
    { kind: "worker", conversationId: "conversation_impostor", role: "orchestrator" },
    MANAGER,
  );
  expect(impostor).toEqual({ kind: "unrestricted", reason: "worker" });
});

test("with no designation on file nobody is the manager", () => {
  const claimed = mcpCallerIdentity({ kind: "worker", conversationId: "conversation_x", role: "orchestrator" }, null);
  expect(claimed).toEqual({ kind: "unrestricted", reason: "worker" });
});

test("an operator-selected seat confers the manager label exactly like the primary record", () => {
  const seated: ManagerTarget = { conversationId: null, path: null, seats: [{ conversationId: "conversation_seated", path: null }] };
  const manager = mcpCallerIdentity({ kind: "worker", conversationId: "conversation_seated", role: "builder" }, seated);
  expect(manager).toEqual({ kind: "unrestricted", reason: "manager" });
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

test("the manager is recognized by conversation id alone, whatever role it carries", () => {
  for (const role of ["orchestrator", "builder", null]) {
    const manager = mcpCallerIdentity({ kind: "worker", conversationId: MANAGER_CONVERSATION, role }, MANAGER);
    expect(manager).toEqual({ kind: "unrestricted", reason: "manager" });
  }
});
