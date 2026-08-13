import type { OrchestratorRevocation, OrchestratorSeat } from "./seats";

/* Durable manager authority (the fix for the measured null-pid refusal).
 *
 * Designation is logical and durable; authority used to be physical and
 * ephemeral — an MCP caller was the manager only while the registry happened to
 * have recorded a live host pid for its conversation. The measured failure was
 * a correctly designated manager whose registry entry carried NO host pids at
 * all: the caller resolved to "unidentified" and every manager-only tool
 * refused it, forever, while its host was demonstrably alive.
 *
 * This module is the durable half of the replacement. WHO is calling is now
 * resolved from the spawn capability the Viewer minted at admission and
 * injected into the launch environment (see `callerAuthority.ts`) — immutable
 * launch lineage that survives host death, PID reuse, resume, migration and
 * generation change, and that no caller can restate because only its digest is
 * ever stored. WHETHER that conversation is a manager is decided here, from
 * the durable designation records alone, failing closed on every conflicting,
 * revoked, superseded, unknown or cross-project identity.
 *
 * B+ scope: manager identity is NOT a tool-availability gate. What it decides
 * is the server-derived origin label (manager voice vs attributed agent) and
 * the one gated operation — minting a deployment confirmation. Every session
 * holds the full Viewer MCP surface regardless of what this returns.
 *
 * Deliberately pure over supplied sources so every refusal path is testable
 * without a registry on disk.
 */

/** Registry facts about one conversation, read fresh per decision. */
export interface ManagerConversationFacts {
  /** Terminally replaced by a successor (issue #383). A superseded manager is
      a stale writer by definition and must not come back to life. */
  superseded: boolean;
  /** Whether any generation exists — an identity with no recorded generation
      cannot be attributed to a transcript and is refused. */
  hasGeneration: boolean;
  /** Durable project ownership, when the operator recorded one. */
  project: string | null;
}

export interface ManagerAuthoritySources {
  activeSeats(): readonly OrchestratorSeat[];
  revocations(): readonly OrchestratorRevocation[];
  /** Null when the registry does not know the conversation at all. */
  conversationFacts(conversationId: string): ManagerConversationFacts | null;
  /** Canonical id after migration aliasing; identity must survive migration. */
  resolveAlias(conversationId: string): string;
}

/** One authorized manager identity, for the tool-policy target directory. */
export interface AuthorizedManagerSeat {
  conversationId: string;
  path: string | null;
  project: string | null;
}

function factsPermit(facts: ManagerConversationFacts | null, seatProject: string | null): boolean {
  if (!facts) return false;
  if (!facts.hasGeneration) return false;
  if (facts.superseded) return false;
  /* Cross-project designation: the seat claims one project, the durable
     ownership record names another. Contradictory evidence authorizes nothing;
     the recovery is an explicit re-designation, not a guess. */
  if (seatProject && facts.project && facts.project !== seatProject) return false;
  return true;
}

/**
 * Every conversation currently entitled to manager authority, resolved fresh
 * per call so a replacement, revocation or supersedence takes effect on the
 * very next tool call without restarting anything.
 *
 * FAIL-CLOSED RULES, in order:
 *  - a conversation named by seats in TWO different projects is conflicting
 *    evidence and gets nothing (neither seat can be trusted to be the one the
 *    operator meant);
 *  - a revocation at an epoch >= the seat's epoch kills the seat — the ABA
 *    guard: a predecessor returning from pause, or a re-adopted transcript,
 *    still points at a revoked epoch, while a deliberate re-designation minted
 *    a strictly newer one;
 *  - registry facts must exist, carry a generation, not be superseded, and not
 *    contradict the seat's project;
 *  - without an active seat, no manager identity resolves.
 */
export function authorizedManagerSeats(sources: ManagerAuthoritySources): AuthorizedManagerSeat[] {
  const seats = sources.activeSeats().filter((seat) => seat.state === "active" && seat.conversationId);
  const revocations = sources.revocations();
  const byConversation = new Map<string, OrchestratorSeat[]>();
  for (const seat of seats) {
    const id = sources.resolveAlias(seat.conversationId!);
    byConversation.set(id, [...(byConversation.get(id) ?? []), seat]);
  }
  const newestRevocation = (conversationId: string): number => Math.max(0, ...revocations
    .filter((revocation) => sources.resolveAlias(revocation.conversationId) === conversationId)
    .map((revocation) => revocation.seatEpoch));

  const authorized: AuthorizedManagerSeat[] = [];
  for (const [conversationId, claims] of byConversation) {
    if (new Set(claims.map((claim) => claim.project)).size > 1) continue;
    const seat = claims[0]!;
    if (newestRevocation(conversationId) >= seat.seatEpoch) continue;
    if (!factsPermit(sources.conversationFacts(conversationId), seat.project)) continue;
    authorized.push({ conversationId, path: seat.path, project: seat.project });
  }

  return authorized;
}
