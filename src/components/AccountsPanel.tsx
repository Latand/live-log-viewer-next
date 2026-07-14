"use client";

import { Fragment, useEffect, useRef, useState } from "react";

import {
  accountNoticeText,
  claudeLoginErrKey,
  NONTERMINAL_CLAUDE_LOGIN_PHASES,
  type AccountOperation,
  type AccountAuthHealth,
  type AccountOption,
  type EngineAccountsState,
} from "@/hooks/useEngineAccounts";
import { type TFunction, useLocale } from "@/lib/i18n";
import { handleOverlayEscape } from "@/lib/overlay";

import { Check, Loader2, X } from "./icons";
import { Badge } from "./ui/Badge";
import { formatResetClock, formatResetEta } from "./rateLimit";
import { engineTintOf } from "./utils";

/** Amber that clears contrast on the panel background — state legibility never
    leans on color alone, so this pairs with the "needs sign-in" text chip. */
const NEEDS_LOGIN_COLOR = "var(--color-warning)";
const AUTH_HEALTH_KEY = {
  authenticated: "accounts.auth.authenticated",
  signed_out: "accounts.auth.signedOut",
  unknown: "accounts.auth.unknown",
  error: "accounts.auth.error",
} as const satisfies Record<AccountAuthHealth, Parameters<TFunction>[0]>;

function engineDisplay(engine: "claude" | "codex"): string {
  return engine === "claude" ? "Claude" : "Codex";
}

/** Capacity-chip color ramp mirrors the limits bars: engine tint with headroom,
    amber as it tightens, red when nearly spent. */
function capacityColor(percent: number, engineColor: string): string {
  if (percent <= 10) return "var(--color-danger)";
  if (percent <= 30) return "var(--color-warning)";
  return engineColor;
}

function CapacityChip({ account, engine }: { account: AccountOption; engine: "claude" | "codex" }) {
  const { t } = useLocale();
  const effective = account.effective;
  if (!effective || effective.freshness === "unavailable") return null;
  const tint = engineTintOf(engine);
  const window = t(effective.window === "weekly" ? "limits.windowWeekly" : "limits.windowSession");
  const stale = effective.freshness === "stale";
  const color = capacityColor(effective.percent, tint.color);
  return (
    <span
      className={`shrink-0 rounded-full border border-border bg-canvas px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${stale ? "opacity-55" : ""}`}
      style={{ color }}
      title={t(stale ? "accounts.effectiveStale" : "accounts.effectiveTip", { window })}
    >
      {t("accounts.effective", { pct: Math.round(effective.percent) })}
    </span>
  );
}

/** Per-account quota detail (issue #40): the session and weekly windows with
    remaining capacity and reset times, so the switch decision reads without
    leaving the panel. The collapsed {@link CapacityChip} is the min-window
    summary of this; here both windows are broken out. Renders nothing when no
    live/stale read exists; a stale read is dimmed and labeled. Time formatting is
    shared with the limits footer so both read identically. */
