"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { accountEntryPointVisible, type Engine, useEngineAccounts } from "@/hooks/useEngineAccounts";
import { consumePendingAccountPanel, onAccountPanelRequest } from "@/lib/accounts/openPanel";
import { claudeTierDisplayName } from "@/lib/agent/models";
import { type Locale, translate, useLocale } from "@/lib/i18n";
import { effectiveQuota, LIMITS_FRESHNESS_S, quotaAsEngineLimits, quotaReadingFromAccountLimits, quotaReadingFromEngineLimits, reconcileQuotaReadings } from "@/lib/rateLimit";
import { LIMITS_RATE_LIMITED_REASON, LIMITS_REAUTH_REQUIRED_REASON, type EngineLimits, type LimitsPayload, type LimitsProvenance, type LimitWindow } from "@/lib/types";

import { AccountsPanel } from "./AccountsPanel";
import { BurndownPanel } from "./BurndownPanel";
import { TelegramFooterRow } from "./TelegramConnect";
import { ChevronDown, Loader2 } from "./icons";
import { formatQuotaAsOf, formatResetClock as fmtResetAt, formatResetEta as fmtEta, localeBcp47 as bcp47, windowLabel } from "./rateLimit";
import { engineTintOf, fmtAge } from "./utils";

const POLL_MS = 60_000;

/** Human "as of HH:MM" hint for a stale snapshot. The Codex block renders this
    text alongside the dimming, giving that state a readable reason. */
export function fmtStaleSince(staleSince: string | null | undefined, locale: Locale): string | null {
  return formatQuotaAsOf(staleSince, locale);
}

export function fmtQuotaStaleHint(stale: boolean, observedAt: number | null, locale: Locale): string | null {
  if (!stale) return null;
  return formatQuotaAsOf(observedAt, locale) ?? translate(locale, "accounts.limitsStale");
}

export function fmtLimitsFailureReason(meta: LimitsProvenance, locale: Locale): string | null {
  if (meta.source !== "unavailable" && meta.source !== "cache") return null;
  if (meta.reason === LIMITS_REAUTH_REQUIRED_REASON) return translate(locale, "limits.reauthRequired");
  if (meta.reason !== LIMITS_RATE_LIMITED_REASON || !meta.retryAt) return null;
  const retryAt = new Date(meta.retryAt);
  if (Number.isNaN(retryAt.getTime())) return translate(locale, "limits.rateLimited");
  return translate(locale, "limits.rateLimitedRetry", {
    time: retryAt.toLocaleTimeString(bcp47(locale), { hour: "2-digit", minute: "2-digit", hour12: false }),
  });
}

/** Bar keeps the engine identity color while there is headroom, then warns. */
function barColor(leftPercent: number, engineColor: string): string {
  if (leftPercent <= 10) return "var(--color-danger)";
  if (leftPercent <= 30) return "var(--color-warning)";
  return engineColor;
}

function LimitRow({
  label,
  window: w,
  engineColor,
  now,
  staleHint,
}: {
  label: string;
  window: LimitWindow | null;
  engineColor: string;
  now: number;
  staleHint?: string | null;
}) {
  const { t } = useLocale();
  if (!w) return null;
  const left = Math.max(0, Math.min(100, 100 - w.usedPercent));
  const color = barColor(left, engineColor);
  return (
    <div className="mt-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold text-primary">{label}</span>
        <span className="text-[11px] text-muted">
          {t("limits.left")} <span className={`font-bold tabular-nums ${left <= 30 ? "" : "text-primary"}`} style={left <= 30 ? { color } : undefined}>{Math.round(left)}%</span>
        </span>
      </div>
      <div className="mt-1 h-[4px] overflow-hidden rounded-full bg-sunken">
        <div
          className="h-full rounded-full transition-[width] duration-700 ease-out"
          style={{ width: Math.max(left, 1.5) + "%", backgroundColor: color }}
        />
      </div>
      {w.resetsAt || staleHint ? (
        <div className="mt-[3px] text-[10px] leading-none text-muted">
          {w.resetsAt ? t("limits.reset", { eta: fmtEta(w.resetsAt, now), at: fmtResetAt(w.resetsAt, now) }) : null}
          {w.resetsAt && staleHint ? " · " : null}
          {staleHint}
        </div>
      ) : null}
    </div>
  );
}

/** True only when both payloads name a Codex account and the id changed. A
    freshly added account has no transcripts, so its payload arrives with
    `codex: null`; without this guard the sticky merge would carry the previous
    account's percentages forward under the new account's name. */
