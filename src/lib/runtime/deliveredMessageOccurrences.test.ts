import { expect, test } from "bun:test";

import type { RegistryFile } from "@/lib/agent/registry";
import type { HeldDelivery } from "@/lib/accounts/migration/contracts";

import { ORCHESTRATOR_PROMPT_VERSION, ORCHESTRATOR_SYSTEM_PROMPT } from "@/lib/orchestrator/prompt";
import type { OrchestratorSeat } from "@/lib/orchestrator/seats";

import { deliveredMessageOccurrences, heldDeliveryOccurrences, orchestratorMandateDeliveries } from "./deliveredMessageOccurrences";
import type { DeliveredMessageOccurrence } from "./messageOrigin";
import { messageTextDigest } from "./messageTextDigest";

/**
 * The registry→feed occurrence projection of #1117: a delivered held record
 * keeps its origin stamp, content digest, and settlement time, and those three
 * facts are exactly what the feed needs to attribute one transcript row. Any
 * record missing one of them, or belonging to another conversation, is not
 * evidence and contributes nothing.
 */

const TRANSCRIPT = "/sessions/worker-transcript.jsonl";
const RELAY_DIGEST = messageTextDigest("Round 2 verdict: REQUEST_CHANGES");
const MANDATE_DIGEST = messageTextDigest("Implement issue #12 in this worktree.");
const OPERATOR_DIGEST = messageTextDigest("what is left on the branch?");

function delivery(overrides: Partial<HeldDelivery> & { id: string }): HeldDelivery {
  return {
    conversationId: "conversation_worker",
    runtimeConversationId: "conversation_worker",
    text: "",
    createdAt: "2026-08-24T09:00:00.000Z",
    clientMessageId: null,
    payloadKind: "text",
    runtimeImages: [],
    contentDigest: MANDATE_DIGEST,
    artifactPaths: [],
    command: { operationId: overrides.id, kind: "send", policy: "queue", origin: { kind: "agent", role: "orchestrator" } },
    requestDigest: null,
    state: "delivered",
    generationId: "gen-1",
    attempts: 1,
    assignedAt: "2026-08-24T09:00:00.000Z",
    deliveredAt: "2026-08-24T09:00:01.000Z",
    error: null,
    ...overrides,
  } as HeldDelivery;
}

/* The #1117 cases are about delivery evidence, not seats. They pass this
   explicitly so no case in this file reads whatever seat store happens to be
   on the machine running it. */
const noSeats = () => ({ schemaVersion: 1, nextSeatEpoch: 1, seats: {}, pending: {}, revocations: [], history: [] });

function snapshot(deliveries: HeldDelivery[]): RegistryFile {
  return {
    conversations: {
      conversation_worker: {
        id: "conversation_worker",
        engine: "claude",
        generations: [{ id: "gen-1", path: TRANSCRIPT }],
        continuityPaths: [],
      },
      conversation_other: {
        id: "conversation_other",
        engine: "codex",
        generations: [{ id: "gen-9", path: "/sessions/other-transcript.jsonl" }],
        continuityPaths: [],
      },
    },
    conversationAliases: { conversation_worker_old: "conversation_worker" },
    heldDeliveries: Object.fromEntries(deliveries.map((item) => [item.id, item])),
  } as unknown as RegistryFile;
}

test("a delivered, stamped record projects its digest, settlement time, sender, and client-message identity", () => {
  const occurrences = heldDeliveryOccurrences(TRANSCRIPT, snapshot([
    delivery({ id: "d-mandate" }),
    delivery({
      id: "d-operator",
      clientMessageId: "composer-7",
      contentDigest: OPERATOR_DIGEST,
      deliveredAt: "2026-08-24T09:05:00.000Z",
      command: { operationId: "d-operator", kind: "send", policy: "queue", origin: { kind: "operator" } },
    }),
  ]));
  expect(occurrences).toEqual([
    { textDigest: MANDATE_DIGEST, deliveredAt: "2026-08-24T09:00:01.000Z", origin: "agent", senderRole: "orchestrator" },
    { textDigest: OPERATOR_DIGEST, deliveredAt: "2026-08-24T09:05:00.000Z", origin: "operator", clientMessageId: "composer-7" },
  ]);
});

test("a record addressed through a conversation alias still belongs to the transcript's conversation", () => {
  const occurrences = heldDeliveryOccurrences(TRANSCRIPT, snapshot([
    delivery({ id: "d-alias", conversationId: "conversation_worker_old" as HeldDelivery["conversationId"] }),
  ]));
  expect(occurrences).toHaveLength(1);
});

