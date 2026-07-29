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
 * labels origins and gates exactly one operation (minting a deployment
 * confirmation); it never makes a tool disappear.
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
      /* No confirmation payload: minting is the one gated operation and has its
         own tests below. Everything else is allowed for everyone. */
      const verdict = permitMcpTool(identity, toolName, { clientRequestId: "r1", conversationId: "conversation_anyone", text: "go" });
      expect(`${toolName}:${verdict.allowed}`).toBe(`${toolName}:true`);
    }
  }
});

test("the gateway may message ANY conversation — role no longer restricts recipients", () => {
  const gateway = mcpCallerIdentity({ kind: "root", conversationId: "conversation_root" });
  expect(permitMcpTool(gateway, "send_message", { clientRequestId: "r1", conversationId: "conversation_worker", text: "hi" }).allowed).toBe(true);
  expect(permitMcpTool(gateway, "send_message", { clientRequestId: "r1", text: "hello" }).allowed).toBe(true);
});

test("host health admission reaches exactly the two deployment reads and no agent action", () => {
  const admitted = MCP_TOOL_NAMES.filter((toolName) =>
    permitMcpTool({ kind: "health-probe" }, toolName, { clientRequestId: "health" }).allowed);

  expect([...HEALTH_PROBE_ALLOWED_TOOLS].sort()).toEqual(["board_snapshot", "deployment_status"]);
  expect([...admitted].sort()).toEqual(["board_snapshot", "deployment_status"]);
});

/* ── The one operation identity still gates: minting a deploy confirmation ── */

const CONFIRMATION_ARGS = {
  clientRequestId: "r1",
  key: "k",
  class: "confirmation_request",
  body: "deploy?",
  confirmation: { sha: "a".repeat(40) },
};

test("only the designated orchestrator may mint a confirmation_request", () => {
  const manager = mcpCallerIdentity({ kind: "worker", conversationId: MANAGER_CONVERSATION, role: "orchestrator" }, MANAGER);
  expect(manager).toEqual({ kind: "unrestricted", reason: "manager" });
  expect(permitMcpTool(manager, "bridge_report", CONFIRMATION_ARGS).allowed).toBe(true);

  for (const identity of [
    mcpCallerIdentity({ kind: "root", conversationId: "conversation_root" }),
    mcpCallerIdentity({ kind: "unidentified" }),
    mcpCallerIdentity({ kind: "worker", conversationId: "conversation_builder", role: "builder" }, MANAGER),
  ]) {
    const verdict = permitMcpTool(identity, "bridge_report", CONFIRMATION_ARGS);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.code).toBe("confirmation_not_permitted");
      expect(verdict.error).toContain("orchestrator");
    }
  }
});

test("a smuggled confirmation payload on another class is refused for non-managers too", () => {
  const worker = mcpCallerIdentity({ kind: "worker", conversationId: "conversation_builder", role: "builder" }, MANAGER);
  const verdict = permitMcpTool(worker, "bridge_report", {
    clientRequestId: "r1",
    key: "k",
    class: "status",
    body: "fine",
    confirmation: { sha: "a".repeat(40) },
  });
  expect(verdict.allowed).toBe(false);
});

test("a plain report from any session is allowed — origin labeling, not refusal, is the control", () => {
  for (const identity of EVERY_SESSION_IDENTITY) {
    expect(permitMcpTool(identity, "bridge_report", { clientRequestId: "r1", key: "k", class: "status", body: "fyi" }).allowed).toBe(true);
  }
});

/* ── Classification itself: labels from evidence the caller cannot restate ── */

test("a claimed orchestrator role grants nothing without matching the designation", () => {
  /* The role string comes off a launch profile, which a caller can be launched
     with. The manager label — and with it the confirmation mint and the manager
     voice — comes only from the durable designation naming the conversation. */
  const impostor = mcpCallerIdentity(
    { kind: "worker", conversationId: "conversation_impostor", role: "orchestrator" },
    MANAGER,
  );
  expect(impostor).toEqual({ kind: "unrestricted", reason: "worker" });
  expect(permitMcpTool(impostor, "bridge_report", CONFIRMATION_ARGS).allowed).toBe(false);
});

test("with no designation on file nobody is the manager, so nobody can mint", () => {
  const claimed = mcpCallerIdentity({ kind: "worker", conversationId: "conversation_x", role: "orchestrator" }, null);
  expect(claimed).toEqual({ kind: "unrestricted", reason: "worker" });
  expect(permitMcpTool(claimed, "bridge_report", CONFIRMATION_ARGS).allowed).toBe(false);
});

test("an operator-selected seat confers the manager label exactly like the primary record", () => {
  const seated: ManagerTarget = { conversationId: null, path: null, seats: [{ conversationId: "conversation_seated", path: null }] };
  const manager = mcpCallerIdentity({ kind: "worker", conversationId: "conversation_seated", role: "builder" }, seated);
  expect(manager).toEqual({ kind: "unrestricted", reason: "manager" });
  expect(permitMcpTool(manager, "bridge_report", CONFIRMATION_ARGS).allowed).toBe(true);
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
