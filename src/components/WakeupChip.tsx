"use client";

import { useEffect, useState } from "react";

import { useLocale } from "@/lib/i18n";
import type { PendingWakeup } from "@/lib/types";

import { AlarmClock } from "./icons";
import { fmtWakeClock, fmtWakeMagnitude } from "./wakeupFormat";

/* The board timer chip (issue #161 §3): "⏰ 12 min" on a conversation card /
   scheme node, so an idle-looking orchestrator reads as sleeping until a known
   time. It re-reads the clock every 30 seconds and removes itself on the first
   tick at or after the fire time, so a stale server snapshot clears from the
   board within one cadence instead of lingering as a phantom countdown.

   Interactive (default): a real button carrying the reason behind a hover title
   AND a tap disclosure, with an invisible 44px hit area so touch users can
   reveal it on a comfortable target. It stops its own key/pointer events from
   reaching the surrounding card so activating the chip never opens the
   conversation (issue #161 review). `interactive={false}` renders a passive,
   focus-free visual chip for always-hidden hosts like the far-zoom label. */
export function WakeupChip({ wakeup, className, interactive = true }: { wakeup?: PendingWakeup | null; className?: string; interactive?: boolean }) {
  const { locale, t } = useLocale();
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const fireAt = wakeup?.fireAt ?? 0;
  const pending = Boolean(wakeup) && fireAt > now;
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [pending]);
  if (!wakeup || !pending) return null;
  const clock = fmtWakeClock(fireAt, locale);
  const magnitude = fmtWakeMagnitude(fireAt - now, t);
  const label = t("wakeup.chipTitle", { time: clock, reason: wakeup.reason || t("wakeup.card") });
  const face = (
    <>
      <AlarmClock className="h-3 w-3" aria-hidden />
      {magnitude}
    </>
  );
  const chrome = "inline-flex items-center gap-1 rounded-full border border-[#e4c789] bg-[#fdf5e3] px-2 py-0.5 text-[10px] font-bold text-[#8a5d12]";

  /* A passive chip for always-hidden hosts (far-zoom label): no button, no
     focus, no handlers — a purely visual token. */
  if (!interactive) {
    return (
      <span data-wakeup className={`${chrome} shrink-0 ${className ?? ""}`} aria-hidden>
        {face}
      </span>
    );
  }

  return (
    <span className={`relative inline-flex shrink-0 ${className ?? ""}`}>
      <button
        type="button"
        data-wakeup
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => e.stopPropagation()}
        onKeyUp={(e) => e.stopPropagation()}
        onBlur={() => setOpen(false)}
        className={`relative ${chrome} after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
      >
        {face}
      </button>
      {open ? (
        <span role="tooltip" className="absolute left-0 top-full z-20 mt-1 max-w-[240px] whitespace-normal rounded-lg border border-line bg-panel px-2.5 py-1.5 text-[11px] font-normal leading-snug text-ink shadow-card">
          {label}
        </span>
      ) : null}
    </span>
  );
}
