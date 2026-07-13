"use client";

import { Pause, Play, RefreshCw, Square, X } from "lucide-react";
import { useState } from "react";

import type { Flow, FlowAction } from "@/lib/flows/types";
import { useLocale } from "@/lib/i18n";

import { useRuntimeFlow } from "@/hooks/useRuntime";
import { currentRound, flowLinkPhase, type FlowLinkPhase } from "@/components/scheme/agentLinks";

import { flowPresentation, patchFlow } from "./flowModel";

/* Hub tone per link phase: work in accent, waiting-on-you in amber, done in
   verdict green, idle gray — the palette the strip and verdict chips use. */
const PHASE_TONE: Record<FlowLinkPhase, string> = {
  waiting: "var(--color-muted)",
  running: "var(--color-accent)",
  awaiting_verdict: "var(--color-accent)",
  attention: "var(--color-warning)",
  paused: "var(--color-warning)",
  done: "var(--color-success)",
};

/**
 * The ⟳ hub of a flow link, sitting in the corridor between the implementer
 * and its reviewer side: current round number and lifecycle tone at a glance,
 * and a click opens the compact control popover — pause/resume, the one
 * pending transition, stop-reviewer and close, all via PATCH /api/flows/:id.
 * The full strip above the pair stays the detailed surface; the hub is the
 * on-the-link shortcut.
 */
export function FlowHub({
  flow: polledFlow,
  x,
  y,
  interactive,
  moveTransition,
}: {
  flow: Flow;
  /** World coordinates of the hub center. */
  x: number;
  y: number;
  interactive: boolean;
  /** Matches the board's layout-glide transition. */
  moveTransition: string;
}) {
  const { locale, t } = useLocale();
  /* Event-driven progression wins over the poll, same as the strip. */
  const runtimeFlow = useRuntimeFlow(polledFlow.id);
  const flow = runtimeFlow ? { ...runtimeFlow, block: polledFlow.block } : polledFlow;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phase = flowLinkPhase(flow.state);
  const tone = PHASE_TONE[phase];
  const round = currentRound(flow)?.n ?? 0;
  const presentation = flowPresentation(t, flow, locale);
  const state = presentation.label;
  const label = round > 0 ? t("flowHub.aria", { n: round, state }) : t("flowHub.ariaNoRound", { state });
  const pending = presentation.pending;
  const closed = flow.state === "closed" || flow.state === "approved";

  const run = async (action: FlowAction) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const fail = await patchFlow(flow.id, { action });
    if (fail) setError(fail);
    else if (action === "close") setOpen(false);
    setBusy(false);
  };

  return (
    <div
      className={`absolute left-0 top-0 ${open ? "z-30" : "z-[5]"} ${interactive ? "" : "pointer-events-none"}`}
      style={{ transform: `translate(${x}px, ${y}px)`, transition: moveTransition }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
      }}
    >
      <button
        data-scheme-ui
        className="absolute inline-flex h-[34px] -translate-x-1/2 -translate-y-1/2 items-center gap-1 whitespace-nowrap rounded-full border-2 bg-card px-2.5 shadow-1 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        style={{ borderColor: tone, color: tone }}
        title={label}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="text-[15px] font-bold leading-none" aria-hidden>
          ⟳
        </span>
        {round > 0 ? <span className="text-[11px] font-bold">R{round}</span> : null}
      </button>
      {open ? (
        <div
          data-scheme-ui
          aria-label={t("flowHub.controls")}
          className="absolute bottom-[27px] left-0 z-30 flex w-[230px] -translate-x-1/2 flex-col gap-1.5 rounded-[12px] border border-border bg-card p-2.5 shadow-2"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: tone }} aria-hidden />
            <span className="shrink-0 text-[11.5px] font-bold">{state}</span>
            {presentation.detail ? (
              <span className="min-w-0 truncate text-[10.5px] font-semibold text-muted" title={presentation.detail}>
                {presentation.detail}
              </span>
            ) : null}
            {busy ? <RefreshCw className="ml-auto h-3 w-3 shrink-0 animate-spin text-muted" aria-hidden /> : null}
          </span>
          {error ? (
            <span className="truncate text-[10.5px] font-semibold text-danger" title={error}>
              {error}
            </span>
          ) : null}
          {pending ? (
            <button
              className="rounded-full border border-accent bg-accent px-3 py-1 text-[11px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40"
              disabled={busy}
              onClick={() => void run(pending.action)}
            >
              {t(pending.labelKey)}
            </button>
          ) : null}
          {flow.state === "reviewing" ? (
            <button
              className="inline-flex items-center justify-center gap-1 rounded-full border border-danger/40 bg-danger-soft px-3 py-1 text-[11px] font-bold text-danger hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
              disabled={busy}
              title={t("flowStrip.stopReviewerTitle")}
              onClick={() => void run("cancel-round")}
            >
              <Square className="h-3 w-3" aria-hidden /> {t("flowStrip.stopReviewer")}
            </button>
          ) : null}
          <span className="flex items-center gap-1.5">
            {closed ? null : flow.state === "paused" ? (
              <button
                className="inline-flex flex-1 items-center justify-center gap-1 rounded-full border border-success/40 bg-success-soft px-3 py-1 text-[11px] font-bold text-success hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
                disabled={busy}
                onClick={() => void run("resume")}
              >
                <Play className="h-3 w-3" aria-hidden /> {t("flowStrip.resume")}
              </button>
            ) : (
              <button
                className="inline-flex flex-1 items-center justify-center gap-1 rounded-full border border-border bg-canvas px-3 py-1 text-[11px] font-bold text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
                disabled={busy}
                onClick={() => void run("pause")}
              >
                <Pause className="h-3 w-3" aria-hidden /> {t("flowStrip.pause")}
              </button>
            )}
            <button
              className="inline-flex flex-1 items-center justify-center gap-1 rounded-full border border-border bg-canvas px-3 py-1 text-[11px] font-bold text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
              disabled={busy}
              onClick={() => void run("close")}
            >
              <X className="h-3 w-3" aria-hidden /> {t("flowStrip.close")}
            </button>
          </span>
        </div>
      ) : null}
    </div>
  );
}
