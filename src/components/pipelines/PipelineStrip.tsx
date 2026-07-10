"use client";

import { Pause, Play, RefreshCw, X } from "lucide-react";
import { useState } from "react";

import { Hint } from "@/components/Hint";
import { useLocale } from "@/lib/i18n";
import type { Pipeline, PipelineAction } from "@/lib/pipelines/types";

import { patchPipeline, PIPELINE_ATTENTION_STATES, PIPELINE_BUSY_STATES, pipelineStateLabel } from "./pipelineModel";

function stageAttempt(pipeline: Pipeline, stageId: string) {
  return pipeline.runs.find((run) => run.stageId === stageId)?.attempts.at(-1) ?? null;
}
function stageTone(pipeline: Pipeline, stageId: string): { color: string; soft: string; pulse: boolean } {
  const attempt = stageAttempt(pipeline, stageId);
  if (attempt?.state === "passed" || attempt?.state === "skipped") return { color: "#1a8a3e", soft: "#e7f4ea", pulse: false };
  if (pipeline.cursor?.stageId === stageId && PIPELINE_BUSY_STATES.has(pipeline.state)) return { color: "#5a51e0", soft: "#ecebfb", pulse: true };
  if (attempt?.state === "failed" || attempt?.state === "needs_decision") return { color: "#b4483d", soft: "#fbeaea", pulse: false };
  return { color: "#8b8b95", soft: "#efeff3", pulse: false };
}

export function PipelineStrip({ pipeline }: { pipeline: Pipeline }) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mutate = async (action: PipelineAction) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setError(await patchPipeline(pipeline.id, action));
    setBusy(false);
  };
  const attention = PIPELINE_ATTENTION_STATES.has(pipeline.state);
  const finished = pipeline.state === "completed" || pipeline.state === "closed";
  return (
    <div
      data-scheme-ui
      className={`pointer-events-auto flex min-h-11 w-full items-center gap-3 rounded-[14px] border bg-panel/95 px-4 py-1 shadow-[0_2px_10px_rgb(20_20_30/0.08)] ${attention ? "border-[#e0ae45]/70" : "border-line"}`}
    >
      <span className="flex min-w-0 max-w-[42%] shrink-0 items-center gap-2">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${pipeline.state === "needs_decision" ? "bg-err" : PIPELINE_BUSY_STATES.has(pipeline.state) ? "animate-pulse bg-ok" : pipeline.state === "completed" ? "bg-ok" : "bg-[#9a9aa4]"}`} aria-hidden />
        <span className="shrink-0 text-[10.5px] font-bold tracking-[0.08em] text-dim">{t("pipelineStrip.pipeline")}</span>
        <span className="min-w-0 truncate text-[12px] font-bold" title={pipeline.task}>{pipeline.task}</span>
        <span className="shrink-0 text-[11.5px] font-semibold text-dim">{pipelineStateLabel(t, pipeline.state)}</span>
        {pipeline.stateDetail ? <span className="min-w-0 truncate text-[11.5px] font-semibold text-err" title={pipeline.stateDetail}>{pipeline.stateDetail}</span> : null}
      </span>
      <span className="no-scrollbar flex min-w-0 flex-1 items-center justify-center gap-1.5 overflow-x-auto" aria-label={t("pipelineStrip.stagesAria")}>
        {pipeline.stages.map((stage, index) => {
          const tone = stageTone(pipeline, stage.id);
          const attempt = stageAttempt(pipeline, stage.id);
          const access = attempt?.effectiveRole.access ?? stage.role.access ?? (stage.kind === "review-loop" ? "read-only" : "read-write");
          const title = [stage.role.roleId, t(access === "read-only" ? "pipelineStrip.readOnly" : "pipelineStrip.readWrite"), attempt?.sessionId].filter(Boolean).join(" · ");
          return (
            <span key={stage.id} className="flex shrink-0 items-center gap-1.5">
              {index ? <span className="text-[10px] font-bold text-[#c9c9d1]" aria-hidden>→</span> : null}
              <span
                className={`inline-flex h-6 max-w-[180px] items-center gap-1 truncate rounded-full px-2 text-[10.5px] font-bold ${tone.pulse ? "animate-pulse" : ""}`}
                style={{ backgroundColor: tone.soft, color: tone.color }}
                title={title}
              >
                {attempt?.state === "passed" ? "✓ " : attempt?.state === "skipped" ? "↷ " : ""}
                {stage.kind === "review-loop" ? t("pipelineStrip.reviewStage") : stage.id}
              </span>
            </span>
          );
        })}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {error ? <span className="max-w-[220px] truncate text-[10.5px] font-semibold text-err" title={error}>{error}</span> : null}
        {busy ? <RefreshCw className="h-3.5 w-3.5 animate-spin text-dim" aria-hidden /> : null}
        {pipeline.state === "needs_decision" ? (
          <>
            <button className="rounded-full border border-accent bg-accent px-3 py-1 text-[11px] font-bold text-white disabled:opacity-40" disabled={busy} onClick={() => void mutate("retry-stage")}>{t("pipelineStrip.retryStage")}</button>
            <button className="rounded-full border border-line bg-bg px-2.5 py-1 text-[10.5px] font-bold text-dim disabled:opacity-40" disabled={busy} onClick={() => void mutate("skip-stage")}>{t("pipelineStrip.skipStage")}</button>
          </>
        ) : null}
        {finished ? null : pipeline.state === "paused" ? (
          <Hint label={t("pipelineStrip.resume")}><button className="inline-flex h-6 w-6 items-center justify-center rounded-full text-ok" disabled={busy} aria-label={t("pipelineStrip.resume")} onClick={() => void mutate("resume")}><Play className="h-3.5 w-3.5" aria-hidden /></button></Hint>
        ) : (
          <Hint label={t("pipelineStrip.pause")}><button className="inline-flex h-6 w-6 items-center justify-center rounded-full text-dim" disabled={busy} aria-label={t("pipelineStrip.pause")} onClick={() => void mutate("pause")}><Pause className="h-3.5 w-3.5" aria-hidden /></button></Hint>
        )}
        <Hint label={t("pipelineStrip.close")}><button className="inline-flex h-6 w-6 items-center justify-center rounded-full text-dim hover:text-err" disabled={busy} aria-label={t("pipelineStrip.close")} onClick={() => void mutate("close")}><X className="h-3.5 w-3.5" aria-hidden /></button></Hint>
      </span>
    </div>
  );
}
