"use client";

import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";

/** Compact EN/UK switch in the rail header; persists to localStorage. */
export function LanguageToggle() {
  const { locale, t, setLocale } = useLocale();
  const isMobile = useIsMobile();
  const next = locale === "en" ? "uk" : "en";
  return (
    <button
      className={`inline-flex shrink-0 items-center justify-center rounded-full border border-line bg-panel px-2 text-[10.5px] font-bold text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        isMobile ? "min-h-11 min-w-11" : "h-[26px]"
      }`}
      title={t("lang.aria")}
      aria-label={t("lang.aria")}
      onClick={() => setLocale(next)}
    >
      {locale.toUpperCase()}
    </button>
  );
}
