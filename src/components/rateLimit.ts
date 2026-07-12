import { getLocale, translate, type TFunction, type Locale } from "@/lib/i18n";
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

/** Absolute reset moment: today's resets show the hour, later ones the date too. */
export function formatResetClock(resetsAt: number, now: number): string {
  const d = new Date(resetsAt * 1000);
  const time = d.toLocaleTimeString(localeBcp47(), { hour: "2-digit", minute: "2-digit", hour12: false });
  if (resetsAt - now < 86400) return time;
  return d.toLocaleDateString(localeBcp47(), { day: "numeric", month: "short" }) + " " + time;
}
