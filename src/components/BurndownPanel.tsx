"use client";

import { useEffect, useRef, useState } from "react";

import { burndownForActiveAccount, computePace, idealRemaining, type WindowKey } from "@/lib/burndown";
import { getLocale, useLocale } from "@/lib/i18n";
import { handleOverlayEscape } from "@/lib/overlay";
import type { BurndownPayload, BurndownSeries } from "@/lib/types";

import { X } from "./icons";
import { engineTintOf } from "./utils";

const VB_W = 320;
const VB_H = 150;
const PAD = { l: 4, r: 4, t: 8, b: 4 };
const PW = VB_W - PAD.l - PAD.r;
const PH = VB_H - PAD.t - PAD.b;

/** Same amber-<30% / red-<10% thresholds the footer bars use; above that the
    curve keeps the engine's identity tint. */
function paceColor(remaining: number, tint: string): string {
  if (remaining <= 10) return "#c62828";
  if (remaining <= 30) return "#d29a2f";
  return tint;
}

function bcp47(): string {
  return getLocale() === "uk" ? "uk-UA" : "en-US";
}

/** Short absolute moment for the depletion projection: hour today, else + date. */
function fmtMoment(unix: number, now: number): string {
  const d = new Date(unix * 1000);
  const time = d.toLocaleTimeString(bcp47(), { hour: "2-digit", minute: "2-digit", hour12: false });
  if (Math.abs(unix - now) < 86400) return time;
  return d.toLocaleDateString(bcp47(), { day: "numeric", month: "short" }) + " " + time;
}

/** The SVG plot: ideal even-pace diagonal (dashed, muted) vs the actual
    remaining-quota curve (solid, engine-tinted), with a "now" marker. Stretches
    to the panel width; non-scaling strokes keep the lines crisp. */
function BurndownChart({ series, tint, now }: { series: BurndownSeries; tint: string; now: number }) {
  const { windowStart, resetsAt, windowSeconds, samples } = series;
  const x0 = windowStart ?? samples[0]?.t ?? now - windowSeconds;
  const x1 = resetsAt ?? Math.max(now, samples[samples.length - 1]?.t ?? now);
  const span = x1 > x0 ? x1 - x0 : 1;
  const xScale = (t: number) => PAD.l + (Math.max(x0, Math.min(x1, t)) - x0) / span * PW;
  const yScale = (pct: number) => PAD.t + (100 - Math.max(0, Math.min(100, pct))) / 100 * PH;

  const idealPath =
    windowStart !== null && resetsAt !== null
      ? `M ${xScale(windowStart).toFixed(2)},${yScale(idealRemaining(windowStart, resetsAt, x0)).toFixed(2)} L ${xScale(resetsAt).toFixed(2)},${yScale(idealRemaining(windowStart, resetsAt, x1)).toFixed(2)}`
      : null;
  const actualPath = samples.length
    ? samples.map((s, i) => `${i === 0 ? "M" : "L"} ${xScale(s.t).toFixed(2)},${yScale(s.remaining).toFixed(2)}`).join(" ")
    : null;
  const latest = samples[samples.length - 1] ?? null;
  const curveColor = latest ? paceColor(latest.remaining, tint) : tint;
  const nowX = xScale(now);

  return (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none" className="h-[150px] w-full" role="img">
      {/* Plot frame + 50% guide */}
      <rect x={PAD.l} y={PAD.t} width={PW} height={PH} className="fill-none stroke-line" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <line x1={PAD.l} y1={yScale(50)} x2={PAD.l + PW} y2={yScale(50)} className="stroke-line" strokeWidth={1} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" opacity={0.6} />
      {idealPath ? (
        <path d={idealPath} className="fill-none stroke-dim" strokeWidth={1.5} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" opacity={0.7} />
      ) : null}
      {actualPath ? (
        <path d={actualPath} fill="none" stroke={curveColor} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      ) : null}
      {latest ? <circle cx={xScale(latest.t)} cy={yScale(latest.remaining)} r={2.5} fill={curveColor} vectorEffect="non-scaling-stroke" /> : null}
      {now > x0 && now < x1 ? (
        <line x1={nowX} y1={PAD.t} x2={nowX} y2={PAD.t + PH} className="stroke-accent" strokeWidth={1} strokeDasharray="1 2" vectorEffect="non-scaling-stroke" opacity={0.7} />
      ) : null}
    </svg>
  );
}

/** Floating burndown panel for one engine, anchored off the rail like the
    cleanup panel: ideal-pace vs actual-consumption for the 5h and weekly
    windows. Opened from {@link LimitsFooter}; closed via ✕/Esc/outside click
    (owned by the caller). */