function accountChanged(previous: LimitsPayload | null, next: LimitsPayload, engine: "claude" | "codex"): boolean {
  if (!previous) return false;
  const prevId = engine === "claude" ? previous.claudeAccountId ?? null : previous.codexAccountId ?? null;
  const nextId = engine === "claude" ? next.claudeAccountId ?? null : next.codexAccountId ?? null;
  if (prevId === null || nextId === null) return false;
  return prevId !== nextId;
}

export function stickyPayload(previous: LimitsPayload | null, next: LimitsPayload): LimitsPayload {
  const claudeChanged = accountChanged(previous, next, "claude");
  const codexChanged = accountChanged(previous, next, "codex");
  return {
    claude: claudeChanged ? next.claude : (next.claude ?? previous?.claude ?? null),
    // A switch clears the prior account's values. Same-account refreshes may
    // retain the last snapshot while provenance explains its freshness.
    codex: codexChanged ? next.codex : (next.codex ?? previous?.codex ?? null),
    claudeAccountId: next.claudeAccountId ?? previous?.claudeAccountId ?? null,
    codexAccountId: next.codexAccountId ?? previous?.codexAccountId ?? null,
    provenance: next.provenance,
    staleSince: next.staleSince ?? null,
  };
}

/** The Codex limits block doubles as the account switcher: the whole block is a
    button that opens the unified {@link AccountsPanel}, and the header carries the
    active account chip so "which account am I on" reads without a click. It
    renders even with no Codex numbers (a freshly switched account) so the entry
    point never disappears. */
/** Masks Codex values until the payload explicitly names the active account.
    A stale request can still complete, while its quota values stay detached from
    the visible account until a payload with the same identity arrives. */
export function codexLimitsForActiveAccount(payload: Pick<LimitsPayload, "codex" | "codexAccountId"> | null, activeAccountId: string): EngineLimits | null {
  if (!payload?.codex || !activeAccountId || payload.codexAccountId !== activeAccountId) return null;
  return payload.codex;
}

/** Engine-symmetric masking gate: the same account-ownership stamp check for
    either engine, so a stale limits response never renders one account's
    percentages under another account's label (Fable/Sol invariant 19). */
