import type { AttentionCallerAuthority } from "@/lib/attention/callerAuthority";

import type { McpToolArgs, McpToolName } from "./server";

/**
 * #691 §6 — which agent may reach which tool.
 *
 * The architecture rests on two sentences: *the voice agent never drives workers
 * directly*, and *the manager never speaks to the user directly*. The second is a
 * prompt-level commitment, because a model that decides to address the user has
 * no user-facing channel to do it through. The first is not — the voice root runs
 * against the same `viewer` MCP server every worker uses, so without a fence it
 * could spawn agents, edit tasks and deploy, and the two-agent split would be a
 * convention rather than a property.
 *
 * This is that fence. The gateway relays intent and asks for the operator's
 * screen; everything that touches the board belongs to the manager.
 *
 * Deliberately pure over a supplied authority and a supplied manager target, so
 * the decision is testable without a process tree, and so the negative test can
 * enumerate the real tool list rather than a sample of it.
 */

/**
 * The gateway's entire surface. Additions are an operator grant (U6 is open on
 * exactly this) and belong in this array — nowhere else, so "what can the voice
 * agent do" has one answer readable in one place.
 *
 * The report drain is deliberately absent: reports reach the gateway through the
 * host-side delivery seam, not through a tool, so there is nothing here for a
 * model to call and nothing to rate-limit.
 */
export const GATEWAY_ALLOWED_TOOLS: readonly McpToolName[] = [
  /* The deterministic relay: the recipient and the delivery id are derived
     server-side, so the gateway cannot address anyone but the manager and cannot
     mint an id that would let a retry deliver twice. */
  "bridge_directive",
  "send_message",
  "request_attention",
];

const GATEWAY_TOOL_SET: ReadonlySet<string> = new Set(GATEWAY_ALLOWED_TOOLS);

/**
 * Tools only the designated manager may call.
 *
 * `bridge_report` is the single channel anything the user hears comes through. A
 * worker holding it could put words in the manager's mouth — and the operator has
 * no way to tell a report the manager wrote from one a reviewer three levels down
 * injected, because by design they arrive in the same voice. "Every Viewer-spawned
 * worker registers with the same MCP server the operator's own session uses" is the
 * exact hole `attentionCallerAuthority` was written to close for `request_attention`;
 * this closes it for the bridge.
 */
export const MANAGER_ONLY_TOOLS: readonly McpToolName[] = ["bridge_report"];

const MANAGER_ONLY_TOOL_SET: ReadonlySet<string> = new Set(MANAGER_ONLY_TOOLS);

export const HEALTH_PROBE_ALLOWED_TOOLS: readonly McpToolName[] = [
  "board_snapshot",
  "deployment_status",
];

const HEALTH_PROBE_TOOL_SET: ReadonlySet<string> = new Set(HEALTH_PROBE_ALLOWED_TOOLS);

/** Where the manager currently sits, resolved from its designation record. Both
    addressing forms `send_message` accepts must be checkable, or the restriction
    is bypassed by using the other one. */
export interface ManagerTarget {
  conversationId: string | null;
  path: string | null;
}

export type McpCallerIdentity =
  /** A single-use admission minted and redeemed by the runtime host. This
      identity can exercise only the two reads that gate an exact deployment. */
  | { kind: "health-probe" }
  /** Held to the gateway allowlist. `gateway` is the voice root; `unidentified`
      is a caller the registry could not name, which is denied for the same
      reason — see {@link mcpCallerIdentity}. */
  | { kind: "restricted"; reason: "gateway" | "unidentified" }
  /** Positively identified as something other than the root. Keeps exactly the
      surface it has today. */
  | { kind: "unrestricted"; reason: "manager" | "worker" };

export type McpToolVerdict =
  | { allowed: true }
  | { allowed: false; code: "tool_not_permitted" | "recipient_not_permitted"; error: string };

const ALLOWED: McpToolVerdict = { allowed: true };

