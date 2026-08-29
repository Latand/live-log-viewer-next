import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";

import { redactBounded } from "./redact";

/**
 * Per-project seat tick settings (issue #1275).
 *
 * The tick arms a loop the seat could not reach. It was forbidden from
 * scheduling itself — correctly, because a session-scheduled monitor dies with
 * its session — and there was no lever anywhere to quiet, slow or stop the loop
 * the Viewer armed instead. A seat that had correctly concluded "there is
 * nothing here for me and the reason will still hold next hour" (see #1274,
 * where an undeletable draft woke a seat hourly for fourteen hours) had no way
 * to say so, and only the operator could intervene by hand.
 *
 * Three properties this file exists to keep:
 *
 * - **Nothing has to be configured for the tick to work.** A project with no
 *   row here reads {@link defaultSeatTickSettings} and behaves exactly as it
 *   did before this existed: enabled, on the default wake interval. "Works out
 *   of the box" was never a reason to deny anyone the controls.
 * - **The controls are real.** Off is off, for as long as the caller says —
 *   indefinitely, if that is the decision. An expiry is offered because it is
 *   convenient for whoever reads the board later, never as a leash that turns
 *   the tick back on under a seat that did not ask for it.
 * - **Every change is attributed.** Who changed which project's tick, in their
 *   own words, is recorded on the row, shown on the board and journaled. A
 *   change to another project's tick is allowed and is not hidden: attribution
 *   is the answer here, not a prohibition.
 */

export const SEAT_TICK_SETTINGS_SCHEMA_VERSION = 1;

/** Bound on the stored reason. Long enough for a real sentence, short enough
    that a board card stays a card. */
const REASON_LIMIT = 500;

/**
 * Ceiling on an explicit wake interval, in minutes: one year.
 *
 * It is not a policy limit on how quiet a project may be — `enabled: false` is
 * the indefinite off switch and nothing bounds it. It is what keeps a stored
 * number a number, so a typo cannot write an interval no clock can express.
 */
export const SEAT_TICK_MAX_WAKE_INTERVAL_MINUTES = 365 * 24 * 60;

/** Who changed a project's tick. Server-derived; never a caller's claim. */
export interface SeatTickSettingsActor {
  /** `manager` is a designated seat, `gateway` the operator's own session,
      `agent` any other identified session, `unidentified` a caller no evidence
      named. */
  kind: "manager" | "agent" | "gateway" | "unidentified";
  conversationId: string | null;
  /** The actor's own canonical project, when one is known — so a change made
      to another project's tick reads as exactly that. */
  project: string | null;
  seatEpoch: number | null;
}

export interface SeatTickSettings {
  project: string;
  /** Whether the Viewer ticks this project at all. */
  enabled: boolean;
  /** Minutes between two wakes for this project; null keeps the default. */
  wakeIntervalMinutes: number | null;
  /** Why, in the caller's own words. */
  reason: string | null;
  /** When the setting lapses back to the default. Null means it stands until
      someone changes it. */
  until: string | null;
  updatedAt: string | null;
  setBy: SeatTickSettingsActor | null;
}

/** The settings as one check should read them: the record with its expiry
    already applied. */
export interface EffectiveSeatTickSettings {
  enabled: boolean;
  wakeIntervalMs: number;
  reason: string | null;
  until: string | null;
  /** When the record this reading came from was written; null when nothing
      ever wrote one. It is what the board card is stamped with, so the card's
      text changes when the SETTING changes rather than at every check. */
  updatedAt: string | null;
  /** True while nothing departs from the defaults — nothing was ever set, or
      what was set has lapsed. */
  isDefault: boolean;
  /** Whether anyone has ever written this project's row. A project that never
      has costs the board nothing: there is no card to raise and none to
      resolve, so a check for it does exactly what it did before #1275. */
  configured: boolean;
  /** True when an expiry passed and this reading is the default again; the
      controller persists the reversion when it sees it. */
  lapsed: boolean;
  setBy: SeatTickSettingsActor | null;
}

export interface SeatTickSettingsChange {
  enabled?: boolean;
  /** `null` restores the default interval. */
  wakeIntervalMinutes?: number | null;
  reason?: string | null;
  /** ISO instant, or `null` for "until someone changes it". */
  until?: string | null;
}

