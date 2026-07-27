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

import { sessionOriginFor, type SessionOrigin, type SessionOriginInput } from "./pluginAllowlist";
import { sessionKeyId } from "./sessionKey";

/** The always-on baseline. A spawn that selects nothing gets exactly this. */
export const DEFAULT_SPAWN_MCP_SERVERS: readonly string[] = Object.freeze(["viewer"]);

/** Outer bound of the mechanism: the only MCP servers the Viewer can grant at
    all. Everything else the operator has configured stays off for every
    session, whoever asks.

    Tranche 1 deliberately ships this bound EMPTY of connectors — `viewer` is
    the baseline every session holds, not a grant. No MCP server can be enabled
    for any session until a connector is added here, which is what tranche 2
    does for `telegram`. Adding a name here grants it to the operator-root
    session class by default, so a name belongs here only once its credential
    boundary and revocation path exist. */
export const GRANTABLE_MCP_SERVERS: readonly string[] = Object.freeze(["viewer"]);

/** What an operator-launched root session receives when it does not opt out.
    The operator's own root conversation is the session class the grantable
    surface exists for, so it carries the whole bound by default. */
export const OPERATOR_ROOT_MCP_SERVERS: readonly string[] = Object.freeze([...GRANTABLE_MCP_SERVERS]);

/** What a delegated session (subagent, builder, reviewer, pipeline helper)
    receives: the baseline and nothing more. A delegated launch that asks for a
    connector is not an error — the grant simply is not its to take. */
export const DELEGATED_MCP_SERVERS: readonly string[] = Object.freeze([...DEFAULT_SPAWN_MCP_SERVERS]);

/**
 * The bound plus its per-origin defaults, as one value.
 *
 * Every function here takes it as an optional last argument that defaults to
 * {@link MCP_GRANT_POLICY}; no production call site passes one. The seam exists
 * so the origin rules can be exercised against a policy that actually has a
 * grantable connector while the shipped bound has none — otherwise "delegated
 * cannot obtain a connector" would be proven only by there being nothing to
 * obtain, and would silently stop being proven the day tranche 2 lands.
 */
export interface McpGrantPolicy {
  readonly grantable: readonly string[];
  readonly operatorRoot: readonly string[];
  readonly delegated: readonly string[];
}

export const MCP_GRANT_POLICY: McpGrantPolicy = Object.freeze({
  grantable: GRANTABLE_MCP_SERVERS,
  operatorRoot: OPERATOR_ROOT_MCP_SERVERS,
  delegated: DELEGATED_MCP_SERVERS,
});

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
export function normalizeSpawnMcpServers(value: unknown, policy: McpGrantPolicy = MCP_GRANT_POLICY): SpawnMcpServersResult {
  if (value === undefined) return { ok: true, value: [...DEFAULT_SPAWN_MCP_SERVERS] };
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string" && MCP_SERVER_NAME.test(name))) {
    return { ok: false, error: "mcpServers must be an array of non-empty server names" };
  }
  const names = value as string[];
  const ungranted = names.filter((name) => !policy.grantable.includes(name));
  if (ungranted.length > 0) {
    return { ok: false, error: `mcpServers may only contain ${policy.grantable.join(", ")}; rejected: ${[...new Set(ungranted)].join(", ")}` };
  }
  return { ok: true, value: withViewer(names) };
}

/** Policy default for a session class, before any request narrows it. */
export function defaultMcpServersForOrigin(origin: SessionOrigin, policy: McpGrantPolicy = MCP_GRANT_POLICY): readonly string[] {
  return origin === "operator-root" ? policy.operatorRoot : policy.delegated;
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
}, policy: McpGrantPolicy = MCP_GRANT_POLICY): string[] {
  const allowed = defaultMcpServersForOrigin(input.origin, policy);
  const granted = input.requested == null
    ? allowed
    : allowed.filter((name) => input.requested!.includes(name));
  return withViewer(granted.filter((name) => policy.grantable.includes(name)));
}

