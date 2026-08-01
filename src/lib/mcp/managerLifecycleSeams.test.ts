import crypto from "node:crypto";

import { expect, test } from "bun:test";

import { attentionCallerAuthority, type AttentionCallerSources } from "@/lib/attention/callerAuthority";
import { authorizedManagerSeats, type ManagerAuthoritySources } from "@/lib/orchestrator/authority";
import type { OrchestratorSeat } from "@/lib/orchestrator/seats";

import { capabilityConversationResolver, hostedConversationsFromSnapshot } from "./bindings";
import { mcpCallerIdentity, type ManagerTarget } from "./toolAllowlist";

/* THE LIFECYCLE SEAMS.
 *
 * Designation is durable, so manager authority has to outlive every event that
 * moves, restarts or renames the hosting process. Each test here drives the
 * whole seam — attentionCallerAuthority -> mcpCallerIdentity — across one
 * lifecycle event, and asserts the caller is still labeled the designated
 * manager afterwards. That label is what the deploy binding derives its
 * authority from (#795), so losing it here is losing the deploy.
 *
 * The property under test is that NOTHING on the authorized path reads a
 * process id. Authority comes from the spawn capability the Viewer minted at
 * admission (immutable launch lineage, stored only as a digest, so no caller
 * can restate it) joined to the durable seat. A lifecycle event may change
 * every pid, every generation path and even the conversation id — the
 * designation survives, or it fails closed for a reason the operator can act on.
 */

const MANAGER_ID = "conversation_11111111-1111-4111-8111-111111111111";
const SUCCESSOR_ID = "conversation_33333333-3333-4333-8333-333333333333";
const MANAGER_PATH = "/tmp/llv-fixture/manager.jsonl";
const RESUMED_PATH = "/tmp/llv-fixture/manager-resumed.jsonl";
const MIGRATED_PATH = "/tmp/llv-fixture/manager-migrated.jsonl";
const CAPABILITY = "A".repeat(43);
const CAPABILITY_DIGEST = crypto.createHash("sha256").update(CAPABILITY).digest("hex");

type Snapshot = Parameters<typeof hostedConversationsFromSnapshot>[0];

/** One conversation with the given generations, plus one registry entry per
    supplied host pid. `pid: null` is an entry whose host was never recorded or
    has been retired — the measured null-pid shape. */
function snapshotOf(
  conversationId: string,
  generations: readonly string[],
  entries: readonly { path: string; pid: number | null }[],
): Snapshot {
  return {
    conversations: {
      [conversationId]: {
        id: conversationId,
        generations: generations.map((path) => ({ path, launchProfile: { role: "orchestrator" } })),
      },
    },
    entries: Object.fromEntries(entries.map((entry, index) => [
      `claude:e${index}`,
      {
        artifactPath: entry.path,
        host: entry.pid === null ? null : { agent: { pid: entry.pid } },
        structuredHost: null,
      },
    ])),
  } as unknown as Snapshot;
}

function activeSeat(conversationId: string, seatEpoch = 1): OrchestratorSeat {
  return {
    project: "proj-a",
    seatEpoch,
    conversationId,
    path: MANAGER_PATH,
    mandate: "own the board",
    promptVersion: null,
    predecessorConversationId: null,
    state: "active",
    intent: { clientRequestId: "req_0000001", mode: "spawn", launchId: null, error: null },
    designatedAt: "2026-07-29T00:00:00.000Z",
    activatedAt: "2026-07-29T00:00:00.000Z",
  };
}

function managerSources(overrides: Partial<ManagerAuthoritySources> = {}): ManagerAuthoritySources {
  return {
    activeSeats: () => [activeSeat(MANAGER_ID)],
    revocations: () => [],
    legacyManagerConversationId: () => null,
    conversationFacts: () => ({ superseded: false, hasGeneration: true, project: "proj-a" }),
    resolveAlias: (id) => id,
    ...overrides,
  };
}

function callerSources(overrides: Partial<AttentionCallerSources> = {}): AttentionCallerSources {
  return {
    ancestry: () => [4242, 4241, 1],
    hosted: () => hostedConversationsFromSnapshot(snapshotOf(MANAGER_ID, [MANAGER_PATH], [{ path: MANAGER_PATH, pid: null }])),
    rootConversationId: () => null,
    capabilityCallerConversationId: capabilityConversationResolver(
      CAPABILITY,
      (digest) => (digest === CAPABILITY_DIGEST ? MANAGER_ID : null),
    ),
    ...overrides,
  };
}

function managerTargetFor(sourcesValue: ManagerAuthoritySources): ManagerTarget {
  return {
    conversationId: null,
    path: null,
    seats: authorizedManagerSeats(sourcesValue).map((seat) => ({ conversationId: seat.conversationId, path: seat.path })),
  };
}

/** Drive the whole seam and report whether the caller is the designated seat —
    the label the deploy binding requires. */
function isDesignatedSeat(caller: AttentionCallerSources, manager: ManagerAuthoritySources): boolean {
  const identity = mcpCallerIdentity(attentionCallerAuthority(caller), managerTargetFor(manager));
  return identity.kind === "unrestricted" && identity.reason === "manager";
}

test("HOST RETIREMENT: the entry survives with its host cleared and the seat still holds", () => {
  /* Retirement clears the host record but leaves the conversation and its
     generation on file — the exact shape that resolved to "unidentified"
     before, now indistinguishable from any other zero-pid conversation. */
  const retired = snapshotOf(MANAGER_ID, [MANAGER_PATH], [{ path: MANAGER_PATH, pid: null }]);
  const caller = callerSources({ hosted: () => hostedConversationsFromSnapshot(retired) });

  expect(attentionCallerAuthority(caller)).toEqual({ kind: "worker", conversationId: MANAGER_ID, role: "orchestrator" });
  expect(isDesignatedSeat(caller, managerSources())).toBe(true);
});

