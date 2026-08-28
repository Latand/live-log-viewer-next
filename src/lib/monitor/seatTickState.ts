import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";

import { emptySeatTickState, SEAT_TICK_WAKE_REASON_KINDS, type SeatTickProjectState, type SeatTickWakeReasonKind } from "./types";

/**
 * The seat tick's durable row per project (issue #1245).
 *
 * A timer that happened to be running is never the source of truth. Everything
 * that decides what a check does — when the last check and the last DELIVERED
 * wake were, what was stalled at the previous check, which lifecycle events the
 * seat has actually been told about, whether the last wake changed anything —
 * lives here, so a Viewer restart, a deploy or a rotation resumes from the
 * stamps rather than from a process's memory.
 */

const SEAT_TICK_STATE_VERSION = 1;

interface SeatTickStateFile {
  version: number;
  projects: Record<string, SeatTickProjectState>;
}

export function seatTickStatePath(): string {
  return process.env.LLV_SEAT_TICK_STATE_FILE?.trim() || statePath("seat-tick.json");
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function normalizeRow(value: unknown): SeatTickProjectState {
  const empty = emptySeatTickState();
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
  const raw = value as Record<string, unknown>;
  const wakesWithoutChange: Partial<Record<SeatTickWakeReasonKind, number>> = {};
  const counters = (raw.wakesWithoutChange ?? {}) as Record<string, unknown>;
  for (const kind of SEAT_TICK_WAKE_REASON_KINDS) {
    const count = counters[kind];
    if (typeof count === "number" && Number.isInteger(count) && count >= 0) wakesWithoutChange[kind] = count;
  }
  return {
    seatEpoch: typeof raw.seatEpoch === "number" && Number.isSafeInteger(raw.seatEpoch) ? raw.seatEpoch : null,
    lastCheckAt: isoOrNull(raw.lastCheckAt),
    lastWakeAt: isoOrNull(raw.lastWakeAt),
    lastWakeReasons: (Array.isArray(raw.lastWakeReasons) ? raw.lastWakeReasons : [])
      .filter((entry): entry is SeatTickWakeReasonKind => SEAT_TICK_WAKE_REASON_KINDS.includes(entry as SeatTickWakeReasonKind)),
    wakesWithoutChange,
    quietSince: isoOrNull(raw.quietSince),
    idleSince: isoOrNull(raw.idleSince),
    lastProposalAt: isoOrNull(raw.lastProposalAt),
    stalledSeen: (Array.isArray(raw.stalledSeen) ? raw.stalledSeen : [])
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= 100)
      .slice(0, 200),
    lastWakeFingerprint: typeof raw.lastWakeFingerprint === "string" ? raw.lastWakeFingerprint.slice(0, 200) : null,
    eventsThrough: typeof raw.eventsThrough === "number" && Number.isInteger(raw.eventsThrough) && raw.eventsThrough >= 0 ? raw.eventsThrough : 0,
  };
}

function readFile(filePath: string): SeatTickStateFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { version: SEAT_TICK_STATE_VERSION, projects: {} };
    const projects = ((parsed as SeatTickStateFile).projects ?? {}) as Record<string, unknown>;
    return {
      version: SEAT_TICK_STATE_VERSION,
      projects: Object.fromEntries(Object.entries(projects).map(([project, row]) => [project, normalizeRow(row)])),
    };
  } catch {
    return { version: SEAT_TICK_STATE_VERSION, projects: {} };
  }
}

/**
 * The row a check should start from.
 *
 * A seat epoch that moved means a rotation happened: the successor inherits the
 * clock but none of the predecessor's bookkeeping, so its stall memory, its
 * retry-guard counters and its wake stamps start empty. That is the whole
 * handover — the incoming seat is ticking without anyone configuring it, and it
 * is not carrying a record of wakes it never received.
 *
 * The event cursor is the one thing that survives, because it is a fact about
 * the journal rather than about the seat: re-relaying a predecessor's whole
 * history to a fresh successor would bury the events that arrived after it sat
 * down.
 */
export function seatTickStateForEpoch(row: SeatTickProjectState, seatEpoch: number | null): SeatTickProjectState {
  if (row.seatEpoch === seatEpoch) return row;
  return { ...emptySeatTickState(), seatEpoch, eventsThrough: row.eventsThrough };
}

export function readSeatTickState(project: string, filePath = seatTickStatePath()): SeatTickProjectState {
  return readFile(filePath).projects[project] ?? emptySeatTickState();
}

export function readSeatTickStateFile(filePath = seatTickStatePath()): Record<string, SeatTickProjectState> {
  return readFile(filePath).projects;
}

/** Serialized read-modify-write of one project's row; other projects' rows are
    re-read inside the transaction so two projects' checks cannot clobber. */
export function writeSeatTickState(project: string, row: SeatTickProjectState, filePath = seatTickStatePath()): void {
  withFileTransactionSync(filePath, "seat tick state is busy", () => {
    const file = readFile(filePath);
    writeJsonDurably(filePath, { version: SEAT_TICK_STATE_VERSION, projects: { ...file.projects, [project]: row } });
  });
}
