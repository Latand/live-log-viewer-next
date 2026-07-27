import { expect, test } from "bun:test";

import {
  BRIDGE_LIVE_BATCH_INTERVAL_MS,
  type BridgeReportBatch,
  type BridgeReportV1,
} from "@/lib/bridge/types";

import {
  bridgeDeliveryTurnId,
  bridgeReportResponseId,
  isBridgeDeliveryTurn,
  planBridgeReportDelivery,
} from "./bridgeDelivery";
import { normalizeVoiceDeliveries, rememberAcknowledgedVoiceDelivery } from "./voiceDelivery";

const NOW = new Date("2026-07-27T12:00:00.000Z");
const SHA = "4f3c1b9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a";

function report(seq: number, overrides: Partial<BridgeReportV1> = {}): BridgeReportV1 {
  return {
    seq,
    id: `rpt_${seq}`,
    at: NOW.toISOString(),
    class: "status",
    body: `report ${seq}`,
    ...overrides,
  };
}

function batch(reports: BridgeReportV1[], remaining = 0): BridgeReportBatch {
  return {
    reports,
    throughSeq: reports.reduce((highest, entry) => Math.max(highest, entry.seq), 0),
    remaining,
    gap: null,
  };
}

test("a batch becomes one delivery whose id is derived from the report seqs", () => {
  const plan = planBridgeReportDelivery({
    batch: batch([report(21), report(22, { class: "completed" })]),
    now: NOW,
    lastBatchAt: null,
  });

  expect(plan).not.toBeNull();
  expect(plan!.throughSeq).toBe(22);
  expect(plan!.delivery.turnId).toBe(bridgeDeliveryTurnId(22));
  expect(plan!.delivery.ready).toBe(true);
  expect(plan!.delivery.responses.map((response) => response.responseId)).toEqual([
    bridgeReportResponseId(21),
    bridgeReportResponseId(22),
  ]);
  expect(plan!.delivery.responses[1]!.text).toContain("completed");
  expect(plan!.delivery.responses[1]!.text).toContain("report 22");
});

test("the delivery id comes out of the existing worker-delivery derivation, unchanged", () => {
  const plan = planBridgeReportDelivery({ batch: batch([report(4)]), now: NOW, lastBatchAt: null })!;
  /* Round-tripping through the seam the worker path uses must reproduce the same
     id, or the tombstones that already survive reload would not recognize it. */
  const [normalized] = normalizeVoiceDeliveries([plan.delivery]);
  expect(normalized!.deliveryId).toBe(plan.delivery.deliveryId);
});

test("the same batch planned twice yields the same delivery id, so a replay is one delivery (§7.5)", () => {
  const first = planBridgeReportDelivery({ batch: batch([report(7), report(8)]), now: NOW, lastBatchAt: null })!;
  const again = planBridgeReportDelivery({
    batch: batch([report(7), report(8)]),
    now: new Date(NOW.getTime() + 5 * 60_000),
    lastBatchAt: null,
  })!;
  expect(again.delivery.deliveryId).toBe(first.delivery.deliveryId);
});

test("an acknowledged batch is never planned again, across reload (§7.6)", () => {
  const first = planBridgeReportDelivery({ batch: batch([report(7)]), now: NOW, lastBatchAt: null })!;
  const tombstones = rememberAcknowledgedVoiceDelivery([], first.delivery.deliveryId);

  const replay = planBridgeReportDelivery({
    batch: batch([report(7)]),
    now: new Date(NOW.getTime() + 60_000),
    lastBatchAt: null,
    acknowledgedDeliveryIds: tombstones,
  });
  expect(replay).toBeNull();
});

test("at most one batch per coalescing window reaches a live call (§4)", () => {
  const justBefore = new Date(NOW.getTime() - (BRIDGE_LIVE_BATCH_INTERVAL_MS - 1));
  expect(planBridgeReportDelivery({ batch: batch([report(1)]), now: NOW, lastBatchAt: justBefore })).toBeNull();

  const windowElapsed = new Date(NOW.getTime() - BRIDGE_LIVE_BATCH_INTERVAL_MS);
  expect(planBridgeReportDelivery({ batch: batch([report(1)]), now: NOW, lastBatchAt: windowElapsed })).not.toBeNull();
});

test("an empty batch plans nothing", () => {
  expect(planBridgeReportDelivery({ batch: batch([]), now: NOW, lastBatchAt: null })).toBeNull();
});

test("a confirmation request carries the SHA, nonce and expiry the gateway must echo back", () => {
  const plan = planBridgeReportDelivery({
    batch: batch([report(9, {
      class: "confirmation_request",
      body: "gates green on #726",
      confirmation: { sha: SHA, nonce: "0123456789abcdef0123456789abcdef", expiresAt: "2026-07-27T12:10:00.000Z" },
    })]),
    now: NOW,
    lastBatchAt: null,
  })!;

  const text = plan.delivery.responses[0]!.text;
  expect(text).toContain(SHA);
  expect(text).toContain("0123456789abcdef0123456789abcdef");
  expect(text).toContain("2026-07-27T12:10:00.000Z");
  expect(text).toContain("[bridge ref=9");
});

test("a gap notice is carried into the call rather than dropped (§7.12)", () => {
  const plan = planBridgeReportDelivery({
    batch: {
      reports: [report(20, { synthetic: true, body: "20 earlier report(s) are no longer available." }), report(21)],
      throughSeq: 21,
      remaining: 0,
      gap: { resumedAtSeq: 21, missedThroughSeq: 20 },
    },
    now: NOW,
    lastBatchAt: null,
  })!;
  expect(plan.delivery.responses[0]!.text).toContain("no longer available");
});

test("bridge delivery turns are distinguishable from worker turns", () => {
  expect(isBridgeDeliveryTurn(bridgeDeliveryTurnId(3))).toBe(true);
  expect(isBridgeDeliveryTurn("turn_0199")).toBe(false);
});

test("two different batches never collide on one id", () => {
  const first = planBridgeReportDelivery({ batch: batch([report(1), report(2)]), now: NOW, lastBatchAt: null })!;
  const second = planBridgeReportDelivery({ batch: batch([report(3)]), now: NOW, lastBatchAt: null })!;
  expect(second.delivery.deliveryId).not.toBe(first.delivery.deliveryId);
});