export function seatTickSettingsPath(): string {
  return process.env.LLV_SEAT_TICK_SETTINGS_FILE?.trim() || statePath("seat-tick-settings.json");
}

export function defaultSeatTickSettings(project: string): SeatTickSettings {
  return { project, enabled: true, wakeIntervalMinutes: null, reason: null, until: null, updatedAt: null, setBy: null };
}

/** Whether a record says anything the default does not. */
export function seatTickSettingsAreDefault(settings: SeatTickSettings): boolean {
  return settings.enabled && settings.wakeIntervalMinutes === null;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function normalizeActor(value: unknown): SeatTickSettingsActor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  if (kind !== "manager" && kind !== "agent" && kind !== "gateway" && kind !== "unidentified") return null;
  return {
    kind,
    conversationId: typeof raw.conversationId === "string" && raw.conversationId ? raw.conversationId.slice(0, 200) : null,
    project: typeof raw.project === "string" && raw.project ? raw.project.slice(0, 200) : null,
    seatEpoch: typeof raw.seatEpoch === "number" && Number.isSafeInteger(raw.seatEpoch) ? raw.seatEpoch : null,
  };
}

function normalizeInterval(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(SEAT_TICK_MAX_WAKE_INTERVAL_MINUTES, value);
}

function normalizeRow(project: string, value: unknown): SeatTickSettings {
  const empty = defaultSeatTickSettings(project);
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
  const raw = value as Record<string, unknown>;
  return {
    project,
    enabled: raw.enabled !== false,
    wakeIntervalMinutes: normalizeInterval(raw.wakeIntervalMinutes),
    reason: typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.slice(0, REASON_LIMIT) : null,
    until: isoOrNull(raw.until),
    updatedAt: isoOrNull(raw.updatedAt),
    setBy: normalizeActor(raw.setBy),
  };
}

interface SeatTickSettingsFile {
  version: number;
  projects: Record<string, SeatTickSettings>;
}

function readFile(filePath: string): SeatTickSettingsFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { version: SEAT_TICK_SETTINGS_SCHEMA_VERSION, projects: {} };
    }
    const projects = ((parsed as Partial<SeatTickSettingsFile>).projects ?? {}) as Record<string, unknown>;
    return {
      version: SEAT_TICK_SETTINGS_SCHEMA_VERSION,
      projects: Object.fromEntries(Object.entries(projects).map(([project, row]) => [project, normalizeRow(project, row)])),
    };
  } catch {
    /* An unreadable settings file reads as "nothing is configured", which is
       the tick as it shipped. Failing the check instead would let one corrupt
       row stop every project's seat from ever being woken again. */
    return { version: SEAT_TICK_SETTINGS_SCHEMA_VERSION, projects: {} };
  }
}

export function readSeatTickSettings(project: string, filePath = seatTickSettingsPath()): SeatTickSettings {
  return readFile(filePath).projects[project] ?? defaultSeatTickSettings(project);
}

export function readSeatTickSettingsFile(filePath = seatTickSettingsPath()): Record<string, SeatTickSettings> {
  return readFile(filePath).projects;
}

/** Serialized read-modify-write of one project's row; every other project's row
    is re-read inside the transaction, so two writers cannot clobber. */
export function writeSeatTickSettings(project: string, settings: SeatTickSettings, filePath = seatTickSettingsPath()): void {
  withFileTransactionSync(filePath, "seat tick settings are busy", () => {
    const file = readFile(filePath);
    writeJsonDurably(filePath, {
      version: SEAT_TICK_SETTINGS_SCHEMA_VERSION,
      projects: { ...file.projects, [project]: { ...settings, project } },
    });
  });
}

/**
 * The settings one check decides on: the record with its own expiry applied.
 *
 * The expiry is evaluated at read time rather than by a timer, so a Viewer that
 * was not running when it passed still reads the default afterwards, and a
 * setting with no expiry is simply one this function never rewrites.
 */
