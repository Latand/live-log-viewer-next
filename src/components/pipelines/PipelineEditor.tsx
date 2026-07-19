"use client";

import { ArrowDown, ArrowUp, Pause, Play, Plus, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";

import { effortTierLabel, roleNameById } from "@/components/builderCopy";
import { Select } from "@/components/ui/Select";
import { ENGINE_EFFORTS } from "@/lib/agent/efforts";
import type { FlowEngine } from "@/lib/flows/types";
import { useLocale } from "@/lib/i18n";
import { MAX_PIPELINE_STAGES, MIN_STARTED_PIPELINE_STAGES } from "@/lib/pipelines/limits";
import type { Pipeline, PipelineStage, PipelineStageKind } from "@/lib/pipelines/types";

import {
  PIPELINE_ROLE_OPTIONS,
  buildStagePrompt,
  defaultStageWiring,
  optimisticAddStage,
  optimisticRemoveStage,
  patchPipeline,
  reviewLoopChainValid,
  stageOverrideBody,
  stagePromptExtra,
  stageReceivesPrevOutput,
} from "./pipelineModel";
import { StageEdgeControls } from "./StageEdgeControls";

const ENGINES: FlowEngine[] = ["claude", "codex"];
const fieldLabel = "text-label font-semibold text-secondary";
const inputBase =
  "h-7 w-full rounded-[8px] border border-border bg-canvas px-2 text-[11.5px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
const primaryBtn =
  "inline-flex items-center justify-center gap-1 rounded-full border border-accent bg-accent px-3 py-1 text-[11px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40";
const ghostBtn =
  "inline-flex flex-1 items-center justify-center gap-1 rounded-full border border-border bg-canvas px-3 py-1 text-[11px] font-bold text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40";

function resetRuntimeForEngine(
  next: FlowEngine,
  ctl: { setEngine: (engine: FlowEngine) => void; setModel: (model: string) => void; setEffort: (effort: string) => void; effort: string },
): void {
  ctl.setEngine(next);
  ctl.setModel("");
  if (ctl.effort && !ENGINE_EFFORTS[next].includes(ctl.effort)) ctl.setEffort("");
}

function stageAttemptCount(pipeline: Pipeline, stageId: string): number {
  return pipeline.runs.find((run) => run.stageId === stageId)?.attempts.length ?? 0;
}

function EffortSelect({ engine, value, onChange, label }: { engine: FlowEngine; value: string; onChange: (value: string) => void; label: string }) {
  const { t } = useLocale();
  const tiers = ENGINE_EFFORTS[engine];
  const safe = value && tiers.includes(value) ? value : "";
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className={fieldLabel}>{label}</span>
      <Select className="w-full" value={safe} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t("groupOverride.effortDefault")}</option>
        {tiers.map((effort) => (
          <option key={effort} value={effort}>{effortTierLabel(t, effort)}</option>
        ))}
      </Select>
    </label>
  );
}

function EngineSelect({ value, onChange }: { value: FlowEngine; onChange: (value: FlowEngine) => void }) {
  const { t } = useLocale();
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className={fieldLabel}>{t("groupOverride.engine")}</span>
      <Select className="w-full" value={value} onChange={(event) => onChange(event.target.value as FlowEngine)}>
        {ENGINES.map((engine) => <option key={engine} value={engine}>{engine}</option>)}
      </Select>
    </label>
  );
}

