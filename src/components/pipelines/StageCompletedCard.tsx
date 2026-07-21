"use client";

import { ArrowUpRight } from "lucide-react";

import { effortTierLabel } from "@/components/builderCopy";
import type { StageSlot } from "@/components/scheme/layout";
import { engineTintOf } from "@/components/utils";
import { ENGINE_MODELS } from "@/lib/agent/models";
import { useLocale } from "@/lib/i18n";
import { renderStagePrompt } from "@/lib/pipelines/prompts";

import {
  STAGE_TONES,
  VERDICT_TONES,
  attemptStateLabel,
  stageChipLabel,
  stageChipState,
  verdictStatusLabel,
} from "./pipelineModel";

/**
 * A completed pipeline stage as a FULL conversation card (#507 F2). A terminal
 * stage of an ACTIVE pipeline goes idle, so its transcript is no longer surfaced
 * as a live board node — but the stage must still read as a real conversation
 * card inside the colored pipeline group, not a compact history stub. This card
 * stands in at the stage's position with the same footprint as the live and
 * placeholder cards: the header the live window has, the prompt that was sent
 * (rendered exactly as the placeholder previewed it, so there is minimal visual
 * difference from the eventual live conversation), the settled state/verdict, and
 * an affordance that opens the full transcript on demand.
 */
export function StageCompletedCard({ slot, onOpen }: { slot: StageSlot; onOpen?: () => void }) {
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
  const previewPreviousOutput = "[The previous stage output was inserted here]";
  const promptPreview = renderStagePrompt(pipeline, stage, stage.effectiveRole, previewPreviousOutput);

  return (
    <section
      data-pipeline-stage-card={`${pipeline.id}::${stage.id}`}
      data-pipeline-stage-state={state}
      data-pipeline-stage-completed="true"
      aria-label={t("pipelineSlot.completedAria", { role: label })}
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-control border-2 bg-card shadow-1"
      style={{ borderColor: tone.color }}
    >
      <span aria-hidden className="h-1 w-full shrink-0 opacity-60" style={{ backgroundColor: tint.color }} />
      <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2.5" style={{ backgroundColor: tint.soft }}>
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: tone.color }} title={t(`pipelineChipState.${state}`)} />
        <span className="shrink-0 rounded-full border border-border bg-card/70 px-1.5 py-0.5 text-caption font-bold capitalize text-muted">
          {stage.effectiveRole.engine}
        </span>
        <span className="min-w-0 flex-1 truncate text-ui font-semibold text-muted" title={label}>
          {label} · {t("pipelineSlot.stageOf", { k: slot.index + 1, n: slot.total })}
        </span>
        <span className="shrink-0 rounded-full border border-border bg-card/70 px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide text-muted">
          {review ? `⟳ ${t("groupOverride.reviewKind")}` : t("groupOverride.runKind")}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-3">
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5">
            <span className="rounded-full px-3 py-1 text-body font-bold" style={{ backgroundColor: tone.soft, color: tone.color }}>
              {attempt ? attemptStateLabel(t, attempt.state) : t(`pipelineChipState.${state}`)}
            </span>
            {verdict ? (
              <span
                className="rounded-full px-2 py-1 text-label font-bold"
                style={{ backgroundColor: VERDICT_TONES[verdict.status].soft, color: VERDICT_TONES[verdict.status].color }}
              >
                {verdictStatusLabel(t, verdict.status)}
              </span>
            ) : null}
          </span>
          <span className="truncate text-label font-semibold text-muted" title={`${modelLabel}${effort ? ` · ${effort}` : ""}`}>
            {modelLabel}{effort ? ` · ${effort}` : ""}
          </span>
        </div>
        <div className="ml-auto max-w-[88%] min-h-0 overflow-hidden rounded-[14px] rounded-br-[4px] bg-accent/10 px-3 py-2.5 text-ui leading-5 text-primary shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_18%,transparent)]">
          <p className="mb-1 text-caption font-bold uppercase tracking-wide text-accent">{t("pipelineSlot.promptLabel")}</p>
          <p className="line-clamp-[12] whitespace-pre-wrap break-words">{promptPreview}</p>
        </div>
        <button
          type="button"
          data-scheme-ui
          className="mt-auto inline-flex h-8 items-center justify-center gap-1 self-center rounded-control border border-border bg-canvas px-3 text-label font-bold text-muted hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
          disabled={!onOpen}
          onClick={() => onOpen?.()}
        >
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          {t("pipelineSlot.openTranscript")}
        </button>
      </div>
    </section>
  );
}