export function effectiveSeatTickSettings(
  settings: SeatTickSettings,
  nowMs: number,
  defaultWakeIntervalMs: number,
): EffectiveSeatTickSettings {
  const expiry = settings.until ? Date.parse(settings.until) : Number.NaN;
  const lapsed = Number.isFinite(expiry) && expiry <= nowMs && !seatTickSettingsAreDefault(settings);
  const configured = settings.updatedAt !== null;
  if (lapsed || seatTickSettingsAreDefault(settings)) {
    return {
      enabled: true,
      wakeIntervalMs: defaultWakeIntervalMs,
      reason: null,
      until: null,
      updatedAt: settings.updatedAt,
      isDefault: true,
      configured,
      lapsed,
      setBy: lapsed ? settings.setBy : null,
    };
  }
  return {
    enabled: settings.enabled,
    wakeIntervalMs: settings.wakeIntervalMinutes === null
      ? defaultWakeIntervalMs
      : Math.round(settings.wakeIntervalMinutes * 60_000),
    reason: settings.reason,
    until: settings.until,
    updatedAt: settings.updatedAt,
    isDefault: false,
    configured,
    lapsed: false,
    setBy: settings.setBy,
  };
}

export type SeatTickSettingsChangeResult =
  | { ok: true; settings: SeatTickSettings }
  | { ok: false; error: string };

/**
 * Apply one change to a project's settings. Pure, so every refusal is testable
 * without a file.
 *
 * The one thing a change must carry is a REASON whenever it departs from the
 * default. That is not a limit on what may be decided — anything may be
 * decided, including off for ever — it is what keeps a deliberately quiet tick
 * distinguishable from a broken one. Restoring the default needs no reason:
 * the record it clears already said why the tick was quiet.
 */
export function applySeatTickSettingsChange(
  current: SeatTickSettings,
  change: SeatTickSettingsChange,
  context: { at: string; actor: SeatTickSettingsActor },
): SeatTickSettingsChangeResult {
  const touched = ["enabled", "wakeIntervalMinutes", "reason", "until"].filter((key) => Object.hasOwn(change, key));
  if (touched.length === 0) return { ok: false, error: "a tick settings change needs at least one field" };

  const enabled = Object.hasOwn(change, "enabled") ? change.enabled : current.enabled;
  if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };

  let wakeIntervalMinutes = current.wakeIntervalMinutes;
  if (Object.hasOwn(change, "wakeIntervalMinutes")) {
    const raw = change.wakeIntervalMinutes;
    if (raw === null) wakeIntervalMinutes = null;
    else if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      return { ok: false, error: "wakeIntervalMinutes must be a positive number of minutes, or null for the default" };
    } else if (raw > SEAT_TICK_MAX_WAKE_INTERVAL_MINUTES) {
      return { ok: false, error: `wakeIntervalMinutes must be at most ${SEAT_TICK_MAX_WAKE_INTERVAL_MINUTES}; disable the tick instead of setting a longer interval` };
    } else {
      wakeIntervalMinutes = raw;
    }
  }

  let until = current.until;
  if (Object.hasOwn(change, "until")) {
    const raw = change.until;
    if (raw === null) until = null;
    else if (typeof raw !== "string" || !Number.isFinite(Date.parse(raw))) {
      return { ok: false, error: "until must be an ISO instant, or null for a setting that stands until it is changed" };
    } else {
      until = new Date(Date.parse(raw)).toISOString();
    }
  }

  let reason = current.reason;
  if (Object.hasOwn(change, "reason")) {
    const raw = change.reason;
    if (raw === null) reason = null;
    else if (typeof raw !== "string") return { ok: false, error: "reason must be a string" };
    else reason = redactBounded(raw, REASON_LIMIT) || null;
  }

  const next: SeatTickSettings = {
    project: current.project,
    enabled,
    wakeIntervalMinutes,
    reason,
    until,
    updatedAt: context.at,
    setBy: context.actor,
  };
  if (!seatTickSettingsAreDefault(next) && !next.reason) {
    return { ok: false, error: "a reason is required when the tick is disabled or its wake interval is changed; a quiet tick with no recorded reason is indistinguishable from a broken one" };
  }
  /* Back at the defaults, the record keeps nothing of the setting it replaced:
     an interval, an expiry and a reason that describe a state nobody holds any
     more are the same disagreement between record and behaviour the lapsed
     write exists to close. Who restored it, and when, is on the row either
     way — `setBy` and `updatedAt` outlive the setting they ended. */
  if (seatTickSettingsAreDefault(next)) {
    return { ok: true, settings: { ...next, wakeIntervalMinutes: null, reason: null, until: null } };
  }
  return { ok: true, settings: next };
}