test("undelivered, unstamped, digest-less, corrupt, and foreign records contribute nothing", () => {
  const occurrences = heldDeliveryOccurrences(TRANSCRIPT, snapshot([
    delivery({ id: "d-held", state: "held", deliveredAt: null }),
    delivery({ id: "d-failed", state: "failed", deliveredAt: null }),
    delivery({ id: "d-unstamped", command: { operationId: "d-unstamped", kind: "send", policy: "queue" } }),
    delivery({ id: "d-no-digest", contentDigest: null }),
    delivery({ id: "d-bad-digest", contentDigest: "not-a-digest" }),
    delivery({ id: "d-bad-time", deliveredAt: "yesterday-ish" }),
    delivery({
      id: "d-forged",
      command: { operationId: "d-forged", kind: "send", policy: "queue", origin: { kind: "root" } as unknown as HeldDelivery["command"]["origin"] },
    }),
    delivery({ id: "d-foreign", conversationId: "conversation_other" as HeldDelivery["conversationId"] }),
  ]));
  expect(occurrences).toEqual([]);
  expect(heldDeliveryOccurrences("/sessions/unknown.jsonl", snapshot([delivery({ id: "d-1" })]))).toEqual([]);
});

const RELAY: DeliveredMessageOccurrence = {
  textDigest: RELAY_DIGEST,
  deliveredAt: "2026-08-24T09:10:00.000Z",
  origin: "agent",
  senderRole: "reviewer",
};

/** The identity a structured relay reserves its registry record under. */
const STRUCTURED_RELAY_ID = "flow_relay_round2";

function relayRecord(overrides: Partial<HeldDelivery> & { id: string }): HeldDelivery {
  return delivery({
    contentDigest: RELAY_DIGEST,
    deliveredAt: "2026-08-24T09:10:04.000Z",
    command: { operationId: overrides.id, kind: "send", policy: "queue", origin: { kind: "agent", role: "reviewer" } },
    ...overrides,
  });
}

test("one structured relay in both stores is one occurrence, joined by the round's identity; a relay the registry never reserved is added", () => {
  const registrySnapshot = () => snapshot([
    relayRecord({ id: "d-structured-relay", clientMessageId: STRUCTURED_RELAY_ID }),
  ]);
  const structuredRelay: DeliveredMessageOccurrence = { ...RELAY, clientMessageId: STRUCTURED_RELAY_ID };
  const legacyRelay: DeliveredMessageOccurrence = { ...RELAY, deliveredAt: "2026-08-24T11:00:00.000Z", clientMessageId: "flow_relay_round3" };
  const occurrences = deliveredMessageOccurrences(TRANSCRIPT, {
    registrySnapshot,
    orchestratorSeats: noSeats,
    relayOccurrences: () => [legacyRelay, structuredRelay],
  });
  /* The registry's settlement wins for the shared delivery; the identity
     itself never reaches the wire. */
  expect(occurrences).toEqual([
    { textDigest: RELAY_DIGEST, deliveredAt: "2026-08-24T09:10:04.000Z", origin: "agent", senderRole: "reviewer" },
    { textDigest: RELAY_DIGEST, deliveredAt: "2026-08-24T11:00:00.000Z", origin: "agent", senderRole: "reviewer" },
  ]);
});

test("an operator message and a legacy relay with identical text within ten minutes are two occurrences", () => {
  /* The operator repeated the relay's words four minutes after it landed.
     Text and time agree, the delivery identities differ, and only a shared
     identity may collapse two records into one. */
  const registrySnapshot = () => snapshot([
    delivery({
      id: "d-operator-repeat",
      clientMessageId: "composer-1",
      contentDigest: RELAY_DIGEST,
      deliveredAt: "2026-08-24T09:14:00.000Z",
      command: { operationId: "d-operator-repeat", kind: "send", policy: "queue", origin: { kind: "operator" } },
    }),
  ]);
  const legacyRelay: DeliveredMessageOccurrence = { ...RELAY, clientMessageId: STRUCTURED_RELAY_ID };
  expect(deliveredMessageOccurrences(TRANSCRIPT, { registrySnapshot, orchestratorSeats: noSeats, relayOccurrences: () => [legacyRelay] })).toEqual([
    { textDigest: RELAY_DIGEST, deliveredAt: "2026-08-24T09:10:00.000Z", origin: "agent", senderRole: "reviewer" },
    { textDigest: RELAY_DIGEST, deliveredAt: "2026-08-24T09:14:00.000Z", origin: "operator" },
  ]);
  /* Neither side naming an identity is the all-legacy case: still two. */
  const unnamedOperator = () => snapshot([
    delivery({
      id: "d-operator-unnamed",
      contentDigest: RELAY_DIGEST,
      deliveredAt: "2026-08-24T09:14:00.000Z",
      command: { operationId: "d-operator-unnamed", kind: "send", policy: "queue", origin: { kind: "operator" } },
    }),
  ]);
  expect(deliveredMessageOccurrences(TRANSCRIPT, { registrySnapshot: unnamedOperator, orchestratorSeats: noSeats, relayOccurrences: () => [RELAY] })).toHaveLength(2);
});

