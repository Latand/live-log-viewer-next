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
  type LimitsAction,
} from "@/hooks/useEngineAccounts";
import { claudeTierDisplayName } from "@/lib/agent/models";
import { type TFunction, useLocale } from "@/lib/i18n";
import { handleOverlayEscape } from "@/lib/overlay";
import { effectiveQuota, quotaReadingFromAccountLimits, reconcileQuotaReadings, type ReconciledQuota } from "@/lib/rateLimit";

import { Loader2, RotateCw, SquareTerminal, Trash2, X, Zap } from "./icons";
import { Badge } from "./ui/Badge";
import { formatCheckedClock, formatQuotaAsOf, formatResetClock, formatResetEta, windowLabel } from "./rateLimit";
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

function accountQuota(account: AccountOption, now: number) {
  return reconcileQuotaReadings(null, quotaReadingFromAccountLimits(account.limits), now);
}

function CapacityChip({ quota, engine }: { quota: ReconciledQuota; engine: "claude" | "codex" }) {
  const { t } = useLocale();
  const effective = effectiveQuota(quota);
  if (!effective) return null;
  const tint = engineTintOf(engine);
  const window = effective.window === "flagship"
    ? t("limits.windowFlagship", { tier: claudeTierDisplayName(quota.flagship?.value.tier ?? "") })
    : t(effective.window === "weekly" ? "limits.windowWeekly" : "limits.windowSession");
  const stale = effective.stale;
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

/** One recipe for the two per-card limits actions (#1418, #1373): quiet ghost
    buttons inside the limits block, 44px tall on touch, compact on desktop. */
const LIMITS_ACTION_CLASS = "inline-flex min-h-[44px] shrink-0 items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[10px] font-semibold text-secondary hover:bg-canvas hover:text-primary disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[24px]";

/**
 * Per-account limits block (issues #40, #1418, #1373, #1358). One place on the
 * card says how much is left and lets the operator act on it:
 *
 *   Checked · 14:32                                    ↻ Refresh
 *   rate-limited until 6 Sep 10:48
 *   Week         ▓▓░░░░░░   0% left · reset in 5d · 6 Sep 10:48
 *   Opus · Week  ▓▓▓▓▓░░░  62% left · reset in 3d · …      (flagship tier, when reported)
 *   1 reset available · expires 21 Sep 10:48           ⚡ Use one reset   (Codex only)
 *
 * Refresh re-reads that account's live limits now; Use one reset redeems one
 * usage-limit reset credit. Both fire on click — there is no confirmation step
 * anywhere on the card — and the card takes the reading the route answers
 * with. Each window renders as a labelled meter on the limits color ramp plus
 * the numeric % left and the reset time; the collapsed {@link CapacityChip} is
 * the min-window summary of this. A stale read is dimmed and captioned, and
 * the check time renders for fresh reads too, so the operator always sees when
 * the numbers were taken. Time formatting is shared with the limits footer.
 */
function AccountLimitsBlock({ account, engine, quota, now, busy, disabled, wideLabels, onRefresh, onUseReset }: {
  account: AccountOption;
  engine: "claude" | "codex";
  quota: ReconciledQuota;
  now: number;
  busy: LimitsAction["operation"] | null;
  disabled: boolean;
  /** True when any card in the dialog carries a flagship row: every card then
      uses the wider label column, so the meters line up down the whole list. */
  wideLabels: boolean;
  onRefresh: () => void;
  onUseReset: () => void;
}) {
  const { t } = useLocale();
  const rows = [
    { key: "session", label: windowLabel(t, "session", quota.session?.value.windowMinutes), window: quota.session },
    { key: "weekly", label: windowLabel(t, "weekly", quota.weekly?.value.windowMinutes), window: quota.weekly },
    // The flagship tier's own week (#1358), named by the provider's tier; the
    // row exists only when the account reports a distinct bucket.
    { key: "flagship", label: quota.flagship ? t("limits.tierWeek", { tier: claudeTierDisplayName(quota.flagship.value.tier) }) : "", window: quota.flagship },
  ].filter((row): row is { key: string; label: string; window: NonNullable<typeof row.window> } => row.window != null);
  const stale = rows.some((row) => row.window.stale);
  const observed = rows.map((row) => row.window.observedAt).filter((value): value is number => value !== null);
  const observedAt = observed.length ? Math.min(...observed) : null;
  const staleObserved = rows
    .filter((row) => row.window.stale)
    .map((row) => row.window.observedAt)
    .filter((value): value is number => value !== null);
  const sharedStaleAt = staleObserved.length > 1 && staleObserved.every((value) => value === staleObserved[0])
    ? staleObserved[0]
    : null;
  const exhausted = rows.filter((row) => row.window.value.usedPercent >= 100);
  const exhaustedResets = exhausted.map((row) => row.window.value.resetsAt);
  const rateLimitedUntil = exhausted.length > 0
    && exhaustedResets.every((reset): reset is number => reset !== null && reset > now)
    ? Math.max(...exhaustedResets)
    : null;
  const tint = engineTintOf(engine);
  // Freshness is a visible, screen-reader-readable line — not opacity or a
  // title tooltip alone (touch has no hover, and `title` AT support is
  // spotty), so historical numbers never read as current.
  const caption = sharedStaleAt !== null
    ? formatQuotaAsOf(sharedStaleAt) ?? t("accounts.limitsStale")
    : !stale && observedAt !== null
      ? `${t("accounts.limitsChecked")} · ${formatCheckedClock(new Date(observedAt * 1000).toISOString())}`
      : rows.length === 0 ? t("limits.noDataYet") : null;
  const resets = engine === "codex" ? account.resetCredits ?? null : null;
  const canRedeem = resets !== null && resets.availableCount > 0;
  const refreshing = busy === "refreshLimits";
  const redeeming = busy === "resetCredit";
  const labelWidth = wideLabels ? "w-[72px]" : "w-8";
  return (
    <dl
      data-account-limits={account.id}
      aria-label={t("accounts.limitsAria", { label: account.label })}
      title={stale ? t("accounts.limitsStaleTip") : undefined}
      className="flex flex-col gap-1 px-3.5 pb-1 pl-[30px]"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[9.5px] font-semibold text-secondary">{caption}</span>
        <button
          type="button"
          data-account-refresh-limits={account.id}
          aria-label={t("accounts.refreshLimitsAria", { label: account.label })}
          aria-busy={refreshing || undefined}
          disabled={disabled || busy !== null}
          onClick={onRefresh}
          className={LIMITS_ACTION_CLASS}
        >
          {refreshing
            ? <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none text-accent" aria-hidden />
            : <RotateCw className="h-3 w-3 text-muted" aria-hidden />}
          {t("accounts.refreshLimits")}
        </button>
      </div>
      {exhausted.length > 0 ? (
        <div className="text-[10px] font-semibold text-danger">
          {rateLimitedUntil === null
            ? t("rateLimit.badge")
            : t("rateLimit.badgeUntil", { time: formatResetClock(rateLimitedUntil, now) })}
        </div>
      ) : null}
      {rows.length > 0 ? (
        <div className={`flex flex-col gap-1 ${stale ? "opacity-70" : ""}`}>
          {rows.map(({ key, label, window }) => {
            const w = window.value;
            const left = Math.max(0, Math.min(100, 100 - w.usedPercent));
            const color = capacityColor(left, tint.color);
            const groupedStaleHint = sharedStaleAt !== null && window.observedAt === sharedStaleAt;
            const staleHint = window.stale && !groupedStaleHint
              ? formatQuotaAsOf(window.observedAt) ?? t("accounts.limitsStale")
              : null;
            return (
              <div key={key} data-limit-row={key} className="flex items-center gap-2 text-[10px] leading-snug text-muted">
                <dt className={`${labelWidth} shrink-0 font-semibold`}>{label}</dt>
                <dd className="flex min-w-0 flex-1 items-center gap-2">
                  <span aria-hidden className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-sunken sm:w-20">
                    <span className="block h-full rounded-full" style={{ width: `${left}%`, backgroundColor: color }} />
                  </span>
                  <span className="font-bold tabular-nums text-primary">{Math.round(left)}%</span>
                  <span>{t("limits.left")}</span>
                  {w.resetsAt ? (
                    <span className="truncate">· {t("limits.reset", { eta: formatResetEta(w.resetsAt, now), at: formatResetClock(w.resetsAt, now) })}</span>
                  ) : null}
                  {staleHint ? <span className="truncate">{w.resetsAt ? "· " : ""}{staleHint}</span> : null}
                </dd>
              </div>
            );
          })}
        </div>
      ) : null}
      {engine === "codex" ? (
        // Reset credits live beside the limit state they remedy (#1373), so an
        // exhausted account and its way out read in one place.
        <div data-account-reset-credits={account.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted">
          <span className={`min-w-0 flex-1 ${canRedeem ? "font-semibold text-primary" : ""}`}>
            {resets === null
              ? t("accounts.resetsUnknown")
              : resets.availableCount === 0
                ? t("accounts.resetsNone")
                : t("accounts.resetsAvailable", { count: resets.availableCount })}
            {resets !== null && resets.availableCount > 0 && resets.expiresAt !== null
              ? ` · ${t("accounts.resetsExpire", { at: formatResetClock(resets.expiresAt, now) })}`
              : null}
          </span>
          <button
            type="button"
            data-account-use-reset={account.id}
            aria-label={t("accounts.useResetAria", { label: account.label })}
            aria-busy={redeeming || undefined}
            disabled={disabled || busy !== null || !canRedeem}
            onClick={onUseReset}
            className={`${LIMITS_ACTION_CLASS} ${canRedeem ? "border border-accent/40 bg-canvas text-accent hover:text-accent" : ""}`}
          >
            {redeeming
              ? <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none text-accent" aria-hidden />
              : <Zap className="h-3 w-3" aria-hidden />}
            {t("accounts.useReset")}
          </button>
        </div>
      ) : null}
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
      <code className="truncate font-mono" title={account.id}>{account.id}</code>
      {account.plan ? <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">{account.plan}</Badge> : null}
      <Badge tone={tone} className="px-1.5 py-0 text-[9px]">{t(AUTH_HEALTH_KEY[health])}</Badge>
    </span>
  );
}

function AccountRow({ account, engine, quota, activeId, onSelect, onRemove, onCopyCommand, disabled, focused = false, children }: { account: AccountOption; engine: "claude" | "codex"; quota: ReconciledQuota; activeId: string; onSelect: () => void; onRemove: () => void; onCopyCommand: () => void; disabled: boolean; focused?: boolean; children?: React.ReactNode }) {
  const { t } = useLocale();
  const state = rowState(account, activeId);
  const isActive = account.id === activeId;
  const tint = engineTintOf(engine);
  const usable = account.authPresent && authHealth(account) !== "signed_out" && !account.loginPending;
  const selectionDisabled = disabled || !usable;
  // Removal deletes the managed home (including its credentials) with no undo,
  // so the unblocked path arms on the first click and only executes on a
  // second, explicit confirm — mirroring the confirm step migration already
  // requires for its far less destructive account switch.
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  // A badge-driven open (issue #229) focuses one account: scroll it into view
  // and ring it so the panel lands on the conversation's account, not the top.
  const selectRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focused) selectRef.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);
  return (
    <div
      className={`relative ${focused ? "ring-2 ring-inset ring-accent/50" : ""}`}
      // The active account reads as a tinted wash + hairline identity bar —
      // no boxed borders, so the list stays one quiet column.
      style={isActive ? { background: `color-mix(in srgb, ${tint.color} 7%, transparent)`, boxShadow: `inset 2px 0 0 ${tint.color}` } : undefined}
    >
      <button
        ref={selectRef}
        type="button"
        aria-current={isActive ? "true" : undefined}
        disabled={selectionDisabled}
        onClick={onSelect}
        className="flex min-h-[44px] w-full items-center gap-2.5 px-3.5 pt-2.5 pb-1 text-left hover:bg-canvas/60 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0"
      >
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: isActive ? tint.color : "transparent", boxShadow: isActive ? "none" : "inset 0 0 0 1.5px var(--color-border)" }}
        />
        <span className="min-w-0 flex-1">
          <span className={`block break-words text-[13px] leading-tight ${isActive ? "font-bold text-primary" : "font-semibold"}`}>{account.label}</span>
          <AuthIdentity account={account} />
        </span>
        <CapacityChip quota={quota} engine={engine} />
        <StateChip state={state} />
      </button>
      {children}
      {state === "pending" && account.deviceAuth ? (
        <div className="flex items-center gap-2 px-3.5 pb-1.5 text-[10px] text-muted">
          <a href={account.deviceAuth.url} target="_blank" rel="noreferrer" className="inline-flex min-h-[44px] items-center truncate underline sm:min-h-0">{t("accounts.openLogin")}</a>
          <code className="select-all font-semibold text-primary">{account.deviceAuth.code}</code>
        </div>
      ) : null}
      <div className="flex items-center gap-1 px-3.5 pb-2 pl-[30px]">
        {/* Copies the account-bound CLI command — tmux/terminals live on the
            operator's machine, so the panel hands over the command, always. */}
        <button
          type="button"
          aria-label={t("accounts.copyCliAria", { label: account.label })}
          disabled={disabled || !usable}
          onClick={onCopyCommand}
          className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-[6px] px-1.5 py-0.5 text-[10.5px] font-semibold text-secondary hover:bg-canvas hover:text-primary disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[28px]"
        >
          <SquareTerminal className="h-3.5 w-3.5 text-muted" aria-hidden />
          {t("accounts.copyCli")}
        </button>
        <span className="min-w-0 flex-1" />
        {account.kind === "managed" ? (
          confirmingRemove ? (
            <>
              <span className="min-w-0 flex-1 text-right text-[10.5px] font-semibold text-danger">{t("accounts.removeConfirm")}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  setConfirmingRemove(false);
                  onRemove();
                }}
                className="inline-flex min-h-[44px] shrink-0 items-center rounded-[6px] bg-danger px-2 py-0.5 text-[10.5px] font-semibold text-white hover:opacity-90 disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[28px]"
              >
                {t("accounts.removeConfirmCta")}
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => setConfirmingRemove(false)}
                className="inline-flex min-h-[44px] shrink-0 items-center rounded-[6px] px-2 py-0.5 text-[10.5px] font-semibold text-secondary hover:bg-canvas disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[28px]"
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
              className="inline-flex min-h-[44px] shrink-0 items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[10.5px] font-semibold text-muted hover:bg-danger-soft hover:text-danger disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[28px]"
            >
              <Trash2 className="h-3 w-3" aria-hidden />
              {t("accounts.remove")}
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}

