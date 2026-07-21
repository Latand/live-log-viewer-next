"use client";

import { LayoutGrid, Pause, Play, X } from "lucide-react";
import { useState } from "react";

import { useLocale } from "@/lib/i18n";
import { MIN_STARTED_PIPELINE_STAGES } from "@/lib/pipelines/limits";
import type { Pipeline } from "@/lib/pipelines/types";

import { patchPipeline } from "./pipelineModel";

const fieldLabel = "text-label font-semibold text-secondary";
const inputBase =
  "h-7 w-full rounded-[8px] border border-border bg-canvas px-2 text-[11.5px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
const primaryBtn =
  "inline-flex items-center justify-center gap-1 rounded-full border border-accent bg-accent px-3 py-1 text-[11px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40";
const ghostBtn =
  "inline-flex flex-1 items-center justify-center gap-1 rounded-full border border-border bg-canvas px-3 py-1 text-[11px] font-bold text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40";

/**
 * Pipeline-level override panel opened from a pipeline group's label (#118).
 *
 * Stage editing lives entirely on the real canvas conversation/placeholder cards
 * now (#507 review F1): every planned stage renders its own StagePlaceholderPane
 * with role/runtime/prompt/edge controls, reorder, remove, and add affordances,
 * and a running stage's live conversation is its own card. So this panel keeps
 * ONLY the pipeline-scoped controls it alone owns — the draft's task / spec /
 * repository details and the lifecycle actions (start · pause · resume · close ·
 * discard, plus retry/skip when parked) — and points the operator at the canvas
 * for per-stage edits. No nested stage form, no nested scroller.
 */
