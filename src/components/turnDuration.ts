import { getLocale, translate, type Locale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

/** Humanized run length, at most two units deep, mirroring the codex TUI's
    "Worked for …" line. uk uses с/хв/год with spaces («12 хв 30 с»), en the
    compact "12m 30s". Sub-second and negative inputs clamp to "0 с"/"0s". */
export function humanizeDuration(seconds: number, locale: Locale = getLocale()): string {
  const total = Math.max(0, Math.round(seconds));
  const units = locale === "uk"
    ? { h: " год", m: " хв", s: " с", sep: " " }
    : { h: "h", m: "m", s: "s", sep: " " };
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const seg: string[] = [];
  if (h > 0) {
    seg.push(`${h}${units.h}`);
    if (m > 0) seg.push(`${m}${units.m}`);
  } else if (m > 0) {
    seg.push(`${m}${units.m}`);
    if (s > 0) seg.push(`${s}${units.s}`);
  } else {
    seg.push(`${s}${units.s}`);
  }
  return seg.join(units.sep);
}

/** Ticking-clock rendering for the live bottom timer: «4:32», «1:04:09».
    Locale-neutral digits, so the same string serves en and uk next to their
    own «працює…»/"working…" labels. Negative inputs clamp to «0:00». */
export function clockDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Seconds spanned by a completed turn, or null when it is still running or the
    boundary is unavailable. */
export function turnDurationSeconds(file: Pick<FileEntry, "lastTurn">): number | null {
  const turn = file.lastTurn;
  if (!turn || turn.endedAt === null) return null;
  return Math.max(0, (turn.endedAt - turn.startedAt) / 1000);
}

/** Feed caption after a completed turn: «Працював 12 хв 30 с» / "Worked for 12m 30s".
    null while the turn runs (the card carries the live elapsed instead). */
export function workedCaption(file: Pick<FileEntry, "lastTurn">, locale: Locale = getLocale()): string | null {
  const seconds = turnDurationSeconds(file);
  if (seconds === null) return null;
  return translate(locale, "turn.worked", { d: humanizeDuration(seconds, locale) });
}

/** Recency-slot text plus optional tooltip for a card meta row. While the agent
    is live and the turn is open, the slot ticks the elapsed time («працює 4 хв»);
    otherwise callers fall back to their own "…ago" label and, for a finished
    turn, the run length is parked in the tooltip («останній прогін: 12 хв»). */
export function recencyTurnInfo(
  file: Pick<FileEntry, "lastTurn" | "activity">,
  now = Date.now(),
  locale: Locale = getLocale(),
): { running: string | null; idleTitle: string | null } {
  const turn = file.lastTurn;
  if (turn && turn.endedAt === null && file.activity === "live") {
    const elapsed = Math.max(0, (now - turn.startedAt) / 1000);
    return { running: translate(locale, "turn.running", { d: humanizeDuration(elapsed, locale) }), idleTitle: null };
  }
  const seconds = turnDurationSeconds(file);
  if (seconds !== null) {
    return { running: null, idleTitle: translate(locale, "turn.lastRun", { d: humanizeDuration(seconds, locale) }) };
  }
  return { running: null, idleTitle: null };
}
