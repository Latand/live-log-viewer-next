"use client";

import { useState } from "react";

import { ExternalLink, Pause, Play, RefreshCw, X } from "lucide-react";

import { useLocale } from "@/lib/i18n";
import type { Workflow, WorkflowAction } from "@/lib/workflows/types";

import { Hint } from "@/components/Hint";

import { isGateOpen, patchWorkflow, WF_ATTENTION_STATES, WF_BUSY_STATES, workflowStateLabel } from "./workflowModel";

function stateDot(wf: Workflow): string {
  if (wf.state === "approved") return "bg-success";
  if (wf.state === "needs_decision") return "bg-danger";
  if (wf.state === "paused") return "bg-warning";
  if (WF_BUSY_STATES.has(wf.state)) return "bg-success animate-pulse";
  return "bg-muted";
}

/** Chip tone of one stage: done green, current accent, waiting gray. */
function stageTone(wf: Workflow, index: number): { color: string; soft: string; pulse: boolean } {
  const run = wf.stageRuns[index];
  if (run?.doneAt) return { color: "var(--color-success)", soft: "var(--color-success-soft)", pulse: false };
  if (index === wf.stageIndex && WF_BUSY_STATES.has(wf.state) && wf.state !== "provisioning") {
    return { color: "var(--color-accent)", soft: "var(--color-accent-soft)", pulse: true };
  }
  return { color: "var(--color-muted)", soft: "var(--color-sunken)", pulse: false };
}

/**
 * The workflow's docked header strip: state cluster, stage chips, controls.
 * All mutations go through PATCH /api/workflows/:id; the poll refresh
 * carries the resulting state back.
 */
export function WorkflowStrip({ wf }: { wf: Workflow }) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: WorkflowAction) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const fail = await patchWorkflow(wf.id, { action });
    if (fail) setError(fail);
    setBusy(false);
  };

  const attention = WF_ATTENTION_STATES.has(wf.state);
  const finished = wf.state === "closed" || wf.state === "approved";
  const gate = isGateOpen(wf);

  const stageLabel = (index: number): string => {
    const stage = wf.template.stages[index];
    if (!stage) return `S${index + 1}`;
    if (stage.kind === "review-loop") return t("wfStrip.reviewStage");
    return stage.scope.split(/[.:\n]/)[0]?.trim() || `S${index + 1}`;
  };

  return (
    <div
      data-scheme-ui
      className={`pointer-events-auto flex min-h-11 w-full items-center gap-3 rounded-[14px] border bg-card/95 px-4 py-1 shadow-[0_2px_10px_rgb(20_20_30/0.08)] ${
        attention ? "border-warning/70" : "border-border"
      }`}
    >
      {/* State cluster: dot, the WF mark, the name, current state and detail. */}
      <span className="flex min-w-0 max-w-[46%] shrink-0 items-center gap-2">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${stateDot(wf)}`} aria-hidden />
        <span className="shrink-0 text-[10.5px] font-bold tracking-[0.08em] text-muted">{t("wfStrip.workflow")}</span>
        <span className="shrink-0 text-[12px] font-bold">{wf.name}</span>
        <span className="shrink-0 text-[11.5px] font-semibold text-muted">{workflowStateLabel(t, wf.state)}</span>
        {wf.stateDetail ? (
          <span className="min-w-0 truncate text-[11.5px] font-semibold text-danger" title={wf.stateDetail}>
            {wf.stateDetail}
          </span>
        ) : null}
      </span>

      {/* Stage chips: the pipeline at a glance. */}
      <span className="no-scrollbar flex min-w-0 flex-1 items-center justify-center gap-1.5 overflow-x-auto" aria-label={t("wfStrip.stagesAria")}>
        {wf.template.stages.map((stage, index) => {
          const tone = stageTone(wf, index);
          const runInfo = wf.stageRuns[index];
          return (
            <span key={index} className="flex shrink-0 items-center gap-1.5">
              {index > 0 ? (
                <span className="text-[10px] font-bold text-strong" aria-hidden>
                  →
                </span>
              ) : null}
              <span
                className={`inline-flex h-6 max-w-[180px] items-center gap-1 truncate rounded-full px-2 text-[10.5px] font-bold ${tone.pulse ? "animate-pulse" : ""}`}
                style={{ backgroundColor: tone.soft, color: tone.color }}
                title={runInfo?.doneNote ?? stageLabel(index)}
              >
                {runInfo?.doneAt ? "✓ " : ""}
                {stageLabel(index)}
              </span>
            </span>
          );
        })}
      </span>

      {/* Control cluster. */}
      <span className="flex shrink-0 items-center gap-1.5">
        {error ? (
          <span className="max-w-[220px] truncate text-[10.5px] font-semibold text-danger" title={error}>
            {error}
          </span>
        ) : null}
        {busy ? <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin text-muted" aria-hidden /> : null}
        {wf.prUrl ? (
          <a
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-success/40 bg-success-soft px-2.5 text-[10.5px] font-bold text-success hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            href={wf.prUrl}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink className="h-3 w-3" aria-hidden /> PR
          </a>
        ) : null}
        {gate ? (
          <button
            className="shrink-0 rounded-full border border-accent bg-accent px-3 py-1 text-[11px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40"
            disabled={busy}
            onClick={() => void run("advance")}
          >
            {t("wfStrip.advance")}
          </button>
        ) : null}
        {wf.state === "needs_decision" ? (
          <>
            <button
              className="shrink-0 rounded-full border border-accent bg-accent px-3 py-1 text-[11px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40"
              disabled={busy}
              onClick={() => void run("retry-stage")}
            >
              {t("wfStrip.retryStage")}
            </button>
            <button
              className="shrink-0 rounded-full border border-border bg-canvas px-2.5 py-1 text-[10.5px] font-bold text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
              disabled={busy}
              onClick={() => void run("advance")}
            >
              {t("wfStrip.skipStage")}
            </button>
          </>
        ) : null}
        {finished ? null : wf.state === "paused" ? (
          <Hint label={t("wfStrip.resume")}>
            <button
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-success hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
              disabled={busy}
              aria-label={t("wfStrip.resume")}
              onClick={() => void run("resume")}
            >
              <Play className="h-3.5 w-3.5" aria-hidden />
            </button>
          </Hint>
        ) : (
          <Hint label={t("wfStrip.pause")}>
            <button
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted hover:bg-canvas hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
              disabled={busy}
              aria-label={t("wfStrip.pause")}
              onClick={() => void run("pause")}
            >
              <Pause className="h-3.5 w-3.5" aria-hidden />
            </button>
          </Hint>
        )}
        <Hint label={t("wfStrip.close")}>
          <button
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted hover:bg-canvas hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
            disabled={busy}
            aria-label={t("wfStrip.close")}
            onClick={() => void run("close")}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </Hint>
      </span>
    </div>
  );
}
