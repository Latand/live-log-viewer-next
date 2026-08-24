import { expect, test } from "bun:test";

import type { DeliveredMessageOccurrence } from "@/lib/runtime/messageOrigin";
import { messageTextDigest } from "@/lib/runtime/messageTextDigest";

import { assignDeliveredOccurrences, OCCURRENCE_WINDOW_MS } from "./deliveredOccurrences";
import type { Item } from "./parse";

/**
 * The occurrence join is what keeps #1117 honest about authorship: evidence
 * attaches to the one row its delivery produced, never to every row sharing
 * the text.
 */

const RELAY_TEXT = "Review round findings are below.\n\nP1 — the held command drops its origin.";
const RELAY_DIGEST = messageTextDigest(RELAY_TEXT);
const T0 = Date.parse("2026-08-24T09:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function user(offsetMs: number, text = RELAY_TEXT): Item {
  return { kind: "user", ts: iso(offsetMs), text };
}

function relay(offsetMs: number, senderRole = "reviewer"): DeliveredMessageOccurrence {
  return { textDigest: RELAY_DIGEST, deliveredAt: iso(offsetMs), origin: "agent", senderRole };
}

test("an occurrence claims the nearest-in-time row with its text and leaves an identical row alone", () => {
  const relayRow = user(500);
  const operatorRow = user(3 * 60_000);
  const assigned = assignDeliveredOccurrences([relayRow, operatorRow], [relay(0)]);
  expect(assigned.get(relayRow)).toEqual({ origin: "agent", senderRole: "reviewer" });
  expect(assigned.has(operatorRow)).toBe(false);
  /* Mirrored order: the operator's identical message came first. */
  const earlierOperator = user(-3 * 60_000);
  const laterRelay = user(500);
  const mirrored = assignDeliveredOccurrences([earlierOperator, laterRelay], [relay(0)]);
  expect(mirrored.has(earlierOperator)).toBe(false);
  expect(mirrored.get(laterRelay)).toEqual({ origin: "agent", senderRole: "reviewer" });
});

test("two deliveries of the same text claim two rows in settlement order, one each", () => {
  const first = user(1_000);
  const second = user(60_000 + 1_000);
  const assigned = assignDeliveredOccurrences([first, second], [relay(60_000, "orchestrator"), relay(0, "reviewer")]);
  expect(assigned.get(first)).toEqual({ origin: "agent", senderRole: "reviewer" });
  expect(assigned.get(second)).toEqual({ origin: "agent", senderRole: "orchestrator" });
  /* A third occurrence with no row left over claims nothing. */
  const overflow = assignDeliveredOccurrences([first], [relay(0), relay(2_000)]);
  expect(overflow.size).toBe(1);
});

test("a row outside the settlement window, without a timestamp, or with other text is never claimed", () => {
  const farRow = user(OCCURRENCE_WINDOW_MS + 1_000);
  const untimed: Item = { kind: "user", ts: undefined, text: RELAY_TEXT };
  const otherText = user(100, "ship it once the checks pass");
  const assigned = assignDeliveredOccurrences([farRow, untimed, otherText], [relay(0)]);
  expect(assigned.size).toBe(0);
  const edge = user(OCCURRENCE_WINDOW_MS);
  expect(assignDeliveredOccurrences([edge], [relay(0)]).has(edge)).toBe(true);
});

test("rows the parser or ledger already attributed consume their occurrence so it cannot drift", () => {
  const structuredRelay: Item = { kind: "tmsg", ts: iso(200), dir: "in", peer: "reviewer", summary: "", text: RELAY_TEXT, internal: true };
  const operatorRepeat = user(40_000);
  const assigned = assignDeliveredOccurrences([structuredRelay, operatorRepeat], [relay(0)]);
  expect(assigned.has(structuredRelay)).toBe(true);
  expect(assigned.has(operatorRepeat)).toBe(false);
  const deliveredRow: Item = {
    kind: "sysmsg",
    label: "system",
    text: RELAY_TEXT,
    deliveredMessage: { engineMessageId: null, ts: iso(300) },
  };
  expect(assignDeliveredOccurrences([deliveredRow, operatorRepeat], [relay(0)]).has(deliveredRow)).toBe(true);
});

test("scaffold rows never take part, and the verbatim text matches when only trimming differs", () => {
  const scaffold: Item = { kind: "sysmsg", label: "system", text: RELAY_TEXT };
  const paddedRow = user(100, `${RELAY_TEXT}\n`);
  const verbatim: DeliveredMessageOccurrence = { ...relay(0), textDigest: messageTextDigest(`${RELAY_TEXT}\n`) };
  expect(assignDeliveredOccurrences([scaffold], [relay(0)]).size).toBe(0);
  expect(assignDeliveredOccurrences([paddedRow], [relay(0)]).has(paddedRow)).toBe(true);
  expect(assignDeliveredOccurrences([paddedRow], [verbatim]).has(paddedRow)).toBe(true);
  expect(assignDeliveredOccurrences([paddedRow], []).size).toBe(0);
  const corruptTime: DeliveredMessageOccurrence = { ...relay(0), deliveredAt: "when?" };
  expect(assignDeliveredOccurrences([paddedRow], [corruptTime]).size).toBe(0);
});
