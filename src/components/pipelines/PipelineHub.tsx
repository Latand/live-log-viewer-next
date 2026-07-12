"use client";

import { Pause, Play, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useLocale } from "@/lib/i18n";
import type { Pipeline, PipelineAction } from "@/lib/pipelines/types";

import { latestAttempt, patchPipeline, pipelineStateLabel, stageChipLabel } from "./pipelineModel";

const TONES: Record<Pipeline["state"], string> = {
  provisioning: "#5a51e0",
  running: "#5a51e0",
  needs_decision: "#e0ae45",
  paused: "#e0ae45",
  completed: "#1a8a3e",
  closed: "#9a9aa4",
};

/**
 * The single on-board control hub for a pipeline (#93 §2.2), sitting on the edge
 * into the current stage: `⇢ <stage> · k/n` at a glance, and a click opens a
 * compact control popover — pause/resume, retry/skip when parked, close — the
 * same PATCH calls the dashboard strip drives. Mirrors FlowHub's popover model.
 */
export function PipelineHub({
  pipeline,
  x,
  y,
  interactive,
  moveTransition,
}: {
  pipeline: Pipeline;
  x: number;
  y: number;
  interactive: boolean;
  moveTransition: string;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  /* Focus enters the control popover on open and returns to the hub chip when it
     closes (Escape, close action, or toggle), matching the verdict popover. The
     wasOpen guard keeps the board's initial render from stealing focus. */
  useEffect(() => {
    if (open) {
      popoverRef.current?.focus();
      wasOpen.current = true;
    } else if (wasOpen.current) {
      triggerRef.current?.focus();
      wasOpen.current = false;
    }
  }, [open]);

  const tone = TONES[pipeline.state];
  const total = pipeline.stages.length;
  const cursorStageId = pipeline.cursor?.stageId ?? pipeline.stages.at(-1)?.id ?? null;
  const stageIndex = cursorStageId ? pipeline.stages.findIndex((stage) => stage.id === cursorStageId) : -1;
  const stage = stageIndex >= 0 ? pipeline.stages[stageIndex]! : null;
  const stageLabel = stage ? stageChipLabel(t, stage) : pipeline.id;
  const k = stageIndex >= 0 ? stageIndex + 1 : total;
  const attempt = cursorStageId ? latestAttempt(pipeline, cursorStageId) : null;
  const finished = pipeline.state === "completed" || pipeline.state === "closed";
  const parked = pipeline.state === "needs_decision";

  const run = async (action: PipelineAction) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const fail = await patchPipeline(pipeline.id, action);
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
        ref={triggerRef}
        data-scheme-ui
        className="absolute inline-flex h-[30px] -translate-x-1/2 -translate-y-1/2 items-center gap-1 whitespace-nowrap rounded-full border-2 bg-panel px-2.5 text-[10.5px] font-bold shadow-card hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        style={{ borderColor: tone, color: tone }}
        aria-label={t("pipelineHub.aria", { task: pipeline.task, stage: stageLabel, k, n: total })}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden>{pipeline.state === "paused" ? "⏸" : "⇢"}</span>
        <span className="max-w-[120px] truncate">{t("pipelineHub.stageOf", { stage: stageLabel, k, n: total })}</span>
      </button>
      {open ? (
        <div
          ref={popoverRef}
          data-scheme-ui
          role="dialog"
          tabIndex={-1}
          aria-label={t("pipelineHub.controls")}
          className="absolute bottom-[24px] left-0 z-30 flex w-[224px] -translate-x-1/2 flex-col gap-1.5 rounded-[12px] border border-line bg-panel p-2.5 shadow-[0_10px_36px_rgb(20_20_30/0.18)] focus-visible:outline-none"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: tone }} aria-hidden />
            <span className="shrink-0 text-[11.5px] font-bold">{pipelineStateLabel(t, pipeline.state)}</span>
            {busy ? <RefreshCw className="ml-auto h-3 w-3 shrink-0 animate-spin text-dim" aria-hidden /> : null}
          </span>
          <span className="min-w-0 truncate text-[10.5px] font-semibold text-dim">
            {t("pipelineHub.stageOf", { stage: stageLabel, k, n: total })}
            {attempt && attempt.n > 1 ? ` · ${t("pipelineHub.attempt", { n: attempt.n })}` : ""}
          </span>
          {pipeline.stateDetail ? <span className="truncate text-[10px] font-semibold text-[#a06a15]" title={pipeline.stateDetail}>{pipeline.stateDetail}</span> : null}
          {error ? <span className="truncate text-[10.5px] font-semibold text-err" title={error}>{error}</span> : null}
          {parked ? (
            <span className="flex items-center gap-1.5">
              <button className="flex-1 rounded-full border border-accent bg-accent px-3 py-1 text-[11px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40" disabled={busy} onClick={() => void run("retry-stage")}>{t("pipelineStrip.retryStage")}</button>
              <button className="rounded-full border border-line bg-bg px-2.5 py-1 text-[10.5px] font-bold text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40" disabled={busy} onClick={() => void run("skip-stage")}>{t("pipelineStrip.skipStage")}</button>
            </span>
          ) : null}
          <span className="flex items-center gap-1.5">
            {finished ? null : pipeline.state === "paused" ? (
              <button className="inline-flex flex-1 items-center justify-center gap-1 rounded-full border border-ok/40 bg-[#eef8f0] px-3 py-1 text-[11px] font-bold text-ok hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40" disabled={busy} onClick={() => void run("resume")}>
                <Play className="h-3 w-3" aria-hidden /> {t("pipelineStrip.resume")}
              </button>
            ) : (
              <button className="inline-flex flex-1 items-center justify-center gap-1 rounded-full border border-line bg-bg px-3 py-1 text-[11px] font-bold text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40" disabled={busy} onClick={() => void run("pause")}>
                <Pause className="h-3 w-3" aria-hidden /> {t("pipelineStrip.pause")}
              </button>
            )}
            <button className="inline-flex flex-1 items-center justify-center gap-1 rounded-full border border-line bg-bg px-3 py-1 text-[11px] font-bold text-dim hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40" disabled={busy} onClick={() => void run("close")}>
              <X className="h-3 w-3" aria-hidden /> {t("pipelineStrip.close")}
            </button>
          </span>
        </div>
      ) : null}
    </div>
  );
}
