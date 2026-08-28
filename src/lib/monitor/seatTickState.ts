import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";

import {
  emptySeatTickState,
  SEAT_TICK_WAKE_REASON_KINDS,
  type SeatTickOutstandingWake,
  type SeatTickProjectState,
  type SeatTickWakeCommit,
  type SeatTickWakeReasonKind,
} from "./types";

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

/**
 * Version 2 changes one field's meaning: `eventsThrough` may be null, and null
 * means "the tick has never established where the journal stood", which version
 * 1 could not say. It wrote a literal zero for that, and a zero cursor reads the
 * journal from the beginning — the replay in #1262. A version 1 row that has
 * never had a delivered wake is therefore migrated to null on read, so its next
 * check seals it at the head; a row that HAS been woken keeps its cursor exactly
 * where it is, because that number is a fact about what the seat was told.
 */
const SEAT_TICK_STATE_VERSION = 2;

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

/** The commit a landing will apply. A row missing it is a row from before the
    plan was recorded, and a wake whose landing cannot be credited correctly is
    better forgotten than credited wrongly — so the whole record drops. */
function normalizeWakeCommit(value: unknown): SeatTickWakeCommit | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.fingerprint !== "string" || !raw.fingerprint) return null;
  if (typeof raw.eventsThrough !== "number" || !Number.isInteger(raw.eventsThrough) || raw.eventsThrough < 0) return null;
  return {
    proposal: raw.proposal === true,
    reasons: (Array.isArray(raw.reasons) ? raw.reasons : [])
      .filter((entry): entry is SeatTickWakeReasonKind => SEAT_TICK_WAKE_REASON_KINDS.includes(entry as SeatTickWakeReasonKind)),
    fingerprint: raw.fingerprint.slice(0, 200),
    eventsThrough: raw.eventsThrough,
  };
}

/**
 * The cursor a row starts the next check from.
 *
 * Absent is null — nothing has been established yet. The one migration is the
 * version 1 zero on a row with no delivered wake: that row was never told
 * anything, so its zero is the uninitialised cursor written the only way the old
 * shape could write it, and reading it as a real cursor is what replayed the
 * whole journal. A zero beside a wake stamp is left alone: the seat WAS woken,
 * the wake read no events past zero, and moving that cursor forward would skip
 * events nobody has been told about.
 */
function eventsThrough(raw: Record<string, unknown>, legacy: boolean): number | null {
  const value = raw.eventsThrough;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  if (legacy && value === 0 && !isoOrNull(raw.lastWakeAt)) return null;
  return value;
}

function normalizeOutstandingWake(value: unknown): SeatTickOutstandingWake | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const clientMessageId = typeof raw.clientMessageId === "string" ? raw.clientMessageId.slice(0, 300) : "";
  const conversationId = typeof raw.conversationId === "string" ? raw.conversationId.slice(0, 200) : "";
  const seatEpoch = raw.seatEpoch;
  const commit = normalizeWakeCommit(raw.commit);
  if (!clientMessageId || !conversationId || !commit || typeof seatEpoch !== "number" || !Number.isSafeInteger(seatEpoch)) return null;
  return {
    clientMessageId,
    conversationId,
    seatEpoch,
    operationId: typeof raw.operationId === "string" && raw.operationId ? raw.operationId.slice(0, 200) : null,
    commit,
  };
}

function normalizeRow(value: unknown, legacy: boolean): SeatTickProjectState {
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
    eventsThrough: eventsThrough(raw, legacy),
    outstandingWake: normalizeOutstandingWake(raw.outstandingWake),
  };
}

function readFile(filePath: string): SeatTickStateFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { version: SEAT_TICK_STATE_VERSION, projects: {} };
    const file = parsed as Partial<SeatTickStateFile>;
    const legacy = !(typeof file.version === "number" && file.version >= SEAT_TICK_STATE_VERSION);
    const projects = (file.projects ?? {}) as Record<string, unknown>;
    return {
      version: SEAT_TICK_STATE_VERSION,
      projects: Object.fromEntries(Object.entries(projects).map(([project, row]) => [project, normalizeRow(row, legacy)])),
    };
  } catch {
    return { version: SEAT_TICK_STATE_VERSION, projects: {} };
  }
}

/**
 * The row a check should start from.
 *
 * A seat epoch that moved means a rotation happened: the successor inherits the
 * clock but none of the predecessor's JUDGEMENT, so its stall memory, its
 * retry-guard counters and the reasons it was last woken for start empty. That
 * is the whole handover — the incoming seat is ticking without anyone
 * configuring it, and it is not carrying a record of wakes it never received.
 *
 * Three things are not the seat's, and survive:
 *
 * - The event cursor, which is a fact about the journal: re-relaying a
 *   predecessor's whole history to a fresh successor would bury the events that
 *   arrived after it sat down.
 * - The wake and proposal stamps, which are the project's bounds. A rotation
 *   that cleared them would let a successor be woken minutes after its
 *   predecessor was — a bypass of the hourly bound, and one an operator
 *   rotating a seat by hand could trip repeatedly.
 * - The outstanding wake, which is a payload the runtime is still holding for
 *   the PREDECESSOR. It survives so the successor's first check is what takes
 *   it back; dropping it here would leave it addressed to a seat nothing is
 *   watching any more.
 */
export function seatTickStateForEpoch(row: SeatTickProjectState, seatEpoch: number | null): SeatTickProjectState {
  if (row.seatEpoch === seatEpoch) return row;
  return {
    ...emptySeatTickState(),
    seatEpoch,
    eventsThrough: row.eventsThrough,
    lastWakeAt: row.lastWakeAt,
    lastProposalAt: row.lastProposalAt,
    outstandingWake: row.outstandingWake,
  };
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
