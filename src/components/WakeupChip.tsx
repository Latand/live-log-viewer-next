"use client";

import { useEffect, useState } from "react";

import { useLocale } from "@/lib/i18n";
import type { PendingWakeup } from "@/lib/types";

import { AlarmClock } from "./icons";
import { fmtWakeClock, fmtWakeMagnitude } from "./wakeupFormat";

/* The board timer chip (issue #161 §3): "⏰ 12 min" on a conversation card /
   scheme node, so an idle-looking orchestrator reads as sleeping until a known
   time. Ticks once a minute; hides itself the moment the fire time passes so a
   stale server snapshot never leaves a phantom countdown on the board. */
export function WakeupChip({ wakeup, className }: { wakeup?: PendingWakeup | null; className?: string }) {
  const { locale, t } = useLocale();
  const [now, setNow] = useState(() => Date.now());
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
  return (
    <span
      data-wakeup
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-[#e4c789] bg-[#fdf5e3] px-2 py-0.5 text-[10px] font-bold text-[#8a5d12] ${className ?? ""}`}
      title={t("wakeup.chipTitle", { time: clock, reason: wakeup.reason || t("wakeup.card") })}
    >
      <AlarmClock className="h-3 w-3" aria-hidden />
      {magnitude}
    </span>
  );
}
