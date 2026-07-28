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
type StoredReceipt = {
  conversationId?: string | null;
  agentRole?: string | null;
  delegationDepth?: number | null;
  parentConversationId?: string | null;
  key?: { engine: string; sessionId: string } | null;
  launchProfile?: { mcpServers: string[] } | null;
};
type StoredLineageEdge = {
  parentConversationId?: string | null;
  /** Which launch the edge was written for. Admission (#393) records it, and it
      lives on the EDGE, so a receipt cannot choose which edge names it. */
  evidence?: { launchId?: string | null } | null;
};
export interface StoredGrantFile {
  conversations: Record<string, StoredConversation>;
  entries: Record<string, StoredEntry>;
  receipts?: Record<string, StoredReceipt>;
  lineageEdges?: Record<string, StoredLineageEdge>;
}

function isBaselineGrant(names: readonly string[]): boolean {
  return names.length === 1 && names[0] === "viewer";
}

/**
 * Whether a durable row claims anything other than the baseline every session
 * already holds, on any profile it carries.
 *
 * This is the exact condition {@link reboundStoredMcpGrants} and
 * {@link reboundAssembledMcpGrants} use to decide whether a row is worth
 * re-deciding: a row already at the baseline is left byte-identical by both.
 * A lazy storage backend can therefore use it to decide whether reading a
 * single row obliges it to assemble the whole file first, WITHOUT that being a
 * way around the gate — the rows it skips are the ones the gate would return
 * unchanged. Everything that could gain by the decision being skipped answers
 * `true` here, including an empty selection, which the decision does rewrite.
 */
export function rowClaimsBeyondBaselineGrant(row: unknown): boolean {
  const claimed = (value: unknown): boolean => Array.isArray(value) && !isBaselineGrant(value as string[]);
  if (!row || typeof row !== "object") return false;
  const candidate = row as { launchProfile?: { mcpServers?: unknown } | null; generations?: unknown };
  if (claimed(candidate.launchProfile?.mcpServers)) return true;
  if (!Array.isArray(candidate.generations)) return false;
  return candidate.generations.some((generation) => {
    const profile = (generation as { launchProfile?: { mcpServers?: unknown } } | null)?.launchProfile;
    return claimed(profile?.mcpServers);
  });
}

