"use client";

import { ArrowUpRight } from "lucide-react";

import { effortTierLabel } from "@/components/builderCopy";
import type { StageSlot } from "@/components/scheme/layout";
import { engineTintOf } from "@/components/utils";
import { ENGINE_MODELS } from "@/lib/agent/models";
import { useLocale } from "@/lib/i18n";

import {
  STAGE_TONES,
  VERDICT_TONES,
  attemptStateLabel,
  stageChipLabel,
  stageChipState,
  verdictStatusLabel,
} from "./pipelineModel";

/**
 * A terminal pipeline stage as a COMPACT navigable history card (#353 R3): its
 * full conversation pane is folded out of the world scene (compactPipelineArtifactPaths
 * keeps only the current live stage full-size), so this short card stands in at
 * the stage's position — carrying its verdict, state, model, and an open control
 * — so the stage stays a first-class halo member and its pass/fail edges keep a
 * real anchor. Opening it reveals the full transcript on demand.
 */
export function StageHistoryCard({ slot, onOpen }: { slot: StageSlot; onOpen?: () => void }) {
  const { t } = useLocale();
  const { pipeline, stage, attempt } = slot;
  const state = stageChipState(pipeline, stage);
  const tone = STAGE_TONES[state];
  const label = stageChipLabel(t, stage);
  const review = stage.kind === "review-loop";
  const tint = engineTintOf(stage.effectiveRole.engine);
  const model = stage.effectiveRole.model ?? "";
  const modelLabel = (ENGINE_MODELS[stage.effectiveRole.engine].find((option) => option.id === model)?.label ?? model)
    || t("draft.modelDefault");
  const effort = stage.effectiveRole.effort ? effortTierLabel(t, stage.effectiveRole.effort) : "";
  const verdict = attempt?.verdict ?? null;

  return (
    <section
      data-pipeline-stage-card={`${pipeline.id}::${stage.id}`}
      data-pipeline-stage-state={state}
      data-pipeline-stage-history="true"
      aria-label={t("pipelineSlot.historyAria", { role: label })}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-control border border-border bg-card/95 opacity-90 shadow-1"
      style={{ borderColor: tone.soft }}
    >
      <span aria-hidden className="h-1 w-full shrink-0 opacity-50" style={{ backgroundColor: tint.color }} />
      <header className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-2.5" style={{ backgroundColor: tint.soft }}>
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: tone.color }} />
        <span className="min-w-0 flex-1 truncate text-ui font-semibold text-muted" title={label}>
          {label} · {t("pipelineSlot.stageOf", { k: slot.index + 1, n: slot.total })}
        </span>
        <span className="shrink-0 rounded-full border border-border bg-card/70 px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide text-muted">
          {review ? `⟳ ${t("groupOverride.reviewKind")}` : t("groupOverride.runKind")}
        </span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 rounded-full px-2 py-0.5 text-label font-bold" style={{ backgroundColor: tone.soft, color: tone.color }}>
            {attempt ? attemptStateLabel(t, attempt.state) : t(`pipelineChipState.${state}`)}
          </span>
          {verdict ? (
            <span
              className="shrink-0 rounded-full px-2 py-0.5 text-label font-bold"
              style={{ backgroundColor: VERDICT_TONES[verdict.status].soft, color: VERDICT_TONES[verdict.status].color }}
            >
              {verdictStatusLabel(t, verdict.status)}
            </span>
          ) : null}
          <span className="ml-auto min-w-0 truncate text-label font-semibold text-muted" title={`${modelLabel}${effort ? ` · ${effort}` : ""}`}>
            {modelLabel}{effort ? ` · ${effort}` : ""}
          </span>
        </div>
        <p className="min-w-0 truncate text-caption font-semibold text-secondary">{t("pipelineSlot.historyFolded")}</p>
        <button
          type="button"
          data-scheme-ui
          className="mt-auto inline-flex h-7 items-center justify-center gap-1 self-start rounded-control border border-border bg-canvas px-2.5 text-label font-bold text-muted hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
          disabled={!onOpen}
          onClick={() => onOpen?.()}
        >
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          {t("pipelineSlot.openHistory")}
        </button>
      </div>
    </section>
  );
}