function StageForm({
  pipeline,
  stage,
  index,
  busy,
  disabled,
  run,
}: {
  pipeline: Pipeline;
  stage: PipelineStage;
  index: number;
  busy: boolean;
  disabled: boolean;
  run: (label: string, action: () => Promise<string | null>) => Promise<void>;
}) {
  const { t } = useLocale();
  const [roleId, setRoleId] = useState(stage.role?.roleId ?? "");
  const [engine, setEngine] = useState<FlowEngine>(stage.effectiveRole.engine);
  const [model, setModel] = useState(stage.effectiveRole.model ?? "");
  const [effort, setEffort] = useState(stage.effectiveRole.effort ?? "");
  const [extra, setExtra] = useState(() => stagePromptExtra(stage.prompt));
  const promptForSubmit = () =>
    extra.trim() === stagePromptExtra(stage.prompt) ? stage.prompt : buildStagePrompt(stage.prompt, extra, index);

  return (
    <>
      <label className="flex flex-col gap-1">
        <span className={fieldLabel}>{t("groupOverride.role")}</span>
        <Select className="w-full" value={roleId} onChange={(event) => setRoleId(event.target.value)}>
          <option value="">{t("groupOverride.noRole")}</option>
          {PIPELINE_ROLE_OPTIONS.map((id) => <option key={id} value={id}>{roleNameById(t, id)}</option>)}
        </Select>
      </label>
      <div className="flex items-end gap-1.5">
        <EngineSelect value={engine} onChange={(next) => resetRuntimeForEngine(next, { setEngine, setModel, setEffort, effort })} />
        <EffortSelect engine={engine} value={effort} onChange={setEffort} label={t("groupOverride.effort")} />
      </div>
      <label className="flex flex-col gap-1">
        <span className={fieldLabel}>{t("groupOverride.model")}</span>
        <input className={inputBase} value={model} placeholder={t("groupOverride.modelPlaceholder")} onChange={(event) => setModel(event.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        <span className={fieldLabel}>{t("groupOverride.stagePrompt")}</span>
        <span className="text-label font-medium text-muted">
          {t(stage.kind === "review-loop" ? "pipelineSlot.reviewHint" : index > 0 && stageReceivesPrevOutput(stage.prompt) ? "pipelineSlot.wiringPrev" : "pipelineSlot.wiringTask")}
        </span>
        <textarea
          className="min-h-[64px] w-full resize-y rounded-[8px] border border-border bg-canvas px-2 py-1.5 text-[11.5px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          value={extra}
          placeholder={t("pipelineSlot.noPrompt")}
          onChange={(event) => setExtra(event.target.value)}
        />
      </label>
      <button
        className={primaryBtn}
        disabled={busy || disabled}
        onClick={() => void run(t("groupOverride.savedStage"), () => patchPipeline(pipeline.id, "override-stage", stageOverrideBody(stage, { roleId, engine, model, effort, prompt: promptForSubmit() })))}
      >
        {t("groupOverride.applyStage")}
      </button>
    </>
  );
}

function DraftStageCards({
  pipeline,
  busy,
  run,
}: {
  pipeline: Pipeline;
  busy: boolean;
  run: (label: string, action: () => Promise<string | null>) => Promise<void>;
}) {
  const { t } = useLocale();
  const stages = pipeline.stages;
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const kinds = stages.map((item) => item.kind);
  const orderAfterMove = (from: number, to: number): PipelineStageKind[] => {
    const next = [...kinds];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    return next;
  };
  const canMoveTo = (fromIndex: number, toIndex: number) =>
    toIndex >= 0 && toIndex < stages.length && toIndex !== fromIndex && reviewLoopChainValid(orderAfterMove(fromIndex, toIndex));
  const canRemove = (index: number) => stages.length > 1 && reviewLoopChainValid(kinds.filter((_, candidate) => candidate !== index));
  const canAddReview = stages.length < MAX_PIPELINE_STAGES && stages.some((item) => item.kind === "run");
  const moveTo = (stageId: string, toIndex: number) => {
    const from = stages.findIndex((item) => item.id === stageId);
    if (from < 0 || !canMoveTo(from, toIndex)) return;
    void run(t("groupOverride.reordered"), () => patchPipeline(pipeline.id, "reorder-stage", { stageId, toIndex }));
  };
  const addStage = (kind: PipelineStageKind) => {
    const ids = new Set(stages.map((item) => item.id));
    let n = stages.length + 1;
    while (ids.has(`stage-${n}`)) n += 1;
    const index = stages.length;
    const stage = { id: `stage-${n}`, kind, prompt: defaultStageWiring(index), next: null };
    void run(t("groupOverride.stageAdded"), () => patchPipeline(pipeline.id, "add-stage", { index, stage }, optimisticAddStage(pipeline, stage, index)));
  };
  const removeStage = (stageId: string) =>
    void run(t("groupOverride.stageRemoved"), () => patchPipeline(pipeline.id, "remove-stage", { stageId }, optimisticRemoveStage(pipeline, stageId)));
  const onDrop = (targetId: string) => {
    const from = dragId;
    setDragId(null);
    setOverId(null);
    if (!from || from === targetId) return;
    const toIndex = stages.findIndex((item) => item.id === targetId);
    if (toIndex >= 0) moveTo(from, toIndex);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10.5px] font-bold text-primary">{t("groupOverride.stagesHeading")}</span>
      <span className="text-[10px] font-semibold text-muted">{stages.length ? t("groupOverride.stagesHint") : t("groupOverride.stagesEmpty")}</span>
      <div className="flex max-h-[46vh] flex-col gap-2 overflow-y-auto pr-0.5">
        {stages.map((stage, index) => (
          <div
            key={stage.id}
            data-stage-card={stage.id}
            draggable={!busy}
            onDragStart={(event) => { setDragId(stage.id); event.dataTransfer?.setData?.("text/plain", stage.id); }}
            onDragEnd={() => { setDragId(null); setOverId(null); }}
            onDragOver={(event) => { event.preventDefault(); if (overId !== stage.id) setOverId(stage.id); }}
            onDrop={(event) => { event.preventDefault(); onDrop(stage.id); }}
            className={`flex flex-col gap-1.5 rounded-[10px] border bg-card p-2 ${overId === stage.id && dragId && dragId !== stage.id ? "border-accent" : "border-border"} ${dragId === stage.id ? "opacity-60" : ""}`}
          >
            <div className="flex items-center gap-1.5">
              <span className="cursor-grab select-none text-[13px] leading-none text-muted" aria-label={t("groupOverride.dragHandle")} title={t("groupOverride.dragHandle")}>⠿</span>
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-sunken px-1.5 text-[10px] font-black text-muted">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate text-[10.5px] font-bold text-primary">{stage.role?.roleId ? roleNameById(t, stage.role.roleId) : stage.id}</span>
              <span className="shrink-0 rounded-full border border-border px-1.5 py-[1px] text-[9px] font-bold uppercase tracking-wide text-muted">{t(stage.kind === "review-loop" ? "groupOverride.reviewKind" : "groupOverride.runKind")}</span>
              <button className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-border bg-canvas text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-30" disabled={busy || !canMoveTo(index, index - 1)} aria-label={t("groupOverride.moveStageUp")} onClick={() => moveTo(stage.id, index - 1)}><ArrowUp className="h-3 w-3" aria-hidden /></button>
              <button className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-border bg-canvas text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-30" disabled={busy || !canMoveTo(index, index + 1)} aria-label={t("groupOverride.moveStageDown")} onClick={() => moveTo(stage.id, index + 1)}><ArrowDown className="h-3 w-3" aria-hidden /></button>
              <button className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-border bg-canvas text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-30" disabled={busy || !canRemove(index)} aria-label={t("groupOverride.removeStage")} onClick={() => removeStage(stage.id)}><Trash2 className="h-3 w-3" aria-hidden /></button>
            </div>
            <StageForm key={`${stage.id}:${stage.role?.roleId ?? ""}:${stage.effectiveRole.engine}:${stage.effectiveRole.model ?? ""}:${stage.effectiveRole.effort ?? ""}:${stage.prompt}`} pipeline={pipeline} stage={stage} index={index} busy={busy} disabled={false} run={run} />
            {stages.length > 1 ? <StageEdgeControls pipeline={pipeline} stage={stage} disabled={busy} /> : null}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <button className={ghostBtn} disabled={busy || stages.length >= MAX_PIPELINE_STAGES} onClick={() => addStage("run")}><Plus className="h-3 w-3" aria-hidden /> {t("groupOverride.addRunStage")}</button>
        <button className={ghostBtn} disabled={busy || !canAddReview} onClick={() => addStage("review-loop")}><Plus className="h-3 w-3" aria-hidden /> {t("groupOverride.addReviewStage")}</button>
      </div>
    </div>
  );
}

export function PipelineEditor({ pipeline, onClose, label = pipeline.task }: { pipeline: Pipeline; onClose: () => void; label?: string }) {
  const { t } = useLocale();
  const draft = pipeline.state === "draft";
  const editable = useMemo(() => pipeline.stages.filter((stage) => stageAttemptCount(pipeline, stage.id) === 0), [pipeline]);
  const [stageId, setStageId] = useState(editable[0]?.id ?? "");
  const stage = editable.find((item) => item.id === stageId) ?? editable[0] ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [task, setTask] = useState(pipeline.task);
  const [spec, setSpec] = useState(pipeline.spec ?? "");
  const [repoDir, setRepoDir] = useState(pipeline.repoDir);
  const closed = pipeline.state === "completed" || pipeline.state === "closed";
  const parked = pipeline.state === "needs_decision";
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
      {draft ? (
        <DraftStageCards pipeline={pipeline} busy={busy} run={run} />
      ) : stage ? (
        <>
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>{t("groupOverride.nextStage")}</span>
            <Select className="w-full" value={stage.id} onChange={(event) => setStageId(event.target.value)}>
              {editable.map((item) => <option key={item.id} value={item.id}>{item.role?.roleId ? roleNameById(t, item.role.roleId) : item.id}</option>)}
            </Select>
          </label>
          <StageForm key={`${stage.id}:${stage.role?.roleId ?? ""}:${stage.effectiveRole.engine}:${stage.effectiveRole.model ?? ""}:${stage.effectiveRole.effort ?? ""}:${stage.prompt}`} pipeline={pipeline} stage={stage} index={Math.max(0, pipeline.stages.findIndex((item) => item.id === stage.id))} busy={busy} disabled={closed} run={run} />
        </>
      ) : <span className="text-[11px] font-semibold text-muted">{t("groupOverride.noEditableStage")}</span>}
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
