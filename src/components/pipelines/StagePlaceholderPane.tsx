"use client";

import { Check, Loader2 } from "lucide-react";
import { useState } from "react";

import { ReasoningControls } from "@/components/ReasoningControls";
import type { StageSlot } from "@/components/scheme/layout";
import { engineTintOf } from "@/components/utils";
import { isEngineEffort } from "@/lib/agent/efforts";
import { ENGINE_MODELS } from "@/lib/agent/models";
import type { FlowEngine } from "@/lib/flows/types";
import { useLocale } from "@/lib/i18n";

import {
  STAGE_TONES,
  patchPipeline,
  stageAttempts,
  stageChipLabel,
  stageChipState,
  stageOverrideBody,
} from "./pipelineModel";

const ENGINES: { key: FlowEngine; label: string }[] = [
  { key: "claude", label: "Claude" },
  { key: "codex", label: "Codex" },
];

/**
 * A planned pipeline stage as a dashed placeholder chat window on the canvas
 * (issue #196): the same footprint the stage's live window will take, labeled
 * with its role, visible from the moment a template lands as a draft. Carries
 * the per-role engine + model + reasoning pickers — the SAME ReasoningControls
 * every agent-launch surface uses, at the full 44px recipe — and each edit is
 * an `override-stage` PATCH against the draft, so the config the stage spawns
 * with is exactly what the placeholder shows. When the stage materializes a
 * node/deck, the layout dissolves this slot and the live window takes over.
 */
