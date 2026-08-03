import type { AttentionCallerAuthority } from "@/lib/attention/callerAuthority";

import type { McpToolArgs, McpToolName } from "./server";

/**
 * B+ tool policy: the full Viewer MCP surface is present and callable in EVERY
 * agent session. Role, seat and root classification decide NOTHING about
 * availability — the era in which the voice gateway was held to a three-tool
 * allowlist, `bridge_report` was manager-only, and an unidentified caller lost
 * the surface entirely is over, deliberately: it cost the operator the ability
 * to focus a session through the Viewer at all when identity resolution had
 * nothing to say.
 *
 * What identity still decides — and these are OPERATION contracts, not
 * availability gates:
 *
 *  - ORIGIN LABELING. Every `bridge_report` row carries a server-derived origin
 *    (`@/lib/bridge/types`), so a non-orchestrator report is visibly attributed
 *    and can never impersonate the manager's voice. That happens in the
 *    binding, from the same identity resolved here.
 *  - DEPLOY EXECUTION. Only the designated orchestrator seat executes
 *    `deploy_exact_sha`; that authority is derived and refused in the deploy
 *    binding itself, from the same server-attributed identity chain.
 *
 * The exact-SHA deploy contract, idempotency keys, typed-target validation,
 * receipts and redaction are all enforced in their own layers and are
 * untouched by this policy.
 */

export const HEALTH_PROBE_ALLOWED_TOOLS: readonly McpToolName[] = [
  "board_snapshot",
  "deployment_status",
];

const HEALTH_PROBE_TOOL_SET: ReadonlySet<string> = new Set(HEALTH_PROBE_ALLOWED_TOOLS);

/** Where the designated orchestrator currently sits. `seats` are the
    operator-selected per-project designations, VALIDATED before they get here
    (`@/lib/orchestrator/authority` fails closed on conflicting, revoked,
    superseded, unknown and cross-project identities). */
export interface ManagerTarget {
  conversationId: string | null;
  path: string | null;
  seats?: readonly { conversationId: string; path: string | null }[];
}

function managerMatchesConversation(manager: ManagerTarget | null, conversationId: string): boolean {
  if (!manager) return false;
  if (manager.conversationId != null && manager.conversationId === conversationId) return true;
  return (manager.seats ?? []).some((seat) => seat.conversationId === conversationId);
}

export type McpCallerIdentity =
  /** A single-use admission minted and redeemed by the runtime host. This
      identity can exercise only the two reads that gate an exact deployment —
      it is a probe credential, not an agent session, so B+ item 1 does not
      apply to it. */
  | { kind: "health-probe" }
  /** The voice gateway (root) or a caller the registry could not name. Holds
      the full surface; the kind exists for labeling, not for availability. */
  | { kind: "restricted"; reason: "gateway" | "unidentified" }
  /** Positively identified as an agent conversation. `manager` means the
      durable designation names this conversation. */
  | { kind: "unrestricted"; reason: "manager" | "worker" };

export type McpToolVerdict =
  | { allowed: true }
  | { allowed: false; code: "tool_not_permitted"; error: string };

const ALLOWED: McpToolVerdict = { allowed: true };

/**
 * Who is calling, from evidence the caller cannot restate.
 *
 * MANAGER AUTHORITY COMES FROM THE DURABLE DESIGNATION, NEVER FROM A ROLE
 * STRING: `role` is stamped on a launch profile, so anything launched as
 * "orchestrator" could claim it. The designation record and the validated
 * seats are the only statement of which conversation is the manager, and
 * matching them is the only way to be one. This classification labels; it does
 * not gate availability.
 */
export function mcpCallerIdentity(
  authority: AttentionCallerAuthority,
  manager: ManagerTarget | null = null,
): McpCallerIdentity {
  if (authority.kind === "root") return { kind: "restricted", reason: "gateway" };
  if (authority.kind === "unidentified") return { kind: "restricted", reason: "unidentified" };
  const isManager = managerMatchesConversation(manager, authority.conversationId);
  return { kind: "unrestricted", reason: isManager ? "manager" : "worker" };
}

