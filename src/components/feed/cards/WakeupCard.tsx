"use client";

import { useEffect, useState } from "react";

import { useLocale } from "@/lib/i18n";
import { wakeupPhase } from "@/lib/wakeup";

import { GlyphIcon } from "../../icons";
import { fmtWakeClock, fmtWakeRelative } from "../../wakeupFormat";
import { mdBlocks } from "../markdown";
import { type WakeupEventInfo } from "../parse";

/* Ticks once a second, but only while a wakeup is genuinely counting down — a
   superseded or already-fired card is static, so it never mounts an interval.
   Every active card in the pane shares the same 1s cadence. */
function useWakeupNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * A `ScheduleWakeup` call as a dedicated card: the reason is the visible
 * summary, the absolute fire time carries a live countdown, and the wake plan
 * (the prompt) sits behind an expander as readable text (issue #161). Only the
 * newest wakeup of a conversation is active; a superseded or elapsed one shows
 * a quiet past state.
 */
export function WakeupCard({ wakeup }: { wakeup: WakeupEventInfo }) {
  const { locale, t } = useLocale();
  const { fireAt, superseded, reason, prompt } = wakeup;
  const [nowSeed] = useState(() => Date.now());
  const initiallyPending = !superseded && wakeupPhase(fireAt, nowSeed) === "pending";
  const now = useWakeupNow(initiallyPending);
  const phase = superseded ? "superseded" : wakeupPhase(fireAt, now);
  const active = phase === "pending";

  const clock = fireAt !== null ? fmtWakeClock(fireAt, locale) : "";
  const relative = fireAt !== null && !superseded ? fmtWakeRelative(fireAt, now, t) : "";

  /* The state badge: an amber live countdown while pending, a quiet grey label
     once fired or superseded. */
  const badge = superseded
    ? { text: t("wakeup.superseded"), tone: "text-dim" }
    : phase === "pending"
      ? { text: relative, tone: "text-[#b0791f]" }
      : phase === "fired"
        ? { text: clock ? t("wakeup.firedAt", { time: clock }) : t("wakeup.fired"), tone: "text-dim" }
        : { text: "", tone: "text-dim" };

  const past = fireAt !== null && fireAt <= now;
  const headline = clock ? (past ? t("wakeup.firedAt", { time: clock }) : t("wakeup.wakesAt", { time: clock })) : t("wakeup.noTime");

  const cardTone = active ? "border-[#e4c789] bg-[#fdf7ea]" : "border-line bg-panel";

  return (
    <details className={`group/wake my-2.5 ml-9 overflow-hidden rounded-[14px] border shadow-card ${cardTone}`} open={active}>
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2.5 px-3.5 py-2">
        <span className={`flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg ${active ? "bg-[#f3e2bd] text-[#8a5d12]" : "bg-chip text-dim"}`}>
          <GlyphIcon name="clock" className="h-4 w-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[12.5px] font-semibold" title={reason || headline}>
            {reason || t("wakeup.card")}
          </span>
          <span className="truncate text-[11px] text-dim">{headline}</span>
        </span>
        {badge.text ? (
          <span className={`shrink-0 text-[11px] font-bold tabular-nums ${badge.tone}`}>{badge.text}</span>
        ) : null}
      </summary>
      <div className="border-t border-line px-3.5 py-2.5">
        <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-dim">
          <span className="font-semibold text-ink">{headline}</span>
          {relative ? <span>· {relative}</span> : null}
          {superseded ? <span className="rounded-md bg-chip px-1.5 py-0.5">{t("wakeup.superseded")}</span> : null}
        </div>
        {prompt ? (
          <details className="group/plan rounded-[10px] border border-line bg-panel-alt">
            <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-[11.5px] font-semibold text-dim">
              {t("wakeup.plan")}
            </summary>
            <div className="border-t border-line px-3 py-2 text-[12.5px] leading-snug">{mdBlocks(prompt)}</div>
          </details>
        ) : (
          <span className="text-[11.5px] text-dim">{t("wakeup.noPlan")}</span>
        )}
      </div>
    </details>
  );
}
