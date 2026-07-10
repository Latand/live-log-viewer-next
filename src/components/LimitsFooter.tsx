"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { codexEntryPointVisible, useCodexAccounts } from "@/hooks/useCodexAccounts";
import { getLocale, type Locale, translate, useLocale } from "@/lib/i18n";
import type { EngineLimits, LimitsPayload, LimitsProvenance, LimitWindow } from "@/lib/types";

import { CodexAccountsPanel } from "./CodexAccountsPanel";
import { ChevronDown } from "./icons";
import { engineTintOf, fmtAge } from "./utils";

const POLL_MS = 60_000;
/** Codex numbers come from the last transcript event; flag them past this age. */
const STALE_S = 20 * 60;

const bcp47 = (locale = getLocale()) => (locale === "uk" ? "uk-UA" : "en-US");

function fmtEta(resetsAt: number, now: number): string {
  const locale = getLocale();
  const s = resetsAt - now;
  if (s <= 60) return translate(locale, "limits.now");
  if (s < 5400) return translate(locale, "limits.inMin", { n: Math.round(s / 60) });
  if (s < 129600) return translate(locale, "limits.inHour", { n: Math.round(s / 3600) });
  return translate(locale, "limits.inDay", { n: Math.round(s / 86400) });
}

/** Absolute reset moment: today's resets show the hour, later ones the date too. */
function fmtResetAt(resetsAt: number, now: number): string {
  const d = new Date(resetsAt * 1000);
  const time = d.toLocaleTimeString(bcp47(), { hour: "2-digit", minute: "2-digit", hour12: false });
  if (resetsAt - now < 86400) return time;
  return d.toLocaleDateString(bcp47(), { day: "numeric", month: "short" }) + " " + time;
}

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

function EngineBlock({
  label,
  engine,
  limits,
  now,
  provenance,
}: {
  label: string;
  engine: string;
  limits: EngineLimits | null;
  now: number;
  provenance: LimitsProvenance;
}) {
  const { t } = useLocale();
  if (!limits || (!limits.session && !limits.weekly)) return null;
  const tint = engineTintOf(engine);
  const stale = limits.capturedAt && now - limits.capturedAt > STALE_S ? fmtAge(limits.capturedAt) : null;
  const staleHint = fmtStaleSince(provenance.staleSince, getLocale());
  return (
    <div className={`mt-2.5 first:mt-0 ${staleHint ? "opacity-60" : ""}`}>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[11.5px] font-bold" style={{ color: tint.color }}>
          {label}
        </span>
        {limits.plan ? <span className="truncate text-[10px] text-dim">{limits.plan}</span> : null}
        {staleHint ? <span className="truncate text-[10px] text-dim">{staleHint}</span> : null}
        {stale ? (
          <span
            className="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-[#d29a2f]"
            title={t("limits.stale", { stale })}
          />
        ) : null}
      </div>
      <LimitRow label={t("limits.5h")} window={limits.session} engineColor={tint.color} now={now} />
      <LimitRow label={t("limits.week")} window={limits.weekly} engineColor={tint.color} now={now} />
    </div>
  );
}

/** True only when both payloads name a Codex account and the id changed. A
    freshly added account has no transcripts, so its payload arrives with
    `codex: null`; without this guard the sticky merge would carry the previous
    account's percentages forward under the new account's name. */
function codexAccountChanged(previous: LimitsPayload | null, next: LimitsPayload): boolean {
  if (!previous) return false;
  const prevId = previous.codexAccountId ?? null;
  const nextId = next.codexAccountId ?? null;
  if (prevId === null || nextId === null) return false;
  return prevId !== nextId;
}

export function stickyPayload(previous: LimitsPayload | null, next: LimitsPayload): LimitsPayload {
  const accountChanged = codexAccountChanged(previous, next);
  return {
    claude: next.claude ?? previous?.claude ?? null,
    // A switch clears the prior account's values. Same-account refreshes may
    // retain the last snapshot while provenance explains its freshness.
    codex: accountChanged ? next.codex : (next.codex ?? previous?.codex ?? null),
    codexAccountId: next.codexAccountId ?? previous?.codexAccountId ?? null,
    provenance: next.provenance,
    staleSince: next.staleSince ?? null,
  };
}

