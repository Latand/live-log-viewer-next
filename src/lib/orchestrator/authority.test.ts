import { expect, test } from "bun:test";

import { authorizedManagerSeats, type ManagerAuthoritySources, type ManagerConversationFacts } from "./authority";
import type { OrchestratorRevocation, OrchestratorSeat } from "./seats";

function seat(overrides: Partial<OrchestratorSeat> & { conversationId: string; project: string; seatEpoch: number }): OrchestratorSeat {
  return {
    path: null,
    mandate: "m",
    promptVersion: null,
    predecessorConversationId: null,
    state: "active",
    intent: { clientRequestId: "req_0000001", mode: "spawn", launchId: null, error: null },
    designatedAt: "2026-07-29T00:00:00.000Z",
    activatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

const LIVE: ManagerConversationFacts = { superseded: false, hasGeneration: true, project: null };

function sources(overrides: Partial<ManagerAuthoritySources>): ManagerAuthoritySources {
  return {
    activeSeats: () => [],
    revocations: () => [],
    legacyManagerConversationId: () => null,
    conversationFacts: () => LIVE,
    resolveAlias: (id) => id,
    ...overrides,
  };
}

const ids = (sourcesValue: ManagerAuthoritySources) => authorizedManagerSeats(sourcesValue).map((entry) => entry.conversationId);

test("an active seat with live registry facts is authorized", () => {
  const value = sources({ activeSeats: () => [seat({ conversationId: "conversation_a", project: "proj-a", seatEpoch: 1 })] });
  expect(ids(value)).toEqual(["conversation_a"]);
});

test("fails closed when the registry does not know the conversation at all", () => {
  const value = sources({
    activeSeats: () => [seat({ conversationId: "conversation_a", project: "proj-a", seatEpoch: 1 })],
    conversationFacts: () => null,
  });
  expect(ids(value)).toEqual([]);
});

test("fails closed on a missing generation and on a superseded conversation", () => {
  const seats = () => [seat({ conversationId: "conversation_a", project: "proj-a", seatEpoch: 1 })];
  expect(ids(sources({ activeSeats: seats, conversationFacts: () => ({ ...LIVE, hasGeneration: false }) }))).toEqual([]);
  expect(ids(sources({ activeSeats: seats, conversationFacts: () => ({ ...LIVE, superseded: true }) }))).toEqual([]);
});

test("fails closed on a cross-project identity: seat project contradicts durable ownership", () => {
  const value = sources({
    activeSeats: () => [seat({ conversationId: "conversation_a", project: "proj-a", seatEpoch: 1 })],
    conversationFacts: () => ({ ...LIVE, project: "proj-b" }),
  });
  expect(ids(value)).toEqual([]);
});

test("fails closed when two projects claim the same conversation", () => {
  const value = sources({
    activeSeats: () => [
      seat({ conversationId: "conversation_a", project: "proj-a", seatEpoch: 1 }),
      seat({ conversationId: "conversation_a", project: "proj-b", seatEpoch: 2 }),
    ],
  });
  expect(ids(value)).toEqual([]);
});

test("revocation kills the seat it names; re-designation at a newer epoch survives (ABA)", () => {
  const revocation: OrchestratorRevocation = { project: "proj-a", conversationId: "conversation_a", seatEpoch: 3, revokedAt: "2026-07-29T00:00:00.000Z" };
  /* A stale seat at the revoked epoch (a predecessor returning from pause, or
     a re-adopted transcript replaying an old file) stays dead. */
  expect(ids(sources({
    activeSeats: () => [seat({ conversationId: "conversation_a", project: "proj-a", seatEpoch: 3 })],
    revocations: () => [revocation],
  }))).toEqual([]);
  /* The operator deliberately re-designating the same conversation mints a
     strictly newer epoch, which is alive again. */
  expect(ids(sources({
    activeSeats: () => [seat({ conversationId: "conversation_a", project: "proj-a", seatEpoch: 4 })],
    revocations: () => [revocation],
  }))).toEqual(["conversation_a"]);
});

test("the legacy record keeps authority under the same registry checks", () => {
  expect(ids(sources({ legacyManagerConversationId: () => "conversation_legacy" }))).toEqual(["conversation_legacy"]);
  expect(ids(sources({
    legacyManagerConversationId: () => "conversation_legacy",
    conversationFacts: () => ({ ...LIVE, superseded: true }),
  }))).toEqual([]);
});

test("a durable revocation wins over the legacy pointer", () => {
  const value = sources({
    legacyManagerConversationId: () => "conversation_old",
    revocations: () => [{ project: "proj-a", conversationId: "conversation_old", seatEpoch: 1, revokedAt: "2026-07-29T00:00:00.000Z" }],
  });
  expect(ids(value)).toEqual([]);
});

test("seat evidence about the legacy conversation wins over the pointer, even when it denies", () => {
  const value = sources({
    activeSeats: () => [seat({ conversationId: "conversation_a", project: "proj-a", seatEpoch: 1 })],
    legacyManagerConversationId: () => "conversation_a",
    conversationFacts: () => ({ ...LIVE, project: "proj-b" }),
  });
  expect(ids(value)).toEqual([]);
});

test("identity survives migration: seats and revocations compare by canonical alias", () => {
  const alias = (id: string) => (id === "conversation_old" ? "conversation_new" : id);
  expect(authorizedManagerSeats(sources({
    activeSeats: () => [seat({ conversationId: "conversation_old", project: "proj-a", seatEpoch: 1 })],
    resolveAlias: alias,
  }))).toEqual([{ conversationId: "conversation_new", path: null, project: "proj-a" }]);
});
