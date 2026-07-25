import type { WindowKey } from "./burndown";
import type { EngineLimits } from "./types";

/** Which horizon a quota window carries (issue #606).
 *
 * A provider reports each rate-limit window with its own length: Codex sends
 * `windowDurationMins` on the app-server snapshot and `window_minutes` in the
 * transcript event, and that length — never the `primary`/`secondary` slot the
 * window arrived in — is what says whether a number is a 5-hour or a weekly
 * figure. Codex plans that have no 5-hour limit send their weekly window as
 * `primary` and leave `secondary` null, so a slot-based mapping files weekly
 * data under the 5h label and leaves the weekly tab empty. Everything here is
 * pure so the ingestion (server) and the labels (browser) agree on one rule. */

/** The classic Codex/Claude short window: 5 hours. */
export const SESSION_WINDOW_MINUTES = 5 * 60;
/** The classic long window: 7 days. */
export const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
/** Longest window still shown on the short ("session") tab. Anything above a
    day is a long-horizon window and belongs on the weekly tab. */
export const SESSION_MAX_WINDOW_MINUTES = 24 * 60;

/** The horizon a declared window length belongs to, or null when the provider
    did not declare one (then only the slot order is left to go on). */
export function windowKeyForMinutes(minutes: number | null | undefined): WindowKey | null {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return null;
  return minutes <= SESSION_MAX_WINDOW_MINUTES ? "session" : "weekly";
}

/** How far a declared length may sit from a canonical horizon and still mean
    it. Providers round: a week is reported as both 10080 and 10081 minutes.
    One percent is far below the distance between any two real horizons
    (a day is 8640 minutes from a week), so no distinct window is absorbed. */
const CANONICAL_TOLERANCE = 0.01;

/** Snap a declared length onto the canonical horizon it is reporting, or null
    when it is a horizon of its own (a day, a month) and should keep its length. */
export function canonicalWindowMinutes(minutes: number | null | undefined): number | null {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return null;
  for (const canonical of [SESSION_WINDOW_MINUTES, WEEKLY_WINDOW_MINUTES]) {
    if (Math.abs(minutes - canonical) <= canonical * CANONICAL_TOLERANCE) return canonical;
  }
  return null;
}

export interface DeclaredWindow {
  windowMinutes?: number | null;
  resetsAt?: number | null;
}

/** Seconds a 5-hour window may still have on its clock, with room for
    provider/clock skew. Beyond this the value cannot belong to a 5h window. */
const SESSION_HORIZON_GRACE_S = 30 * 60;

/** True when a window's reset lies further out than a 5-hour window can ever
    reach, so it cannot be a session window whatever slot it arrived in. Only
    meaningful for a window that declared no length of its own, and only when
    both the capture moment and the reset moment are known. */
function exceedsSessionHorizon(window: DeclaredWindow, capturedAt: number | null): boolean {
  if (window.windowMinutes != null || capturedAt === null || window.resetsAt == null) return false;
  return window.resetsAt - capturedAt > SESSION_WINDOW_MINUTES * 60 + SESSION_HORIZON_GRACE_S;
}

/** File a provider's two rate-limit slots onto the horizons their data carries.
 *
 * A window that declares its length claims that horizon. One that declares none
 * keeps its own conventional slot (primary = session, secondary = weekly) when
 * that slot is still free, and is dropped when it is not: with no declared
 * length and its conventional slot already claimed by a window that named the
 * same horizon, there is no evidence left for filing it anywhere, and guessing
 * is what put weekly numbers under the 5h label in the first place.
 *
 * `capturedAt` (Unix seconds, when known) adds the last piece of evidence for a
 * window that declared no length: a reset further out than a 5-hour window can
 * reach belongs to the weekly horizon. */
export function routeWindowsByHorizon<T extends DeclaredWindow>(
  primary: T | null | undefined,
  secondary: T | null | undefined,
  capturedAt: number | null = null,
): { session: T | null; weekly: T | null } {
  const routed: { session: T | null; weekly: T | null } = { session: null, weekly: null };
  const undeclared: { slot: WindowKey; window: T }[] = [];
  for (const [slot, window] of [["session", primary], ["weekly", secondary]] as const) {
    if (!window) continue;
    const key = windowKeyForMinutes(window.windowMinutes);
    if (key && !routed[key]) routed[key] = window;
    else undeclared.push({ slot, window });
  }
  for (const { slot, window } of undeclared) {
    const key: WindowKey = slot === "session" && exceedsSessionHorizon(window, capturedAt) ? "weekly" : slot;
    if (!routed[key]) routed[key] = window;
  }
  return routed;
}

/** Repair a snapshot cached before the horizon fix: a Codex weekly window
    stored under `session` with no declared length, whose reset is further out
    than a 5-hour window can ever reach. Rate-limited (degraded) accounts serve
    that cached snapshot for as long as the provider keeps refusing, so without
    this the wrong "5h" label survives the fix. */
export function relabelCachedWindows(limits: EngineLimits | null): EngineLimits | null {
  if (!limits?.session || limits.weekly) return limits;
  if (!exceedsSessionHorizon(limits.session, limits.capturedAt)) return limits;
  return { ...limits, session: null, weekly: limits.session };
}