/**
 * Who is calling, from evidence the caller cannot restate.
 *
 * FAILS CLOSED. Only a caller the registry positively names as something other
 * than the root gets the full surface; the root and every caller that could not
 * be resolved are held to the allowlist.
 *
 * `unidentified` is the case worth spelling out, because the tempting reading is
 * the wrong one. It does not mean "probably a worker" — it means the host
 * evidence that decides this was missing, racing, or unreadable. A gateway lands
 * in that state whenever the registry snapshot is empty or its own ancestry walk
 * comes up short, so granting it the full surface would make the load-bearing
 * constraint hold only while the registry happened to be readable: an
 * identity-resolution failure would become a path to `spawn_agent` and
 * `deploy_exact_sha`, which is precisely what AC21 forbids.
 *
 * The cost is real and deliberate: a worker whose host record cannot be read is
 * refused tools it would otherwise have, and recovers as soon as the registry
 * names it again. Refusing a call that should have been allowed is a retry;
 * allowing one that should have been refused can spawn agents or ship a commit.
 */
export function mcpCallerIdentity(
  authority: AttentionCallerAuthority,
  manager: ManagerTarget | null = null,
): McpCallerIdentity {
  if (authority.kind === "root") return { kind: "restricted", reason: "gateway" };
  if (authority.kind === "unidentified") return { kind: "restricted", reason: "unidentified" };

  /* MANAGER AUTHORITY COMES FROM THE RECORD, NEVER FROM A ROLE STRING.
     `role` is stamped on a launch profile, so anything launched as "orchestrator"
     could claim it — and the manager's one privilege is the channel the operator
     hears from, where an impostor is indistinguishable from the real thing by
     construction. The designation record is the only statement of which
     conversation is the manager, and matching it is the only way to be one. No
     record on file means no manager, which fails closed. */
  const isManager = manager?.conversationId != null
    && manager.conversationId === authority.conversationId;
  return { kind: "unrestricted", reason: isManager ? "manager" : "worker" };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Whether this call is permitted. Refusals carry a code the MCP failure envelope
 * surfaces verbatim, so an agent that hits the fence learns what to do instead
 * rather than seeing a generic tool error and retrying.
 */
export function permitMcpTool(
  identity: McpCallerIdentity,
  toolName: McpToolName,
  args: McpToolArgs,
  manager: ManagerTarget | null,
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
  /* Checked before the restricted branch so it covers every identity that is not
     the manager, in one place: gateway, unidentified, and ordinary workers. */
  if (MANAGER_ONLY_TOOL_SET.has(toolName)
    && !(identity.kind === "unrestricted" && identity.reason === "manager")) {
    return {
      allowed: false,
      code: "tool_not_permitted",
      error: `${toolName} belongs to the designated manager alone — it is the only channel the operator hears from, and a report from anyone else would reach them in the manager's voice.`,
    };
  }
  if (identity.kind !== "restricted") return ALLOWED;
  if (!GATEWAY_TOOL_SET.has(toolName)) {
    return {
      allowed: false,
      code: "tool_not_permitted",
      error: identity.reason === "gateway"
        ? `${toolName} belongs to the manager, not to the voice gateway. Relay the intent with send_message and report back what the manager answers.`
        : `${toolName} is refused because this caller's conversation could not be identified from the registry, and an unidentified caller is held to the voice gateway's surface. Relay through the manager with send_message.`,
    };
  }
  if (toolName !== "send_message") return ALLOWED;

  /* One correspondent, named explicitly. An unaddressed message is refused rather
     than defaulted to the manager: defaulting would turn a missing recipient into
     apparent intent, and a tool that silently redirects is worse than one that
     says no. */
  const conversationId = text(args.conversationId);
  const transcriptPath = text(args.transcriptPath);
  const matches = (conversationId && manager?.conversationId && conversationId === manager.conversationId)
    || (transcriptPath && manager?.path && transcriptPath === manager.path);
  if (matches) return ALLOWED;
  return {
    allowed: false,
    code: "recipient_not_permitted",
    error: manager?.conversationId
      ? `the voice gateway may only message the manager (${manager.conversationId}); address send_message to it and let it coordinate workers`
      : "no manager conversation is designated, so the voice gateway has nobody to relay to yet",
  };
}

/** The shape {@link import("./server").createMcpToolService} consults. Kept
    narrow so the service does not depend on how an identity was resolved. */
export interface McpToolPolicy {
  permit(toolName: McpToolName, args: McpToolArgs): McpToolVerdict;
}

/** Bind an identity and a manager resolver into a policy. The manager is resolved
    per call, not captured: a manager swap mid-session must take effect without
    restarting the MCP server. */
export function mcpToolPolicy(
  identity: () => McpCallerIdentity,
  manager: () => ManagerTarget | null,
): McpToolPolicy {
  return {
    permit: (toolName, args) => permitMcpTool(identity(), toolName, args, manager()),
  };
}
