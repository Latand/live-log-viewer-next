import { describe, expect, test } from "bun:test";

import {
  deliverPrivateDraft,
  exportDailyRollup,
  exportStoredDailyRollup,
  storeDailyRollup,
} from "./service";
import { emptyWorktimeState, upsertOperatorOccurrence } from "./ledger";

const DAY_ONE = "2026-08-13";
const DAY_TWO = "2026-08-14";
const NOW = Date.parse("2026-08-15T09:00:00.000Z");

function stateWithEvents() {
  const state = emptyWorktimeState(Date.parse("2026-08-13T00:00:00.000Z"));
  for (const [sourceId, occurredAtMs] of [
    ["day-one", Date.parse("2026-08-13T09:00:00.000Z")],
    ["day-two", Date.parse("2026-08-14T09:00:00.000Z")],
  ] as const) {
    upsertOperatorOccurrence(state, {
      sourceId,
      occurrenceId: sourceId,
      origin: "composer",
      relation: "direct",
      occurredAtMs,
      projectCandidates: [{ project: "fixture-project", rank: 4, evidence: "ownership" }],
    });
  }
  return state;
}

describe("worktime export", () => {
  test("model-free export contains audit totals and no transcript or account data", async () => {
    const state = stateWithEvents();
    storeDailyRollup(state, DAY_TWO, { intervals: [], excludedSyntheticMs: 0 }, [], NOW);

    const exported = exportDailyRollup(state, DAY_TWO);
    expect(exported).toMatchObject({ day: DAY_TWO, timezone: "Europe/Kyiv" });
    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain("day-two");
    expect(serialized).not.toContain("accountId");
    expect(serialized).not.toContain("chatId");
    expect(exportStoredDailyRollup(state, DAY_TWO).lifecycle).toMatchObject({
      calculated_at: expect.any(String),
      drafted_at: expect.any(String),
      delivery_attempted_at: null,
      delivered_at: null,
      destination: "private-draft",
      receipt_id: null,
      last_error: null,
    });
  });

  test("late earlier evidence invalidates an undelivered rollup and rebuilds its canonical boundary", async () => {
    const state = stateWithEvents();
    storeDailyRollup(state, DAY_TWO, { intervals: [], excludedSyntheticMs: 0 }, [], NOW);
    upsertOperatorOccurrence(state, {
      sourceId: "day-two",
      occurrenceId: "day-two-earlier-mirror",
      origin: "composer",
      relation: "direct",
      occurredAtMs: Date.parse("2026-08-14T08:55:00.000Z"),
      projectCandidates: [{ project: "fixture-project", rank: 4, evidence: "ownership" }],
    });
    expect(state.rollups[DAY_TWO]).toBeUndefined();

    storeDailyRollup(state, DAY_TWO, { intervals: [], excludedSyntheticMs: 0 }, [], NOW);
    expect(state.rollups[DAY_TWO]?.rollup.projects[0]?.intervals[0]).toEqual({
      startMs: Date.parse("2026-08-14T08:55:00.000Z"),
      endMs: Date.parse("2026-08-14T09:05:00.000Z"),
    });
  });
});

describe("private-draft delivery lifecycle", () => {
  test("failed delivery stays retryable and delivered requires receipt plus read-back", async () => {
    const state = stateWithEvents();
    storeDailyRollup(state, DAY_TWO, { intervals: [], excludedSyntheticMs: 0 }, [], NOW);
    let now = NOW + 1_000;
    const failed = await deliverPrivateDraft(state, DAY_TWO, {
      now: () => now,
      send: async () => { throw new Error("fixture transport unavailable"); },
      readBack: async () => null,
    });

    expect(failed).toBe(false);
    expect(state.rollups[DAY_TWO]?.lifecycle).toMatchObject({ deliveredAt: null, lastError: "worktime operation failed" });

    now += 1_000;
    const mismatched = await deliverPrivateDraft(state, DAY_TWO, {
      now: () => now,
      send: async () => ({ receiptId: "transport-receipt", destination: "private-draft" }),
      readBack: async () => ({ receiptId: "transport-receipt", destination: "private-draft", payloadDigest: "wrong" }),
    });
    expect(mismatched).toBe(false);
    expect(state.rollups[DAY_TWO]?.lifecycle.deliveredAt).toBeNull();

    now += 1_000;
    const delivered = await deliverPrivateDraft(state, DAY_TWO, {
      now: () => now,
      send: async (_payload, payloadDigest) => ({ receiptId: "transport-receipt", destination: "private-draft", payloadDigest }),
      readBack: async (receipt) => ({ ...receipt, payloadDigest: receipt.payloadDigest! }),
    });
    expect(delivered).toBe(true);
    expect(state.rollups[DAY_TWO]?.lifecycle).toMatchObject({
      destination: "private-draft",
      receiptId: "transport-receipt",
      deliveredAt: new Date(now).toISOString(),
      lastError: null,
    });
  });

  test("a delivered day never creates another transport message", async () => {
    const state = stateWithEvents();
    storeDailyRollup(state, DAY_TWO, { intervals: [], excludedSyntheticMs: 0 }, [], NOW);
    let sends = 0;
    const transport = {
      now: () => NOW + 5_000,
      send: async (_payload: unknown, payloadDigest: string) => {
        sends += 1;
        return { receiptId: "one-receipt", destination: "private-draft" as const, payloadDigest };
      },
      readBack: async (receipt: { receiptId: string; destination: "private-draft"; payloadDigest?: string }) => ({
        ...receipt,
        payloadDigest: receipt.payloadDigest!,
      }),
    };

    expect(await deliverPrivateDraft(state, DAY_TWO, transport)).toBe(true);
    expect(await deliverPrivateDraft(state, DAY_TWO, transport)).toBe(true);
    expect(sends).toBe(1);
  });
});