test("a pre-#1117 structured round, whose registry record carries no origin stamp, still surfaces through the flow store", () => {
  const registrySnapshot = () => snapshot([
    relayRecord({
      id: "d-unstamped-relay",
      clientMessageId: STRUCTURED_RELAY_ID,
      command: { operationId: "d-unstamped-relay", kind: "send", policy: "queue" },
    }),
  ]);
  const structuredRelay: DeliveredMessageOccurrence = { ...RELAY, clientMessageId: STRUCTURED_RELAY_ID };
  expect(deliveredMessageOccurrences(TRANSCRIPT, { registrySnapshot, orchestratorSeats: noSeats, relayOccurrences: () => [structuredRelay] })).toEqual([RELAY]);
});

test("each source degrades to absence on its own, and the result is settlement-ordered", () => {
  const registrySnapshot = () => snapshot([
    delivery({ id: "d-late", deliveredAt: "2026-08-24T12:00:00.000Z" }),
  ]);
  expect(deliveredMessageOccurrences(TRANSCRIPT, {
    registrySnapshot: () => { throw new Error("registry unavailable"); },
    orchestratorSeats: noSeats,
    relayOccurrences: () => [RELAY],
  })).toEqual([RELAY]);
  expect(deliveredMessageOccurrences(TRANSCRIPT, {
    registrySnapshot,
    orchestratorSeats: noSeats,
    relayOccurrences: () => { throw new Error("flow store unavailable"); },
  })).toHaveLength(1);
  const ordered = deliveredMessageOccurrences(TRANSCRIPT, { registrySnapshot, orchestratorSeats: noSeats, relayOccurrences: () => [RELAY] });
  expect(ordered.map((occurrence) => occurrence.deliveredAt)).toEqual([
    "2026-08-24T09:10:00.000Z",
    "2026-08-24T12:00:00.000Z",
  ]);
  expect(deliveredMessageOccurrences("", { registrySnapshot, orchestratorSeats: noSeats, relayOccurrences: () => [RELAY] })).toEqual([]);
});

/*
 * #1166: a seat is created by DELIVERING its mandate, so those 8 KB reach the
 * transcript as an ordinary message. The DELIVERY's own identity is what says
 * so — the adoption message under the identity `seatCommand.ts` reserves, the
 * spawn's first prompt under the launch id a seat recorded — and only the exact
 * delivery so identified projects the mandate fact. The seat record, when there
 * still is one, adds which mandate it was.
 */

const MANDATE_TEXT = ORCHESTRATOR_SYSTEM_PROMPT;
const SEAT_MANDATE_DIGEST = messageTextDigest(MANDATE_TEXT);
/** What an operator writes instead of the approved default. */
const BESPOKE_MANDATE = "You run the conveyor for atlas. Ship issue #7 first, and report when it merges.";

function seat(overrides: Partial<OrchestratorSeat> & { intent: OrchestratorSeat["intent"] }): OrchestratorSeat {
  return {
    project: "atlas",
    seatEpoch: 2,
    conversationId: "conversation_worker",
    path: TRANSCRIPT,
    mandate: MANDATE_TEXT,
    promptVersion: ORCHESTRATOR_PROMPT_VERSION,
    predecessorConversationId: null,
    state: "active",
    designatedAt: "2026-08-24T08:59:00.000Z",
    activatedAt: "2026-08-24T09:00:02.000Z",
    ...overrides,
  };
}

/** The approved default's version, as the projection proves it. */
const APPROVED: { kind: "version"; version: number } = { kind: "version", version: ORCHESTRATOR_PROMPT_VERSION };