/**
 * Origin of a session as read back OUT of durable storage, where the evidence
 * is a stored record rather than a live request.
 *
 * {@link sessionOriginFor} answers "did this launch carry a delegation signal?"
 * and reads the absence of every signal as an operator root. That is the right
 * reading for a request being admitted right now, where a root genuinely
 * carries no signals. It is the WRONG reading for a durable row: a record whose
 * origin fields were never written — or were erased by the very session that
 * wants the grant — is then indistinguishable from an operator root, so
 * DELETING evidence would PROMOTE a delegated worker into the most privileged
 * session class. A grant boundary cannot have that shape.
 *
 * So operator root has to be PROVEN here, not merely not-disproven: the record
 * must carry an affirmative root marker — an `operator` origin kind, or the
 * delegation depth `0` that admission (#393) stamps on every root receipt.
 * Anything else is delegated, including a row carrying no origin evidence at
 * all. A session the Viewer never launched (a transcript the scanner adopted,
 * a pre-#393 row) therefore holds the baseline and nothing more, which is the
 * correct answer for a record whose origin nobody can attest to.
 */
export function storedSessionOriginFor(input: SessionOriginInput): SessionOrigin {
  if (sessionOriginFor(input) === "delegated") return "delegated";
  if (input.origin?.kind === "operator") return "operator-root";
  return input.delegationDepth === 0 ? "operator-root" : "delegated";
}

/**
 * The same resolution for a list coming back OUT of durable storage, where the
 * session's origin is whatever its record says it is rather than a live
 * request. The global bound alone is not enough here: without the origin, a
 * delegated session that hand-edits its own profile to name a server the
 * Viewer *can* grant would have it honoured on the next resume, attach or
 * structured recovery. Fail-closed by construction — {@link
 * storedSessionOriginFor} grants the operator-root default only to a record
 * that proves it is one.
 */
export function mcpServersForStoredSession(
  input: SessionOriginInput & { requested?: readonly string[] | null },
  policy: McpGrantPolicy = MCP_GRANT_POLICY,
): string[] {
  return mcpServersForSession({ origin: storedSessionOriginFor(input), requested: input.requested }, policy);
}

/** Last line of the bound, where an engine's enable table is materialized: the
    global grantable set, applied again to whatever the caller was handed. The
    ORIGIN bound belongs upstream of this — {@link mcpServersForStoredSession}
    at the storage boundary — because an engine builder holds a list, not a
    session record. Keeping both means a tampered profile has to defeat the
    origin rule and the bound. */
export function grantedMcpServers(value: readonly string[] | undefined | null, policy: McpGrantPolicy = MCP_GRANT_POLICY): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_SPAWN_MCP_SERVERS];
  return withViewer(value.filter((name) => typeof name === "string" && policy.grantable.includes(name)));
}

/* The durable shapes this module re-decides grants on. Typed structurally and
   type-only, so the storage layers can call in without a runtime cycle. */
type StoredGeneration = { id: string; path?: string | null; launchProfile: { mcpServers: string[]; parentConversationId: string | null } };
type StoredConversation = { engine: string; agentRole: string | null; delegationDepth: number | null; generations: StoredGeneration[] };
type StoredEntry = {
  key?: { engine: string; sessionId: string } | null;
  artifactPath?: string | null;
  launchProfile?: { mcpServers: string[] } | null;
};
export interface StoredGrantFile {
  conversations: Record<string, StoredConversation>;
  entries: Record<string, StoredEntry>;
}

function isBaselineGrant(names: readonly string[]): boolean {
  return names.length === 1 && names[0] === "viewer";
}

