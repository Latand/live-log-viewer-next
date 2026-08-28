import path from "node:path";

import { statePath } from "@/lib/configDir";
import { appendJournalRecord, readJournalRecords } from "@/lib/monitor/journalStore";

import { SEAT_TICK_WAKE_REASON_KINDS, type SeatTickWakeReasonKind } from "./types";

/**
 * The seat tick's audit journal (issue #1245) — one sanitized line per check.
 *
 * It exists to answer the failure mode nothing on disk could answer before:
 * absence. A seat with no tick left no artifact, so a successor could not tell
 * it was missing one, and the operator could not tell how often the predecessor
 * had been ticking — the successor that finally found one guessed both numbers
 * from the predecessor's transcript. Here every check leaves a line, so "no
 * line" means "no check", and the cadence is a readable fact.
 *
 * It rides {@link appendJournalRecord} rather than a second implementation, so
 * the serialization against retention and the mode bits stay in one place.
 */

/** Checks retained before the oldest are dropped. At a five-minute cadence this
    is a bit over a day of history per project, which is the window anything
    diagnosing a tick actually looks at. */
export const SEAT_TICK_RUN_HISTORY = 500;
const DETAIL_LIMIT = 400;

export type SeatTickVerdictKind = "quiet" | "wake" | "proactive" | "no-seat" | "skipped";

const VERDICTS: SeatTickVerdictKind[] = ["quiet", "wake", "proactive", "no-seat", "skipped"];

export interface SeatTickRunRecord {
  schemaVersion: 1;
  at: string;
  project: string;
  seatEpoch: number | null;
  verdict: SeatTickVerdictKind;
  reasons: SeatTickWakeReasonKind[];
  /** Items carried in the wake, and items that did not fit the per-wake bound. */
  items: number;
  deferred: number;
  /** Lifecycle journal seq this check consumed through. */
  digestThrough: number;
  delivery: { clientMessageId: string; outcome: string } | null;
  detail: string | null;
}

export function seatTickJournalPath(): string {
  return process.env.LLV_SEAT_TICK_AUDIT_FILE?.trim() || statePath(path.join("seat-tick", "runs.ndjson"));
}

function text(value: unknown, limit: number): string | null {
  return typeof value === "string" ? value.slice(0, limit) : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Accept only a record shaped like a check line, and keep only the fields the
 * journal is allowed to carry. A caller that tried to smuggle transcript text,
 * a path or an extra property through loses it here, at the boundary, rather
 * than on the honour system.
 */
export function sanitizeSeatTickRecord(value: unknown): SeatTickRunRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const project = text(raw.project, 200);
  const verdict = VERDICTS.find((candidate) => candidate === raw.verdict);
  if (raw.schemaVersion !== 1 || !project || !verdict) return null;

  const delivery = (raw.delivery ?? null) as Record<string, unknown> | null;
  const clientMessageId = delivery ? text(delivery.clientMessageId, 200) : null;
  const outcome = delivery ? text(delivery.outcome, 60) : null;

  return {
    schemaVersion: 1,
    at: text(raw.at, 40) ?? "",
    project,
    seatEpoch: typeof raw.seatEpoch === "number" && Number.isSafeInteger(raw.seatEpoch) ? raw.seatEpoch : null,
    verdict,
    reasons: (Array.isArray(raw.reasons) ? raw.reasons : [])
      .filter((entry): entry is SeatTickWakeReasonKind => SEAT_TICK_WAKE_REASON_KINDS.includes(entry as SeatTickWakeReasonKind)),
    items: count(raw.items),
    deferred: count(raw.deferred),
    digestThrough: count(raw.digestThrough),
    delivery: clientMessageId && outcome ? { clientMessageId, outcome } : null,
    detail: text(raw.detail, DETAIL_LIMIT),
  };
}

export function appendSeatTickRecord(record: SeatTickRunRecord, filePath = seatTickJournalPath()): void {
  appendJournalRecord(record, { filePath, retention: SEAT_TICK_RUN_HISTORY, busyMessage: "the seat tick journal is busy" });
}

/** The newest `limit` checks, oldest first. */
export function readSeatTickRecords(limit: number, filePath = seatTickJournalPath()): SeatTickRunRecord[] {
  return readJournalRecords(limit, { filePath, sanitize: sanitizeSeatTickRecord });
}
