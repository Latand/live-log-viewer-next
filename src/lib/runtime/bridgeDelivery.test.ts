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

function delivered(options: Parameters<typeof planBridgeReportDelivery>[0]) {
  const plan = planBridgeReportDelivery(options);
  if (plan.kind !== "deliver") throw new Error(`expected a delivery, got ${plan.kind}`);
  return plan;
}

test("a batch becomes one delivery whose id is derived from the report seqs", () => {
  const plan = delivered({
    batch: batch([report(21), report(22, { class: "completed" })]),
    now: NOW,
    lastBatchAt: null,
  });

  expect(plan.throughSeq).toBe(22);
  expect(plan.delivery.turnId).toBe(bridgeDeliveryTurnId(22));
  expect(plan.delivery.ready).toBe(true);
  expect(plan.delivery.responses.map((response) => response.responseId)).toEqual([
    bridgeReportResponseId(21),
    bridgeReportResponseId(22),
  ]);
  expect(plan.delivery.responses[1]!.text).toContain("completed");
  expect(plan.delivery.responses[1]!.text).toContain("report 22");
});

test("the delivery id comes out of the existing worker-delivery derivation, unchanged", () => {
  const plan = delivered({ batch: batch([report(4)]), now: NOW, lastBatchAt: null });
  /* Round-tripping through the seam the worker path uses must reproduce the same
     id, or the tombstones that already survive reload would not recognize it. */
  const [normalized] = normalizeVoiceDeliveries([plan.delivery]);
  expect(normalized!.deliveryId).toBe(plan.delivery.deliveryId);
});

test("the same batch planned twice yields the same delivery id, so a replay is one delivery (§7.5)", () => {
  const first = delivered({ batch: batch([report(7), report(8)]), now: NOW, lastBatchAt: null });
  const again = delivered({
    batch: batch([report(7), report(8)]),
    now: new Date(NOW.getTime() + 5 * 60_000),
    lastBatchAt: null,
  });
  expect(again.delivery.deliveryId).toBe(first.delivery.deliveryId);
});

test("an acknowledged batch is never re-spoken, across reload (§7.6)", () => {
  const first = planBridgeReportDelivery({ batch: batch([report(7)]), now: NOW, lastBatchAt: null });
  expect(first.kind).toBe("deliver");
  const tombstones = rememberAcknowledgedVoiceDelivery(
    [],
    first.kind === "deliver" ? first.delivery.deliveryId : "",
  );

  const replay = planBridgeReportDelivery({
    batch: batch([report(7)]),
    now: new Date(NOW.getTime() + 60_000),
    lastBatchAt: null,
    acknowledgedDeliveryIds: tombstones,
  });
  expect(replay.kind).not.toBe("deliver");
});

test("an acknowledged batch whose cursor never advanced asks for the cursor, not for silence", () => {
  /* The ack landed in the call and the cursor write did not. Answering "nothing to
     do" here is what wedges the channel: the drain keeps handing back the same
     batch, the tombstone keeps suppressing it, and every later report sits behind a
     batch the user already heard. The plan has to name the seq to heal to. */
  const first = planBridgeReportDelivery({ batch: batch([report(7), report(8)]), now: NOW, lastBatchAt: null });
  const tombstones = rememberAcknowledgedVoiceDelivery(
    [],
    first.kind === "deliver" ? first.delivery.deliveryId : "",
  );

  const replay = planBridgeReportDelivery({
    batch: batch([report(7), report(8)]),
    now: new Date(NOW.getTime() + 60_000),
    lastBatchAt: null,
    acknowledgedDeliveryIds: tombstones,
  });
  expect(replay).toEqual({ kind: "already-acknowledged", throughSeq: 8 });
});

test("at most one batch per coalescing window reaches a live call (§4)", () => {
  const justBefore = new Date(NOW.getTime() - (BRIDGE_LIVE_BATCH_INTERVAL_MS - 1));
  expect(planBridgeReportDelivery({ batch: batch([report(1)]), now: NOW, lastBatchAt: justBefore }))
    .toEqual({ kind: "hold" });

  const windowElapsed = new Date(NOW.getTime() - BRIDGE_LIVE_BATCH_INTERVAL_MS);
  expect(planBridgeReportDelivery({ batch: batch([report(1)]), now: NOW, lastBatchAt: windowElapsed }).kind)
    .toBe("deliver");
});

test("an empty batch plans nothing", () => {
  expect(planBridgeReportDelivery({ batch: batch([]), now: NOW, lastBatchAt: null })).toEqual({ kind: "idle" });
});

test("a gap notice is carried into the call rather than dropped (§7.12)", () => {
  const plan = delivered({
    batch: {
      reports: [report(20, { synthetic: true, body: "20 earlier report(s) are no longer available." }), report(21)],
      throughSeq: 21,
      remaining: 0,
      gap: { resumedAtSeq: 21, missedThroughSeq: 20 },
    },
    now: NOW,
    lastBatchAt: null,
  });
  expect(plan.delivery.responses[0]!.text).toContain("no longer available");
});

test("bridge delivery turns are distinguishable from worker turns", () => {
  expect(isBridgeDeliveryTurn(bridgeDeliveryTurnId(3))).toBe(true);
  expect(isBridgeDeliveryTurn("turn_0199")).toBe(false);
});

test("two different batches never collide on one id", () => {
  const first = delivered({ batch: batch([report(1), report(2)]), now: NOW, lastBatchAt: null });
  const second = delivered({ batch: batch([report(3)]), now: NOW, lastBatchAt: null });
  expect(second.delivery.deliveryId).not.toBe(first.delivery.deliveryId);
});
