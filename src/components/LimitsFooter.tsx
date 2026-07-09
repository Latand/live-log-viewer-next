"use client";

import { useEffect, useState } from "react";

import { getLocale, type Locale, translate, useLocale } from "@/lib/i18n";
import type { EngineLimits, LimitsPayload, LimitsProvenance, LimitWindow } from "@/lib/types";

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

function fmtStaleSince(staleSince: string | null | undefined, locale: Locale): string | null {
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

export function stickyPayload(previous: LimitsPayload | null, next: LimitsPayload): LimitsPayload {
  if (!previous) return next;
  const sameCodexAccount = previous.codexAccountId === next.codexAccountId;
  return {
    claude: next.claude ?? previous?.claude ?? null,
    codex: sameCodexAccount ? next.codex ?? previous.codex : next.codex,
    codexAccountId: next.codexAccountId,
    provenance: {
      claude: next.claude ? next.provenance.claude : previous.provenance.claude,
      codex: sameCodexAccount && !next.codex ? previous.provenance.codex : next.provenance.codex,
    },
    staleSince: next.staleSince ?? null,
  };
}

/** Sidebar footer: Claude Code and Codex plan limits (5h session + weekly). */
export function LimitsFooter() {
  const [snap, setSnap] = useState<{ data: LimitsPayload; at: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/limits");
        if (!res.ok) return;
        const json = (await res.json()) as LimitsPayload;
        if (alive) {
          setSnap((prev) => ({ data: stickyPayload(prev?.data ?? null, json), at: Date.now() / 1000 }));
        }
      } catch {
        /* keep previous numbers */
      }
    };
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!snap || (!snap.data.claude && !snap.data.codex)) return null;
  return (
    <div className="shrink-0 border-t border-line px-3.5 pb-3 pt-2.5">
      <EngineBlock label="Claude" engine="claude" limits={snap.data.claude} now={snap.at} provenance={snap.data.provenance.claude} />
      <EngineBlock label="Codex" engine="codex" limits={snap.data.codex} now={snap.at} provenance={snap.data.provenance.codex} />
    </div>
  );
}