function sameGrant(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

/** An entry names its generation by session key, and the transcript path is the
    same identity spelled the other way; either match makes the entry's owning
    conversation — and so its origin — knowable. */
function generationKeys(engine: string, generation: StoredGeneration): string[] {
  const keys = [sessionKeyId({ engine: engine as never, sessionId: generation.id })];
  if (generation.path) keys.push(JSON.stringify(["path", engine, generation.path]));
  return keys;
}

function entryKeys(id: string, entry: StoredEntry): string[] {
  const keys = [entry.key ? sessionKeyId({ engine: entry.key.engine as never, sessionId: entry.key.sessionId }) : id];
  if (entry.key && entry.artifactPath) keys.push(JSON.stringify(["path", entry.key.engine, entry.artifactPath]));
  return keys;
}

function decideStoredGrant(
  conversation: StoredConversation,
  generation: StoredGeneration,
  policy: McpGrantPolicy,
): string[] {
  const stored = generation.launchProfile.mcpServers;
  /* Every read walks this, so the overwhelmingly common baseline profile skips
     the resolver and its allocation; only a profile claiming more than the
     baseline is worth re-deciding. */
  if (isBaselineGrant(stored)) return stored;
  return mcpServersForStoredSession({
    parentConversationId: generation.launchProfile.parentConversationId,
    agentRole: conversation.agentRole,
    delegationDepth: conversation.delegationDepth,
    requested: stored,
  }, policy);
}

/**
 * Re-decides every stored MCP grant from the conversation's durable origin as
 * a registry snapshot is read (#739).
 *
 * `emptyLaunchProfile` already applies the global bound to each profile, but a
 * bound alone cannot tell an operator root apart from a delegated worker: a
 * delegated session that edits durable state by hand to name a server the
 * Viewer *can* grant would otherwise have it honoured by attach, resume and
 * structured host adoption, all of which read these profiles straight out of
 * storage. Doing it here means no reader has to remember to.
 *
 * A conversation row carries its own origin evidence, so it is decidable
 * alone. An ENTRY row is not — and both backends normalize rows one collection
 * (one row, for SQLite) at a time, which is why an entry is only ever narrowed
 * here when the conversation that owns it is present in the same object.
 * Deciding an unowned entry at this level would wipe a legitimate root grant
 * every time a lone entries row is normalized; that judgement belongs to
 * {@link reboundAssembledMcpGrants}, which runs where the whole file is known.
 */
export function reboundStoredMcpGrants<T extends StoredGrantFile>(file: T, policy: McpGrantPolicy = MCP_GRANT_POLICY): T {
  const decided = new Map<string, string[]>();
  for (const conversation of Object.values(file.conversations)) {
    for (const generation of conversation.generations) {
      const granted = decideStoredGrant(conversation, generation, policy);
      generation.launchProfile.mcpServers = granted;
      for (const key of generationKeys(conversation.engine, generation)) decided.set(key, granted);
    }
  }
  /* The entry row is the copy structured host adoption reads, and it can be
     tampered with on its own, so it follows its conversation's decision. */
  for (const [id, entry] of Object.entries(file.entries)) {
    const stored = entry.launchProfile?.mcpServers;
    if (!stored || isBaselineGrant(stored)) continue;
    const granted = entryKeys(id, entry).map((key) => decided.get(key)).find(Boolean);
    if (granted && !sameGrant(stored, granted)) entry.launchProfile!.mcpServers = [...granted];
  }
  return file;
}

/**
 * The same pass for a COMPLETE registry snapshot, where every conversation that
 * exists is present: an entry no conversation owns has no origin evidence at
 * all, and here that is a fact about the entry rather than about how much of
 * the file was loaded, so it falls back to the baseline — the same fail-closed
 * reading {@link sessionOriginFor} gives an unrecognized launch.
 */
export function reboundAssembledMcpGrants<T extends StoredGrantFile>(file: T, policy: McpGrantPolicy = MCP_GRANT_POLICY): T {
  reboundStoredMcpGrants(file, policy);
  const owned = new Set<string>();
  for (const conversation of Object.values(file.conversations)) {
    for (const generation of conversation.generations) {
      for (const key of generationKeys(conversation.engine, generation)) owned.add(key);
    }
  }
  for (const [id, entry] of Object.entries(file.entries)) {
    const stored = entry.launchProfile?.mcpServers;
    if (!stored || isBaselineGrant(stored)) continue;
    if (entryKeys(id, entry).some((key) => owned.has(key))) continue;
    entry.launchProfile!.mcpServers = [...DEFAULT_SPAWN_MCP_SERVERS];
  }
  return file;
}

/**
 * The same decision for ONE entry row, for the paths that hand a single entry
 * to a host from inside a mutation rather than from an assembled snapshot.
 */
export function reboundEntryMcpGrant(
  file: StoredGrantFile,
  key: { engine: string; sessionId: string },
  policy: McpGrantPolicy = MCP_GRANT_POLICY,
): void {
  const id = sessionKeyId({ engine: key.engine as never, sessionId: key.sessionId });
  const entry = file.entries[id];
  const stored = entry?.launchProfile?.mcpServers;
  if (!entry || !stored || isBaselineGrant(stored)) return;
  const wanted = new Set(entryKeys(id, entry));
  for (const conversation of Object.values(file.conversations)) {
    for (const generation of conversation.generations) {
      if (!generationKeys(conversation.engine, generation).some((candidate) => wanted.has(candidate))) continue;
      const granted = decideStoredGrant(conversation, generation, policy);
      if (!sameGrant(stored, granted)) entry.launchProfile!.mcpServers = [...granted];
      return;
    }
  }
  entry.launchProfile!.mcpServers = [...DEFAULT_SPAWN_MCP_SERVERS];
}