function seatFile(seats: OrchestratorSeat[], history: OrchestratorSeat[] = []) {
  return {
    schemaVersion: 1,
    nextSeatEpoch: 9,
    seats: Object.fromEntries(seats.map((entry, index) => [`${entry.project}-${index}`, entry])),
    pending: {},
    revocations: [],
    history: history.map((entry) => ({ seat: entry, reason: "terminal_error" as const, terminalizedAt: "2026-08-24T08:00:00.000Z" })),
  };
}

/** The identity `seatCommand.ts` derives for an adoption-mode mandate. */
const ADOPTION_REQUEST_ID = "req-atlas-adopt";
const ADOPTION_MANDATE_ID = `orchmandate_${ADOPTION_REQUEST_ID}`;
/** The identity `structuredSpawn.ts` reserves a launch's first prompt under. */
const SPAWN_LAUNCH_ID = "launch-atlas-1";

function mandateRecord(overrides: Partial<HeldDelivery> & { id: string }): HeldDelivery {
  return delivery({
    contentDigest: SEAT_MANDATE_DIGEST,
    text: MANDATE_TEXT,
    /* The seat command builds its delivery from four fields and stamps no
       authorship — the identity is what says who sent it. */
    command: { operationId: overrides.id, kind: "send", policy: "queue" },
    ...overrides,
  });
}

test("the seat's own delivery identities are the mandate ids, in both delivery modes", () => {
  const mandates = orchestratorMandateDeliveries(seatFile([
    seat({ intent: { clientRequestId: ADOPTION_REQUEST_ID, mode: "existing", launchId: null, error: null } }),
    seat({ mandate: BESPOKE_MANDATE, promptVersion: null, intent: { clientRequestId: "req-atlas-spawn", mode: "spawn", launchId: SPAWN_LAUNCH_ID, error: null } }),
  ]));
  expect(mandates.get(ADOPTION_MANDATE_ID)).toEqual(APPROVED);
  expect(mandates.get(`spawn_${SPAWN_LAUNCH_ID}`)).toEqual({ kind: "custom" });
  /* A spawn-mode intent that never got a launch id names no spawn delivery. */
  expect([...mandates.keys()]).toEqual([ADOPTION_MANDATE_ID, "orchmandate_req-atlas-spawn", `spawn_${SPAWN_LAUNCH_ID}`]);
});

test("a mandate delivery projects the approved default it carried, with no authorship stamp on the record", () => {
  const mandates = orchestratorMandateDeliveries(seatFile([
    seat({ intent: { clientRequestId: ADOPTION_REQUEST_ID, mode: "existing", launchId: null, error: null } }),
  ]));
  const occurrences = heldDeliveryOccurrences(
    TRANSCRIPT,
    snapshot([mandateRecord({ id: "d-seat-mandate", clientMessageId: ADOPTION_MANDATE_ID })]),
    mandates,
  );
  expect(occurrences).toEqual([{
    textDigest: SEAT_MANDATE_DIGEST,
    deliveredAt: "2026-08-24T09:00:01.000Z",
    origin: "agent",
    mandate: APPROVED,
    clientMessageId: ADOPTION_MANDATE_ID,
  }]);
});

test("a bespoke mandate reads as custom even when the seat kept the incumbent's version number", () => {
  /* An operator-edited ROTATION: `executeOrchestratorRotation` composes the
     caller's own text with the handoff and passes the INCUMBENT's
     promptVersion through, so the number says v9 about text nobody approved.
     The stored mandate itself is the evidence that settles it. */
  const rotated = `${BESPOKE_MANDATE}\n\n## Handoff from your predecessor (rotation)\n\nYou are replacing conversation_predecessor.`;
  const mandates = orchestratorMandateDeliveries(seatFile([
    seat({ mandate: rotated, intent: { clientRequestId: ADOPTION_REQUEST_ID, mode: "existing", launchId: null, error: null } }),
  ]));
  expect(mandates.get(ADOPTION_MANDATE_ID)).toEqual({ kind: "custom" });
});

test("an unedited rotation is still the approved default the incumbent held", () => {
  /* The mirror of the case above: no caller text, so the seat kept the
     default and only appended a handoff to it. */
  const rotated = `${ORCHESTRATOR_SYSTEM_PROMPT}\n\n## Handoff from your predecessor (rotation)\n\nYou are replacing conversation_predecessor.`;
  const mandates = orchestratorMandateDeliveries(seatFile([
    seat({ mandate: rotated, intent: { clientRequestId: ADOPTION_REQUEST_ID, mode: "existing", launchId: null, error: null } }),
  ]));
  expect(mandates.get(ADOPTION_MANDATE_ID)).toEqual(APPROVED);
});

