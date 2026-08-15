import crypto from "node:crypto";

import {
  calculateDailyRollup,
} from "./calculator";
import type {
  DailyWorktimeRollup,
  EditorInterval,
  ModelFreeDailyWorktimeExport,
  StoredDailyRollup,
  WorktimeStateV1,
} from "./types";

function payloadDigest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function worktimeSafeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === "AbortError") return "WakaTime request timed out";
  if (message === "WakaTime credential is unavailable"
    || message === "invalid WakaTime heartbeat response"
    || /^WakaTime heartbeat request failed with status \d{3}$/.test(message)) return message;
  return "worktime operation failed";
}

export function storeDailyRollup(
  state: WorktimeStateV1,
  day: string,
  editor: { intervals: EditorInterval[]; excludedSyntheticMs: number },
  projectPriority: string[],
  now: number,
): StoredDailyRollup {
  const existing = state.rollups[day];
  if (existing) return existing;
  const rollup = calculateDailyRollup({
    day,
    events: Object.values(state.events),
    editorIntervals: editor.intervals,
    excludedSyntheticMs: editor.excludedSyntheticMs,
    projectPriority,
  });
  const calculatedAt = new Date(now).toISOString();
  const stored: StoredDailyRollup = {
    rollup,
    lifecycle: {
      calculatedAt,
      draftedAt: calculatedAt,
      deliveryAttemptedAt: null,
      deliveredAt: null,
      destination: "private-draft",
      receiptId: null,
      lastError: null,
      payloadDigest: payloadDigest(rollup),
    },
  };
  state.rollups[day] = stored;
  return stored;
}

export function exportDailyRollup(state: WorktimeStateV1, day: string): DailyWorktimeRollup {
  const stored = state.rollups[day];
  if (!stored) throw new Error(`worktime rollup is unavailable for ${day}`);
  return structuredClone(stored.rollup);
}

export function exportStoredDailyRollup(state: WorktimeStateV1, day: string): ModelFreeDailyWorktimeExport {
  const stored = state.rollups[day];
  if (!stored) throw new Error(`worktime rollup is unavailable for ${day}`);
  const lifecycle = stored.lifecycle;
  return structuredClone({
    rollup: stored.rollup,
    lifecycle: {
      calculated_at: lifecycle.calculatedAt,
      drafted_at: lifecycle.draftedAt,
      delivery_attempted_at: lifecycle.deliveryAttemptedAt,
      delivered_at: lifecycle.deliveredAt,
      destination: lifecycle.destination,
      receipt_id: lifecycle.receiptId,
      last_error: lifecycle.lastError,
      payload_digest: lifecycle.payloadDigest,
    },
  });
}

export interface PrivateDraftReceipt {
  receiptId: string;
  destination: "private-draft";
  payloadDigest?: string;
}

export async function deliverPrivateDraft(state: WorktimeStateV1, day: string, transport: {
  now(): number;
  send(payload: DailyWorktimeRollup, payloadDigest: string): Promise<PrivateDraftReceipt>;
  readBack(receipt: PrivateDraftReceipt): Promise<PrivateDraftReceipt | null>;
}): Promise<boolean> {
  const stored: StoredDailyRollup | undefined = state.rollups[day];
  if (!stored) throw new Error(`worktime rollup is unavailable for ${day}`);
  if (stored.lifecycle.deliveredAt) return true;
  const attemptedAt = new Date(transport.now()).toISOString();
  stored.lifecycle.deliveryAttemptedAt = attemptedAt;
  stored.lifecycle.lastError = null;
  try {
    const payload = exportDailyRollup(state, day);
    const receipt = await transport.send(payload, stored.lifecycle.payloadDigest);
    const readBack = await transport.readBack(receipt);
    if (!receipt.receiptId.trim()
      || receipt.destination !== "private-draft"
      || receipt.payloadDigest !== stored.lifecycle.payloadDigest
      || !readBack
      || readBack.receiptId !== receipt.receiptId
      || readBack.destination !== "private-draft"
      || readBack.payloadDigest !== stored.lifecycle.payloadDigest) {
      stored.lifecycle.lastError = "delivery read-back did not confirm the private draft";
      return false;
    }
    stored.lifecycle.destination = "private-draft";
    stored.lifecycle.receiptId = receipt.receiptId;
    stored.lifecycle.deliveredAt = attemptedAt;
    stored.lifecycle.lastError = null;
    return true;
  } catch (error) {
    stored.lifecycle.lastError = worktimeSafeError(error);
    return false;
  }
}
