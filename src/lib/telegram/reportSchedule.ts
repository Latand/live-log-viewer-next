/**
 * Schedule and window arithmetic for Telegram Daily Reports (issue #1086).
 *
 * Pure, client-safe, and stated in the OPERATOR's day: the schedule time is
 * `HH:MM` in {@link REPORT_TIME_ZONE}, so the same 10:00 fires at the same
 * local hour across DST. Instants stay ISO-UTC everywhere else.
 *
 * Two rules carry the whole feature:
 *
 *  - a scheduled run fires when today's slot has passed and today's day key is
 *    not the one already run. That single condition IS the restart catch-up
 *    (a Viewer that was down at 10:00 finds the slot passed and the day
 *    unstamped) and the per-day idempotency (a second tick finds the day
 *    stamped), so neither needs its own mechanism;
 *  - the window runs from the last SUCCESSFUL report to now, capped at 72 h,
 *    and 24 h on a first run. A failed run never advances the cursor, so the
 *    next run's window still covers the day it missed.
 */

import {
  REPORT_TIME_ZONE,
  type TelegramReportSettings,
} from "./reportContracts";

/** Only the three fields a schedule is made of — so both the stored settings
    and the payload's satisfy it. */
export type ReportScheduleSettings = Pick<TelegramReportSettings, "enabled" | "time" | "days">;

export const REPORT_WINDOW_CAP_MS = 72 * 60 * 60 * 1000;
export const REPORT_FIRST_WINDOW_MS = 24 * 60 * 60 * 1000;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function parts(instant: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number } {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(timeZone, formatter);
  }
  const found: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(instant))) found[part.type] = part.value;
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    year: Number(found.year),
    month: Number(found.month),
    day: Number(found.day),
    /* Intl renders midnight as hour 24 in some ICU versions. */
    hour: Number(found.hour) % 24,
    minute: Number(found.minute),
    second: Number(found.second),
    weekday: Math.max(0, weekdays.indexOf(found.weekday ?? "")),
  };
}

/** `YYYY-MM-DD` of an instant in the operator's zone — the per-day identity a
    fired schedule is stamped with. */
export function localDayKey(instant: number, timeZone: string = REPORT_TIME_ZONE): string {
  const local = parts(instant, timeZone);
  return `${String(local.year).padStart(4, "0")}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
}

/** 0 = Sunday … 6 = Saturday, in the operator's zone. */
export function localWeekday(instant: number, timeZone: string = REPORT_TIME_ZONE): number {
  return parts(instant, timeZone).weekday;
}

function zoneOffsetMs(instant: number, timeZone: string): number {
  const local = parts(instant, timeZone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant at which `HH:MM` occurs on `dayKey` in the operator's zone.
 *
 * Offsets are resolved from a first guess and then re-resolved at the guessed
 * instant, which is what makes the two DST edges land correctly: a spring-
 * forward slot that does not exist locally resolves to the instant just after
 * the jump, and an autumn-repeat slot resolves to its first occurrence.
 */
export function slotInstant(dayKey: string, time: string, timeZone: string = REPORT_TIME_ZONE): number {
  const [hour, minute] = time.split(":").map(Number);
  const [year, month, day] = dayKey.split("-").map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const first = naive - zoneOffsetMs(naive, timeZone);
  const second = naive - zoneOffsetMs(first, timeZone);
  return second;
}

function allowedDay(instant: number, settings: ReportScheduleSettings, timeZone: string): boolean {
  if (settings.days === "daily") return true;
  const weekday = localWeekday(instant, timeZone);
  return weekday >= 1 && weekday <= 5;
}

export interface ReportScheduleCursor {
  /** End of the last window a run reported successfully, or `null`. */
  lastSuccessfulWindowEndAt: string | null;
  /** Day key of the last SCHEDULED run that fired (manual runs do not stamp
      it — a Run now must not swallow the day's scheduled report). */
  lastScheduledDay: string | null;
}

/** Whether the scheduled run for the operator's current day is owed. */
export function scheduledRunDue(input: {
  now: number;
  settings: ReportScheduleSettings;
  cursor: ReportScheduleCursor;
  timeZone?: string;
}): boolean {
  const timeZone = input.timeZone ?? REPORT_TIME_ZONE;
  if (!input.settings.enabled) return false;
  if (!allowedDay(input.now, input.settings, timeZone)) return false;
  const today = localDayKey(input.now, timeZone);
  if (input.cursor.lastScheduledDay === today) return false;
  return input.now >= slotInstant(today, input.settings.time, timeZone);
}

/** The next instant a scheduled run will fire, or `null` when disabled. */
export function nextScheduledRunAt(input: {
  now: number;
  settings: ReportScheduleSettings;
  cursor: ReportScheduleCursor;
  timeZone?: string;
}): number | null {
  const timeZone = input.timeZone ?? REPORT_TIME_ZONE;
  if (!input.settings.enabled) return null;
  if (scheduledRunDue(input)) return input.now;
  /* Walk day keys from local noon: noon ± an hour stays inside its own local
     day, so a 23 h or 25 h DST day cannot make the walk repeat or skip one. */
  const noon = slotInstant(localDayKey(input.now, timeZone), "12:00", timeZone);
  for (let ahead = 0; ahead <= 8; ahead += 1) {
    const dayKey = localDayKey(noon + ahead * DAY_MS, timeZone);
    const slot = slotInstant(dayKey, input.settings.time, timeZone);
    if (!allowedDay(slot, input.settings, timeZone)) continue;
    if (slot <= input.now || input.cursor.lastScheduledDay === dayKey) continue;
    return slot;
  }
  return null;
}

export interface ReportWindow {
  startAt: string;
  endAt: string;
}

/**
 * The window a run about to start must cover: from the last successful report
 * to now, never longer than 72 h, and 24 h when there is no previous report.
 * A cursor in the future (a clock step back) collapses to the first-run
 * window rather than an inverted range.
 */
export function reportWindowFor(now: number, cursor: ReportScheduleCursor): ReportWindow {
  const previous = cursor.lastSuccessfulWindowEndAt ? Date.parse(cursor.lastSuccessfulWindowEndAt) : Number.NaN;
  const fallback = now - REPORT_FIRST_WINDOW_MS;
  const start = Number.isFinite(previous) && previous < now
    ? Math.max(previous, now - REPORT_WINDOW_CAP_MS)
    : fallback;
  return { startAt: new Date(start).toISOString(), endAt: new Date(now).toISOString() };
}

/** Human-readable window length, for the history row. */
export function windowHours(window: ReportWindow): number {
  const span = Date.parse(window.endAt) - Date.parse(window.startAt);
  return Math.max(1, Math.round(span / (60 * MINUTE_MS)));
}
