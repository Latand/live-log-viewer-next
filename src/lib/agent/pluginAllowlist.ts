/**
 * Per-session Codex plugin grants (issue #687).
 *
 * Codex plugins are installed and enabled globally in the operator's
 * `config.toml`. The Viewer never touches that file and never turns the plugin
 * subsystem on for every session: a grant is decided per session here, carried
 * on the durable launch profile, and applied to the thread configuration of a
 * single structured host.
 *
 * The grant is expressed as an allowlist of plugin names. Two properties hold
 * for every path into this module:
 *
 *  - nothing outside {@link GRANTABLE_PLUGINS} can ever be granted, so no
 *    caller can widen a session to "all installed plugins";
 *  - a request can only narrow the policy default, never widen it, so a
 *    delegated session cannot inherit a grant through a spawn chain.
 */

/** Outer bound of the mechanism: the only plugins the Viewer can grant at all.
    Everything the operator has installed stays off unless it is listed here. */
export const GRANTABLE_PLUGINS: readonly string[] = Object.freeze(["computer-use"]);

/** What an operator-launched root Codex session receives when it does not opt
    out. Computer Use is the default capability of that whole session class —
    the operator does not ask for it per session. */
export const OPERATOR_ROOT_PLUGINS: readonly string[] = Object.freeze(["computer-use"]);

/** What a delegated session (subagent, builder, reviewer, pipeline helper)
    receives. Empty in this slice by deliberate decision, not by structure:
    delegated grants are decided separately, and expressing a different answer
    later means changing this list — no branch elsewhere assumes it is empty. */
export const DELEGATED_PLUGINS: readonly string[] = Object.freeze([]);

/** MCP server names each grantable plugin contributes to a thread. Used to
    verify the realized tool surface of a granted thread against the grant. */
export const PLUGIN_MCP_SERVER_NAMES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "computer-use": Object.freeze(["computer-use"]),
});

export type SpawnPluginsResult =
  /** `null` means the request said nothing and the policy default applies. */
  | { ok: true; value: string[] | null }
  | { ok: false; error: string };

/** Durable origin of a session, as recorded on its spawn receipt. */
export type SessionOrigin = "operator-root" | "delegated";

export interface SessionOriginInput {
  /** Initiating origin recorded at admission (#393). */
  origin?: { kind: string } | null;
  /** Lineage parent, if the launch named one. */
  parentConversationId?: string | null;
  /** Role preset id — every preset launch is a delegated helper. */
  agentRole?: string | null;
  /** Delegation depth computed at admission (#393): 0 for roots. */
  delegationDepth?: number | null;
}

/**
 * Classifies a launch as an operator-launched root session or a delegated one.
 * Fail-closed: anything that carries a delegation signal — a non-operator
 * origin, a lineage parent, a role preset, or a non-zero delegation depth — is
 * delegated, and an unknown origin kind is delegated too.
 */
export function sessionOriginFor(input: SessionOriginInput): SessionOrigin {
  const originKind = input.origin?.kind;
  if (originKind !== undefined && originKind !== "operator") return "delegated";
  if (input.parentConversationId) return "delegated";
  if (input.agentRole) return "delegated";
  const depth = input.delegationDepth;
  if (typeof depth === "number" && depth !== 0) return "delegated";
  return "operator-root";
}

/** Policy default for a session class, before any request narrows it. */
export function defaultPluginsForOrigin(origin: SessionOrigin): readonly string[] {
  return origin === "operator-root" ? OPERATOR_ROOT_PLUGINS : DELEGATED_PLUGINS;
}

/**
 * Validates a requested plugin allowlist. `undefined` leaves the decision to
 * policy; `[]` is the explicit opt-out. Any name outside
 * {@link GRANTABLE_PLUGINS} — including wildcards such as `*` or `all` — is
 * rejected rather than silently dropped, so a caller cannot smuggle a wider
 * surface past validation.
 */
export function normalizeSpawnPlugins(value: unknown): SpawnPluginsResult {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
    return { ok: false, error: "plugins must be an array of plugin names" };
  }
  const names = value as string[];
  const unknown = names.filter((name) => !GRANTABLE_PLUGINS.includes(name));
  if (unknown.length > 0) {
    return { ok: false, error: `plugins may only contain ${GRANTABLE_PLUGINS.join(", ")}; rejected: ${[...new Set(unknown)].join(", ")}` };
  }
  return { ok: true, value: [...new Set(names)] };
}

/**
 * Final allowlist for a session: the policy default for its origin, narrowed
 * by whatever the request asked for. The result is always a subset of both, so
 * a request can deny a grant (the opt-out) but never create one.
 */
export function pluginAllowlistForSession(input: {
  origin: SessionOrigin;
  /** Plugins are a Codex thread capability; other engines never carry one. */
  engine?: string;
  requested?: readonly string[] | null;
}): string[] {
  if (input.engine !== undefined && input.engine !== "codex") return [];
  const policy = defaultPluginsForOrigin(input.origin);
  const granted = input.requested == null
    ? policy
    : policy.filter((name) => input.requested!.includes(name));
  return granted.filter((name) => GRANTABLE_PLUGINS.includes(name));
}

/** Re-validates a stored allowlist on the way into a thread configuration.
    Profiles are durable and can be edited by hand, so the bound is enforced
    again at the point of use rather than trusted from storage. */
export function grantedPlugins(value: readonly string[] | undefined | null): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((name) => GRANTABLE_PLUGINS.includes(name)))];
}

/** MCP server names a granted thread is allowed to gain from its plugins. */
export function grantedPluginServerNames(granted: readonly string[]): string[] {
  return [...new Set(granted.flatMap((name) => PLUGIN_MCP_SERVER_NAMES[name] ?? []))];
}
