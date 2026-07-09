"use client";

import { useEffect, useRef, useState } from "react";

import { accountNoticeText, type CodexAccountOption, type CodexAccountsState } from "@/hooks/useCodexAccounts";
import { useLocale } from "@/lib/i18n";
import { handleOverlayEscape } from "@/lib/overlay";

import { Check, Loader2, X } from "./icons";

/** Amber that clears contrast on the panel background — state legibility never
    leans on color alone, so this pairs with the "needs sign-in" text chip. */
const NEEDS_LOGIN_COLOR = "#8a5a00";

export type AccountRowState = "active" | "needsLogin" | "pending" | "idle";

/** Pure row classifier so the state matrix is testable without a DOM. `pending`
    (a device login in flight) and `needsLogin` (no local auth) outrank the
    active marker on purpose: an account can be the active one and still need
    sign-in, and that amber cue must stay visible. The check/`aria-current`
    marker is derived from `id === activeId` separately at render time. */
export function accountRowState(account: CodexAccountOption, activeId: string): AccountRowState {
  if (account.loginPending) return "pending";
  if (!account.authPresent) return "needsLogin";
  if (account.id === activeId) return "active";
  return "idle";
}

function StateChip({ state }: { state: AccountRowState }) {
  const { t } = useLocale();
  if (state === "pending") {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold text-dim">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        {t("accounts.pendingLogin")}
      </span>
    );
  }
  if (state === "needsLogin") {
    return (
      <span className="shrink-0 text-[10px] font-semibold" style={{ color: NEEDS_LOGIN_COLOR }}>
        {t("accounts.needsLogin")}
      </span>
    );
  }
  if (state === "active") {
    return <span className="shrink-0 text-[10px] font-semibold text-dim">{t("accounts.active")}</span>;
  }
  return null;
}

function AccountRow({
  account,
  activeId,
  onSelect,
  disabled,
}: {
  account: CodexAccountOption;
  activeId: string;
  onSelect: () => void;
  disabled: boolean;
}) {
  const { t } = useLocale();
  const state = accountRowState(account, activeId);
  const isActive = account.id === activeId;
  return (
    <div>
      <button
        type="button"
        aria-current={isActive ? "true" : undefined}
        disabled={disabled}
        onClick={onSelect}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-bg disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          {isActive ? <Check className="h-3.5 w-3.5 text-accent" aria-hidden /> : null}
        </span>
        <span className={`min-w-0 flex-1 truncate text-[12.5px] ${isActive ? "font-bold text-ink" : "font-semibold"}`}>
          {account.label}
        </span>
        <StateChip state={state} />
      </button>
      {state === "pending" && account.deviceAuth ? (
        <div className="flex items-center gap-2 px-3 pb-1.5 pl-[26px] text-[10px] text-dim">
          <a href={account.deviceAuth.url} target="_blank" rel="noreferrer" className="truncate underline">
            {t("accounts.openLogin")}
          </a>
          <code className="select-all font-semibold text-ink">{account.deviceAuth.code}</code>
        </div>
      ) : null}
    </div>
  );
}

/** Responsive, accessible Codex account panel opened from the limits footer.
    Positioning mirrors the resources CleanupPanel: a flyout to the right of the
    rail on desktop, a bottom sheet inside the drawer on mobile. */
export function CodexAccountsPanel({
  state,
  onClose,
}: {
  state: CodexAccountsState;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const { accounts, active, status, notice, mutation, select, add, retryNotice } = state;
  const [label, setLabel] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);

  // Move focus into the panel when it opens (return-to-trigger is owned by the
  // footer that hosts this panel).
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const onSelect = async (id: string) => {
    await select(id);
  };

  const onAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = label.trim();
    if (!trimmed || mutation) return;
    const created = await add(trimmed);
    if (created) setLabel("");
  };

  return (
    <>
      {/* Mobile-only backdrop. The sheet lives inside the project drawer, whose
          scrim closes the drawer on tap. Without this, one outside tap reaches
          both — closing the sheet and the drawer together. This absorbs the tap
          (it sits above the scrim, below the sheet) so it closes only the sheet
          and never forwards the gesture to the scrim. Desktop is a flyout beside
          the rail with no drawer, so it keeps the window-level outside-close. */}
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        aria-label={t("accounts.close")}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="fixed inset-0 z-40 cursor-default sm:hidden"
      />
      <div
        role="dialog"
        aria-label={t("accounts.title")}
        // Escape is owned by this sheet's subtree, not a window listener: focus
        // moves into the panel on open, so the keypress bubbles to here first. We
        // stop it before it can reach the project drawer's window-level Escape
        // handler, so one press closes only this sheet and returns focus. A later
        // Escape, with the sheet unmounted, reaches the drawer. See handleOverlayEscape.
        onKeyDown={(event) => handleOverlayEscape(event, onClose)}
        className="fixed bottom-3 left-1/2 z-50 flex w-[min(360px,calc(100vw-16px))] -translate-x-1/2 flex-col rounded-[12px] border border-line bg-panel shadow-[0_8px_28px_rgba(20,20,30,0.14)] sm:absolute sm:bottom-1 sm:left-full sm:ml-2 sm:translate-x-0"
      >
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-[12.5px] font-bold">{t("accounts.title")}</span>
        <button
          ref={closeRef}
          type="button"
          aria-label={t("accounts.close")}
          onClick={onClose}
          className="ml-auto rounded-[6px] p-1 text-dim hover:bg-bg hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </header>
      <div className="max-h-[min(300px,50vh)] overflow-y-auto py-1">
        {status === "loading" ? <div className="px-3 py-2 text-[11px] text-dim">{t("accounts.loading")}</div> : null}
        {status === "error" && accounts.length === 0 ? <div className="px-3 py-2 text-[11px] text-dim">{t("accounts.noAccounts")}</div> : null}
        {accounts.map((account) => (
          <AccountRow key={account.id} account={account} activeId={active} disabled={mutation !== null} onSelect={() => void onSelect(account.id)} />
        ))}
      </div>
      <form onSubmit={onAdd} className="flex items-center gap-2 border-t border-line px-3 py-2">
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder={t("accounts.labelPlaceholder")}
          className="h-8 min-w-0 flex-1 rounded-[8px] border border-line bg-bg px-2 text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        />
        <button
          type="submit"
          disabled={mutation !== null || label.trim() === ""}
          className="h-8 shrink-0 rounded-[8px] border border-line bg-bg px-2.5 text-[11px] font-semibold hover:bg-chip disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {t("accounts.confirmAdd")}
        </button>
      </form>
      {notice ? (
        <div className="flex items-center gap-2 border-t border-line px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate text-[11px] text-dim" title={accountNoticeText(t, notice)}>{accountNoticeText(t, notice)}</span>
          {notice.action ? <button
            type="button"
            disabled={mutation !== null}
            onClick={() => void retryNotice().then((recovered) => {
              if (recovered && notice.operation === "add") setLabel("");
            })}
            className="shrink-0 rounded-[7px] border border-line bg-bg px-2 py-0.5 text-[11px] font-semibold hover:bg-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            {t("accounts.retry")}
          </button> : null}
        </div>
      ) : null}
      </div>
    </>
  );
}