function sameGrant(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

/**
 * The entry row a generation owns.
 *
 * A row KEY is storage identity rather than payload: it is the JSON object key
 * and the SQLite `row_key` column, written by the registry as
 * `sessionKeyId(entry.key)` and never re-read from inside the row. Everything an
 * entry CARRIES — its embedded `key`, its `artifactPath` — is payload the entry
 * can rewrite, so none of it may decide which generation owns the row; letting
 * it would just move the escalation from forging an ORIGIN to forging an
 * IDENTITY, and a delegated row could borrow the operator root's grant by
 * naming the root's session. The registry already resolves a generation's entry
 * exactly this way (`writeConversationLaunchProfile`,
 * `conversationActivelyHosted`).
 */
function generationEntryRowKey(engine: string, generation: StoredGeneration): string {
  return sessionKeyId({ engine: engine as never, sessionId: generation.id });
}

/**
 * What the conversation side — the only side that carries origin evidence —
 * says about entry rows.
 *
 * `grants` maps an entry row key to the grant the generation owning that row
 * was decided to hold. `pathOwner` maps a transcript path a generation records
 * to the row key entitled to it, which is what catches an entry that keeps its
 * own row key but points its `artifactPath` at somebody else's transcript.
 *
 * A `null` in either map is unresolvable identity — two generations claiming
 * one row key with different decisions, or one path recorded under two owners.
 * A grant boundary cannot break that tie by guessing, so it denies.
 */
interface StoredGrantOwnership {
  grants: Map<string, string[] | null>;
  pathOwner: Map<string, string | null>;
  /** The ORIGIN of the generation owning each entry row key, so a receipt is
      also attested by the conversation that owns the row it settled onto, by
      the same row-key rule entries use — forging the receipt's own key just
      points it at a row some OTHER conversation owns, and the attestation
      follows the owner rather than the pointer. `null` where owners disagree. */
  origins: Map<string, SessionOrigin | null>;
  /** The origin each conversation row states for ITSELF. Its lineage edge is a
      separate attestor and stays separate: a conversation contradicted by its
      own edge then produces two disagreeing attestations rather than one
      pre-resolved answer, which denies for the reason it should. */
  conversationOrigins: Map<string, SessionOrigin>;
}

function storedGrantOwnership(
  file: StoredGrantFile,
  policy: McpGrantPolicy,
  decideGenerations: boolean,
): StoredGrantOwnership {
  const grants = new Map<string, string[] | null>();
  const pathOwner = new Map<string, string | null>();
  const origins = new Map<string, SessionOrigin | null>();
  const conversationOrigins = new Map<string, SessionOrigin>();
  for (const [conversationId, conversation] of Object.entries(file.conversations)) {
    const edge = file.lineageEdges?.[conversationId];
    const lineageDelegated = Boolean(edge?.parentConversationId && edge.parentConversationId !== conversationId);
    conversationOrigins.set(conversationId, storedSessionOriginFor({
      parentConversationId: conversation.generations.at(-1)?.launchProfile.parentConversationId ?? null,
      agentRole: conversation.agentRole,
      delegationDepth: conversation.delegationDepth,
    }));
    for (const generation of conversation.generations) {
      const rowKey = generationEntryRowKey(conversation.engine, generation);
      const granted = decideStoredGrant(conversation, generation, policy, lineageDelegated);
      if (decideGenerations && !sameGrant(generation.launchProfile.mcpServers, granted)) {
        generation.launchProfile.mcpServers = granted;
      }
      const origin = lineageDelegated ? "delegated" : storedSessionOriginFor({
        parentConversationId: generation.launchProfile.parentConversationId,
        agentRole: conversation.agentRole,
        delegationDepth: conversation.delegationDepth,
      });
      if (!origins.has(rowKey)) origins.set(rowKey, origin);
      else if (origins.get(rowKey) !== origin) origins.set(rowKey, null);
      if (!grants.has(rowKey)) grants.set(rowKey, granted);
      else {
        const claimed = grants.get(rowKey)!;
        if (claimed === null || !sameGrant(claimed, granted)) grants.set(rowKey, null);
      }
      const recorded = generation.path;
      if (!recorded) continue;
      if (!pathOwner.has(recorded)) pathOwner.set(recorded, rowKey);
      else if (pathOwner.get(recorded) !== rowKey) pathOwner.set(recorded, null);
    }
  }
  return { grants, pathOwner, origins, conversationOrigins };
}

/**
 * The grant an entry row may keep:
 *
 *  - a list is the decision of the generation that owns the row;
 *  - `null` DENIES, because the row's identity evidence is forged, borrowed or
 *    contradictory — an escalation that is merely well-formed is still one;
 *  - `undefined` means no conversation in THIS view claims the row, which is a
 *    statement about how much was loaded rather than about the row itself.
 */
function entryGrant(id: string, entry: StoredEntry, ownership: StoredGrantOwnership): string[] | null | undefined {
  /* The embedded key is payload and the row key is storage, so a row whose
     payload names a different session has rewritten its own identity. This
     needs nothing but the row, so it denies in every view, however little of
     the file was loaded. */
  if (entry.key && sessionKeyId({ engine: entry.key.engine as never, sessionId: entry.key.sessionId }) !== id) return null;
  /* The same move spelled as a path: a transcript recorded by a generation that
     owns a DIFFERENT row is a borrowed identity, and a path two generations both
     record can attribute nothing. An unrecorded path is not evidence either way
     — a lone entries row is normalized with no conversation in sight. */
  if (entry.artifactPath) {
    const owner = ownership.pathOwner.get(entry.artifactPath);
    if (owner !== undefined && owner !== id) return null;
  }
  if (!ownership.grants.has(id)) return undefined;
  return ownership.grants.get(id)!;
}

/**
 * What OTHER rows attest about a receipt's origin, indexed by the launch id the
 * receipt is stored under.
 *
 * The LINEAGE EDGE is indexed from the attesting row inward, by the launch id
 * in the edge's own `evidence`, and that direction is the whole point. Looking
 * the edge up by `receipt.conversationId` would let the subject pick its own
 * attestor: `conversationId` is a field on the row being authorised, so
 * retargeting it at an operator root — or at an id no edge names — would move
 * or SHED the attestation. Indexed by `evidence.launchId`, the edge names the
 * receipt rather than the receipt naming the edge; admission (#393) writes it
 * as a separate row before any conversation record exists, and a receipt
 * cannot rewrite which edge names it.
 *
 * The other two attestors are reached through pointers the receipt DOES
 * control — the conversation it names, and the conversation owning the entry
 * row its `key` names. They are collected anyway because they can only ever
 * ADD a contradiction: {@link receiptGrant} never takes its origin from an
 * attestation, only denies on disagreement, so a pointer a tampered receipt
 * retargets or blanks buys it nothing the unattested case did not already
 * give. Where either resolves to unresolvable identity — two generations
 * claiming one row key with different origins — both origins are attested, so
 * the disagreement denies.
 */
function receiptAttestations(file: StoredGrantFile, ownership: StoredGrantOwnership): Map<string, Set<SessionOrigin>> {
  const attested = new Map<string, Set<SessionOrigin>>();
  const attest = (launchId: string, origin: SessionOrigin) => {
    const seen = attested.get(launchId) ?? new Set<SessionOrigin>();
    seen.add(origin);
    attested.set(launchId, seen);
  };
  for (const [childConversationId, edge] of Object.entries(file.lineageEdges ?? {})) {
    if (!edge.parentConversationId || edge.parentConversationId === childConversationId) continue;
    const launchId = edge.evidence?.launchId;
    if (typeof launchId === "string" && launchId) attest(launchId, "delegated");
  }
  for (const [launchId, receipt] of Object.entries(file.receipts ?? {})) {
    const namedId = receipt.conversationId;
    if (namedId) {
      /* The edge keyed by the conversation the receipt names, which catches an
         edge carrying no `evidence.launchId` to be indexed by — an engine-native
         or pre-#393 row. Shed by retargeting `conversationId`, which is why it
         supplements the evidence index above rather than replacing it. */
      const namedEdge = file.lineageEdges?.[namedId];
      if (namedEdge?.parentConversationId && namedEdge.parentConversationId !== namedId) attest(launchId, "delegated");
      const named = ownership.conversationOrigins.get(namedId);
      if (named) attest(launchId, named);
    }
    if (!receipt.key) continue;
    const rowKey = sessionKeyId({ engine: receipt.key.engine as never, sessionId: receipt.key.sessionId });
    if (!ownership.origins.has(rowKey)) continue;
    const owner = ownership.origins.get(rowKey)!;
    if (owner) attest(launchId, owner);
    /* Unresolvable ownership is not silence: attest both readings so the
       disagreement denies, exactly as two attestors that disagree would. */
    else for (const either of ["operator-root", "delegated"] as const) attest(launchId, either);
  }
  return attested;
}

/**
 * The grant a receipt may keep.
 *
 * Settlement copies `receipt.launchProfile` onto the conversation generation
 * and the entry row, and stamps the receipt's role and depth onto a brand-new
 * conversation, so a receipt that keeps a connector does not merely hold one —
 * it MANUFACTURES the origin evidence every later read trusts.
 *
 * The receipt's own shape decides its origin — the same affirmative root marker
 * ({@link storedSessionOriginFor}) every conversation and entry row is decided
 * by, so a blank receipt is delegated and only a stated depth `0` or `operator`
 * origin reads as a root. What the attesting rows do is CONTRADICT:
 *
 *  - an attestation the self-description disagrees with denies, in EITHER
 *    direction, because a contradiction is a tamper signal rather than a tie to
 *    resolve in the caller's favour;
 *  - attestors that disagree with each other deny for the same reason;
 *  - and where nothing attests — an un-parented launch that has not settled,
 *    which by construction has no other row yet — the receipt's own shape
 *    stands, and there it can still only narrow the policy default.
 *
 * A tampered delegated receipt cannot reach that last case: the lineage edge
 * admission wrote for it is indexed by the launch id in the EDGE's evidence, so
 * rewriting the receipt into root shape leaves the edge still attesting
 * delegated and the contradiction still denying.
 */
function receiptGrant(
  attestations: Map<string, Set<SessionOrigin>>,
  launchId: string,
  receipt: StoredReceipt,
  policy: McpGrantPolicy,
): string[] | null {
  const described = storedSessionOriginFor({
    agentRole: receipt.agentRole,
    delegationDepth: receipt.delegationDepth,
    parentConversationId: receipt.parentConversationId,
  });
  const attested = attestations.get(launchId);
  if (attested && (attested.size > 1 || !attested.has(described))) return null;
  return mcpServersForSession({ origin: described, requested: receipt.launchProfile!.mcpServers }, policy);
}

function reboundGrants<T extends StoredGrantFile>(file: T, policy: McpGrantPolicy, assembled: boolean): T {
  const ownership = storedGrantOwnership(file, policy, true);
  for (const [id, entry] of Object.entries(file.entries)) {
    const stored = entry.launchProfile?.mcpServers;
    if (!stored || isBaselineGrant(stored)) continue;
    const granted = entryGrant(id, entry, ownership);
    /* Unowned in a partial view says nothing; unowned in an assembled one is a
       fact about the row. Forged evidence denies in both. */
    if (granted === undefined && !assembled) continue;
    const next = granted ?? DEFAULT_SPAWN_MCP_SERVERS;
    if (!sameGrant(stored, next)) entry.launchProfile!.mcpServers = [...next];
  }
  const attestations = receiptAttestations(file, ownership);
  for (const [launchId, receipt] of Object.entries(file.receipts ?? {})) {
    const stored = receipt.launchProfile?.mcpServers;
    if (!stored || isBaselineGrant(stored)) continue;
    const granted = receiptGrant(attestations, launchId, receipt, policy) ?? DEFAULT_SPAWN_MCP_SERVERS;
    if (!sameGrant(stored, granted)) receipt.launchProfile!.mcpServers = [...granted];
  }
  return file;
}

function decideStoredGrant(
  conversation: StoredConversation,
  generation: StoredGeneration,
  policy: McpGrantPolicy,
  /** Whether a lineage edge — a row outside this conversation — records it as
      somebody's child. */
  lineageDelegated: boolean,
): string[] {
  const stored = generation.launchProfile.mcpServers;
  /* Every read walks this, so the overwhelmingly common baseline profile skips
     the resolver and its allocation; only a profile claiming more than the
     baseline is worth re-deciding. */
  if (isBaselineGrant(stored)) return stored;
  const origin = storedSessionOriginFor({
    parentConversationId: generation.launchProfile.parentConversationId,
    agentRole: conversation.agentRole,
    delegationDepth: conversation.delegationDepth,
  });
  /* A conversation row claiming to be an operator root while its own lineage
     edge records a parent is contradictory, and a settled receipt forged into
     root shape is exactly how such a row gets written. Deny rather than believe
     whichever copy is more convenient. */
  if (lineageDelegated && origin !== "delegated") return [...DEFAULT_SPAWN_MCP_SERVERS];
  return mcpServersForSession({ origin, requested: stored }, policy);
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
 *
 * Which generation owns an entry is decided by {@link generationEntryRowKey},
 * never by what the entry says about itself.
 */
export function reboundStoredMcpGrants<T extends StoredGrantFile>(file: T, policy: McpGrantPolicy = MCP_GRANT_POLICY): T {
  return reboundGrants(file, policy, false);
}

/**
 * The same pass for a COMPLETE registry snapshot, where every conversation that
 * exists is present: an entry no conversation owns has no origin evidence at
 * all, and here that is a fact about the entry rather than about how much of
 * the file was loaded, so it falls back to the baseline — the same fail-closed
 * reading {@link storedSessionOriginFor} gives a record that cannot prove it is
 * an operator root.
 */
export function reboundAssembledMcpGrants<T extends StoredGrantFile>(file: T, policy: McpGrantPolicy = MCP_GRANT_POLICY): T {
  return reboundGrants(file, policy, true);
}

/**
 * The same decision for ONE entry row, for the paths that hand a single entry
 * to a host from inside a mutation rather than from an assembled snapshot.
 *
 * A mutation holds the whole file, so an entry no generation owns is genuinely
 * unowned here and falls back to the baseline, as it would in an assembled
 * read. The generation profiles are left alone: this is a single-row decision
 * inside somebody else's transaction.
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
  const granted = entryGrant(id, entry, storedGrantOwnership(file, policy, false)) ?? DEFAULT_SPAWN_MCP_SERVERS;
  if (!sameGrant(stored, granted)) entry.launchProfile!.mcpServers = [...granted];
}