test("a seat based on a default this checkout no longer carries claims no version at all", () => {
  /* Its text cannot be checked against the one approved default that ships
     here, so the card names it a mandate and stops there. */
  const mandates = orchestratorMandateDeliveries(seatFile([
    seat({ mandate: BESPOKE_MANDATE, promptVersion: ORCHESTRATOR_PROMPT_VERSION - 1, intent: { clientRequestId: ADOPTION_REQUEST_ID, mode: "existing", launchId: null, error: null } }),
  ]));
  expect(mandates.get(ADOPTION_MANDATE_ID)).toEqual({ kind: "unqualified" });
});

test("identical bytes delivered under any other identity are not the seat's mandate", () => {
  const mandates = orchestratorMandateDeliveries(seatFile([
    seat({ intent: { clientRequestId: ADOPTION_REQUEST_ID, mode: "existing", launchId: null, error: null } }),
  ]));
  const occurrences = heldDeliveryOccurrences(TRANSCRIPT, snapshot([
    /* The operator pasted the very same text into the composer. */
    mandateRecord({
      id: "d-operator-paste",
      clientMessageId: "composer-9",
      command: { operationId: "d-operator-paste", kind: "send", policy: "queue", origin: { kind: "operator" } },
    }),
    /* And an unstamped record with no identity at all still contributes
       nothing: without the seat's id there is no evidence of anything. */
    mandateRecord({ id: "d-unstamped-lookalike" }),
  ]), mandates);
  expect(occurrences).toEqual([
    { textDigest: SEAT_MANDATE_DIGEST, deliveredAt: "2026-08-24T09:00:01.000Z", origin: "operator", clientMessageId: "composer-9" },
  ]);
});

test("the mandate fact reaches the wire; the identity that carried it does not", () => {
  const registrySnapshot = () => snapshot([mandateRecord({ id: "d-seat-mandate", clientMessageId: ADOPTION_MANDATE_ID })]);
  const orchestratorSeats = () => seatFile([
    seat({ intent: { clientRequestId: ADOPTION_REQUEST_ID, mode: "existing", launchId: null, error: null } }),
  ]);
  expect(deliveredMessageOccurrences(TRANSCRIPT, { registrySnapshot, orchestratorSeats, relayOccurrences: () => [] })).toEqual([
    { textDigest: SEAT_MANDATE_DIGEST, deliveredAt: "2026-08-24T09:00:01.000Z", origin: "agent", mandate: APPROVED },
  ]);
});

test("the reserved adoption identity is a mandate on its own, with no seat record behind it", () => {
  /* The seat store is unreadable, and a retention-compacted or plainly absent
     record reads the same way. The identity `seatCommand.ts` reserved still
     says the seat delivered this, so the row is the card — it just names no
     particular mandate. */
  const registrySnapshot = () => snapshot([mandateRecord({ id: "d-seat-mandate", clientMessageId: ADOPTION_MANDATE_ID })]);
  const unqualified: DeliveredMessageOccurrence[] = [
    { textDigest: SEAT_MANDATE_DIGEST, deliveredAt: "2026-08-24T09:00:01.000Z", origin: "agent", mandate: { kind: "unqualified" } },
  ];
  expect(deliveredMessageOccurrences(TRANSCRIPT, {
    registrySnapshot,
    orchestratorSeats: () => { throw new Error("seat store unavailable"); },
    relayOccurrences: () => [],
  })).toEqual(unqualified);
  expect(deliveredMessageOccurrences(TRANSCRIPT, { registrySnapshot, orchestratorSeats: noSeats, relayOccurrences: () => [] }))
    .toEqual(unqualified);
});

test("a spawn's first prompt without its seat record stays the message it was", () => {
  /* `spawn_<launchId>` is every delegated launch's identity, so with no seat
     claiming this one there is nothing to say it carried a mandate. */
  const registrySnapshot = () => snapshot([mandateRecord({ id: "d-spawn-prompt", clientMessageId: `spawn_${SPAWN_LAUNCH_ID}` })]);
  expect(deliveredMessageOccurrences(TRANSCRIPT, { registrySnapshot, orchestratorSeats: noSeats, relayOccurrences: () => [] })).toEqual([]);
});
