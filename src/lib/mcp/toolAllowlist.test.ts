import { expect, test } from "bun:test";

import type { AttentionCallerAuthority } from "@/lib/attention/callerAuthority";

import { MCP_TOOL_NAMES } from "./server";
import {
  HEALTH_PROBE_ALLOWED_TOOLS,
  mcpCallerIdentity,
  permitAttentionHandoff,
  permitMcpTool,
  type ManagerTarget,
} from "./toolAllowlist";

/*
 * B+ item 1: the full Viewer MCP surface is present in every agent session.
 * Archive execution is the scoped operation-level exception: root and a
 * durably designated orchestrator seat may change board visibility.
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

test("archive and unarchive admit only root or a durably designated orchestrator", () => {
  const archiveArgs = { action: "archive" };
  const root = mcpCallerIdentity({ kind: "root", conversationId: "conversation_root" });
  const manager = mcpCallerIdentity(
    { kind: "worker", conversationId: MANAGER_CONVERSATION, role: "builder" },
    MANAGER,
  );
  const worker = mcpCallerIdentity({ kind: "worker", conversationId: "conversation_builder", role: "builder" }, MANAGER);
  const unidentified = mcpCallerIdentity({ kind: "unidentified" }, MANAGER);

  expect(permitMcpTool(root, "conversation_action", archiveArgs).allowed).toBe(true);
  expect(permitMcpTool(manager, "conversation_action", archiveArgs).allowed).toBe(true);
  expect(permitMcpTool(manager, "conversation_action", { action: "unarchive" }).allowed).toBe(true);
  expect(permitMcpTool(worker, "conversation_action", archiveArgs)).toMatchObject({
    allowed: false,
    code: "tool_not_permitted",
  });
  expect(permitMcpTool(unidentified, "conversation_action", archiveArgs)).toMatchObject({
    allowed: false,
    code: "tool_not_permitted",
  });
  expect(permitMcpTool(worker, "conversation_action", { action: "kill" }).allowed).toBe(true);
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

/* ── #873 review, finding 1: who may execute an attention handoff ────────── */

const TARGET_PROJECT = "live-log-viewer-next";

test("the root/gateway session directs the handoff in either phase", () => {
  for (const targetProject of [null, TARGET_PROJECT]) {
    expect(permitAttentionHandoff({ kind: "root", conversationId: "conversation_root" }, [], targetProject))
      .toEqual({ allowed: true, via: "root" });
    expect(permitAttentionHandoff({ kind: "root", conversationId: null }, [], targetProject))
      .toEqual({ allowed: true, via: "root" });
  }
});

test("an unidentified caller is refused in the identity phase, before any target is read", () => {
  const verdict = permitAttentionHandoff({ kind: "unidentified" }, [], null);
  expect(verdict.allowed).toBe(false);
  if (!verdict.allowed) expect(verdict.refusedAs).toBe("unidentified");
});

test("a worker with no validated seat is refused in the identity phase", () => {
  const verdict = permitAttentionHandoff(
    { kind: "worker", conversationId: "conversation_reviewer", role: "reviewer" },
    [{ conversationId: "conversation_manager", project: TARGET_PROJECT }],
    null,
  );
  expect(verdict.allowed).toBe(false);
  if (!verdict.allowed) expect(verdict.refusedAs).toBe("worker");
});

test("the validated orchestrator seat for the target's project is allowed", () => {
  expect(permitAttentionHandoff(
    { kind: "worker", conversationId: "conversation_manager", role: "orchestrator" },
    [{ conversationId: "conversation_manager", project: TARGET_PROJECT }],
    TARGET_PROJECT,
  )).toEqual({ allowed: true, via: "orchestrator" });
});

test("an orchestrator seated in a different project is refused cross-project", () => {
  const verdict = permitAttentionHandoff(
    { kind: "worker", conversationId: "conversation_manager", role: "orchestrator" },
    [{ conversationId: "conversation_manager", project: "another-project" }],
    TARGET_PROJECT,
  );
  expect(verdict.allowed).toBe(false);
  if (!verdict.allowed) expect(verdict.refusedAs).toBe("cross-project");
});

test("the legacy unscoped designation (null project) covers any target project", () => {
  expect(permitAttentionHandoff(
    { kind: "worker", conversationId: "conversation_manager", role: null },
    [{ conversationId: "conversation_manager", project: null }],
    TARGET_PROJECT,
  )).toEqual({ allowed: true, via: "orchestrator" });
});

test("nothing the caller states participates: the verdict reads authority and seats alone", () => {
  /* A role string that CLAIMS orchestrator changes nothing — the seat list is
     the only statement of designation, exactly as the deploy gate reads it. */
  const verdict = permitAttentionHandoff(
    { kind: "worker", conversationId: "conversation_impostor", role: "orchestrator" },
    [{ conversationId: "conversation_manager", project: TARGET_PROJECT }],
    TARGET_PROJECT,
  );
  expect(verdict.allowed).toBe(false);
});