/** The Codex limits block doubles as the account switcher: the whole block is a
    button that opens {@link CodexAccountsPanel}, and the header carries the
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

function CodexLimitsBlock({
  limits,
  codexAccountId,
  now,
  staleHint,
  onSwitched,
}: {
  limits: EngineLimits | null;
  codexAccountId: string | null;
  now: number;
  staleHint: string | null;
  onSwitched: () => void;
}) {
  const { t } = useLocale();
  const accounts = useCodexAccounts();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const identityVersion = useRef(accounts.identityVersion);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  // Outside-pointer close only. Escape is owned by the panel's dialog subtree
  // (see CodexAccountsPanel / handleOverlayEscape): routing it through a second
  // window listener here would race the project drawer's window Escape handler,
  // so one press would close both the sheet and the drawer beneath it.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  // Every mounted account surface shares this store. A version bump arrives for
  // both the compact Switchboard selector and the footer panel, including the
  // post-mutation confirmation that can follow an optimistic switch.
  useEffect(() => {
    if (identityVersion.current === accounts.identityVersion) return;
    identityVersion.current = accounts.identityVersion;
    onSwitched();
  }, [accounts.identityVersion, onSwitched]);

  if (!codexEntryPointVisible(Boolean(limits), accounts.status)) return null;

  const tint = engineTintOf("codex");
  const accountLimits = codexLimitsForActiveAccount({ codex: limits, codexAccountId }, accounts.active);
  const identityPending = Boolean(limits && accountLimits === null);
  const hasWindows = Boolean(accountLimits && (accountLimits.session || accountLimits.weekly));
  const stale = accountLimits?.capturedAt && now - accountLimits.capturedAt > STALE_S ? fmtAge(accountLimits.capturedAt) : null;
  const activeLabel = accounts.accounts.find((account) => account.id === accounts.active)?.label ?? t("accounts.trigger");

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t("limits.accountsOpenAria")}
        onClick={() => setOpen((value) => !value)}
        className={`block w-full px-3.5 pb-3 pt-2.5 text-left hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${staleHint ? "opacity-60" : ""}`}
      >
        <div className="flex items-center gap-1.5">
          <span className="text-[11.5px] font-bold" style={{ color: tint.color }}>Codex</span>
          {accountLimits?.plan ? <span className="truncate text-[10px] text-dim">{accountLimits.plan}</span> : null}
          {staleHint ? <span className="truncate text-[10px] text-dim">{staleHint}</span> : null}
          {stale ? (
            <span className="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-[#d29a2f]" title={t("limits.stale", { stale })} />
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-0.5 rounded-full border border-line bg-bg px-1.5 py-0.5 text-[10px] font-semibold text-ink">
            <span className="max-w-24 truncate">{activeLabel}</span>
            <ChevronDown className="h-3 w-3 text-dim" aria-hidden />
          </span>
        </div>
        {hasWindows ? (
          <>
            <LimitRow label={t("limits.5h")} window={accountLimits!.session} engineColor={tint.color} now={now} />
            <LimitRow label={t("limits.week")} window={accountLimits!.weekly} engineColor={tint.color} now={now} />
          </>
        ) : (
          <div className="mt-1.5 text-[10px] text-dim">{accounts.status === "loading" || identityPending ? t("limits.accountLoading") : t("limits.noDataYet")}</div>
        )}
      </button>
      {open ? <CodexAccountsPanel state={accounts} onClose={close} /> : null}
    </div>
  );
}

/** Sidebar footer: Claude Code and Codex plan limits (5h session + weekly). The
    Codex block is also the account switcher (see {@link CodexLimitsBlock}). */
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

  // The Codex account list governs switcher visibility. It remains mounted
  // through empty limits, initial loading, and account refresh failures.
  const codexStaleHint = snap ? fmtStaleSince(snap.data.provenance.codex.staleSince, locale) : null;
  const now = snap?.at ?? 0;
  return (
    <div className="shrink-0 border-t border-line empty:hidden">
      {snap?.data.claude ? (
        <div className="px-3.5 pt-2.5">
          <EngineBlock label="Claude" engine="claude" limits={snap.data.claude} now={now} provenance={snap.data.provenance.claude} />
        </div>
      ) : null}
      <CodexLimitsBlock limits={snap?.data.codex ?? null} codexAccountId={snap?.data.codexAccountId ?? null} now={now} staleHint={codexStaleHint} onSwitched={invalidateLimits} />
    </div>
  );
}
