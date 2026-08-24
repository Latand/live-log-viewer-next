"use client";

import { useEffect, useState } from "react";

import { useLocale } from "@/lib/i18n";
import { wakeupPhase } from "@/lib/wakeup";

import { GlyphIcon } from "../../icons";
import { fmtWakeClock, fmtWakeRelative } from "../../wakeupFormat";
import { type ToolEvent, type WakeupEventInfo } from "../parse";
import { OutputPreview } from "./OutputPreview";

/* The raw wake-plan prompt is orchestrator payload — stage ids, SHAs, playbook
   steps — so it renders as bare monospace text and is never fed through the
   markdown pipeline: internal machine text must not masquerade as user-facing
   prose (issue #1124). A rejected call keeps the harness's bounded error output
   above it, so the reason it was refused stays visible. */
function WakeupBody({ event, wakeup }: { event: ToolEvent; wakeup: WakeupEventInfo }) {
  const { t } = useLocale();
  return (
    <div className="mb-1 mt-1 rounded-surface bg-sunken px-2.5 py-2">
      {wakeup.failed && event.outputPreview.trim() ? (
        <div className="mb-2">
          <OutputPreview output={event.outputPreview} truncated={event.outputTruncated} />
        </div>
      ) : null}
      {wakeup.prompt ? (
        <>
          <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10.5px] font-semibold text-muted">
            <span className="uppercase tracking-wide">{t("wakeup.plan")}</span>
            <span className="rounded-md border border-border bg-card px-1.5 py-px font-mono font-normal">
              {t("wakeup.planInternal")}
            </span>
          </div>
          <pre className="max-w-full whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11px] leading-snug text-secondary">
            {wakeup.prompt}
          </pre>
        </>
      ) : (
        <span className="text-[11px] text-muted">{t("wakeup.noPlan")}</span>
      )}
    </div>
  );
}

/**
 * A `ScheduleWakeup` call in the feed's own quiet language (issue #1124): the
 * same borderless row idiom as a tool line — glyph, the full reason (wrapping,
 * never truncated), and ONE schedule element that fuses the absolute fire time
 * with the live countdown, stated exactly once. Routine scheduling is neutral
 * chrome; alarm styling is reserved for a genuinely rejected call, which keeps
 * the danger edge and opens to show the harness's refusal. The wake plan sits
 * collapsed behind the row and mounts only on first expand, so a long feed
 * never carries walls of internal prompt text in its DOM.
 */
export function WakeupCard({ event, wakeup }: { event: ToolEvent; wakeup: WakeupEventInfo }) {
  const { locale, t } = useLocale();
  const { fireAt, superseded, failed, reason } = wakeup;

  const [now, setNow] = useState(() => Date.now());
  // Only a genuinely pending schedule counts down. `active` is derived from the
  // CURRENT clock, so the interval below stops the moment the fire time passes
  // (issue #161 review). A superseded or failed card is static.
  const phase = failed ? "failed" : superseded ? "superseded" : wakeupPhase(fireAt, now);
  const active = phase === "pending";
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  const clock = fireAt !== null ? fmtWakeClock(fireAt, locale) : "";

  /* The single time element. A superseded FUTURE schedule reads "was set for"
     and never promises to wake (issue #161 review); only a still-active or
     already-fired schedule speaks of its time as future or past. */
  const schedule = failed
    ? t("wakeup.failed")
    : superseded
      ? clock
        ? `${t("wakeup.wasSetFor", { time: clock })} · ${t("wakeup.superseded")}`
        : t("wakeup.superseded")
      : active && fireAt !== null
        ? `${t("wakeup.wakesAt", { time: clock })} · ${fmtWakeRelative(fireAt, now, t)}`
        : phase === "fired"
          ? clock
            ? t("wakeup.firedAt", { time: clock })
            : t("wakeup.fired")
          : t("wakeup.noTime");

  const rowTone = failed ? "border-l-2 border-danger bg-danger-soft pl-2 pr-1 text-danger" : "text-muted";
  const reasonTone = failed ? "font-semibold" : superseded ? "text-muted" : "text-secondary";
  const scheduleTone = failed ? "font-semibold text-danger" : "text-muted";

  // The body mounts lazily on first expand (same contract as ToolLine); a
  // rejected call opens immediately so its refusal is visible without a click.
  const [mounted, setMounted] = useState(failed);

  return (
    <details
      className="ml-9"
      open={failed}
      onToggle={(e) => {
        if (e.currentTarget.open) setMounted(true);
      }}
    >
      <summary
        className={`flex cursor-pointer list-none items-start gap-2 rounded-control py-0.5 text-ui hover:bg-sunken [@media(pointer:coarse)]:min-h-11 [&::-webkit-details-marker]:hidden ${rowTone}`}
      >
        <GlyphIcon name="clock" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {/* The reason wraps in full (grow/shrink around a 10rem basis); on a
            narrow viewport the schedule element drops to its own line instead
            of squeezing the reason into a sliver column. */}
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className={`min-w-0 grow shrink basis-40 leading-snug [overflow-wrap:anywhere] ${reasonTone}`}>
            {reason || t("wakeup.card")}
          </span>
          <span className={`ml-auto whitespace-nowrap text-[11px] tabular-nums ${scheduleTone}`}>{schedule}</span>
        </span>
      </summary>
      {mounted ? <WakeupBody event={event} wakeup={wakeup} /> : null}
    </details>
  );
}
