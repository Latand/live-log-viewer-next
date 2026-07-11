"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useLocale } from "@/lib/i18n";
import type { Pipeline, PipelineStage, PipelineStageAttempt } from "@/lib/pipelines/types";

import { VERDICT_TONES, attemptStateLabel, patchPipeline, stageAttempts, stageChipLabel, verdictStatusLabel } from "./pipelineModel";

const MAX_COLLAPSED_FINDINGS = 8;

/**
 * The verdict popover (#93 §2.1): a structured stage verdict at the point of
 * evidence — status badge, confidence bar, bounded findings, prior-attempt
 * audit lines, and — when the pipeline is parked on this stage — inline
 * Retry/Skip so a decision is takeable right here. Anchored like FlowHub's
 * popover; focus enters on open and Escape returns it to the trigger.
 */
export function VerdictPopover({
  pipeline,
  stage,
  attempt,
  canOpenFlow = true,
  canOpenPath = true,
  onClose,
  onOpenPath,
  onOpenFlow,
}: {
  pipeline: Pipeline;
  stage: PipelineStage;
  attempt: PipelineStageAttempt;
  /** Whether the embedded flow still has a board deck; a closed/missing flow
      hides "Open review" so it never routes to an absent entry (default true). */
  canOpenFlow?: boolean;
  /** Whether the run transcript is still in the scan; a vanished path hides
      "Open transcript" so it never no-ops on a missing file (default true). */
  canOpenPath?: boolean;
  onClose: () => void;
  onOpenPath?: (path: string) => void;
  onOpenFlow?: (flowId: string) => void;
}) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  /* Focus enters the popover on open and returns to the verdict glyph that
     opened it on close — Escape, an action, or an outside toggle all unmount
     this component, so restoring here covers every path. */
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    return () => trigger?.focus();
  }, []);

  const label = stageChipLabel(t, stage);
  const verdict = attempt.verdict;
  const parked = pipeline.state === "needs_decision" && pipeline.cursor?.stageId === stage.id;
  /* Only attempts before the one in the header — the current attempt is already
     represented above, so listing it here would duplicate its status (AC5). */
  const priorAttempts = stageAttempts(pipeline, stage.id).filter((prior) => prior.n < attempt.n);
  const findings = verdict?.findings ?? [];
  const shown = expanded ? findings : findings.slice(0, MAX_COLLAPSED_FINDINGS);
  const tone = verdict ? VERDICT_TONES[verdict.status] : null;

  const act = async (action: "retry-stage" | "skip-stage") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const fail = await patchPipeline(pipeline.id, action);
    setBusy(false);
    if (fail) setError(fail);
    else onClose();
  };

  return (
    <div
      ref={ref}
      data-scheme-ui
      tabIndex={-1}
      role="dialog"
      aria-label={t("pipelineVerdict.title", { label })}
      className="flex max-h-[80vh] w-[260px] flex-col gap-2 overflow-y-auto rounded-[12px] border border-line bg-panel p-2.5 shadow-[0_10px_36px_rgb(20_20_30/0.18)] focus-visible:outline-none"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex items-center gap-2">
        {verdict && tone ? (
          <span className="rounded-full px-2 py-0.5 text-[10.5px] font-bold" style={{ backgroundColor: tone.soft, color: tone.color }}>
            {verdictStatusLabel(t, verdict.status)}
          </span>
        ) : (
          /* No verdict: surface the attempt's own error (a spawn/tick failure)
             first, then the pipeline-level detail, so a verdict-less chip still
             explains itself. */
          <span className="text-[11px] font-semibold text-dim">{attempt.error ?? pipeline.stateDetail ?? t("pipelineVerdict.noFindings")}</span>
        )}
        {busy ? <RefreshCw className="ml-auto h-3 w-3 animate-spin text-dim" aria-hidden /> : null}
      </div>

      {verdict && typeof verdict.confidence === "number" ? (
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-[9.5px] font-semibold uppercase tracking-wide text-dim">{t("pipelineVerdict.confidence")}</span>
          <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-line" aria-hidden>
            <span className="block h-full rounded-full" style={{ width: `${Math.round(Math.max(0, Math.min(1, verdict.confidence)) * 100)}%`, backgroundColor: tone?.color ?? "#5a51e0" }} />
          </span>
          <span className="shrink-0 font-mono text-[10px] text-ink">{verdict.confidence.toFixed(2)}</span>
        </div>
      ) : null}

      {findings.length ? (
        <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
          <span className="text-[9.5px] font-semibold uppercase tracking-wide text-dim">{t("pipelineVerdict.findings", { count: findings.length })}</span>
          <ul className="flex flex-col gap-1">
            {shown.map((finding, index) => (
              <li key={index} className="rounded-[7px] bg-bg px-2 py-1 text-[10.5px] leading-4 text-ink">{finding}</li>
            ))}
          </ul>
          {!expanded && findings.length > MAX_COLLAPSED_FINDINGS ? (
            <button type="button" className="self-start text-[10px] font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" onClick={() => setExpanded(true)}>
              {t("pipelineVerdict.more", { count: findings.length - MAX_COLLAPSED_FINDINGS })}
            </button>
          ) : null}
        </div>
      ) : null}

      {priorAttempts.length ? (
        <div className="flex shrink-0 flex-col gap-0.5 border-t border-line pt-1.5">
          <span className="text-[9.5px] font-semibold uppercase tracking-wide text-dim">{t("pipelineVerdict.priorAttempts")}</span>
          {/* Retries append attempts without bound, so the audit scrolls within a
              fixed height — otherwise a long history grows the popover past the
              viewport and pushes the Retry/Skip footer off-screen. */}
          <div className="flex max-h-24 flex-col gap-0.5 overflow-y-auto">
            {priorAttempts.map((prior) => (
              <span key={prior.n} className="font-mono text-[9.5px] text-dim">
                {t("pipelineVerdict.attemptLine", { n: prior.n, status: prior.verdict ? verdictStatusLabel(t, prior.verdict.status) : attemptStateLabel(t, prior.state) })}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {error ? <span className="truncate text-[10px] font-semibold text-err" title={error}>{error}</span> : null}

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-line pt-2">
        {/* A review-loop's agentPath is the reviewer transcript the board folds
            into the round deck — opening it reveals nothing, so offer only the
            flow route below. A run stage opens its own node here (#93 §2.2). */}
        {stage.kind !== "review-loop" && attempt.agentPath && onOpenPath && canOpenPath ? (
          <button type="button" className="rounded-full border border-line bg-bg px-2.5 py-1 text-[10px] font-bold text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" onClick={() => onOpenPath(attempt.agentPath!)}>
            {t("pipelineVerdict.openTranscript")}
          </button>
        ) : null}
        {attempt.flowId && onOpenFlow && canOpenFlow ? (
          <button type="button" className="rounded-full border border-line bg-bg px-2.5 py-1 text-[10px] font-bold text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" onClick={() => onOpenFlow(attempt.flowId!)}>
            {t("pipelineVerdict.openFlow")}
          </button>
        ) : null}
        {parked ? (
          <>
            <button type="button" className="ml-auto rounded-full border border-accent bg-accent px-2.5 py-1 text-[10px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40" disabled={busy} onClick={() => void act("retry-stage")}>
              {t("pipelineVerdict.retry")}
            </button>
            <button type="button" className="rounded-full border border-line bg-bg px-2.5 py-1 text-[10px] font-bold text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40" disabled={busy} onClick={() => void act("skip-stage")}>
              {t("pipelineVerdict.skip")}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
