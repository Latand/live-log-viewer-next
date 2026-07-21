"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { reviewerBindingTargetsForRound } from "@/components/flows/flowModel";
import { useLocale } from "@/lib/i18n";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline, PipelineStage, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

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
  flows = [],
  files = [],
  availablePaths,
  mobile = false,
  canOpenFlow = true,
  canOpenPath = true,
  onClose,
  onOpenPath,
  onOpenFlow,
}: {
  pipeline: Pipeline;
  stage: PipelineStage;
  attempt: PipelineStageAttempt;
  flows?: Flow[];
  files?: readonly FileEntry[];
  availablePaths?: ReadonlySet<string>;
  mobile?: boolean;
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
  /* The header represents the operational attempt. Every other persisted
     attempt remains navigable evidence, including adopted historical children
     appended with a higher attempt number. */
  const priorAttempts = stageAttempts(pipeline, stage.id).filter((candidate) => candidate.n !== attempt.n);
  const stageFlowIds = new Set(stageAttempts(pipeline, stage.id).flatMap((item) => item.flowId ? [item.flowId] : []));
  const attemptPaths = new Set(stageAttempts(pipeline, stage.id).flatMap((item) => item.agentPath ? [item.agentPath] : []));
  const seenReviewPaths = new Set<string>();
  const reviewTranscripts = flows
    .filter((flow) => stageFlowIds.has(flow.id))
    .flatMap((flow) => flow.rounds.flatMap((round) =>
      reviewerBindingTargetsForRound(flow, round, files).flatMap(({ path }) => {
        if (attemptPaths.has(path) || seenReviewPaths.has(path)) return [];
        seenReviewPaths.add(path);
        return [{ n: round.n, path }];
      }),
    ));
  const pathAvailable = (path: string) => !availablePaths || availablePaths.has(path);
  const mobileTarget = mobile ? "min-h-11 min-w-11" : "";
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
      className="flex max-h-[80vh] w-[260px] flex-col gap-2 overflow-y-auto rounded-[12px] border border-border bg-card p-2.5 shadow-2 focus-visible:outline-none"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex items-center gap-2">
        {verdict && tone ? (
          <Badge style={{ backgroundColor: tone.soft, color: tone.color }}>
            {verdictStatusLabel(t, verdict.status)}
          </Badge>
        ) : (
          /* No verdict: surface the attempt's own error (a spawn/tick failure)
             first, then the pipeline-level detail, so a verdict-less chip still
             explains itself. */
          <span className="text-[11px] font-semibold text-muted">{attempt.error ?? pipeline.stateDetail ?? t("pipelineVerdict.noFindings")}</span>
        )}
        {busy ? <RefreshCw className="ml-auto h-3 w-3 animate-spin text-muted" aria-hidden /> : null}
      </div>

      {verdict && typeof verdict.confidence === "number" ? (
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-label font-semibold text-secondary">{t("pipelineVerdict.confidence")}</span>
          <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-border" aria-hidden>
            <span className="block h-full rounded-full" style={{ width: `${Math.round(Math.max(0, Math.min(1, verdict.confidence)) * 100)}%`, backgroundColor: tone?.color ?? "var(--color-accent)" }} />
          </span>
          <span className="shrink-0 font-mono text-[10px] text-primary">{verdict.confidence.toFixed(2)}</span>
        </div>
      ) : null}

      {attempt.reviewHeadSha ? (
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-label font-semibold text-secondary">{t("pipelineVerdict.reviewerSha", { sha: attempt.reviewHeadSha.slice(0, 8) })}</span>
          <code className="min-w-0 truncate font-mono text-[10px] text-primary" title={attempt.reviewHeadSha}>{attempt.reviewHeadSha}</code>
        </div>
      ) : null}

      {findings.length ? (
        <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
          <span className="text-label font-semibold text-secondary">{t("pipelineVerdict.findings", { count: findings.length })}</span>
          <ul className="flex flex-col gap-1">
            {shown.map((finding, index) => (
              <li key={index} className="rounded-[7px] bg-canvas px-2 py-1 text-[10.5px] leading-4 text-primary">{finding}</li>
            ))}
          </ul>
          {!expanded && findings.length > MAX_COLLAPSED_FINDINGS ? (
            <button type="button" className={`self-start text-[10px] font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${mobileTarget}`} onClick={() => setExpanded(true)}>
              {t("pipelineVerdict.more", { count: findings.length - MAX_COLLAPSED_FINDINGS })}
            </button>
          ) : null}
        </div>
      ) : null}

      {priorAttempts.length ? (
        <div className="flex shrink-0 flex-col gap-0.5 border-t border-border pt-1.5">
          <span className="text-label font-semibold text-secondary">{t("pipelineVerdict.priorAttempts")}</span>
          {/* Retries append attempts without bound, so the audit scrolls within a
              fixed height — otherwise a long history grows the popover past the
              viewport and pushes the Retry/Skip footer off-screen. */}
          <div className="flex max-h-24 flex-col gap-0.5 overflow-y-auto">
            {priorAttempts.map((prior) => {
              const line = t("pipelineVerdict.attemptLine", { n: prior.n, status: prior.verdict ? verdictStatusLabel(t, prior.verdict.status) : attemptStateLabel(t, prior.state) });
              return prior.agentPath && onOpenPath && pathAvailable(prior.agentPath) ? (
                <button key={prior.n} type="button" aria-label={t("pipelineVerdict.openAttemptTranscript", { n: prior.n })} onClick={() => onOpenPath(prior.agentPath!)} className={`rounded-control px-1 text-left font-mono text-[9.5px] text-muted hover:bg-canvas hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${mobileTarget}`}>
                  {line}
                </button>
              ) : (
                <span key={prior.n} className="font-mono text-[9.5px] text-muted">{line}</span>
              );
            })}
          </div>
        </div>
      ) : null}

      {reviewTranscripts.length ? (
        <div className="flex shrink-0 flex-col gap-0.5 border-t border-border pt-1.5">
          <span className="text-label font-semibold text-secondary">{t("pipelineVerdict.reviewTranscripts")}</span>
          <div className="flex max-h-24 flex-col gap-0.5 overflow-y-auto">
            {reviewTranscripts.map((transcript) => (
              <button key={transcript.path} type="button" disabled={!onOpenPath || !pathAvailable(transcript.path)} aria-label={t("pipelineVerdict.openReviewTranscript", { n: transcript.n })} onClick={() => onOpenPath?.(transcript.path)} className={`rounded-control px-1 text-left font-mono text-[9.5px] text-muted hover:bg-canvas hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 ${mobileTarget}`}>
                {t("pipelineVerdict.openReviewTranscript", { n: transcript.n })}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {error ? <span className="truncate text-[10px] font-semibold text-danger" title={error}>{error}</span> : null}

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border pt-2">
        {/* Every current attempt keeps direct transcript navigation. Review-loop
            attempts also retain the flow route whenever its deck is present. */}
        {attempt.agentPath && onOpenPath && canOpenPath && pathAvailable(attempt.agentPath) ? (
          <button type="button" aria-label={t("pipelineVerdict.openAttemptTranscript", { n: attempt.n })} className={`rounded-full border border-border bg-canvas px-2.5 py-1 text-[10px] font-bold text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${mobileTarget}`} onClick={() => onOpenPath(attempt.agentPath!)}>
            {t("pipelineVerdict.openTranscript")}
          </button>
        ) : null}
        {attempt.flowId && onOpenFlow && canOpenFlow ? (
          <button type="button" className={`rounded-full border border-border bg-canvas px-2.5 py-1 text-[10px] font-bold text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${mobileTarget}`} onClick={() => onOpenFlow(attempt.flowId!)}>
            {t("pipelineVerdict.openFlow")}
          </button>
        ) : null}
        {parked ? (
          <>
            <button type="button" className={`ml-auto rounded-full border border-accent bg-accent px-2.5 py-1 text-[10px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40 ${mobileTarget}`} disabled={busy} onClick={() => void act("retry-stage")}>
              {t("pipelineVerdict.retry")}
            </button>
            <button type="button" className={`rounded-full border border-border bg-canvas px-2.5 py-1 text-[10px] font-bold text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 ${mobileTarget}`} disabled={busy} onClick={() => void act("skip-stage")}>
              {t("pipelineVerdict.skip")}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