export function StagePlaceholderPane({ slot, interactive }: { slot: StageSlot; interactive: boolean }) {
  const { t } = useLocale();
  const { pipeline, stage } = slot;
  const state = stageChipState(pipeline, stage);
  const tone = STAGE_TONES[state];
  const label = stageChipLabel(t, stage);
  const review = stage.kind === "review-loop";
  /* Only a stage that has never run can be re-configured — the engine snapshots
     a stage's config at its first attempt (same guard as the builder panel). */
  const editable =
    interactive &&
    stageAttempts(pipeline, stage.id).length === 0 &&
    pipeline.state !== "completed" &&
    pipeline.state !== "closed";
  const [engine, setEngine] = useState<FlowEngine>(stage.effectiveRole.engine);
  const [model, setModel] = useState(stage.effectiveRole.model ?? "");
  const [effort, setEffort] = useState(stage.effectiveRole.effort ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /* Every picker change lands immediately as an override-stage PATCH carrying
     only the changed fields (stageOverrideBody), so a role's registry defaults
     stay live until the operator actually pins something. */
  const save = async (next: { engine: FlowEngine; model: string; effort: string }) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    const fail = await patchPipeline(
      pipeline.id,
      "override-stage",
      stageOverrideBody(stage, {
        roleId: stage.role?.roleId ?? "",
        engine: next.engine,
        model: next.model,
        effort: next.effort,
        prompt: stage.prompt,
      }),
    );
    if (fail) setError(fail);
    else setSaved(true);
    setBusy(false);
  };
  const changeEngine = (next: FlowEngine) => {
    if (next === engine) return;
    /* Switching the engine invalidates the model and can invalidate the effort
       tier, so both reset together (mirrors resetRuntimeForEngine). */
    const nextEffort = effort && isEngineEffort(next, effort) ? effort : "";
    setEngine(next);
    setModel("");
    setEffort(nextEffort);
    void save({ engine: next, model: "", effort: nextEffort });
  };
  const changeModel = (value: string) => {
    setModel(value);
    void save({ engine, model: value, effort });
  };
  const changeEffort = (value: string) => {
    setEffort(value);
    void save({ engine, model, effort: value });
  };

  const pulse = (state === "running" || state === "reviewing" || state === "committing") && pipeline.state !== "paused";
  const active = state !== "pending" && state !== "skipped";
  const hint = review
    ? t("pipelineSlot.reviewHint")
    : state === "running" || state === "reviewing" || state === "committing"
      ? t("pipelineSlot.starting", { role: label })
      : t("pipelineSlot.waiting", { role: label });
  const modelLabel = (ENGINE_MODELS[engine].find((option) => option.id === model)?.label ?? model) || t("draft.modelDefault");

  return (
    <section
      data-pan-ignore
      aria-label={t("pipelineSlot.paneAria", { role: label })}
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border-2 border-dashed bg-panel/85"
      style={{ borderColor: active ? tone.color : "var(--border-strong)" }}
    >
      <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-dashed border-line px-3 py-1.5">
        <span aria-hidden className="text-[15px] leading-none" style={{ color: tone.color }}>
          {review ? "⟳" : "▸"}
        </span>
        <span className="min-w-0 truncate text-[15px] font-bold text-ink">{label}</span>
        <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-dim">
          {t(review ? "groupOverride.reviewKind" : "groupOverride.runKind")}
        </span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${pulse ? "animate-pulse" : ""}`}
          style={{ backgroundColor: tone.soft, color: tone.color }}
        >
          {t(`pipelineChipState.${state}`)}
        </span>
        <span className="ml-auto shrink-0 text-[11px] font-semibold tabular-nums text-dim">
          {t("pipelineSlot.stageOf", { k: slot.index + 1, n: slot.total })}
        </span>
      </header>

      {interactive ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-dashed border-line bg-sunken px-3 py-2">
          <div className="flex shrink-0 items-center gap-1" role="radiogroup" aria-label={t("draft.engineAria")}>
            {ENGINES.map(({ key, label: engineLabel }) => {
              const isActive = engine === key;
              const chip = engineTintOf(key);
              return (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  disabled={!editable || busy}
                  onClick={() => changeEngine(key)}
                  style={isActive ? { backgroundColor: "#fff", color: chip.color, borderColor: chip.color } : undefined}
                  className={`min-h-11 rounded-[8px] border px-3 text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 ${
                    isActive ? "" : "border-transparent bg-transparent text-dim hover:text-ink"
                  }`}
                >
                  {engineLabel}
                </button>
              );
            })}
          </div>
          <ReasoningControls
            engine={engine as "claude" | "codex"}
            model={model}
            effort={effort}
            speed=""
            size="tall"
            disabled={!editable || busy}
            onModel={changeModel}
            onEffort={changeEffort}
            onSpeed={() => undefined}
          />
          {busy ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-dim" aria-hidden />
          ) : saved ? (
            <Check className="h-4 w-4 shrink-0 text-ok" role="img" aria-label={t("pipelineSlot.saved")} />
          ) : null}
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-2 border-b border-dashed border-line bg-sunken px-3 py-2 text-[12px] font-semibold text-secondary">
          <span className="rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ backgroundColor: engineTintOf(engine).soft, color: engineTintOf(engine).color }}>
            {engine === "claude" ? "Claude" : "Codex"}
          </span>
          <span className="min-w-0 truncate">{modelLabel}{effort ? ` · ${effort}` : ""}</span>
        </div>
      )}
      {error ? (
        <div className="shrink-0 px-3 py-1 text-[11px] font-semibold text-err" role="alert">
          {error}
        </div>
      ) : null}
      {interactive && !editable ? (
        <div className="shrink-0 px-3 py-1 text-[11px] font-semibold text-dim">{t("pipelineSlot.frozen")}</div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 py-3">
        <div className="shrink-0 rounded-[8px] bg-sunken px-3 py-2">
          <span className="block text-[10px] font-semibold uppercase tracking-wide text-dim">{t("pipelineSlot.promptLabel")}</span>
          <span className="mt-1 line-clamp-4 whitespace-pre-wrap text-[12px] leading-5 text-secondary">
            {stage.prompt || t("pipelineSlot.noPrompt")}
          </span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center">
          <span className="rounded-full px-3 py-1 text-[13px] font-bold" style={{ backgroundColor: tone.soft, color: tone.color }}>
            {label}
          </span>
          <span className="max-w-[400px] text-[12px] leading-5 text-dim">{hint}</span>
        </div>
      </div>
    </section>
  );
}