function AccountLimitsDetail({ account }: { account: AccountOption }) {
  const { t } = useLocale();
  // A single reference `now` for the open panel keeps the two windows' reset
  // ETAs consistent and stable across re-renders (they don't tick live here).
  const [now] = useState(() => Math.floor(Date.now() / 1000));
  const limits = account.limits;
  if (!limits) return null;
  const windows = [
    { key: "session", label: t("limits.5h"), window: limits.session },
    { key: "weekly", label: t("limits.week"), window: limits.weekly },
  ].filter((row): row is { key: string; label: string; window: NonNullable<typeof row.window> } => row.window != null);
  if (windows.length === 0) return null;
  const stale = limits.freshness === "stale";
  return (
    <dl
      aria-label={t("accounts.limitsAria", { label: account.label })}
      title={stale ? t("accounts.limitsStaleTip") : undefined}
      className={`flex flex-col gap-0.5 px-3 pb-1.5 pl-[26px] ${stale ? "opacity-70" : ""}`}
    >
      {/* Freshness is a visible, screen-reader-readable line — not opacity or a
          title tooltip alone (touch has no hover, and `title` AT support is
          spotty), so historical numbers never read as current. */}
      {stale ? <div className="text-[9.5px] font-semibold text-secondary">{t("accounts.limitsStale")}</div> : null}
      {windows.map(({ key, label, window: w }) => {
        const left = Math.max(0, Math.min(100, 100 - w.usedPercent));
        return (
          <div key={key} className="flex items-baseline gap-1.5 text-[10px] leading-snug text-muted">
            <dt className="w-8 shrink-0 font-semibold">{label}</dt>
            <dd className="flex min-w-0 flex-1 items-baseline gap-1">
              <span className="font-bold tabular-nums text-primary">{Math.round(left)}%</span>
              <span>{t("limits.left")}</span>
              {w.resetsAt ? (
                <span className="truncate">· {t("limits.reset", { eta: formatResetEta(w.resetsAt, now), at: formatResetClock(w.resetsAt, now) })}</span>
              ) : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

type RowState = "active" | "needsLogin" | "pending" | "idle";

function authHealth(account: AccountOption): AccountAuthHealth {
  return account.authHealth ?? (account.authPresent ? "unknown" : "signed_out");
}

function rowState(account: AccountOption, activeId: string): RowState {
  if (account.loginPending) return "pending";
  if (!account.authPresent || authHealth(account) === "signed_out") return "needsLogin";
  if (account.id === activeId) return "active";
  return "idle";
}

function StateChip({ state }: { state: RowState }) {
  const { t } = useLocale();
  if (state === "pending") {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold text-muted">
        <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />
        {t("accounts.pendingLogin")}
      </span>
    );
  }
  if (state === "needsLogin") return <span className="shrink-0 text-[10px] font-semibold" style={{ color: NEEDS_LOGIN_COLOR }}>{t("accounts.needsLogin")}</span>;
  if (state === "active") return <span className="shrink-0 text-[10px] font-semibold text-muted">{t("accounts.active")}</span>;
  return null;
}

function AuthIdentity({ account }: { account: AccountOption }) {
  const { t } = useLocale();
  const health = authHealth(account);
  const tone = health === "authenticated" ? "success" : health === "signed_out" || health === "error" ? "danger" : "neutral";
  return (
    <span className="flex min-w-0 items-center gap-1 text-[9.5px] font-medium text-muted">
      <code className="truncate font-mono">{account.id}</code>
      <Badge tone={tone} className="px-1.5 py-0 text-[9px]">{t(AUTH_HEALTH_KEY[health])}</Badge>
    </span>
  );
}

function AccountRow({ account, engine, activeId, onSelect, onRemove, disabled }: { account: AccountOption; engine: "claude" | "codex"; activeId: string; onSelect: () => void; onRemove: () => void; disabled: boolean }) {
  const { t } = useLocale();
  const state = rowState(account, activeId);
  const isActive = account.id === activeId;
  const selectionDisabled = disabled || !account.authPresent || authHealth(account) === "signed_out" || account.loginPending;
  // Removal deletes the managed home (including its credentials) with no undo,
  // so the unblocked path arms on the first click and only executes on a
  // second, explicit confirm — mirroring the confirm step migration already
  // requires for its far less destructive account switch.
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-current={isActive ? "true" : undefined}
        disabled={selectionDisabled}
        onClick={onSelect}
        className="flex min-h-[44px] w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-canvas disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0"
      >
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">{isActive ? <Check className="h-3.5 w-3.5 text-accent" aria-hidden /> : null}</span>
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[12.5px] ${isActive ? "font-bold text-primary" : "font-semibold"}`}>{account.label}</span>
          <AuthIdentity account={account} />
        </span>
        <CapacityChip account={account} engine={engine} />
        <StateChip state={state} />
      </button>
      {state === "pending" && account.deviceAuth ? (
        <div className="flex items-center gap-2 px-3 pb-1.5 pl-[26px] text-[10px] text-muted">
          <a href={account.deviceAuth.url} target="_blank" rel="noreferrer" className="inline-flex min-h-[44px] items-center truncate underline sm:min-h-0">{t("accounts.openLogin")}</a>
          <code className="select-all font-semibold text-primary">{account.deviceAuth.code}</code>
        </div>
      ) : null}
      {account.kind === "managed" ? (
        <div className="flex items-center gap-2 px-3 pb-1.5 pl-[26px]">
          {confirmingRemove ? (
            <>
              <span className="min-w-0 flex-1 text-[10.5px] font-semibold text-danger">{t("accounts.removeConfirm")}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  setConfirmingRemove(false);
                  onRemove();
                }}
                className="inline-flex min-h-[44px] shrink-0 items-center rounded-[7px] border border-danger bg-danger px-2 py-0.5 text-[10.5px] font-semibold text-white hover:opacity-90 disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0"
              >
                {t("accounts.removeConfirmCta")}
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => setConfirmingRemove(false)}
                className="inline-flex min-h-[44px] shrink-0 items-center rounded-[7px] border border-border bg-canvas px-2 py-0.5 text-[10.5px] font-semibold hover:bg-sunken disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0"
              >
                {t("accounts.removeConfirmCancel")}
              </button>
            </>
          ) : (
            <button
              type="button"
              aria-label={t("accounts.removeAria", { label: account.label })}
              disabled={disabled}
              onClick={() => setConfirmingRemove(true)}
              className="inline-flex min-h-[44px] items-center rounded-[7px] border border-border bg-canvas px-2 py-0.5 text-[10.5px] font-semibold text-danger hover:bg-danger-soft disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0"
            >
              {t("accounts.remove")}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The Claude sign-in slice for one account row (issue #61). Renders the live
    login phase (browser link + bounded code entry, Cancel), a sanitized failure
    with Retry, or a Sign in affordance for a managed unauthenticated account —
    and never removes the account. Codex rows never mount this (device login owns
    its own inline affordance in AccountRow). */
function ClaudeLoginRow({ account, state, loginBusy }: { account: AccountOption; state: EngineAccountsState; loginBusy: boolean }) {
  const { t } = useLocale();
  const login = account.login ?? null;
  const phase = login?.phase;
  const nonterminal = login != null && NONTERMINAL_CLAUDE_LOGIN_PHASES.has(login.phase);
  // The op's own Cancel/Submit gate on the shared mutation lock; the Sign in and
  // Retry affordances also stand down while any Claude login is nonterminal (C10).
  const busy = state.mutation !== null;
  const rowRef = useRef<HTMLDivElement>(null);
  const wantFocus = useRef(false);
  const [code, setCode] = useState("");
  const [submitted, setSubmitted] = useState(false);

  // Drop the pasted code the moment we leave code entry so it never lingers or
  // re-submits after a phase change (C6). Adjusting state during render (the
  // React-endorsed "reset on prop change" pattern) keeps it off an effect; the
  // row is also keyed by operationId so a fresh op after a retry starts clean.
  const [seenPhase, setSeenPhase] = useState(phase);
  if (phase !== seenPhase) {
    setSeenPhase(phase);
    if (phase !== "awaiting_code") {
      setCode("");
      setSubmitted(false);
    }
  }

  // Keep focus inside the sub-row when a control the operator just pressed
  // unmounts across a phase change (C9). Other transitions preserve their focus.
  useEffect(() => {
    if (wantFocus.current) {
      wantFocus.current = false;
      rowRef.current?.focus();
    }
  });
  const activate = (run: () => void) => {
    wantFocus.current = true;
    run();
  };

  if (nonterminal && login) {
    const cancelable = phase !== "canceling";
    const cancelButton = (
      <button
        type="button"
        onClick={() => activate(() => void state.cancelLogin(login.operationId))}
        disabled={busy || !cancelable}
        className="inline-flex min-h-[44px] shrink-0 items-center rounded-[7px] border border-border bg-canvas px-2 py-0.5 text-[11px] font-semibold hover:bg-sunken disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0"
      >
        {t("accounts.claudeLogin.cancel")}
      </button>
    );
    const spinnerLine = (key: "accounts.claudeLogin.starting" | "accounts.claudeLogin.awaitingBrowser" | "accounts.claudeLogin.verifying" | "accounts.claudeLogin.canceling") => (
      <div className="flex items-center gap-2">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none text-muted" aria-hidden />
        <span className="min-w-0 flex-1 text-[11px] text-muted">{t(key)}</span>
        {cancelable ? cancelButton : null}
      </div>
    );
    const hintId = `${login.operationId}-hint`;
    return (
      <div
        ref={rowRef}
        tabIndex={-1}
        role="group"
        aria-label={t("accounts.claudeLogin.groupAria", { label: account.label })}
        className="flex flex-col gap-1.5 px-3 pb-2 pl-[26px] focus-visible:outline-none"
      >
        {phase === "starting" ? spinnerLine("accounts.claudeLogin.starting") : null}
        {phase === "awaiting_browser" ? spinnerLine("accounts.claudeLogin.awaitingBrowser") : null}
        {phase === "verifying" ? spinnerLine("accounts.claudeLogin.verifying") : null}
        {phase === "canceling" ? spinnerLine("accounts.claudeLogin.canceling") : null}
        {phase === "awaiting_code" ? (
          <>
            {/* The link renders only in awaiting_code — it is stale once the code
                is submitted. The URL is server-vetted; render it verbatim. */}
            {login.loginUrl ? (
              <a href={login.loginUrl} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-[44px] items-center self-start text-[11px] font-semibold text-accent underline sm:min-h-0">
                {t("accounts.claudeLogin.openLink")}
              </a>
            ) : null}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (submitted || busy || code.trim() === "") return;
                activate(() => {
                  setSubmitted(true);
                  void state.submitLoginCode(login.operationId, code);
                });
              }}
              className="flex items-center gap-2"
            >
              <input
                type="text"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                onFocus={(event) => event.currentTarget.scrollIntoView({ block: "nearest" })}
                maxLength={8192}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-label={t("accounts.claudeLogin.codeLabel")}
                aria-describedby={hintId}
                placeholder={t("accounts.claudeLogin.codePlaceholder")}
                className="h-11 min-w-0 flex-1 rounded-[8px] border border-border bg-canvas px-2 font-mono text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8"
              />
              <button
                type="submit"
                disabled={busy || submitted || code.trim() === ""}
                className="h-11 shrink-0 rounded-[8px] border border-border bg-canvas px-2.5 text-[11px] font-semibold hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8"
              >
                {t("accounts.claudeLogin.submit")}
              </button>
            </form>
            <p id={hintId} className="text-[10px] leading-snug text-muted">{t("accounts.claudeLogin.codeHint")}</p>
            <div className="flex justify-end">{cancelButton}</div>
          </>
        ) : null}
      </div>
    );
  }

  // Terminal failure (failed / timed_out / interrupted): sanitized copy + Retry.
  if (login && login.result?.status === "failure") {
    return (
      <div ref={rowRef} tabIndex={-1} role="alert" className="flex items-center gap-2 px-3 pb-2 pl-[26px] focus-visible:outline-none">
        <span className="min-w-0 flex-1 text-[10.5px] font-semibold text-danger">{t(claudeLoginErrKey(login.result.code))}</span>
        <button
          type="button"
          onClick={() => activate(() => void state.retryLogin(account.id))}
          disabled={busy || loginBusy}
          className="inline-flex min-h-[44px] shrink-0 items-center rounded-[7px] border border-border bg-canvas px-2 py-0.5 text-[11px] font-semibold hover:bg-sunken disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0"
        >
          {t("accounts.retry")}
        </button>
      </div>
    );
  }

  // Managed account with no auth and no live op (covers canceled and the broken
  // production account): a Sign in affordance that restarts login in place.
  if (account.kind === "managed" && (!account.authPresent || authHealth(account) === "signed_out")) {
    return (
      <div ref={rowRef} tabIndex={-1} className="flex items-center gap-2 px-3 pb-2 pl-[26px] focus-visible:outline-none">
        <button
          type="button"
          onClick={() => activate(() => void state.retryLogin(account.id))}
          disabled={busy || loginBusy}
          className="inline-flex min-h-[44px] shrink-0 items-center rounded-[7px] border border-border bg-canvas px-2.5 py-0.5 text-[11px] font-semibold hover:bg-sunken disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0"
        >
          {t("accounts.claudeLogin.signIn")}
        </button>
      </div>
    );
  }

  return null;
}

/** Derived polite announcement for the sign-in live region (C9): the code-ready
    prompt while any account awaits its code, then the signed-in confirmation.
    Deriving from current state means the aria-live text changes exactly on the
    transition, with no effect and no mount-time announcement. */
function claudeAnnouncement(engine: "claude" | "codex", accounts: AccountOption[], t: TFunction): string {
  if (engine !== "claude") return "";
  const awaitingCode = accounts.find((account) => account.login?.phase === "awaiting_code");
  if (awaitingCode) return t("accounts.claudeLogin.announceCodeReady", { label: awaitingCode.label });
  const signedIn = accounts.find((account) => account.login?.phase === "authenticated");
  if (signedIn) return t("accounts.claudeLogin.announceDone", { label: signedIn.label });
  return "";
}

function operationText(operation: AccountOperation, t: TFunction): string {
  switch (operation) {
    case "refresh": return t("accounts.operation.refresh");
    case "add": return t("accounts.operation.add");
    case "switch": return t("accounts.operation.switch");
    case "login": return t("accounts.operation.login");
    case "remove": return t("accounts.operation.remove");
  }
}

/**
 * Unified, engine-parameterized Accounts panel. Symmetric for Claude and Codex:
 * account list with capacity chips, direct active-account selection, clear
 * operation state, and the add-account form.
 *
 * `placement` picks the desktop anchor for the caller's surface (mobile always
 * uses the bottom sheet):
 * - `"footer"` (the limits footer): a flyout beside the rail (`sm:left-full`),
 *   bottom-aligned, mirroring the resources CleanupPanel.
 * - `"header"` (the Switchboard header): a dropdown below the trigger
 *   (`sm:top-full`). The header sits at the top of an overflow-hidden modal, so
 *   a bottom-anchored flyout would grow upward out of that shell and clip; the
 *   header placement anchors downward and stays inside the box.
 */
export function AccountsPanel({
  state,
  onClose,
  placement = "footer",
}: {
  state: EngineAccountsState;
  onClose: () => void;
  placement?: "footer" | "header";
}) {
  const { t } = useLocale();
  const { accounts, active, status, notice, mutation, engine } = state;
  const [label, setLabel] = useState("");
  // While any Claude account has a live login op, the add/sign-in/retry starters
  // stand down so a second login can't race the supervisor (C10).
  const loginBusy = engine === "claude" && accounts.some((account) => account.login != null && NONTERMINAL_CLAUDE_LOGIN_PHASES.has(account.login.phase));
  // One polite live region per panel (C9). Derived from current state, so the
  // aria-live text changes exactly on the code-ready and signed-in transitions —
  // no effect/setState needed, and mount content is never announced.
  const announcement = claudeAnnouncement(engine, accounts, t);
  const closeRef = useRef<HTMLButtonElement>(null);
  const engineName = engineDisplay(engine);
  // Desktop anchor per caller; both share the mobile bottom sheet. The header
  // placement drops downward (`sm:top-full`) so an overflow-hidden ancestor
  // can't clip the panel; the footer keeps the bottom-aligned right-side flyout.
  const placementClass =
    placement === "header"
      ? "sm:absolute sm:top-full sm:left-0 sm:mt-2 sm:bottom-auto sm:translate-x-0"
      : "sm:absolute sm:bottom-1 sm:left-full sm:ml-2 sm:translate-x-0";

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const onSelect = async (id: string) => {
    if (mutation) return;
    await state.select(id);
  };

  const onAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = label.trim();
    if (!trimmed || mutation) return;
    const created = await state.add(trimmed);
    if (created) setLabel("");
  };

  return (
    <>
      {/* Mobile-only backdrop that absorbs the outside tap so it closes only the
          sheet, never the project drawer beneath it (desktop is a flyout). */}
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
        aria-label={t("accounts.titleFor", { engine: engineName })}
        aria-busy={mutation !== null}
        onKeyDown={(event) => handleOverlayEscape(event, onClose)}
        className={`fixed bottom-3 left-1/2 z-50 flex w-[min(360px,calc(100vw-16px))] -translate-x-1/2 flex-col rounded-[12px] border border-border bg-card shadow-2 ${placementClass}`}
      >
        <header className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-[12.5px] font-bold">{t("accounts.titleFor", { engine: engineName })}</span>
          <button
            ref={closeRef}
            type="button"
            aria-label={t("accounts.close")}
            onClick={onClose}
            className="ml-auto inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[6px] p-1 text-muted hover:bg-canvas hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0 sm:min-w-0"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </header>

        <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

        {mutation ? (
          <div role="status" aria-live="polite" className="flex items-center gap-2 border-b border-border bg-accent/5 px-3 py-2 text-[11px] font-semibold text-primary">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none text-accent" aria-hidden />
            {operationText(mutation, t)}
          </div>
        ) : null}
          <>
            <div className="max-h-[min(300px,50vh)] overflow-y-auto py-1">
              {status === "loading" ? <div className="px-3 py-2 text-[11px] text-muted">{t("accounts.loading")}</div> : null}
              {status === "error" && accounts.length === 0 ? <div className="px-3 py-2 text-[11px] text-muted">{t("accounts.noAccounts")}</div> : null}
              {accounts.map((account) => (
                <Fragment key={account.id}>
                  <AccountRow account={account} engine={engine} activeId={active} disabled={mutation !== null} onSelect={() => void onSelect(account.id)} onRemove={() => void state.remove(account.id)} />
                  <AccountLimitsDetail account={account} />
                  {engine === "claude" ? <ClaudeLoginRow key={account.login?.operationId ?? account.id} account={account} state={state} loginBusy={loginBusy} /> : null}
                </Fragment>
              ))}
            </div>
            <form onSubmit={onAdd} className="flex items-center gap-2 border-t border-border px-3 py-2">
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t("accounts.labelPlaceholder")}
                className="h-11 min-w-0 flex-1 rounded-[8px] border border-border bg-canvas px-2 text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8"
              />
              <button
                type="submit"
                disabled={mutation !== null || label.trim() === "" || loginBusy}
                className="inline-flex h-11 min-w-[44px] shrink-0 items-center justify-center rounded-[8px] border border-border bg-canvas px-2.5 text-[11px] font-semibold hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8 sm:min-w-0"
              >
                {t("accounts.confirmAdd")}
              </button>
            </form>
            <div className="flex justify-end border-t border-border px-3 py-1.5">
              <button
                type="button"
                disabled={mutation !== null}
                onClick={() => void state.cleanupOrphans()}
                className="inline-flex min-h-[44px] items-center text-[10.5px] font-semibold text-muted underline underline-offset-2 hover:text-primary disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0"
              >
                {t("accounts.cleanupOrphans")}
              </button>
            </div>
            {notice ? (
              <div className="flex items-center gap-2 border-t border-border px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted" title={accountNoticeText(t, notice)}>{accountNoticeText(t, notice)}</span>
                {notice.action ? (
                  <button
                    type="button"
                    disabled={mutation !== null}
                    onClick={() => void state.retryNotice().then((recovered) => {
                      if (recovered && notice.operation === "add") setLabel("");
                    })}
                    className="inline-flex min-h-[44px] shrink-0 items-center rounded-[7px] border border-border bg-canvas px-2 py-0.5 text-[11px] font-semibold hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0"
                  >
                    {notice.action.kind === "forceRemove"
                      ? t("accounts.forceRemove")
                      : notice.action.kind === "cleanupOrphans"
                        ? t("accounts.cleanupOrphans")
                        : t("accounts.retry")}
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
      </div>
    </>
  );
}
