/**
 * Per-session MCP server grants (issue #739).
 *
 * MCP servers are registered host-wide in the operator's own configuration —
 * Codex `config.toml`, Claude `.claude.json`/`.mcp.json`. The Viewer never
 * enables that whole table for a session: it selects a named subset per launch,
 * carries it on the durable launch profile, and materializes it into each
 * engine's enable table.
 *
 * The selection is bounded exactly the way plugin grants are
 * (`pluginAllowlist.ts`), and for the same reason — `spawn_agent` exposes
 * `mcpServers` to every agent holding the Viewer MCP, so an unbounded name
 * would let any delegated worker hand itself a connector the operator meant to
 * keep for their own root session. Two properties hold on every path here:
 *
 *  - nothing outside {@link GRANTABLE_MCP_SERVERS} can ever be granted, so no
 *    caller can widen a session to "every configured MCP server";
 *  - a request can only narrow the policy default, never widen it, so a
 *    delegated session cannot inherit a grant through a spawn chain.
 *
 * `viewer` is the exception that stays force-included on every path: it is the
 * orchestration surface the board itself depends on, not a grant.
 */

import type { SessionOrigin } from "./pluginAllowlist";

/** The always-on baseline. A spawn that selects nothing gets exactly this. */
export const DEFAULT_SPAWN_MCP_SERVERS: readonly string[] = Object.freeze(["viewer"]);

/** Outer bound of the mechanism: the only MCP servers the Viewer can grant at
    all. Everything else the operator has configured stays off for every
    session, whoever asks. Personal connectors — a Telegram account, a mail
    box — join this list only once they exist and only deliberately. */
export const GRANTABLE_MCP_SERVERS: readonly string[] = Object.freeze(["viewer", "agent-browser"]);

/** What an operator-launched root session receives when it does not opt out.
    The operator's own root conversation is the session class the grantable
    surface exists for, so it carries the whole bound by default. */
export const OPERATOR_ROOT_MCP_SERVERS: readonly string[] = Object.freeze([...GRANTABLE_MCP_SERVERS]);

/** What a delegated session (subagent, builder, reviewer, pipeline helper)
    receives: the baseline and nothing more. A delegated launch that asks for a
    connector is not an error — the grant simply is not its to take. */
export const DELEGATED_MCP_SERVERS: readonly string[] = Object.freeze([...DEFAULT_SPAWN_MCP_SERVERS]);

export type SpawnMcpServersResult =
  | { ok: true; value: string[] }
  | { ok: false; error: string };

/** Shape check before the bound check, so a structurally malformed value keeps
    reporting the malformed-array error it always did. The class is the
    original one: no whitespace, no control characters. */
const MCP_SERVER_NAME = /^[^\s\p{Cc}]{1,128}$/u;

/** Viewer first, deduplicated, and always present — the orchestration surface
    is not part of the grant and cannot be dropped by any caller. */
function withViewer(names: readonly string[]): string[] {
  return ["viewer", ...new Set(names.filter((name) => name !== "viewer"))];
}

/**
 * Validates a requested MCP allowlist. `undefined` selects the baseline; `[]`
 * is the explicit opt-out and still yields `["viewer"]`. Any name outside
 * {@link GRANTABLE_MCP_SERVERS} — including wildcards such as `*` or `all` — is
 * rejected with the bound spelled out, rather than silently dropped, so a
 * caller cannot believe it received a surface it did not get.
 */
export function normalizeSpawnMcpServers(value: unknown): SpawnMcpServersResult {
  if (value === undefined) return { ok: true, value: [...DEFAULT_SPAWN_MCP_SERVERS] };
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string" && MCP_SERVER_NAME.test(name))) {
    return { ok: false, error: "mcpServers must be an array of non-empty server names" };
  }
  const names = value as string[];
  const ungranted = names.filter((name) => !GRANTABLE_MCP_SERVERS.includes(name));
  if (ungranted.length > 0) {
    return { ok: false, error: `mcpServers may only contain ${GRANTABLE_MCP_SERVERS.join(", ")}; rejected: ${[...new Set(ungranted)].join(", ")}` };
  }
  return { ok: true, value: withViewer(names) };
}

/** Policy default for a session class, before any request narrows it. */
export function defaultMcpServersForOrigin(origin: SessionOrigin): readonly string[] {
  return origin === "operator-root" ? OPERATOR_ROOT_MCP_SERVERS : DELEGATED_MCP_SERVERS;
}

/**
 * Final allowlist for a session: the policy default for its origin, narrowed by
 * whatever the request asked for. The result is always a subset of both, so a
 * request can deny a grant (the opt-out) but never create one — plus `viewer`,
 * which every session holds.
 */
export function mcpServersForSession(input: {
  origin: SessionOrigin;
  /** `null`/absent means the request said nothing and policy decides. */
  requested?: readonly string[] | null;
}): string[] {
  const policy = defaultMcpServersForOrigin(input.origin);
  const granted = input.requested == null
    ? policy
    : policy.filter((name) => input.requested!.includes(name));
  return withViewer(granted.filter((name) => GRANTABLE_MCP_SERVERS.includes(name)));
}

/** Re-validates a stored allowlist on the way into an engine's enable table.
    Launch profiles are durable and can be edited by hand, so the bound is
    enforced again at the point of use rather than trusted from storage. */
export function grantedMcpServers(value: readonly string[] | undefined | null): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_SPAWN_MCP_SERVERS];
  return withViewer(value.filter((name) => typeof name === "string" && GRANTABLE_MCP_SERVERS.includes(name)));
}
