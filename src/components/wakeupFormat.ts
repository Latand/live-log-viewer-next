import type { Locale, TFunction } from "@/lib/i18n";

/* Shared time formatting for the wakeup card (feed) and the wakeup chip
   (board). Both show an absolute local fire time and a live relative
   countdown, so they resolve the same way through one helper. */

/** Absolute local wall clock of a fire time, hour:minute (no seconds). */
export function fmtWakeClock(fireAt: number, locale: Locale): string {
  const bcp47 = locale === "uk" ? "uk-UA" : "en-US";
  return new Date(fireAt).toLocaleTimeString(bcp47, { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** A compact magnitude of a duration ("12 хв", "3 h", "45s") — no direction.
    Rounds to the largest whole unit; clamps sub-second to "0s" so a ticking
    countdown never shows a negative or empty value. */
export function fmtWakeMagnitude(ms: number, t: TFunction): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t("wakeup.relSec", { count: s });
  const m = Math.round(s / 60);
  if (m < 60) return t("wakeup.relMin", { count: m });
  const h = Math.round(m / 60);
  if (h < 24) return t("wakeup.relHour", { count: h });
  return t("wakeup.relDay", { count: Math.round(h / 24) });
}

/** Directional relative phrase: "in 12 min" / "через 12 хв" while pending,
    "12 min ago" / "12 хв тому" once fired. */
export function fmtWakeRelative(fireAt: number, now: number, t: TFunction): string {
  const delta = fireAt - now;
  const rel = fmtWakeMagnitude(Math.abs(delta), t);
  return delta >= 0 ? t("wakeup.inRel", { rel }) : t("wakeup.agoRel", { rel });
}
