import type { WindowKey } from "@/lib/burndown";
import { getLocale, translate, type TFunction, type Locale } from "@/lib/i18n";
import { canonicalWindowMinutes, SESSION_WINDOW_MINUTES, WEEKLY_WINDOW_MINUTES } from "@/lib/limitWindows";
import type { RateLimitState } from "@/lib/types";

/** BCP-47 tag for the two supported locales, used by every time formatter here. */
export const localeBcp47 = (locale: Locale = getLocale()): string => (locale === "uk" ? "uk-UA" : "en-US");

export function formatRateLimitTime(resetAt: number, locale: Locale): string {
  return new Date(resetAt * 1000).toLocaleTimeString(localeBcp47(locale), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function rateLimitText(t: TFunction, locale: Locale, rateLimit: Pick<RateLimitState, "resetAt">): string {
  return rateLimit.resetAt
    ? t("rateLimit.badgeUntil", { time: formatRateLimitTime(rateLimit.resetAt, locale) })
    : t("rateLimit.badge");
}

/** Relative "resets in …" phrasing for a quota window, coarsened as the horizon
    grows (minutes → hours → days). Shared by the limits footer and the per-account
    limits detail so both read the same. `resetsAt`/`now` are Unix seconds. */
export function formatResetEta(resetsAt: number, now: number): string {
  const locale = getLocale();
  const s = resetsAt - now;
  if (s <= 60) return translate(locale, "limits.now");
  if (s < 5400) return translate(locale, "limits.inMin", { n: Math.round(s / 60) });
  if (s < 129600) return translate(locale, "limits.inHour", { n: Math.round(s / 3600) });
  return translate(locale, "limits.inDay", { n: Math.round(s / 86400) });
}

/** Label for one quota window, taken from the horizon its data actually carries
    (issue #606): the provider's declared window length wins, and only a value
    that never declared one keeps its tab's nominal name. A provider that stops
    sending a 5-hour window therefore stops being labelled "5h". */
export function windowLabel(t: TFunction, key: WindowKey, windowMinutes: number | null | undefined): string {
  if (typeof windowMinutes !== "number" || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    return t(key === "weekly" ? "limits.week" : "limits.5h");
  }
  // Providers round: a week arrives as both 10080 and 10081 minutes, and both
  // mean "Week" rather than "168h".
  const canonical = canonicalWindowMinutes(windowMinutes) ?? windowMinutes;
  if (canonical === WEEKLY_WINDOW_MINUTES) return t("limits.week");
  if (canonical === SESSION_WINDOW_MINUTES) return t("limits.5h");
  if (windowMinutes % 1440 === 0) return t("limits.windowDays", { n: windowMinutes / 1440 });
  if (windowMinutes >= 60) return t("limits.windowHours", { n: Math.round(windowMinutes / 60) });
  return t("limits.windowMinutes", { n: Math.round(windowMinutes) });
}

/** Absolute reset moment: today's resets show the hour, later ones the date too. */
export function formatResetClock(resetsAt: number, now: number): string {
  const d = new Date(resetsAt * 1000);
  const time = d.toLocaleTimeString(localeBcp47(), { hour: "2-digit", minute: "2-digit", hour12: false });
  if (resetsAt - now < 86400) return time;
  return d.toLocaleDateString(localeBcp47(), { day: "numeric", month: "short" }) + " " + time;
}
