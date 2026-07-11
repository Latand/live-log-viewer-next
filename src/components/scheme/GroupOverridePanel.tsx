"use client";

import { Pause, Play, RefreshCw, Square, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { FlowEngine } from "@/lib/flows/types";
import type { PipelineStage } from "@/lib/pipelines/types";
import { useLocale } from "@/lib/i18n";

import { patchFlow } from "@/components/flows/flowModel";
import { patchPipeline } from "@/components/pipelines/pipelineModel";

import type { SchemeGroup } from "./layout";

/* Effort tiers offered on the override selects. Empty = the engine default; the
   backend blanks a blank effort back to null, so the two agree. Claude accepts
   `max`; codex tops out at `xhigh`, but an unsupported tier just falls back at
   spawn, so one shared list keeps the control simple. */
const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"] as const;
const ENGINES: FlowEngine[] = ["claude", "codex"];

/** How many attempts a pipeline stage has already run — 0 means it is still in
    the future and safe to re-configure (matches the engine's override guard). */
function stageAttemptCount(group: SchemeGroup, stageId: string): number {
  return group.pipeline?.runs.find((run) => run.stageId === stageId)?.attempts.length ?? 0;
}

/**
 * On-canvas stage-override controls for a running flow or pipeline (issue #118),
 * opened from a group halo's label. It steers a flow/pipeline WITHOUT recreating
 * it: change the next round/stage engine·model·effort, edit the next-round note
 * or next-stage prompt, extend or cap rounds, and drive the existing
 * retry/cancel/pause/resume/skip/close actions — every button is a PATCH to the
 * flows or pipelines API. A running round/stage keeps the config it froze at
 * spawn; the override lands on the next one.
 */
export function GroupOverridePanel({ group, onClose }: { group: SchemeGroup; onClose: () => void }) {
  return (
    <div
      data-scheme-ui
      data-group-override={group.kind}
      role="dialog"
      aria-label={group.label}
      className="flex w-[268px] flex-col gap-2 rounded-[12px] border border-line bg-panel p-3 shadow-[0_10px_36px_rgb(20_20_30/0.18)]"
    >
      {group.flow ? <FlowOverride group={group} onClose={onClose} /> : null}
      {group.pipeline ? <PipelineOverride group={group} onClose={onClose} /> : null}
    </div>
  );
}

function PanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
  const { t } = useLocale();
  return (
    <div className="flex items-center gap-1.5">
      <span className="min-w-0 flex-1 truncate text-[12px] font-bold">{title}</span>
      <button
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-bg text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        aria-label={t("groupOverride.closePanel")}
        onClick={onClose}
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}

const fieldLabel = "text-[10px] font-bold uppercase tracking-wide text-dim";
const inputBase =
  "h-7 w-full rounded-[8px] border border-line bg-bg px-2 text-[11.5px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
const primaryBtn =
  "inline-flex items-center justify-center gap-1 rounded-full border border-accent bg-accent px-3 py-1 text-[11px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40";
const ghostBtn =
  "inline-flex flex-1 items-center justify-center gap-1 rounded-full border border-line bg-bg px-3 py-1 text-[11px] font-bold text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40";

function EffortSelect({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  const { t } = useLocale();
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className={fieldLabel}>{label}</span>
      <select className={inputBase} value={value} onChange={(event) => onChange(event.target.value)}>
        {EFFORTS.map((effort) => (
          <option key={effort || "default"} value={effort}>
            {effort || t("groupOverride.effortDefault")}
          </option>
        ))}
      </select>
    </label>
  );
}

function EngineSelect({ value, onChange }: { value: FlowEngine; onChange: (value: FlowEngine) => void }) {
  const { t } = useLocale();
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className={fieldLabel}>{t("groupOverride.engine")}</span>
      <select className={inputBase} value={value} onChange={(event) => onChange(event.target.value as FlowEngine)}>
        {ENGINES.map((engine) => (
          <option key={engine} value={engine}>
            {engine}
          </option>
        ))}
      </select>
    </label>
  );
}

