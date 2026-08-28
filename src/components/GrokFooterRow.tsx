"use client";

import { Zap } from "./icons";

import { useGrokAccount } from "@/hooks/useGrokAccount";
import { useLocale } from "@/lib/i18n";

import { engineTintOf } from "./utils";

/** Sidebar footer: Grok has one CLI login, not Claude/Codex account homes. */
export function GrokFooterRow() {
  const { t } = useLocale();
  const account = useGrokAccount();
  const tint = engineTintOf("grok");
  const signedIn = account.signedIn === true;
  const loading = account.signedIn === null;
  return (
    <div
      className="flex min-h-[44px] w-full items-center gap-2 px-3.5 py-1.5 sm:min-h-[36px]"
      aria-label={t("grok.rowAria")}
    >
      <Zap className="h-3.5 w-3.5 shrink-0" style={{ color: tint.color }} aria-hidden />
      <span className="text-[11.5px] font-bold" style={{ color: tint.color }}>{t("grok.title")}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <span className="text-[10px] font-semibold text-muted">
          {loading ? t("grok.statusLoading") : signedIn ? t("grok.signedIn") : t("grok.signedOut")}
        </span>
        <span
          aria-hidden
          className="h-2 w-2 rounded-full"
          style={{
            backgroundColor: loading ? "transparent" : signedIn ? "var(--color-success)" : "transparent",
            boxShadow: signedIn || loading ? "none" : "inset 0 0 0 1.5px var(--color-border)",
          }}
        />
      </span>
    </div>
  );
}