export function PipelineEditor({ pipeline, onClose, label = pipeline.task }: { pipeline: Pipeline; onClose: () => void; label?: string }) {
  const { t } = useLocale();
  const draft = pipeline.state === "draft";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [task, setTask] = useState(pipeline.task);
  const [spec, setSpec] = useState(pipeline.spec ?? "");
  const [repoDir, setRepoDir] = useState(pipeline.repoDir);
  const closed = pipeline.state === "completed" || pipeline.state === "closed";
  const parked = pipeline.state === "needs_decision";
  /* A stage that has never run is still editable — but the edit surface is its
     canvas card, not this panel. The pointer is shown whenever such a stage
     exists so the operator knows where the controls moved. */
  const editableStages = pipeline.stages.some(
    (stage) => (pipeline.runs.find((run) => run.stageId === stage.id)?.attempts.length ?? 0) === 0,
  );
  const run = async (message: string, action: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    const failure = await action();
    if (failure) setError(failure);
    else setSaved(message);
    setBusy(false);
  };

  return (
    <div data-scheme-ui data-group-override="pipeline" data-pipeline-editor={pipeline.id} role="dialog" aria-label={label} className="flex max-h-[calc(100vh-24px)] w-[min(320px,calc(100vw-24px))] flex-col gap-2 overflow-y-auto rounded-[12px] border border-border bg-card p-3 shadow-2">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] font-bold">{t(draft ? "groupOverride.draftTitle" : "groupOverride.pipelineTitle", { name: label })}</span>
        <button className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-canvas text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" aria-label={t("groupOverride.closePanel")} onClick={onClose}><X className="h-3.5 w-3.5" aria-hidden /></button>
      </div>
      {error ? <span role="alert" className="text-[10.5px] font-semibold text-danger">{error}</span> : null}
      {saved ? <span className="text-[10.5px] font-semibold text-success">{saved}</span> : null}
      {draft ? (
        <div className="flex flex-col gap-1.5 rounded-[9px] border border-dashed border-warning/60 bg-warning-soft p-2">
          <label className="flex flex-col gap-1"><span className={fieldLabel}>{t("groupOverride.task")}</span><input className={inputBase} value={task} onChange={(event) => setTask(event.target.value)} /></label>
          <label className="flex flex-col gap-1"><span className={fieldLabel}>{t("groupOverride.spec")}</span><textarea className="min-h-[52px] w-full resize-y rounded-[8px] border border-border bg-canvas px-2 py-1.5 text-[11.5px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" value={spec} onChange={(event) => setSpec(event.target.value)} /></label>
          <label className="flex flex-col gap-1"><span className={fieldLabel}>{t("groupOverride.repoDir")}</span><input className={inputBase} value={repoDir} onChange={(event) => setRepoDir(event.target.value)} /></label>
          <button className={primaryBtn} disabled={busy || !task.trim() || !repoDir.trim()} onClick={() => void run(t("groupOverride.savedDraft"), () => patchPipeline(pipeline.id, "update-draft", { task, spec, repoDir }))}>{t("groupOverride.saveDraft")}</button>
        </div>
      ) : null}
      {/* Stage editing moved to the canvas cards (#507): point there instead of
          re-mounting a competing nested form. */}
      {!closed && editableStages ? (
        <div data-pipeline-editor-canvas-hint className="flex items-start gap-1.5 rounded-[9px] border border-border bg-sunken px-2 py-1.5 text-[10.5px] font-semibold text-muted">
          <LayoutGrid className="mt-[1px] h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
          <span>{t("groupOverride.editStagesOnCanvas")}</span>
        </div>
      ) : null}
      {parked ? (
        <div className="flex items-center gap-1.5">
          <button className={primaryBtn + " flex-1"} disabled={busy} onClick={() => void run(t("pipelineStrip.retryStage"), () => patchPipeline(pipeline.id, "retry-stage"))}>{t("pipelineStrip.retryStage")}</button>
          <button className={ghostBtn} disabled={busy} onClick={() => void run(t("pipelineStrip.skipStage"), () => patchPipeline(pipeline.id, "skip-stage"))}>{t("pipelineStrip.skipStage")}</button>
        </div>
      ) : null}
      <div className="flex items-center gap-1.5">
        {draft ? (
          <button className="inline-flex min-h-11 flex-1 items-center justify-center gap-1 rounded-full border border-accent bg-accent px-3 text-[11px] font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40" disabled={busy || pipeline.stages.length < MIN_STARTED_PIPELINE_STAGES} title={pipeline.stages.length < MIN_STARTED_PIPELINE_STAGES ? t("groupOverride.startNeedsStages") : undefined} onClick={() => void run(t("pipelineStrip.start"), () => patchPipeline(pipeline.id, "start"))}><Play className="h-3.5 w-3.5" aria-hidden /> {t("pipelineStrip.start")}</button>
        ) : closed ? null : pipeline.state === "paused" ? (
          <button className="inline-flex flex-1 items-center justify-center gap-1 rounded-full border border-success/40 bg-success-soft px-3 py-1 text-[11px] font-bold text-success focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40" disabled={busy} onClick={() => void run(t("pipelineStrip.resume"), () => patchPipeline(pipeline.id, "resume"))}><Play className="h-3 w-3" aria-hidden /> {t("pipelineStrip.resume")}</button>
        ) : (
          <button className={ghostBtn} disabled={busy} onClick={() => void run(t("pipelineStrip.pause"), () => patchPipeline(pipeline.id, "pause"))}><Pause className="h-3 w-3" aria-hidden /> {t("pipelineStrip.pause")}</button>
        )}
        <button className="inline-flex flex-1 items-center justify-center gap-1 rounded-full border border-border bg-canvas px-3 py-1 text-[11px] font-bold text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40" disabled={busy} onClick={() => void run(t(draft ? "pipelineStrip.discard" : "pipelineStrip.close"), () => patchPipeline(pipeline.id, draft ? "delete" : "close"))}><X className="h-3 w-3" aria-hidden /> {t(draft ? "pipelineStrip.discard" : "pipelineStrip.close")}</button>
      </div>
    </div>
  );
}
