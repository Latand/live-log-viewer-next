"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { accountEntryPointVisible, type Engine, useEngineAccounts } from "@/hooks/useEngineAccounts";
import { type Locale, translate, useLocale } from "@/lib/i18n";
import type { EngineLimits, LimitsPayload, LimitWindow } from "@/lib/types";

import { AccountsPanel } from "./AccountsPanel";
import { BurndownPanel } from "./BurndownPanel";
import { ChevronDown, Loader2 } from "./icons";
import { formatResetClock as fmtResetAt, formatResetEta as fmtEta, localeBcp47 as bcp47 } from "./rateLimit";
import { engineTintOf, fmtAge } from "./utils";

const POLL_MS = 60_000;
/** Codex numbers come from the last transcript event; flag them past this age. */
const STALE_S = 20 * 60;

/** Human "as of HH:MM" hint for a stale snapshot. The Codex block renders this
    text alongside the dimming, giving that state a readable reason. */
export function fmtStaleSince(staleSince: string | null | undefined, locale: Locale): string | null {
  if (!staleSince) return null;
  const d = new Date(staleSince);
  if (Number.isNaN(d.getTime())) return null;
  return translate(locale, "limits.asOf", {
    time: d.toLocaleTimeString(bcp47(locale), { hour: "2-digit", minute: "2-digit", hour12: false }),
  });
}

/** Bar keeps the engine identity color while there is headroom, then warns. */
function barColor(leftPercent: number, engineColor: string): string {
  if (leftPercent <= 10) return "#c62828";
  if (leftPercent <= 30) return "#d29a2f";
  return engineColor;
}