/**
 * Whether this call is permitted. Everything is allowed for every agent
 * session; the one exception is the health-probe credential's bounded reads.
 * Nothing in the ARGUMENTS is consulted — a permit decision reads identity and
 * tool name only, so no caller can talk its way past this. Refusals carry a
 * code the MCP failure envelope surfaces verbatim, so a refused caller learns
 * what to do instead of retrying into a wall.
 */
export function permitMcpTool(
  identity: McpCallerIdentity,
  toolName: McpToolName,
): McpToolVerdict {
  if (identity.kind === "health-probe") {
    return HEALTH_PROBE_TOOL_SET.has(toolName)
      ? ALLOWED
      : {
        allowed: false,
        code: "tool_not_permitted",
        error: `${toolName} is outside the managed MCP health-probe surface.`,
      };
  }
  return ALLOWED;
}

/**
 * Who may move the operator's screen (#873 review, finding 1).
 *
 * `request_attention` navigates the operator's one active view the moment it
 * is called — there is no confirmation surface left to stand between a caller
 * and the camera. That is an OPERATION contract in the B+ sense (like deploy
 * execution above), not a tool-availability gate: the tool stays on every
 * session's surface, and the binding itself refuses executions the durable
 * identity does not entitle.
 *
 * Entitled: the operator's own root/gateway session, and the validated
 * designated orchestrator seat for the project the target lives in. Refused,
 * with nothing written and nothing moved: unidentified callers, ordinary
 * workers, and an orchestrator whose seat names a DIFFERENT project than the
 * target (cross-project). Revoked, superseded and unknown identities never
 * appear in the validated seat list at all (`@/lib/orchestrator/authority`
 * fails closed), so they refuse as workers here. Server-attributed authority
 * only — nothing the caller says participates.
 */
export type AttentionHandoffVerdict =
  | { allowed: true; via: "root" | "orchestrator" }
  | { allowed: false; refusedAs: "unidentified" | "worker" | "cross-project"; error: string };

/**
 * One decision, callable in two phases: `targetProject: null` settles the
 * identity half before the binding reads anything (an unauthorized caller
 * learns nothing about the board from target-resolution errors), and the
 * project half runs once the target has named its project.
 */
export function permitAttentionHandoff(
  authority: AttentionCallerAuthority,
  seats: readonly { conversationId: string; project: string | null }[],
  targetProject: string | null,
): AttentionHandoffVerdict {
  if (authority.kind === "root") return { allowed: true, via: "root" };
  if (authority.kind === "unidentified") {
    return {
      allowed: false,
      refusedAs: "unidentified",
      error: "request_attention moves the operator's screen, and no durable evidence names this caller; only the root session or the designated orchestrator may direct it",
    };
  }
  const held = seats.filter((seat) => seat.conversationId === authority.conversationId);
  if (held.length === 0) {
    return {
      allowed: false,
      refusedAs: "worker",
      error: "request_attention moves the operator's screen; a worker session may not direct it — signal the orchestrator or the root session instead",
    };
  }
  /* A seat with no recorded project is the legacy single-instance designation:
     the operator named one manager for the whole machine, so it is not a
     cross-project claim to refuse. */
  if (targetProject === null || held.some((seat) => seat.project === null || seat.project === targetProject)) {
    return { allowed: true, via: "orchestrator" };
  }
  return {
    allowed: false,
    refusedAs: "cross-project",
    error: "this orchestrator seat is designated for a different project than the target; re-designate or target your own project",
  };
}

/** The shape {@link import("./server").createMcpToolService} consults. Kept
    narrow so the service does not depend on how an identity was resolved. */
export interface McpToolPolicy {
  permit(toolName: McpToolName, args: McpToolArgs): McpToolVerdict;
}

/** Bind an identity resolver into a policy. Resolved per call, not captured: a
    designation change mid-session must take effect without restarting the MCP
    server. */
export function mcpToolPolicy(identity: () => McpCallerIdentity): McpToolPolicy {
  return {
    permit: (toolName) => permitMcpTool(identity(), toolName),
  };
}
