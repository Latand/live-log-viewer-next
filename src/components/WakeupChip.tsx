"use client";

import { useEffect, useState } from "react";

import { useLocale } from "@/lib/i18n";
import type { PendingWakeup } from "@/lib/types";

import { AlarmClock } from "./icons";
import { fmtWakeClock, fmtWakeMagnitude } from "./wakeupFormat";

/* The board timer chip (issue #161 §3): "⏰ 12 min" on a conversation card /
   scheme node, so an idle-looking orchestrator reads as sleeping until a known
   time. Ticks once a minute; hides itself the moment the fire time passes so a
   stale server snapshot never leaves a phantom countdown on the board.

   It is a real button, not a bare span: the reason lives behind hover title AND
   a tap disclosure so touch users can reveal it, and an invisible 44px hit area
   keeps the compact chip a comfortable mobile target (issue #161 review). */
export function WakeupChip({ wakeup, className }: { wakeup?: PendingWakeup | null; className?: string }) {
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
        onBlur={() => setOpen(false)}
        className="relative inline-flex items-center gap-1 rounded-full border border-[#e4c789] bg-[#fdf5e3] px-2 py-0.5 text-[10px] font-bold text-[#8a5d12] after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <AlarmClock className="h-3 w-3" aria-hidden />
        {magnitude}
      </button>
      {open ? (
        <span role="tooltip" className="absolute left-0 top-full z-20 mt-1 max-w-[240px] whitespace-normal rounded-lg border border-line bg-panel px-2.5 py-1.5 text-[11px] font-normal leading-snug text-ink shadow-card">
          {label}
        </span>
      ) : null}
    </span>
  );
}