function LimitRow({
  label,
  window: w,
  engineColor,
  now,
}: {
  label: string;
  window: LimitWindow | null;
  engineColor: string;
  now: number;
}) {
  const { t } = useLocale();
  if (!w) return null;
  const left = Math.max(0, Math.min(100, 100 - w.usedPercent));
  const color = barColor(left, engineColor);
  return (
    <div className="mt-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold text-ink">{label}</span>
        <span className="text-[11px] text-dim">
          {t("limits.left")} <span className={`font-bold tabular-nums ${left <= 30 ? "" : "text-ink"}`} style={left <= 30 ? { color } : undefined}>{Math.round(left)}%</span>
        </span>
      </div>
      <div className="mt-1 h-[4px] overflow-hidden rounded-full bg-chip">
        <div
          className="h-full rounded-full transition-[width] duration-700 ease-out"
          style={{ width: Math.max(left, 1.5) + "%", backgroundColor: color }}
        />
      </div>
      {w.resetsAt ? (
        <div className="mt-[3px] text-[10px] leading-none text-dim">
          {t("limits.reset", { eta: fmtEta(w.resetsAt, now), at: fmtResetAt(w.resetsAt, now) })}
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
    the header carries the active-account chip (with a live capacity chip) so
    "which account am I on, and how much is left" reads without a click. Renders
    even with no numbers (a freshly switched account) so the entry point never
    disappears — symmetric for Claude and Codex (Fable P9). */
function EngineLimitsBlock({
  engine,
  label,
  limits,
  payloadAccountId,
  now,
  staleHint,
  onSwitched,
}: {
  engine: Engine;
  label: string;
  limits: EngineLimits | null;
  payloadAccountId: string | null;
  now: number;
  staleHint: string | null;
  onSwitched: () => void;
}) {
  const { t } = useLocale();
  const accounts = useEngineAccounts(engine);
  const [open, setOpen] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const chartTriggerRef = useRef<HTMLButtonElement>(null);
  const identityVersion = useRef(accounts.identityVersion);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

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

  if (!accountEntryPointVisible(Boolean(limits), accounts.status)) return null;

  const tint = engineTintOf(engine);
  const accountLimits = limitsForActiveAccount(limits, payloadAccountId, accounts.active);
  const identityPending = Boolean(limits && accountLimits === null);
  const hasWindows = Boolean(accountLimits && (accountLimits.session || accountLimits.weekly));
  const stale = accountLimits?.capturedAt && now - accountLimits.capturedAt > STALE_S ? fmtAge(accountLimits.capturedAt) : null;
  const activeAccount = accounts.accounts.find((account) => account.id === accounts.active);
  const activeLabel = activeAccount?.label ?? t("accounts.trigger");
  const effective = activeAccount?.effective;
  const draining = accounts.migration?.state === "draining";

  return (
    <div ref={containerRef} className="relative">
      <div className={staleHint ? "opacity-60" : ""}>
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
          className="block w-full px-3.5 pb-1.5 pt-2.5 text-left hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <div className="flex items-center gap-1.5">
            <span className="text-[11.5px] font-bold" style={{ color: tint.color }}>{label}</span>
            {accountLimits?.plan ? <span className="truncate text-[10px] text-dim">{accountLimits.plan}</span> : null}
            {staleHint ? <span className="truncate text-[10px] text-dim">{staleHint}</span> : null}
            {stale ? <span className="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-[#d29a2f]" title={t("limits.stale", { stale })} /> : null}
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {effective && effective.freshness !== "unavailable" ? (
                <span
                  className={`rounded-full border border-line bg-bg px-1.5 py-0.5 text-[9.5px] font-bold tabular-nums ${effective.freshness === "stale" ? "opacity-55" : ""}`}
                  style={{ color: barColor(effective.percent, tint.color) }}
                >
                  {t("accounts.effective", { pct: Math.round(effective.percent) })}
                </span>
              ) : null}
              <span className="flex items-center gap-0.5 rounded-full border border-line bg-bg px-1.5 py-0.5 text-[10px] font-semibold text-ink">
                <span className="max-w-24 truncate">{activeLabel}</span>
                {draining ? (
                  <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none text-accent" aria-hidden />
                ) : (
                  <ChevronDown className="h-3 w-3 text-dim" aria-hidden />
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
            className="block w-full px-3.5 pb-3 pt-0.5 text-left hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <LimitRow label={t("limits.5h")} window={accountLimits!.session} engineColor={tint.color} now={now} />
            <LimitRow label={t("limits.week")} window={accountLimits!.weekly} engineColor={tint.color} now={now} />
          </button>
        ) : (
          <div className="px-3.5 pb-3 pt-0.5 text-[10px] text-dim">{accounts.status === "loading" || identityPending ? t("limits.accountLoading") : t("limits.noDataYet")}</div>
        )}
      </div>
      {open ? <AccountsPanel state={accounts} onClose={close} /> : null}
      {chartOpen ? <BurndownPanel key={accounts.active} engine={engine} label={label} plan={accountLimits?.plan ?? null} activeAccountId={accounts.active} onClose={closeChart} /> : null}
    </div>
  );
}

/** Sidebar footer: Claude and Codex plan limits (5h session + weekly). Each
    block is also that engine's account switcher (see {@link EngineLimitsBlock}). */
export function LimitsFooter() {
  const { locale } = useLocale();
  const [snap, setSnap] = useState<{ data: LimitsPayload; at: number } | null>(null);
  /* A switch busts the account-keyed server cache and immediately schedules a
     fresh read through this ref. */
  const loadRef = useRef<() => Promise<void>>(async () => {});
  const invalidateLimits = useCallback(() => void loadRef.current(), []);

  useEffect(() => {
    const loader = createLatestLimitsLoader(fetch, (json) => {
      setSnap((prev) => ({ data: stickyPayload(prev?.data ?? null, json), at: Date.now() / 1000 }));
    });
    const load = async () => { await loader.load(); };
    loadRef.current = load;
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      clearInterval(t);
      loader.dispose();
      loadRef.current = async () => {};
    };
  }, []);

  // Each engine's account list governs its switcher visibility. Both remain
  // mounted through empty limits, initial loading, and account refresh failures.
  const claudeStaleHint = snap ? fmtStaleSince(snap.data.provenance.claude.staleSince, locale) : null;
  const codexStaleHint = snap ? fmtStaleSince(snap.data.provenance.codex.staleSince, locale) : null;
  const now = snap?.at ?? 0;
  return (
    <div className="shrink-0 border-t border-line empty:hidden">
      <EngineLimitsBlock engine="claude" label="Claude" limits={snap?.data.claude ?? null} payloadAccountId={snap?.data.claudeAccountId ?? null} now={now} staleHint={claudeStaleHint} onSwitched={invalidateLimits} />
      <EngineLimitsBlock engine="codex" label="Codex" limits={snap?.data.codex ?? null} payloadAccountId={snap?.data.codexAccountId ?? null} now={now} staleHint={codexStaleHint} onSwitched={invalidateLimits} />
    </div>
  );
}
