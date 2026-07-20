"use client";
import { Pause, Play, X } from "lucide-react";
import { useState } from "react";

import { patchPipeline, type StageNavTarget } from "@/components/pipelines/pipelineModel";
import type { Flow } from "@/lib/flows/types";
import { useLocale } from "@/lib/i18n";
import { MIN_STARTED_PIPELINE_STAGES } from "@/lib/pipelines/limits";
import type { Pipeline } from "@/lib/pipelines/types";

import { PipelineStageGraph, PipelineStageGraphFlowsProvider } from "./PipelineStageGraph";

const inputBase =
  "h-7 w-full rounded-[8px] border border-border bg-canvas px-2 text-[11.5px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
const fieldLabel = "text-label font-semibold text-secondary";
const primaryBtn =
  "inline-flex min-h-8 items-center justify-center gap-1 rounded-full border border-accent bg-accent px-3 text-[11px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40";
const ghostBtn =
  "inline-flex min-h-8 flex-1 items-center justify-center gap-1 rounded-full border border-border bg-canvas px-3 text-[11px] font-bold text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40";

/**
 * The expanded body of a board `PipelineGroup` (#353 operator correction): the
 * SAME compact colored container introduced in #451 now hosts the real
 * conversation-card shells — every declared stage rendered by `PipelineStageGraph`
 * (pending placeholders, live conversations, completed rounds, roles, statuses,
 * and the directed pass/fail links) — followed by only the compact metadata and
 * lifecycle controls. There is no tall nested-scroll stage form and no detached
 * graph surface: the body sizes to its actual card content, so a short pipeline
 * never leaves an empty fixed-height slab.
 *
 * The heavy desktop graph mounts ONLY here, on the board. The phone keeps its
 * compact `MobilePipelineDock` disclosure (chat stays primary), so this panel is
 * never mounted in the conversation viewport.
 */
export function PipelineGroupBody({
  pipeline,
  flows,
  onOpenAttempt,
  onClose,
}: {
  pipeline: Pipeline;
  flows: readonly Flow[];
  onOpenAttempt: (target: StageNavTarget) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const draft = pipeline.state === "draft";
  const paused = pipeline.state === "paused";
  const parked = pipeline.state === "needs_decision";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [task, setTask] = useState(pipeline.task);
  const [spec, setSpec] = useState(pipeline.spec ?? "");
  const [repoDir, setRepoDir] = useState(pipeline.repoDir);

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
    <div
      data-scheme-ui
      data-group-override="pipeline"
      data-pipeline-group-editor={pipeline.id}
      role="dialog"
      aria-label={t(draft ? "groupOverride.draftTitle" : "groupOverride.pipelineTitle", { name: pipeline.task })}
      className="flex flex-col gap-2"
    >
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] font-bold text-primary">
          {t(draft ? "groupOverride.draftTitle" : "groupOverride.pipelineTitle", { name: pipeline.task })}
        </span>
        <button
          type="button"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-canvas text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label={t("groupOverride.closePanel")}
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      {error ? <span role="alert" className="text-[10.5px] font-semibold text-danger">{error}</span> : null}
      {saved ? <span className="text-[10.5px] font-semibold text-success">{saved}</span> : null}

      {draft ? (
        <div className="flex flex-col gap-1.5 rounded-[9px] border border-dashed border-warning/60 bg-warning-soft p-2">
          <label className="flex flex-col gap-1"><span className={fieldLabel}>{t("groupOverride.task")}</span><input className={inputBase} value={task} onChange={(event) => setTask(event.target.value)} /></label>
          <label className="flex flex-col gap-1"><span className={fieldLabel}>{t("groupOverride.spec")}</span><input className={inputBase} value={spec} onChange={(event) => setSpec(event.target.value)} /></label>
          <label className="flex flex-col gap-1"><span className={fieldLabel}>{t("groupOverride.repoDir")}</span><input className={inputBase} value={repoDir} onChange={(event) => setRepoDir(event.target.value)} /></label>
          <button className={primaryBtn} disabled={busy || !task.trim() || !repoDir.trim()} onClick={() => void run(t("groupOverride.savedDraft"), () => patchPipeline(pipeline.id, "update-draft", { task, spec, repoDir }))}>{t("groupOverride.saveDraft")}</button>
        </div>
      ) : null}

      {/* The real conversation-card shells for every declared stage. */}
      <PipelineStageGraphFlowsProvider flows={flows}>
        <PipelineStageGraph pipeline={pipeline} onOpenAttempt={onOpenAttempt} />
      </PipelineStageGraphFlowsProvider>

      {parked ? (
        <div className="flex items-center gap-1.5">
          <button className={primaryBtn + " flex-1"} disabled={busy} onClick={() => void run(t("pipelineStrip.retryStage"), () => patchPipeline(pipeline.id, "retry-stage"))}>{t("pipelineStrip.retryStage")}</button>
          <button className={ghostBtn} disabled={busy} onClick={() => void run(t("pipelineStrip.skipStage"), () => patchPipeline(pipeline.id, "skip-stage"))}>{t("pipelineStrip.skipStage")}</button>
        </div>
      ) : null}

      <div className="flex items-center gap-1.5">
        {draft ? (
          <button className={primaryBtn + " flex-1"} disabled={busy || pipeline.stages.length < MIN_STARTED_PIPELINE_STAGES} title={pipeline.stages.length < MIN_STARTED_PIPELINE_STAGES ? t("groupOverride.startNeedsStages") : undefined} onClick={() => void run(t("pipelineStrip.start"), () => patchPipeline(pipeline.id, "start"))}><Play className="h-3.5 w-3.5" aria-hidden /> {t("pipelineStrip.start")}</button>
        ) : paused ? (
          <button className={ghostBtn} disabled={busy} onClick={() => void run(t("pipelineStrip.resume"), () => patchPipeline(pipeline.id, "resume"))}><Play className="h-3 w-3" aria-hidden /> {t("pipelineStrip.resume")}</button>
        ) : (
          <button className={ghostBtn} disabled={busy} onClick={() => void run(t("pipelineStrip.pause"), () => patchPipeline(pipeline.id, "pause"))}><Pause className="h-3 w-3" aria-hidden /> {t("pipelineStrip.pause")}</button>
        )}
        <button className={ghostBtn} disabled={busy} onClick={() => void run(t(draft ? "pipelineStrip.discard" : "pipelineStrip.close"), () => patchPipeline(pipeline.id, draft ? "delete" : "close"))}><X className="h-3 w-3" aria-hidden /> {t(draft ? "pipelineStrip.discard" : "pipelineStrip.close")}</button>
      </div>
    </div>
  );
}