export type ProjectAccountContext = {
  project: string;
  restricted: boolean;
  allowed: { accountId: string; label: string }[];
  carrying: { accountId: string; label: string }[];
  outsidePool: { accountId: string; label: string; at: string; actor: "operator" | "agent" }[];
};

/** Project pool detail formerly painted as one chip per account in the primary
    toolbar. It now lives inside the engine panel, where full labels and the
    reason each account is present remain available without consuming the row. */
function ProjectAccountDetail({ context }: { context: ProjectAccountContext }) {
  const { t } = useLocale();
  const carrying = new Set(context.carrying.map((account) => account.accountId));
  const chosen = new Map(context.outsidePool.map((account) => [account.accountId, account] as const));
  const extra = [...context.carrying, ...context.outsidePool]
    .filter((account, index, list) => list.findIndex((item) => item.accountId === account.accountId) === index);
  const rows = context.restricted
    ? [...context.allowed, ...extra.filter((account) => !context.allowed.some((item) => item.accountId === account.accountId))]
    : extra;

  return (
    <section data-project-account-detail={context.project} className="border-b border-border bg-canvas/55 px-3.5 py-2.5">
      <div className="mb-1.5 flex items-center gap-2 text-[10px] font-semibold text-muted">
        <span>{t("projectAccounts.label")}</span>
        {!context.restricted ? (
          <span className="rounded-full border border-border bg-card px-1.5 py-0.5 text-secondary">
            {t("projectAccounts.any")}
          </span>
        ) : null}
      </div>
      {rows.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {rows.map((account) => {
            const choice = chosen.get(account.accountId);
            return (
              <span
                key={account.accountId}
                title={choice
                  ? t(choice.actor === "agent" ? "projectAccounts.chosenByAgent" : "projectAccounts.chosenByOperator", {
                      label: account.label,
                      at: choice.at,
                    })
                  : carrying.has(account.accountId)
                    ? t("projectAccounts.carryingAria", { label: account.label })
                    : account.accountId}
                {...(carrying.has(account.accountId) ? { "data-project-account-carrying": account.accountId } : {})}
                {...(choice ? { "data-project-account-outside-pool": account.accountId } : {})}
                className={`max-w-full break-words rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                  choice
                    ? "border-warning/45 bg-warning-soft text-warning"
                    : carrying.has(account.accountId)
                      ? "border-accent/45 bg-accent/10 text-primary"
                      : "border-border bg-card text-secondary"
                }`}
              >
                {account.label}
                {carrying.has(account.accountId) ? ` · ${t("projectAccounts.carrying")}` : ""}
                {choice ? ` · ${t("projectAccounts.outsidePool")}` : ""}
              </span>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

/** The Claude sign-in slice for one account row (issue #61). Renders the live
    login phase (browser link + bounded code entry, Cancel), a sanitized failure
    with Retry, or a Sign in / Retry affordance for any account stranded in
    signed_out or error — legacy Main included (issue #470) — and never removes
    the account. Codex rows never mount this (device login owns its own inline
    affordance in AccountRow). */
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

  // Any Claude account stranded in signed_out or error with no live op — legacy
  // Main included (issue #470) — gets an in-place recovery affordance that never
  // removes the account: Sign in when signed out, Retry when a credentialed
  // account is erroring. This also covers a canceled managed sign-in.
  const health = authHealth(account);
  if (health === "signed_out" || health === "error" || !account.authPresent) {
    const label = health === "error" ? t("accounts.retry") : t("accounts.claudeLogin.signIn");
    return (
      <div ref={rowRef} tabIndex={-1} className="flex items-center gap-2 px-3 pb-2 pl-[26px] focus-visible:outline-none">
        <button
          type="button"
          onClick={() => activate(() => void state.retryLogin(account.id))}
          disabled={busy || loginBusy}
          className="inline-flex min-h-[44px] shrink-0 items-center rounded-[7px] border border-border bg-canvas px-2.5 py-0.5 text-[11px] font-semibold hover:bg-sunken disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0"
        >
          {label}
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
    case "terminal": return t("accounts.operation.terminal");
    case "refreshLimits": return t("accounts.operation.refreshLimits");
    case "resetCredit": return t("accounts.operation.resetCredit");
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
  focusAccountId = null,
  quotaOverride,
  projectContext,
}: {
  state: EngineAccountsState;
  onClose: () => void;
  placement?: "footer" | "header";
  /** When set, the panel opens scrolled to and highlighting this account
      (issue #229 — a header account badge steers here). */
  focusAccountId?: string | null;
  quotaOverride?: { accountId: string; quota: ReconciledQuota; now: number };
  projectContext?: ProjectAccountContext;
}) {
  const { t } = useLocale();
  const { accounts, active, status, notice, mutation, engine } = state;
  const [label, setLabel] = useState("");
  const [presentationNow, setPresentationNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (quotaOverride) return;
    const id = setInterval(() => setPresentationNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, [quotaOverride]);
  const quotaNow = quotaOverride?.now ?? presentationNow;
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

  const rows = accounts.map((account) => ({
    account,
    quota: quotaOverride?.accountId === active && account.id === active ? quotaOverride.quota : accountQuota(account, quotaNow),
  }));
  // One label column for the whole list (#1358): a flagship row's longer label
  // widens every card's column, so the meters stay aligned from card to card.
  const wideLabels = rows.some(({ quota }) => quota.flagship !== null);

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
        className={`fixed bottom-3 left-1/2 z-50 flex w-[min(400px,calc(100vw-16px))] -translate-x-1/2 flex-col rounded-[14px] border border-border bg-card shadow-2 ${placementClass}`}
      >
        <header className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: engineTintOf(engine).color }} />
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

        {projectContext ? <ProjectAccountDetail context={projectContext} /> : null}

        {mutation ? (
          <div role="status" aria-live="polite" className="flex items-center gap-2 border-b border-border bg-accent/5 px-3 py-2 text-[11px] font-semibold text-primary">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none text-accent" aria-hidden />
            {operationText(mutation, t)}
          </div>
        ) : null}
          <>
            <div className="max-h-[min(420px,60vh)] divide-y divide-border/40 overflow-y-auto">
              {status === "loading" ? <div className="px-3.5 py-2 text-[11px] text-muted">{t("accounts.loading")}</div> : null}
              {status === "error" && accounts.length === 0 ? <div className="px-3.5 py-2 text-[11px] text-muted">{t("accounts.noAccounts")}</div> : null}
              {rows.map(({ account, quota }) => {
                // The limits block belongs to every account that can be read
                // (credentials present) and to any account that still carries a
                // last-known reading; a fresh managed account awaiting sign-in
                // shows neither numbers nor actions.
                const showLimits = account.authPresent || Boolean(quota.session || quota.weekly || quota.flagship);
                return (
                  <AccountRow key={account.id} account={account} engine={engine} quota={quota} activeId={active} disabled={mutation !== null} focused={account.id === focusAccountId} onSelect={() => void onSelect(account.id)} onRemove={() => void state.remove(account.id)} onCopyCommand={() => void state.copyTerminalCommand(account.id)}>
                    {showLimits ? (
                      <AccountLimitsBlock
                        account={account}
                        engine={engine}
                        quota={quota}
                        now={quotaNow}
                        busy={state.limitsBusy?.accountId === account.id ? state.limitsBusy.operation : null}
                        disabled={mutation !== null || !account.authPresent}
                        wideLabels={wideLabels}
                        onRefresh={() => void state.refreshLimits(account.id)}
                        onUseReset={() => void state.useResetCredit(account.id)}
                      />
                    ) : null}
                    {engine === "claude" ? <ClaudeLoginRow key={account.login?.operationId ?? account.id} account={account} state={state} loginBusy={loginBusy} /> : null}
                  </AccountRow>
                );
              })}
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
                {/* Failure text may carry the server's real error (`detail`), so it
                    wraps to two lines instead of truncating away the cause. */}
                <span className={`min-w-0 flex-1 text-[11px] leading-snug [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden ${notice.kind === "error" ? "text-danger" : "text-muted"}`} title={accountNoticeText(t, notice)}>{accountNoticeText(t, notice)}</span>
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
