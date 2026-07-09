"use client";

import { accountNoticeText, accountSwitchView, type CodexAccountOption, pendingDeviceAuth, useCodexAccounts } from "@/hooks/useCodexAccounts";
import { useLocale } from "@/lib/i18n";

// The account shape lives in the shared store. Keep these exports for existing
// importers that use the compact control's helpers.
export { accountSwitchView, pendingDeviceAuth };
export type { CodexAccountOption };

/** Compact selector in the Switchboard header. The trigger remains mounted while
    account data loads or recovers, so it always offers a path to Accounts. */
export function CodexAccountSwitch() {
  const { accounts, active, status, notice, challenge, mutation, select, add, retryNotice } = useCodexAccounts();
  const { t } = useLocale();
  const busy = mutation !== null;
  const noticeText = notice ? accountNoticeText(t, notice) : null;

  return (
    <div className="flex items-center gap-1.5">
      <select
        aria-label={t("accounts.activeAria")}
        value={active}
        disabled={busy || status === "loading"}
        onChange={(event) => void select(event.target.value)}
        className="h-8 max-w-36 rounded-[7px] border border-line bg-bg px-2 text-[11px] font-semibold disabled:cursor-wait disabled:opacity-60"
      >
        <option value="">{status === "loading" ? t("accounts.loading") : t("accounts.placeholder")}</option>
        {accounts.map((account) => <option key={account.id} value={account.id}>{account.label}{account.authPresent ? "" : ` · ${t("accounts.login")}`}</option>)}
      </select>
      <button
        type="button"
        disabled={busy}
        onClick={() => void add(window.prompt(t("accounts.prompt")) ?? "")}
        className="h-8 rounded-[7px] border border-line bg-bg px-2 text-[11px] font-semibold disabled:cursor-wait disabled:opacity-60"
      >
        {t("accounts.add")}
      </button>
      {challenge ? <span className="flex items-center gap-1 text-[10px] text-dim"><a href={challenge.url} target="_blank" rel="noreferrer" className="underline">{t("accounts.openLogin")}</a><code className="select-all font-semibold text-ink">{challenge.code}</code></span> : null}
      {noticeText ? <span className="max-w-48 truncate text-[10px] text-dim" title={noticeText}>{noticeText}</span> : null}
      {notice?.action ? <button type="button" disabled={busy} onClick={() => void retryNotice()} className="h-8 rounded-[7px] border border-line bg-bg px-2 text-[11px] font-semibold disabled:cursor-wait disabled:opacity-60">{t("accounts.retry")}</button> : null}
    </div>
  );
}
