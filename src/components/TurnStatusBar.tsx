"use client";

import type { LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { clockDuration, workedCaption } from "./turnDuration";

/** Live elapsed readout for the current turn, ticking once a second. The value
    derives from `startedAt` against the wall clock on every tick, so a new
    turn's changed `startedAt` resets the display without a remount, and a
    stalled poll cannot freeze it mid-run. */
function ElapsedTimer({ startedAt, label }: { startedAt: number; label: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span role="timer" aria-label={label} className="tabular-nums">
      {clockDuration((now - startedAt) / 1000)}
    </span>
  );
}

interface Props {
  file: Pick<FileEntry, "lastTurn" | "activity">;
  workingLabel: string;
  workingIcon: LucideIcon;
  compact?: boolean;
}

/**
 * Pinned bottom working-status slot of a conversation pane (issue #268). One
 * of two mutually exclusive states, both centered on the pane's vertical axis:
 *
 *  - running («працює · 4:32»): the agent is live and the turn is open — the
 *    working label plus a 1 Hz timer from the initiating prompt to now. The
 *    timer keeps counting across long tool calls because it tracks the wall
 *    clock, not transcript writes.
 *  - finished («Працював 12 хв 30 с»): the frozen total from the initiating
 *    prompt to the agent's last activity, never a single action's own span.
 *
 * The bar lives OUTSIDE the transcript scroller, so the floating live-tail
 * pill (anchored inside the scroller) can never collide with it at any width.
 * Renders nothing when no turn boundary is known and the agent is idle.
 */
export function TurnStatusBar({ file, workingLabel, workingIcon: Icon, compact = false }: Props) {
  const { t } = useLocale();
  const turn = file.lastTurn ?? null;
  const running = file.activity === "live" && (!turn || turn.endedAt === null);
  const pad = compact ? "px-3 py-1" : "px-6 py-1.5";

  if (running) {
    return (
      <div
        /* Deliberately NOT role="status": a live region would announce every
           1 Hz tick. The timer's own role="timer" keeps it silent but named. */
        data-turn-status="running"
        className={`flex shrink-0 items-center justify-center gap-2 border-t border-border ${pad} text-[12px] font-semibold text-success`}
      >
        <span className="flex items-center gap-0.5" aria-hidden>
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-success" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-success [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-success [animation-delay:300ms]" />
        </span>
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{workingLabel}</span>
        {turn ? (
          <>
            <span aria-hidden>·</span>
            <ElapsedTimer startedAt={turn.startedAt} label={t("turn.timer")} />
          </>
        ) : null}
      </div>
    );
  }

  const caption = workedCaption(file);
  if (!caption) return null;
  return (
    <div
      role="note"
      data-turn-status="finished"
      className={`flex shrink-0 items-center gap-2 border-t border-border ${pad} text-[11px] font-semibold text-muted`}
    >
      <span className="h-px flex-1 bg-border" aria-hidden />
      {/* No aria-label here: this role-less span's accessible output must be
          the caption itself — the localized visible duration text — not a
          generic timer name that would override it (issue #268 review). */}
      <span className="tabular-nums">{caption}</span>
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  );
}