export function limitsForActiveAccount(limits: EngineLimits | null, payloadAccountId: string | null, activeAccountId: string): EngineLimits | null {
  if (!limits || !activeAccountId || payloadAccountId !== activeAccountId) return null;
  return limits;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** A single latest-request-wins limits channel. Abort improves resource use;
    the generation check also protects callers whose fetch implementation still
    resolves an aborted response. */
export function createLatestLimitsLoader(fetcher: Fetcher, onPayload: (payload: LimitsPayload) => void) {
  let generation = 0;
  let controller: AbortController | null = null;
  return {
    async load(): Promise<boolean> {
      controller?.abort();
      const requestGeneration = ++generation;
      controller = new AbortController();
      try {
        const response = await fetcher("/api/limits", { signal: controller.signal });
        if (!response.ok) return false;
        const payload = await response.json() as LimitsPayload;
        if (requestGeneration !== generation) return false;
        controller = null;
        onPayload(payload);
        return true;
      } catch {
        return false;
      }
    },
    dispose() {
      generation += 1;
      controller?.abort();
      controller = null;
    },
  };
}

/** One engine's limits block, doubling as its account switcher: the whole block
    is a button opening the unified {@link AccountsPanel} for that engine, and
    the header carries the active-account chip from the reconciled windows so
    "which account am I on, and how much is left" reads without a click. Renders
    even with no numbers (a freshly switched account) so the entry point never
    disappears — symmetric for Claude and Codex (Fable P9). */
function EngineLimitsBlock({
  engine,
  label,
  limits,
  payloadAccountId,
  now,
  receivedAt,
  provenance,
  onSwitched,
}: {
  engine: Engine;
  label: string;
  limits: EngineLimits | null;
  payloadAccountId: string | null;
  now: number;
  receivedAt: number;
  provenance: LimitsProvenance;
  onSwitched: () => void;
}) {
  const { locale, t } = useLocale();
  const accounts = useEngineAccounts(engine);
  const [open, setOpen] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);
  const [focusAccountId, setFocusAccountId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const chartTriggerRef = useRef<HTMLButtonElement>(null);
  const identityVersion = useRef(accounts.identityVersion);

  const close = () => {
    setOpen(false);
    setFocusAccountId(null);
    triggerRef.current?.focus();
  };

  // A tapped account badge (issue #229) asks this engine's panel to open focused
  // on one account. Desktop: this block is always mounted, so the window event
  // lands directly. Mobile: it mounts with the project drawer, so a request
  // dispatched a moment earlier is claimed from the retained pending slot here.
  useEffect(() => {
    const openFocused = (accountId: string) => {
      setChartOpen(false);
      setFocusAccountId(accountId);
      setOpen(true);
    };
    const pending = consumePendingAccountPanel(engine);
    if (pending) openFocused(pending.accountId);
    return onAccountPanelRequest((request) => {
      if (request.engine === engine) openFocused(request.accountId);
    });
  }, [engine]);

  const closeChart = () => {
    setChartOpen(false);
    chartTriggerRef.current?.focus();
  };

  // Outside-pointer close only. Escape is owned by the panel's dialog subtree
  // (see AccountsPanel / handleOverlayEscape): routing it through a second
  // window listener here would race the project drawer's window Escape handler,
  // so one press would close both the sheet and the drawer beneath it.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  // Outside-pointer close only. Escape is owned by the chart's own dialog subtree
  // (BurndownPanel routes it through handleOverlayEscape), so it never races the
  // project drawer's window Escape handler — one press closes only the chart.
  // The panel renders inside containerRef, so clicks inside it are "contained"
  // and never self-close it.
  useEffect(() => {
    if (!chartOpen) return;
    const onDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setChartOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [chartOpen]);

  // Every mounted account surface of this engine shares one store. A version
  // bump arrives for both the compact Switchboard selector and the footer panel,
  // including the post-mutation confirmation that can follow an optimistic switch.
  useEffect(() => {
    if (identityVersion.current === accounts.identityVersion) return;
    identityVersion.current = accounts.identityVersion;
    onSwitched();
  }, [accounts.identityVersion, onSwitched]);

  // A per-card re-read or a redeemed reset credit (#1418, #1373) produced a
  // newer reading than this block's own payload; the route dropped the
  // server-side cache for that account, so one reload brings the footer level
  // with the card instead of waiting out the poll.
  const limitsVersion = useRef(accounts.limitsVersion);
  useEffect(() => {
    if (limitsVersion.current === accounts.limitsVersion) return;
    limitsVersion.current = accounts.limitsVersion;
    onSwitched();
  }, [accounts.limitsVersion, onSwitched]);

  if (!accountEntryPointVisible(Boolean(limits), accounts.status)) return null;

  const tint = engineTintOf(engine);
  const payloadLimits = limitsForActiveAccount(limits, payloadAccountId, accounts.active);
  const identityPending = Boolean(limits && payloadLimits === null);
  const activeAccount = accounts.accounts.find((account) => account.id === accounts.active);
  const quota = reconcileQuotaReadings(
    quotaReadingFromEngineLimits(payloadLimits, provenance, receivedAt),
    quotaReadingFromAccountLimits(activeAccount?.limits),
    now,
  );
  const accountLimits = quotaAsEngineLimits(quota);
  const hasWindows = Boolean(accountLimits && (accountLimits.session || accountLimits.weekly || accountLimits.flagship));
  const stale = accountLimits?.capturedAt && now - accountLimits.capturedAt > LIMITS_FRESHNESS_S ? fmtAge(accountLimits.capturedAt) : null;
  const activeLabel = activeAccount?.label ?? t("accounts.trigger");
  const effective = effectiveQuota(quota);
  const effectiveStaleHint = fmtQuotaStaleHint(Boolean(effective?.stale), effective?.observedAt ?? null, locale);
  const anyStale = Boolean(quota.session?.stale || quota.weekly?.stale || quota.flagship?.stale);
  const draining = accounts.migration?.state === "draining";
  const failureReason = fmtLimitsFailureReason(provenance, locale);
  const visibleFailureReason = accounts.status === "loading" || identityPending ? null : failureReason;

  return (
    <div ref={containerRef} className="relative">
      <div className={anyStale ? "opacity-60" : ""}>
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={t("accounts.triggerAria", { engine: label })}
          onClick={() => {
            setChartOpen(false);
            setOpen((value) => !value);
          }}
          className="block w-full px-3.5 pb-1.5 pt-2.5 text-left hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <div className="flex items-center gap-1.5">
            <span className="text-[11.5px] font-bold" style={{ color: tint.color }}>{label}</span>
            {accountLimits?.plan ? <span className="truncate text-[10px] text-muted">{accountLimits.plan}</span> : null}
            {effectiveStaleHint ? <span className="truncate text-[10px] text-muted">{effectiveStaleHint}</span> : null}
            {stale ? <span className="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-warning" title={t("limits.stale", { stale })} /> : null}
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {effective ? (
                <span
                  className={`rounded-full border border-border bg-canvas px-1.5 py-0.5 text-[9.5px] font-bold tabular-nums ${effective.stale ? "opacity-55" : ""}`}
                  style={{ color: barColor(effective.percent, tint.color) }}
                >
                  {t("accounts.effective", { pct: Math.round(effective.percent) })}
                </span>
              ) : null}
              <span className="flex items-center gap-0.5 rounded-full border border-border bg-canvas px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                <span className="max-w-24 truncate">{activeLabel}</span>
                {draining ? (
                  <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none text-accent" aria-hidden />
                ) : (
                  <ChevronDown className="h-3 w-3 text-muted" aria-hidden />
                )}
              </span>
            </span>
          </div>
        </button>
        {hasWindows ? (
          <button
            ref={chartTriggerRef}
            type="button"
            aria-expanded={chartOpen}
            aria-haspopup="dialog"
            aria-label={t("burndown.openAria", { engine: label })}
            onClick={() => {
              setOpen(false);
              setChartOpen((value) => !value);
            }}
            className={`block w-full px-3.5 pt-0.5 text-left hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${visibleFailureReason ? "pb-1.5" : "pb-3"}`}
          >
            <LimitRow label={windowLabel(t, "session", accountLimits!.session?.windowMinutes)} window={accountLimits!.session} engineColor={tint.color} now={now} staleHint={fmtQuotaStaleHint(Boolean(quota.session?.stale), quota.session?.observedAt ?? null, locale)} />
            <LimitRow label={windowLabel(t, "weekly", accountLimits!.weekly?.windowMinutes)} window={accountLimits!.weekly} engineColor={tint.color} now={now} staleHint={fmtQuotaStaleHint(Boolean(quota.weekly?.stale), quota.weekly?.observedAt ?? null, locale)} />
            {/* The flagship tier's own weekly (#1358): rendered only when the
                account reports a distinct bucket, named by the provider's tier. */}
            {accountLimits!.flagship ? (
              <LimitRow label={t("limits.tierWeek", { tier: claudeTierDisplayName(accountLimits!.flagship.tier) })} window={accountLimits!.flagship} engineColor={tint.color} now={now} staleHint={fmtQuotaStaleHint(Boolean(quota.flagship?.stale), quota.flagship?.observedAt ?? null, locale)} />
            ) : null}
          </button>
        ) : visibleFailureReason ? null : (
          <div className="px-3.5 pb-3 pt-0.5 text-[10px] text-muted">{accounts.status === "loading" || identityPending ? t("limits.accountLoading") : t("limits.noDataYet")}</div>
        )}
        {visibleFailureReason ? <div className="px-3.5 pb-3 pt-0.5 text-[10px] text-muted">{visibleFailureReason}</div> : null}
      </div>
      {open ? <AccountsPanel state={accounts} onClose={close} focusAccountId={focusAccountId} quotaOverride={{ accountId: accounts.active, quota, now }} /> : null}
      {chartOpen ? <BurndownPanel key={accounts.active} engine={engine} label={label} plan={accountLimits?.plan ?? null} activeAccountId={accounts.active} onClose={closeChart} /> : null}
    </div>
  );
}

/** Sidebar footer: Claude and Codex plan limits (5h session + weekly). Each
    block is also that engine's account switcher (see {@link EngineLimitsBlock}). */
export function LimitsFooter() {
  const [snap, setSnap] = useState<{ data: LimitsPayload; at: number } | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);
  /* A switch busts the account-keyed server cache and immediately schedules a
     fresh read through this ref. */
  const loadRef = useRef<() => Promise<void>>(async () => {});
  const invalidateLimits = useCallback(() => void loadRef.current(), []);

  useEffect(() => {
    let active = true;
    const loader = createLatestLimitsLoader(fetch, (json) => {
      setSnap((prev) => ({ data: stickyPayload(prev?.data ?? null, json), at: Date.now() / 1000 }));
    });
    const load = async () => {
      await loader.load();
      if (active) setNow(Date.now() / 1000);
    };
    loadRef.current = load;
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      active = false;
      clearInterval(t);
      loader.dispose();
      loadRef.current = async () => {};
    };
  }, []);

  // Each engine's account list governs its switcher visibility. Both remain
  // mounted through empty limits, initial loading, and account refresh failures.
  return (
    <div className="shrink-0 border-t border-border empty:hidden">
      <EngineLimitsBlock engine="claude" label="Claude" limits={snap?.data.claude ?? null} payloadAccountId={snap?.data.claudeAccountId ?? null} now={now} receivedAt={snap?.at ?? now} provenance={snap?.data.provenance.claude ?? { source: "unavailable", reason: null, staleSince: null }} onSwitched={invalidateLimits} />
      <EngineLimitsBlock engine="codex" label="Codex" limits={snap?.data.codex ?? null} payloadAccountId={snap?.data.codexAccountId ?? null} now={now} receivedAt={snap?.at ?? now} provenance={snap?.data.provenance.codex ?? { source: "unavailable", reason: null, staleSince: null }} onSwitched={invalidateLimits} />
      {/* The personal Telegram connector row (issue #1059) sits beside the
          account controls; the entry point never disappears. */}
      <TelegramFooterRow />
    </div>
  );
}
