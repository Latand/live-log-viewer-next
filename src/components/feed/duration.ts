import { getLocale, translate } from "@/lib/i18n";

export function timestampMilliseconds(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function elapsedDurationMs(start: unknown, end: unknown): number | null {
  const startedAt = timestampMilliseconds(start);
  const endedAt = timestampMilliseconds(end);
  if (startedAt === null || endedAt === null) return null;
  return Math.max(0, endedAt - startedAt);
}

/** Tool-row duration: milliseconds below one second, seconds from one second. */
export function formatDuration(ms: number): string {
  const locale = getLocale();
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate(locale, key, params);
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return t("tools.durationMs", { n: Math.round(ms) });
  const totalSec = ms / 1000;
  const n = totalSec < 10 ? Math.round(totalSec * 10) / 10 : Math.round(totalSec);
  return t("tools.durationSec", { n });
}
