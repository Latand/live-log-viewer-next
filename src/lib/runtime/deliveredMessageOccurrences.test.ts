import { expect, test } from "bun:test";

import type { RegistryFile } from "@/lib/agent/registry";
import type { HeldDelivery } from "@/lib/accounts/migration/contracts";

import { deliveredMessageOccurrences, heldDeliveryOccurrences } from "./deliveredMessageOccurrences";
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

test("a delivered, stamped record projects its digest, settlement time, and sender", () => {
  const occurrences = heldDeliveryOccurrences(TRANSCRIPT, snapshot([
    delivery({ id: "d-mandate" }),
    delivery({
      id: "d-operator",
      contentDigest: OPERATOR_DIGEST,
      deliveredAt: "2026-08-24T09:05:00.000Z",
      command: { operationId: "d-operator", kind: "send", policy: "queue", origin: { kind: "operator" } },
    }),
  ]));
  expect(occurrences).toEqual([
    { textDigest: MANDATE_DIGEST, deliveredAt: "2026-08-24T09:00:01.000Z", origin: "agent", senderRole: "orchestrator" },
    { textDigest: OPERATOR_DIGEST, deliveredAt: "2026-08-24T09:05:00.000Z", origin: "operator" },
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

test("a flow relay the registry also settled counts once; a relay it never saw is added", () => {
  const registrySnapshot = () => snapshot([
    delivery({
      id: "d-structured-relay",
      contentDigest: RELAY_DIGEST,
      deliveredAt: "2026-08-24T09:10:04.000Z",
      command: { operationId: "d-structured-relay", kind: "send", policy: "queue", origin: { kind: "agent", role: "reviewer" } },
    }),
  ]);
  const legacyRelay: DeliveredMessageOccurrence = { ...RELAY, deliveredAt: "2026-08-24T11:00:00.000Z" };
  const occurrences = deliveredMessageOccurrences(TRANSCRIPT, {
    registrySnapshot,
    relayOccurrences: () => [legacyRelay, RELAY],
  });
  expect(occurrences).toEqual([
    { textDigest: RELAY_DIGEST, deliveredAt: "2026-08-24T09:10:04.000Z", origin: "agent", senderRole: "reviewer" },
    legacyRelay,
  ]);
});

test("each source degrades to absence on its own, and the result is settlement-ordered", () => {
  const registrySnapshot = () => snapshot([
    delivery({ id: "d-late", deliveredAt: "2026-08-24T12:00:00.000Z" }),
  ]);
  expect(deliveredMessageOccurrences(TRANSCRIPT, {
    registrySnapshot: () => { throw new Error("registry unavailable"); },
    relayOccurrences: () => [RELAY],
  })).toEqual([RELAY]);
  expect(deliveredMessageOccurrences(TRANSCRIPT, {
    registrySnapshot,
    relayOccurrences: () => { throw new Error("flow store unavailable"); },
  })).toHaveLength(1);
  const ordered = deliveredMessageOccurrences(TRANSCRIPT, { registrySnapshot, relayOccurrences: () => [RELAY] });
  expect(ordered.map((occurrence) => occurrence.deliveredAt)).toEqual([
    "2026-08-24T09:10:00.000Z",
    "2026-08-24T12:00:00.000Z",
  ]);
  expect(deliveredMessageOccurrences("", { registrySnapshot, relayOccurrences: () => [RELAY] })).toEqual([]);
});
