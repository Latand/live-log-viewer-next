"use client";

import { useCallback, useEffect, useState } from "react";

import { useLocale } from "@/lib/i18n";

type DeviceAuth = { url: string; code: string };
export type CodexAccountOption = { id: string; label: string; authPresent: boolean; loginPending: boolean; loginState: "pending" | "idle" | "authenticated"; deviceAuth: DeviceAuth | null };

export function pendingDeviceAuth(accounts: CodexAccountOption[]): DeviceAuth | null {
  return accounts.find((account) => account.loginPending)?.deviceAuth ?? null;
}

/** Pure render decision so failure visibility is testable without a DOM.
 *  "switch" — the full selector; "recovery" — a failure note with a retry
 *  affordance before accounts load; "hidden" — nothing to show. An initial
 *  refresh failure must never collapse to "hidden" and silently drop the note. */
export type AccountSwitchView = "switch" | "recovery" | "hidden";
export function accountSwitchView(accounts: CodexAccountOption[], note: string): AccountSwitchView {
  if (accounts.length) return "switch";
  if (note) return "recovery";
  return "hidden";
}

export function CodexAccountSwitch() {
  const [active, setActive] = useState("");
  const [accounts, setAccounts] = useState<CodexAccountOption[]>([]);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [challenge, setChallenge] = useState<DeviceAuth | null>(null);
  const { t } = useLocale();
  const refresh = useCallback(async (showFailure = true) => {
    try {
      const res = await fetch("/api/accounts");
      if (!res.ok) throw new Error("accounts request failed");
      const body = await res.json() as { codex?: { active?: unknown; accounts?: unknown } };
      if (typeof body.codex?.active !== "string" || !Array.isArray(body.codex.accounts)) throw new Error("accounts response invalid");
      const nextAccounts = body.codex.accounts as CodexAccountOption[];
      setActive(body.codex.active);
      setAccounts(nextAccounts);
      setPending(nextAccounts.some((account) => account.loginPending));
      setChallenge(pendingDeviceAuth(nextAccounts));
    } catch {
      if (showFailure) setNote(t("accounts.refreshFailed"));
    }
  }, [t]);
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [pending, refresh]);
  const select = async (id: string) => {
    const previous = active;
    setActive(id);
    try {
      const res = await fetch("/api/accounts/codex/active", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      if (!res.ok) throw new Error("account selection failed");
    } catch {
      setActive(previous);
      setNote(t("accounts.switchFailed"));
    } finally {
      await refresh(false);
    }
  };
  const add = async () => {
    const label = window.prompt(t("accounts.prompt"));
    if (!label) return;
    try {
      const res = await fetch("/api/accounts/codex", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label }) });
      const body = await res.json().catch(() => null) as { target?: unknown } | null;
      if (!res.ok || typeof body?.target !== "string") throw new Error("account creation failed");
      setNote(t("accounts.loginOpened", { target: body.target }));
    } catch {
      setNote(t("accounts.addFailed"));
    } finally {
      await refresh(false);
    }
  };
  const view = accountSwitchView(accounts, note);
  if (view === "hidden") return null;
  if (view === "recovery") return <div className="flex items-center gap-1.5"><span className="max-w-48 truncate text-[10px] text-dim" title={note}>{note}</span><button type="button" onClick={() => void refresh()} className="h-8 rounded-[7px] border border-line bg-bg px-2 text-[11px] font-semibold">{t("accounts.retry")}</button></div>;
  return <div className="flex items-center gap-1.5"><select aria-label={t("accounts.activeAria")} value={active} onChange={(event) => void select(event.target.value)} className="h-8 max-w-36 rounded-[7px] border border-line bg-bg px-2 text-[11px] font-semibold"><option value="">{t("accounts.placeholder")}</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.label}{account.authPresent ? "" : ` · ${t("accounts.login")}`}</option>)}</select><button type="button" onClick={() => void add()} className="h-8 rounded-[7px] border border-line bg-bg px-2 text-[11px] font-semibold">{t("accounts.add")}</button>{challenge ? <span className="flex items-center gap-1 text-[10px] text-dim"><a href={challenge.url} target="_blank" rel="noreferrer" className="underline">{t("accounts.openLogin")}</a><code className="select-all font-semibold text-ink">{challenge.code}</code></span> : null}{note ? <span className="max-w-48 truncate text-[10px] text-dim" title={note}>{note}</span> : null}</div>;
}
