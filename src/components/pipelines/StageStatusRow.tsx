"use client";

import { ChevronRight } from "lucide-react";

import type { StageSlot } from "@/components/scheme/layout";
import { useLocale } from "@/lib/i18n";

import { STAGE_GLYPH, STAGE_TONES, latestAttempt, stageChipState, stageOutcomeReason, stagePaneTitle } from "./pipelineModel";

/**
 * A settled pipeline stage as ONE status row (#658). A stage the chain has
 * already left behind — skipped by the operator, or completed evidence — used to
 * render with the full weight of a pending or active stage, stage-prompt block
 * included, so a board with two finished stages read as if all that work were
 * still ahead. The row states the three things that remain interesting about
 * finished work: the state badge, which stage it was (role · stage · position,
 * never the prompt's first line), and why it ended that way. The full card stays
 * one click away — the disclosure is owned by the slot shell, which floats the
 * real card over the board while it is open.
 */
export function StageStatusRow({
  slot,
  expanded,
  controls,
  onToggle,
}: {
  slot: StageSlot;
  expanded: boolean;
  /** DOM id of the card this row discloses, tying the toggle to what it opens. */
  controls?: string;
  onToggle?: () => void;
}) {
  const { t } = useLocale();
  const { pipeline, stage, attempt } = slot;
  const state = stageChipState(pipeline, stage);
  const tone = STAGE_TONES[state];
  const title = stagePaneTitle(t, stage, slot.index, slot.total);
  /* A completed slot carries the exact attempt whose transcript it stands in for;
     a skipped stage that never reached the board has no slot attempt, so its
     latest one supplies the outcome. */
  const reason = stageOutcomeReason(t, pipeline, stage, attempt ?? latestAttempt(pipeline, stage.id));

  return (
    <section
      data-pan-ignore
      /* Exactly one element per declared stage carries the stage-card identity:
         the row owns it while collapsed and hands it to the disclosed full card
         when open, so a stage never projects two surfaces at once. */
      data-pipeline-stage-card={expanded ? undefined : `${pipeline.id}::${stage.id}`}
      data-pipeline-stage-state={state}
      data-pipeline-stage-row="true"
      aria-label={t("pipelineSlot.rowAria", { title })}
      className="flex h-full min-h-0 min-w-0 flex-col justify-center gap-1 overflow-hidden rounded-control border bg-card px-3 py-2 shadow-1"
      style={{ borderColor: "var(--border-strong)" }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-label font-bold"
          style={{ backgroundColor: tone.soft, color: tone.color }}
        >
          <span aria-hidden>{STAGE_GLYPH[state]}</span>
          {t(`pipelineChipState.${state}`)}
        </span>
        <span className="min-w-0 flex-1 truncate text-ui font-semibold text-secondary" title={title}>
          {title}
        </span>
        {onToggle ? (
          <button
            type="button"
            data-scheme-ui
            data-stage-row-toggle
            aria-expanded={expanded}
            aria-controls={controls}
            aria-label={expanded ? t("pipelineSlot.rowCollapse") : t("pipelineSlot.rowExpand")}
            title={expanded ? t("pipelineSlot.rowCollapse") : t("pipelineSlot.rowExpand")}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-control border border-border bg-canvas text-muted hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onClick={onToggle}
          >
            <ChevronRight className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-90" : ""}`} aria-hidden />
          </button>
        ) : null}
      </div>
      <p className="min-w-0 truncate text-label text-muted" title={reason}>
        {reason}
      </p>
    </section>
  );
}