export function BurndownPanel({
  engine,
  label,
  plan,
  activeAccountId,
  onClose,
}: {
  engine: "claude" | "codex";
  label: string;
  plan: string | null;
  /** The account the footer block is showing; a history response for any other
      account is discarded so a switch never charts the previous account. */
  activeAccountId: string;
  onClose: () => void;
}) {
  const { t, locale } = useLocale();
  const [data, setData] = useState<BurndownPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const [window, setWindow] = useState<WindowKey>("weekly");
  const [now] = useState(() => Math.round(Date.now() / 1000));
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // One fetch per mount. LimitsFooter keys this panel by the active account, so a
  // switch remounts it and re-fetches with fresh state; the cleanup's `alive`
  // flag drops a response that arrives after that switch. The render-time
  // ownership gate below is the second guard for an in-flight account race.
  useEffect(() => {
    let alive = true;
    fetch("/api/limits/history")
      .then((res) => (res.ok ? (res.json() as Promise<BurndownPayload>) : Promise.reject(new Error(String(res.status)))))
      .then((json) => {
        if (alive) setData(json);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const engineData = burndownForActiveAccount(data, engine, activeAccountId);
  // A response whose account stamp no longer matches is treated as not-yet-loaded
  // so a stale-account curve never shows; the effect above will refetch.
  const ownershipPending = Boolean(data && !engineData);
  const series = engineData ? engineData[window] : null;
  const tint = engineTintOf(engine).color;
  const hasData = Boolean(series && series.samples.length > 0);
  const pace = series ? computePace(series, now) : null;

  const paceText = (() => {
    if (!pace) return null;
    if (pace.delta < -2) return t("burndown.fast", { pct: Math.round(-pace.delta) });
    if (pace.delta > 2) return t("burndown.slow", { pct: Math.round(pace.delta) });
    return t("burndown.even");
  })();
  const projectText = pace?.zeroCrossing ? t("burndown.emptyBy", { at: fmtMoment(pace.zeroCrossing, now) }) : null;
  const sinceText =
    engine === "claude" && !hasData && data?.historySince
      ? t("burndown.buildsFrom", { date: new Date(data.historySince).toLocaleDateString(locale === "uk" ? "uk-UA" : "en-US", { day: "numeric", month: "short" }) })
      : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("burndown.openAria", { engine: label })}
      tabIndex={-1}
      onKeyDown={(event) => handleOverlayEscape(event, onClose)}
      className="fixed bottom-3 left-1/2 z-50 flex w-[min(430px,calc(100vw-16px))] -translate-x-1/2 flex-col rounded-[12px] border border-line bg-panel shadow-[0_8px_28px_rgba(20,20,30,0.14)] sm:absolute sm:bottom-1 sm:left-full sm:ml-2 sm:translate-x-0"
    >
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-[12.5px] font-bold" style={{ color: tint }}>{label}</span>
        <span className="text-[11px] text-dim">{t("burndown.title")}</span>
        {plan ? <span className="truncate text-[10px] text-dim">{plan}</span> : null}
        <div className="ml-auto flex items-center gap-1">
          <div className="flex rounded-[8px] border border-line p-0.5" role="tablist" aria-label={t("burndown.windowAria")}>
            {(["weekly", "session"] as const).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={window === key}
                onClick={() => setWindow(key)}
                className={`rounded-[6px] px-2 py-0.5 text-[10.5px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${window === key ? "bg-chip text-ink" : "text-dim hover:text-ink"}`}
              >
                {t(key === "weekly" ? "limits.week" : "limits.5h")}
              </button>
            ))}
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label={t("burndown.close")}
            onClick={onClose}
            className="rounded-[6px] p-1 text-dim hover:bg-bg hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </header>
      <div className="px-3 py-2.5">
        {failed ? (
          <div className="py-6 text-center text-[12px] text-dim">{t("burndown.failed")}</div>
        ) : !data || ownershipPending ? (
          <div className="py-6 text-center text-[12px] text-dim">{t("burndown.loading")}</div>
        ) : hasData && series ? (
          <>
            <BurndownChart series={series} tint={tint} now={now} />
            <div className="mt-1.5 flex items-center justify-between text-[10px] text-dim">
              <span className="flex items-center gap-1">
                <span className="inline-block h-0 w-3 border-t-2 border-dashed border-dim" aria-hidden />
                {t("burndown.ideal")}
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-0 w-3 border-t-2" style={{ borderColor: tint }} aria-hidden />
                {t("burndown.actual")}
              </span>
            </div>
            {paceText ? (
              <div className="mt-2 text-[11.5px] font-semibold text-ink">
                {paceText}
                {projectText ? <span className="ml-1 font-normal text-dim">· {projectText}</span> : null}
              </div>
            ) : null}
          </>
        ) : (
          <div className="py-6 text-center text-[12px] text-dim">
            {t("burndown.empty")}
            {sinceText ? <div className="mt-1 text-[11px]">{sinceText}</div> : null}
          </div>
        )}
      </div>
    </div>
  );
}