function FlowOverride({ group, onClose }: { group: SchemeGroup; onClose: () => void }) {
  const { t } = useLocale();
  const flow = group.flow!;
  const reviewer = flow.roles.reviewer;
  const [engine, setEngine] = useState<FlowEngine>(reviewer.engine);
  const [model, setModel] = useState(reviewer.model ?? "");
  const [effort, setEffort] = useState(reviewer.effort ?? "");
  const [note, setNote] = useState(flow.rounds.at(-1)?.readyNote ?? "");
  const [limit, setLimit] = useState(String(flow.roundLimit));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const closed = flow.state === "closed" || flow.state === "approved";

  const run = async (label: string, action: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    const fail = await action();
    if (fail) setError(fail);
    else setSaved(label);
    setBusy(false);
  };

  return (
    <>
      <PanelHeader title={t("groupOverride.flowTitle", { name: group.label })} onClose={onClose} />
      {error ? <span className="truncate text-[10.5px] font-semibold text-err" title={error}>{error}</span> : null}
      {saved ? <span className="truncate text-[10.5px] font-semibold text-ok">{saved}</span> : null}

      <span className="text-[10.5px] font-bold text-ink">{t("groupOverride.reviewerRole")}</span>
      <div className="flex items-end gap-1.5">
        <EngineSelect value={engine} onChange={setEngine} />
        <EffortSelect value={effort} onChange={setEffort} label={t("groupOverride.effort")} />
      </div>
      <label className="flex flex-col gap-1">
        <span className={fieldLabel}>{t("groupOverride.model")}</span>
        <input
          className={inputBase}
          value={model}
          placeholder={t("groupOverride.modelPlaceholder")}
          onChange={(event) => setModel(event.target.value)}
        />
      </label>
      <button
        className={primaryBtn}
        disabled={busy || closed}
        onClick={() =>
          void run(t("groupOverride.savedReviewer"), () =>
            patchFlow(flow.id, {
              action: "set-roles",
              roles: { reviewer: { engine, model: model.trim() || null, effort: effort || null } },
            }),
          )
        }
      >
        {t("groupOverride.applyRole")}
      </button>

      <label className="flex flex-col gap-1">
        <span className={fieldLabel}>{t("groupOverride.nextRoundNote")}</span>
        <textarea
          className="min-h-[52px] w-full resize-y rounded-[8px] border border-line bg-bg px-2 py-1.5 text-[11.5px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          value={note}
          placeholder={t("groupOverride.notePlaceholder")}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>

      <div className="flex items-end gap-1.5">
        <label className="flex w-[86px] flex-col gap-1">
          <span className={fieldLabel}>{t("groupOverride.roundLimit")}</span>
          <input
            className={inputBase}
            type="number"
            min={0}
            max={50}
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
          />
        </label>
        <button
          className={ghostBtn}
          disabled={busy || closed}
          onClick={() =>
            void run(t("groupOverride.savedLimit"), () =>
              patchFlow(flow.id, { action: "set-round-limit", rounds: Math.max(0, Math.min(50, Number(limit) || 0)) }),
            )
          }
        >
          {t("groupOverride.setLimit")}
        </button>
        <button
          className={ghostBtn}
          disabled={busy || closed}
          onClick={() => void run(t("groupOverride.savedExtend"), () => patchFlow(flow.id, { action: "extend", rounds: 1 }))}
        >
          {t("groupOverride.extend")}
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        {flow.state === "needs_decision" ? (
          <button
            className={primaryBtn + " flex-1"}
            disabled={busy}
            onClick={() =>
              void run(t("groupOverride.savedRetry"), () =>
                patchFlow(flow.id, { action: "retry-round", note: note.trim() || undefined }),
              )
            }
          >
            <RefreshCw className="h-3 w-3" aria-hidden /> {t("flowStrip.retryRound")}
          </button>
        ) : null}
        {flow.state === "reviewing" ? (
          <button
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-full border border-err/40 bg-[#fbeaea] px-3 py-1 text-[11px] font-bold text-err hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
            disabled={busy}
            onClick={() => void run(t("groupOverride.savedCancel"), () => patchFlow(flow.id, { action: "cancel-round" }))}
          >
            <Square className="h-3 w-3" aria-hidden /> {t("flowStrip.stopReviewer")}
          </button>
        ) : null}
      </div>

      <div className="flex items-center gap-1.5">
        {closed ? null : flow.state === "paused" ? (
          <button
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-full border border-ok/40 bg-[#eef8f0] px-3 py-1 text-[11px] font-bold text-ok hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
            disabled={busy}
            onClick={() => void run(t("flowStrip.resume"), () => patchFlow(flow.id, { action: "resume" }))}
          >
            <Play className="h-3 w-3" aria-hidden /> {t("flowStrip.resume")}
          </button>
        ) : (
          <button
            className={ghostBtn}
            disabled={busy}
            onClick={() => void run(t("flowStrip.pause"), () => patchFlow(flow.id, { action: "pause" }))}
          >
            <Pause className="h-3 w-3" aria-hidden /> {t("flowStrip.pause")}
          </button>
        )}
        <button
          className="inline-flex flex-1 items-center justify-center gap-1 rounded-full border border-line bg-bg px-3 py-1 text-[11px] font-bold text-dim hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
          disabled={busy}
          onClick={() => void run(t("flowStrip.close"), () => patchFlow(flow.id, { action: "close" }))}
        >
          <X className="h-3 w-3" aria-hidden /> {t("flowStrip.close")}
        </button>
      </div>
    </>
  );
}

/** The per-stage editing form (issue #118): engine·model·effort·prompt for one
    not-yet-started stage. Remounted (via `key={stage.id}`) whenever the operator
    picks a different upcoming stage, so its inputs always start from that stage's
    current config without a reset effect. */
function StageForm({
  group,
  stage,
  busy,
  disabled,
  run,
}: {
  group: SchemeGroup;
  stage: PipelineStage;
  busy: boolean;
  disabled: boolean;
  run: (label: string, action: () => Promise<string | null>) => Promise<void>;
}) {
  const { t } = useLocale();
  const pipeline = group.pipeline!;
  const [engine, setEngine] = useState<FlowEngine>(stage.effectiveRole.engine);
  const [model, setModel] = useState(stage.effectiveRole.model ?? "");
  const [effort, setEffort] = useState(stage.effectiveRole.effort ?? "");
  const [prompt, setPrompt] = useState(stage.prompt);
  return (
    <>
      <div className="flex items-end gap-1.5">
        <EngineSelect value={engine} onChange={setEngine} />
        <EffortSelect value={effort} onChange={setEffort} label={t("groupOverride.effort")} />
      </div>
      <label className="flex flex-col gap-1">
        <span className={fieldLabel}>{t("groupOverride.model")}</span>
        <input
          className={inputBase}
          value={model}
          placeholder={t("groupOverride.modelPlaceholder")}
          onChange={(event) => setModel(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className={fieldLabel}>{t("groupOverride.stagePrompt")}</span>
        <textarea
          className="min-h-[64px] w-full resize-y rounded-[8px] border border-line bg-bg px-2 py-1.5 text-[11.5px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      <button
        className={primaryBtn}
        disabled={busy || disabled || !prompt.trim()}
        onClick={() =>
          void run(t("groupOverride.savedStage"), () =>
            patchPipeline(pipeline.id, "override-stage", {
              stageId: stage.id,
              engine,
              model: model.trim() || null,
              effort: effort || null,
              prompt: prompt.trim(),
            }),
          )
        }
      >
        {t("groupOverride.applyStage")}
      </button>
    </>
  );
}

function PipelineOverride({ group, onClose }: { group: SchemeGroup; onClose: () => void }) {
  const { t } = useLocale();
  const pipeline = group.pipeline!;
  /* Only stages that have not run yet can be re-configured — the engine snapshots
     a stage's config the moment its first attempt starts. */
  const editable = useMemo(
    () => pipeline.stages.filter((stage) => stageAttemptCount(group, stage.id) === 0),
    [pipeline, group],
  );
  const [stageId, setStageId] = useState(editable[0]?.id ?? "");
  const stage = editable.find((item) => item.id === stageId) ?? editable[0] ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const closed = pipeline.state === "completed" || pipeline.state === "closed";
  const parked = pipeline.state === "needs_decision";

  const run = async (label: string, action: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    const fail = await action();
    if (fail) setError(fail);
    else setSaved(label);
    setBusy(false);
  };

  return (
    <>
      <PanelHeader title={t("groupOverride.pipelineTitle", { name: group.label })} onClose={onClose} />
      {error ? <span className="truncate text-[10.5px] font-semibold text-err" title={error}>{error}</span> : null}
      {saved ? <span className="truncate text-[10.5px] font-semibold text-ok">{saved}</span> : null}

      {stage ? (
        <>
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>{t("groupOverride.nextStage")}</span>
            <select className={inputBase} value={stage.id} onChange={(event) => setStageId(event.target.value)}>
              {editable.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.role?.roleId ?? item.id}
                </option>
              ))}
            </select>
          </label>
          {/* Keyed on the stage id so switching stages remounts the form with the
              picked stage's config — no reset-in-effect. */}
          <StageForm key={stage.id} group={group} stage={stage} busy={busy} disabled={closed} run={run} />
        </>
      ) : (
        <span className="text-[11px] font-semibold text-dim">{t("groupOverride.noEditableStage")}</span>
      )}

      {parked ? (
        <div className="flex items-center gap-1.5">
          <button
            className={primaryBtn + " flex-1"}
            disabled={busy}
            onClick={() => void run(t("pipelineStrip.retryStage"), () => patchPipeline(pipeline.id, "retry-stage"))}
          >
            {t("pipelineStrip.retryStage")}
          </button>
          <button
            className={ghostBtn}
            disabled={busy}
            onClick={() => void run(t("pipelineStrip.skipStage"), () => patchPipeline(pipeline.id, "skip-stage"))}
          >
            {t("pipelineStrip.skipStage")}
          </button>
        </div>
      ) : null}

      <div className="flex items-center gap-1.5">
        {closed ? null : pipeline.state === "paused" ? (
          <button
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-full border border-ok/40 bg-[#eef8f0] px-3 py-1 text-[11px] font-bold text-ok hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
            disabled={busy}
            onClick={() => void run(t("pipelineStrip.resume"), () => patchPipeline(pipeline.id, "resume"))}
          >
            <Play className="h-3 w-3" aria-hidden /> {t("pipelineStrip.resume")}
          </button>
        ) : (
          <button
            className={ghostBtn}
            disabled={busy}
            onClick={() => void run(t("pipelineStrip.pause"), () => patchPipeline(pipeline.id, "pause"))}
          >
            <Pause className="h-3 w-3" aria-hidden /> {t("pipelineStrip.pause")}
          </button>
        )}
        <button
          className="inline-flex flex-1 items-center justify-center gap-1 rounded-full border border-line bg-bg px-3 py-1 text-[11px] font-bold text-dim hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
          disabled={busy}
          onClick={() => void run(t("pipelineStrip.close"), () => patchPipeline(pipeline.id, "close"))}
        >
          <X className="h-3 w-3" aria-hidden /> {t("pipelineStrip.close")}
        </button>
      </div>
    </>
  );
}
