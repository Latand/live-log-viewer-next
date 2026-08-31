"use client";

import type { LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { clockDuration, humanizeDuration, turnIsRunning } from "./turnDuration";

/** Live elapsed readout for the current turn, ticking once a second. The value
    derives from `startedAt` against the wall clock on every tick, so a new
    turn's changed `startedAt` resets the display without a remount, and a
    stalled poll cannot freeze it mid-run. */
function ElapsedTimer({ startedAt, label, human = false }: { startedAt: number; label: string; human?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <span role="timer" aria-label={label} className="tabular-nums">
      {human ? humanizeDuration(seconds) : clockDuration(seconds)}
    </span>
  );
}

interface Props {
  file: Pick<FileEntry, "lastTurn" | "activity">
    & Partial<Pick<FileEntry, "mtime" | "pendingQuestion" | "waitingInput" | "rateLimit">>;
  workingLabel: string;
  workingIcon: LucideIcon;
  compact?: boolean;
}

function waitingStartedAt(file: Props["file"]): number | null {
  if (file.pendingQuestion) {
    const askedAt = Date.parse(file.pendingQuestion.askedAt);
    return Number.isFinite(askedAt) ? askedAt : null;
  }
  if (file.rateLimit) return file.lastTurn?.startedAt ?? (file.mtime === undefined ? null : file.mtime * 1000);
  if (file.waitingInput) return file.waitingInput.since * 1000;
  return null;
}

/**
 * Pinned bottom status slot of a conversation pane, centered on its vertical
 * axis. It shows an open turn or an operator wait:
 *
 *  - running («працює · 4 хв 32 с»): the agent is live and the turn is open;
 *    the working label carries a 1 Hz wall-clock timer from receipt to now.
 *  - waiting: the agent is blocked on operator input and keeps that wait's
 *    existing clock display.
 *
 * Completed totals live with their response rows and remain in transcript
 * history when later turns replace the card's current boundary.
 *
 * The bar lives OUTSIDE the transcript scroller, so the floating live-tail
 * pill (anchored inside the scroller) can never collide with it at any width.
 * Renders nothing when no turn boundary is known and the agent is idle.
 */
export function TurnStatusBar({ file, workingLabel, workingIcon: Icon, compact = false }: Props) {
  const { t } = useLocale();
  const turn = file.lastTurn ?? null;
  const waiting = Boolean(file.pendingQuestion || file.rateLimit || file.waitingInput);
  const running = turnIsRunning(file);
  const pad = compact ? "px-3 py-1" : "px-6 py-1.5";

  if (waiting) {
    const startedAt = waitingStartedAt(file);
    return (
      <div
        data-turn-status="waiting"
        className={`flex shrink-0 items-center justify-center gap-2 border-t border-border ${pad} text-[12px] font-semibold text-warning`}
      >
        <span className="flex items-center gap-0.5" aria-hidden>
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-warning" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-warning [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-warning [animation-delay:300ms]" />
        </span>
        <span className="min-w-0 truncate">{t("turn.waiting")}</span>
        {startedAt !== null ? (
          <>
            <span aria-hidden>·</span>
            <ElapsedTimer startedAt={startedAt} label={t("turn.timer")} />
          </>
        ) : null}
      </div>
    );
  }

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
            <ElapsedTimer startedAt={turn.startedAt} label={t("turn.timer")} human />
          </>
        ) : null}
      </div>
    );
  }

  return null;
}
