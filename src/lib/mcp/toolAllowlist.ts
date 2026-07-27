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
  "send_message",
  "request_attention",
];

const GATEWAY_TOOL_SET: ReadonlySet<string> = new Set(GATEWAY_ALLOWED_TOOLS);

/** Where the manager currently sits, resolved from its designation record. Both
    addressing forms `send_message` accepts must be checkable, or the restriction
    is bypassed by using the other one. */
export interface ManagerTarget {
  conversationId: string | null;
  path: string | null;
}

export type McpCallerIdentity =
  /** The voice root: sole user-facing gateway, minimal tools. */
  | { kind: "gateway" }
  /** Everyone else keeps exactly the surface they have today. */
  | { kind: "unrestricted"; reason: "manager" | "worker" | "unidentified" };

export type McpToolVerdict =
  | { allowed: true }
  | { allowed: false; code: "tool_not_permitted" | "recipient_not_permitted"; error: string };

const ALLOWED: McpToolVerdict = { allowed: true };

/**
 * Who is calling, from evidence the caller cannot restate.
 *
 * `unidentified` stays unrestricted on purpose. `attentionCallerAuthority`
 * explains why the state exists at all: the operator's root is frequently a
 * terminal they started themselves, which the Viewer observes rather than
 * launches, so there are ordinary setups with no host evidence naming it.
 * Treating "cannot tell" as "is the gateway" would strip that session of every
 * tool it has today. The gateway this fence is actually about is a hosted
 * `codex-app-server` conversation by construction — voice requires it — which is
 * precisely the case the registry always has a host pid for.
 */
export function mcpCallerIdentity(
  authority: AttentionCallerAuthority,
  manager: ManagerTarget | null = null,
): McpCallerIdentity {
  if (authority.kind === "root") return { kind: "gateway" };
  if (authority.kind === "unidentified") return { kind: "unrestricted", reason: "unidentified" };
  const isManager = authority.role === "orchestrator"
    || (manager?.conversationId != null && manager.conversationId === authority.conversationId);
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
  if (identity.kind !== "gateway") return ALLOWED;
  if (!GATEWAY_TOOL_SET.has(toolName)) {
    return {
      allowed: false,
      code: "tool_not_permitted",
      error: `${toolName} belongs to the manager, not to the voice gateway. Relay the intent with send_message and report back what the manager answers.`,
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