test("HOST RETIREMENT: the entry is dropped entirely and the capability alone still names the manager", () => {
  const evicted = snapshotOf(MANAGER_ID, [MANAGER_PATH], []);
  expect(isDesignatedSeat(callerSources({ hosted: () => hostedConversationsFromSnapshot(evicted) }), managerSources())).toBe(true);
});

test("RESUME: a resume successor generation with a BRAND NEW live pid keeps the same seat", () => {
  /* Resume appends a generation and a fresh host process. Both evidence chains
     now name the manager — the ancestry through the new pid, the capability
     through admission lineage — and they agree, so authority holds. */
  const resumed = snapshotOf(
    MANAGER_ID,
    [MANAGER_PATH, RESUMED_PATH],
    [{ path: MANAGER_PATH, pid: null }, { path: RESUMED_PATH, pid: 9100 }],
  );
  const caller = callerSources({
    ancestry: () => [9101, 9100, 1],
    hosted: () => hostedConversationsFromSnapshot(resumed),
  });

  expect(attentionCallerAuthority(caller)).toEqual({ kind: "worker", conversationId: MANAGER_ID, role: "orchestrator" });
  expect(isDesignatedSeat(caller, managerSources())).toBe(true);
});

test("RESUME: the seat still holds from a resumed host whose pid the registry never recorded", () => {
  const resumed = snapshotOf(
    MANAGER_ID,
    [MANAGER_PATH, RESUMED_PATH],
    [{ path: RESUMED_PATH, pid: null }],
  );
  expect(isDesignatedSeat(callerSources({ hosted: () => hostedConversationsFromSnapshot(resumed) }), managerSources())).toBe(true);
});

test("MIGRATION: the conversation is aliased to a new id and the seat follows it through the alias", () => {
  /* Migration renames the conversation. The capability digest resolves to the
     CANONICAL id, while the seat still records the pre-migration one, so the
     seam is only correct if both sides compare through resolveAlias. */
  const migrated = snapshotOf(SUCCESSOR_ID, [MIGRATED_PATH], [{ path: MIGRATED_PATH, pid: null }]);
  const caller = callerSources({
    hosted: () => hostedConversationsFromSnapshot(migrated),
    capabilityCallerConversationId: capabilityConversationResolver(
      CAPABILITY,
      (digest) => (digest === CAPABILITY_DIGEST ? SUCCESSOR_ID : null),
    ),
  });
  const manager = managerSources({
    activeSeats: () => [activeSeat(MANAGER_ID)],
    resolveAlias: (id) => (id === MANAGER_ID ? SUCCESSOR_ID : id),
  });

  expect(attentionCallerAuthority(caller)).toEqual({ kind: "worker", conversationId: SUCCESSOR_ID, role: "orchestrator" });
  expect(isDesignatedSeat(caller, manager)).toBe(true);
});

test("GENERATION CHANGE: rolling a generation neither grants nor removes authority on its own", () => {
  const rolled = snapshotOf(MANAGER_ID, [MANAGER_PATH, RESUMED_PATH, MIGRATED_PATH], []);
  const caller = callerSources({ hosted: () => hostedConversationsFromSnapshot(rolled) });
  expect(isDesignatedSeat(caller, managerSources())).toBe(true);

  /* The same rolled conversation with NO generation on the registry facts is
     unattributable and fails closed — a generation change must not become a
     way to launder an identity the registry cannot place. */
  const ungenerated = managerSources({
    conversationFacts: () => ({ superseded: false, hasGeneration: false, project: "proj-a" }),
  });
  expect(isDesignatedSeat(caller, ungenerated)).toBe(false);
});

test("RETIREMENT + RESUME do not resurrect a REVOKED predecessor (ABA across the lifecycle)", () => {
  /* The predecessor was revoked at epoch 1 and its successor seated at epoch 2.
     A retired predecessor coming back through resume still presents the same
     valid capability and a live new pid — and holds nothing, because the
     revocation names an epoch at or above its seat's. */
  const resumed = snapshotOf(
    MANAGER_ID,
    [MANAGER_PATH, RESUMED_PATH],
    [{ path: RESUMED_PATH, pid: 9100 }],
  );
  const caller = callerSources({
    ancestry: () => [9101, 9100, 1],
    hosted: () => hostedConversationsFromSnapshot(resumed),
  });
  const manager = managerSources({
    activeSeats: () => [activeSeat(SUCCESSOR_ID, 2)],
    revocations: () => [{ project: "proj-a", conversationId: MANAGER_ID, seatEpoch: 1, revokedAt: "2026-07-29T00:00:00.000Z" }],
  });

  /* Still positively IDENTIFIED — it is a real conversation — but not a manager. */
  expect(attentionCallerAuthority(caller)).toEqual({ kind: "worker", conversationId: MANAGER_ID, role: "orchestrator" });
  expect(isDesignatedSeat(caller, manager)).toBe(false);
});

test("a lifecycle event that makes the two evidence chains DISAGREE fails closed", () => {
  /* Resume bound a new pid to a DIFFERENT conversation while the capability
     still names the manager. Contradictory evidence identifies nobody, so the
     seat is denied rather than resolved in either direction. */
  const crossed = snapshotOf(SUCCESSOR_ID, [RESUMED_PATH], [{ path: RESUMED_PATH, pid: 9100 }]);
  const caller = callerSources({
    ancestry: () => [9101, 9100, 1],
    hosted: () => hostedConversationsFromSnapshot(crossed),
  });

  expect(attentionCallerAuthority(caller)).toEqual({ kind: "unidentified" });
  expect(isDesignatedSeat(caller, managerSources())).toBe(false);
});
