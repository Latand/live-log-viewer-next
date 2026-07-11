"use client";

import { Pause, Play, RefreshCw, X } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { Hint } from "@/components/Hint";
import { currentRound } from "@/components/scheme/agentLinks";
import type { Flow } from "@/lib/flows/types";
import { useLocale } from "@/lib/i18n";
import type { Pipeline, PipelineAction, PipelineStage } from "@/lib/pipelines/types";

import {
  PIPELINE_ATTENTION_STATES,
  PIPELINE_BUSY_STATES,
  STAGE_GLYPH,
  STAGE_TONES,
  latestAttempt,
  patchPipeline,
  pipelineStateLabel,
  stageAccess,
  stageAttempts,
  stageChipLabel,
  stageChipState,
  stageHasEvidence,
  stageOpenTarget,
} from "./pipelineModel";
import { VerdictPopover } from "./VerdictPopover";

const EMPTY_PATHS: ReadonlySet<string> = new Set();

const VERDICT_MARGIN = 8;

/**
 * Pure placement math for the verdict popover (kept out of the effect so it is
 * unit-testable). Prefers above the chip (the design's placement) and flips
 * below only when the popover cannot fit above and below has at least as much
 * room; clamps the horizontal center so the box never spills past either edge,
 * and clamps the vertical position so a tall popover (a long retry history,
 * bounded to 80vh) keeps both its header and footer on-screen.
 */
export function verdictPlacement(
  anchor: { top: number; bottom: number; left: number; width: number },
  content: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = VERDICT_MARGIN,
): { left: number; top: number; below: boolean } {
  const roomAbove = anchor.top - margin;
  const roomBelow = viewport.height - anchor.bottom - margin;
  const below = content.height > roomAbove && roomBelow >= roomAbove;
  const half = content.width / 2;
  const cx = anchor.left + anchor.width / 2;
  const left = Math.min(Math.max(cx, half + margin), viewport.width - half - margin);
  if (below) {
    /* transform-origin is the top edge; keep the whole box within the viewport. */
    const top = Math.max(margin, Math.min(anchor.bottom + margin, viewport.height - margin - content.height));
    return { left, top, below };
  }
  /* Above: `top` is the box's bottom edge (translate -100%); keep its top edge
     (top - height) below the margin and its bottom edge above it. */
  const top = Math.min(viewport.height - margin, Math.max(anchor.top - margin, margin + content.height));
  return { left, top, below };
}

/**
 * Renders the verdict popover through a body portal anchored to a chip. The chip
 * lives inside the strip's `overflow-x-auto` scroller, whose clip would hide the
 * popover (#93 finding: clipped verdict); a fixed portal escapes it. Placement
 * measures the popover's own box and flips/clamps via {@link verdictPlacement}
 * so a strip near the page header never renders it off-screen. Recomputed on
 * scroll/resize.
 */
function AnchoredVerdict({ anchorRef, children }: { anchorRef: RefObject<HTMLElement | null>; children: ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number; below: boolean } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = anchorRef.current;
      const content = contentRef.current;
      if (!el) return;
      const a = el.getBoundingClientRect();
      setPlacement(
        verdictPlacement(
          { top: a.top, bottom: a.bottom, left: a.left, width: a.width },
          { width: content?.offsetWidth ?? 260, height: content?.offsetHeight ?? 0 },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [anchorRef]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={contentRef}
      className="fixed z-[60]"
      style={
        placement
          ? { left: placement.left, top: placement.top, transform: placement.below ? "translate(-50%, 0)" : "translate(-50%, -100%)" }
          : { left: -9999, top: 0, visibility: "hidden" }
      }
    >
      {children}
    </div>,
    document.body,
  );
}

/** The parked stage's first finding, when present, is the most useful summary. */
function parkedDetail(pipeline: Pipeline): string | null {
  if (!PIPELINE_ATTENTION_STATES.has(pipeline.state) || !pipeline.cursor) return pipeline.stateDetail;
  const finding = latestAttempt(pipeline, pipeline.cursor.stageId)?.verdict?.findings?.[0];
  return finding ?? pipeline.stateDetail;
}

function StageChip({
  pipeline,
  stage,
  index,
  flows,
  renderableFlows,
  renderablePaths,
  open,
  onToggleVerdict,
  onCloseVerdict,
  onOpenPath,
  onOpenFlow,
}: {
  pipeline: Pipeline;
  stage: PipelineStage;
  index: number;
  flows: Flow[];
  /** Ids of flows that still have a board deck; gates review-loop actions. */
  renderableFlows: ReadonlySet<string>;
  /** Transcript paths still in the scan; gates run-stage actions. */
  renderablePaths?: ReadonlySet<string>;
  open: boolean;
  onToggleVerdict: () => void;
  onCloseVerdict: () => void;
  onOpenPath?: (path: string) => void;
  onOpenFlow?: (flowId: string) => void;
}) {
  const { t } = useLocale();
  const state = stageChipState(pipeline, stage);
  const tone = STAGE_TONES[state];
  const glyph = STAGE_GLYPH[state];
  const attempt = latestAttempt(pipeline, stage.id);
  const label = stageChipLabel(t, stage);
  const access = stageAccess(pipeline, stage);
  /* Paused keeps the active tone (pipelineCursorActive) but freezes motion. */
  const pulse = (state === "running" || state === "reviewing" || state === "committing") && pipeline.state !== "paused";
  const flow = attempt?.flowId ? flows.find((candidate) => candidate.id === attempt.flowId) ?? null : null;
  const round = stage.kind === "review-loop" && flow ? currentRound(flow)?.n ?? 0 : 0;
  const attemptCount = stageAttempts(pipeline, stage.id).length;
  const chipState = t(`pipelineChipState.${state}`);
  const title = [stage.role?.roleId ?? stage.id, t(access === "read-only" ? "pipelineStrip.readOnly" : "pipelineStrip.readWrite"), attempt?.sessionId].filter(Boolean).join(" · ");
  /* Review-loop chips open their flow's round deck (the board folds the reviewer
     transcript away). A closed/missing flow has no deck, and a vanished run
     transcript has left the scan, so renderableFlows/renderablePaths disable the
     action and keep it from dead-ending (#93 §2.2, AC4). */
  const openTarget = stageOpenTarget(stage, attempt, renderableFlows, renderablePaths);
  const canOpen = openTarget ? (openTarget.kind === "flow" ? Boolean(onOpenFlow) : Boolean(onOpenPath)) : false;
  const openStage = () => {
    if (!openTarget) return;
    if (openTarget.kind === "flow") onOpenFlow?.(openTarget.flowId);
    else onOpenPath?.(openTarget.path);
  };
  const chipRef = useRef<HTMLSpanElement>(null);
  /* The verdict popover also carries verdict-less evidence (a spawn/tick error,
     or parked Retry/Skip), but a plain running attempt has none — the shared
     predicate keeps the trigger from opening a misleading "no findings" sheet. */
  const evidence = stageHasEvidence(pipeline, stage, attempt);
  /* Only offer the popover's open actions for targets the board can still reveal. */
  const canOpenFlow = Boolean(attempt?.flowId && renderableFlows.has(attempt.flowId));
  const canOpenPath = Boolean(attempt?.agentPath && (!renderablePaths || renderablePaths.has(attempt.agentPath)));

  return (
    <span ref={chipRef} className="relative flex shrink-0 items-center gap-1.5">
      {index ? <span className="text-[10px] font-bold text-[#c9c9d1]" aria-hidden>→</span> : null}
      <span className="inline-flex items-center">
        <button
          type="button"
          disabled={!canOpen}
          onClick={openStage}
          className={`inline-flex h-6 max-w-[180px] items-center gap-1 truncate rounded-l-full ${evidence ? "" : "rounded-r-full"} px-2 text-[10.5px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default ${pulse ? "animate-pulse" : ""}`}
          style={{ backgroundColor: tone.soft, color: tone.color }}
          title={title}
          aria-label={t("pipelineStrip.chipAria", { label, state: chipState })}
        >
          <span aria-hidden>{stage.kind === "review-loop" ? "⟳" : "▸"}</span>
          <span className="min-w-0 truncate">{label}</span>
          {glyph ? <span aria-hidden>{glyph}</span> : null}
          {round > 0 ? <span aria-hidden>{t("pipelineStrip.roundShort", { n: round })}</span> : null}
          {attemptCount > 1 ? <span aria-hidden>{t("pipelineStrip.attemptSuffix", { n: attemptCount })}</span> : null}
        </button>
        {evidence ? (
          <button
            type="button"
            onClick={onToggleVerdict}
            aria-expanded={open}
            aria-label={t("pipelineStrip.openVerdict", { label })}
            className="inline-flex h-6 items-center rounded-r-full border-l border-panel/60 px-1 text-[10.5px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            style={{ backgroundColor: tone.soft, color: tone.color }}
          >
            <span aria-hidden>{attempt!.verdict ? (attempt!.verdict.status === "pass" ? "✓" : attempt!.verdict.status === "fail" ? "✕" : "●") : "!"}</span>
          </button>
        ) : null}
      </span>
      {open && attempt ? (
        <AnchoredVerdict anchorRef={chipRef}>
          <VerdictPopover pipeline={pipeline} stage={stage} attempt={attempt} canOpenFlow={canOpenFlow} canOpenPath={canOpenPath} onClose={onCloseVerdict} onOpenPath={onOpenPath} onOpenFlow={onOpenFlow} />
        </AnchoredVerdict>
      ) : null}
    </span>
  );
}

export function PipelineStrip({
  pipeline,
  flows = [],
  renderablePaths,
  renderableFlows = EMPTY_PATHS,
  compact = false,
  onOpenPath,
  onOpenFlow,
}: {
  pipeline: Pipeline;
  flows?: Flow[];
  /** Transcript paths currently in the scan; a run chip / "open transcript" is
      disabled for an attempt whose path is absent (AC4). Omitted → no gating. */
  renderablePaths?: ReadonlySet<string>;
  /** Flow ids that actually have a board deck (their implementer is placed);
      review-loop chip / "Open review" is disabled for a flow absent from it. */
  renderableFlows?: ReadonlySet<string>;
  /** Board variant (§2.2): trimmed to node width — drops the "PIPELINE" kicker
      and tightens padding so the chips + controls fit over a single node. */
  compact?: boolean;
  onOpenPath?: (path: string) => void;
  onOpenFlow?: (flowId: string) => void;
}) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openVerdict, setOpenVerdict] = useState<string | null>(null);
  const mutate = async (action: PipelineAction) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setError(await patchPipeline(pipeline.id, action));
    setBusy(false);
  };
  const attention = PIPELINE_ATTENTION_STATES.has(pipeline.state);
  const finished = pipeline.state === "completed" || pipeline.state === "closed";
  const detail = parkedDetail(pipeline);
  return (
    <div
      data-scheme-ui
      role="group"
      aria-label={t("pipelineStrip.groupAria", { task: pipeline.task })}
      className={`pointer-events-auto flex min-h-11 w-full flex-wrap items-center gap-3 rounded-[14px] border bg-panel/95 py-1 shadow-[0_2px_10px_rgb(20_20_30/0.08)] ${compact ? "px-2.5" : "px-4"} ${attention ? "border-[#e0ae45]/70" : "border-line"}`}
    >
      <span className="flex min-w-0 max-w-[42%] shrink-0 items-center gap-2">
        {/* Tone matrix (§3), matching the hub + rail: busy → accent (pulse),
            needs_decision + paused → amber, completed → ok, else neutral. Red is
            reserved for chip/verdict failures, so the strip never conflicts. */}
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${
            PIPELINE_BUSY_STATES.has(pipeline.state)
              ? "animate-pulse bg-accent"
              : PIPELINE_ATTENTION_STATES.has(pipeline.state)
                ? "bg-[#e0ae45]"
                : pipeline.state === "completed"
                  ? "bg-ok"
                  : "bg-[#9a9aa4]"
          }`}
          aria-hidden
        />
        {compact ? null : <span className="shrink-0 text-[10.5px] font-bold tracking-[0.08em] text-dim">{t("pipelineStrip.pipeline")}</span>}
        <span className="min-w-0 truncate text-[12px] font-bold" title={pipeline.task}>{pipeline.task}</span>
        <span className="shrink-0 text-[11.5px] font-semibold text-dim">{pipelineStateLabel(t, pipeline.state)}</span>
        {detail ? <span className={`min-w-0 truncate text-[11.5px] font-semibold ${attention ? "text-[#a06a15]" : "text-err"}`} title={detail}>{detail}</span> : null}
      </span>
      <span className="no-scrollbar flex min-w-0 flex-1 items-center justify-center gap-1.5 overflow-x-auto" aria-label={t("pipelineStrip.stagesAria")}>
        {pipeline.stages.map((stage, index) => (
          <StageChip
            key={stage.id}
            pipeline={pipeline}
            stage={stage}
            index={index}
            flows={flows}
            renderableFlows={renderableFlows}
            renderablePaths={renderablePaths}
            open={openVerdict === stage.id}
            onToggleVerdict={() => setOpenVerdict((prev) => (prev === stage.id ? null : stage.id))}
            onCloseVerdict={() => setOpenVerdict(null)}
            onOpenPath={onOpenPath}
            onOpenFlow={onOpenFlow}
          />
        ))}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {error ? <span className="max-w-[220px] truncate text-[10.5px] font-semibold text-err" title={error}>{error}</span> : null}
        {busy ? <RefreshCw className="h-3.5 w-3.5 animate-spin text-dim" aria-hidden /> : null}
        {pipeline.state === "needs_decision" ? (
          <>
            <button className="rounded-full border border-accent bg-accent px-3 py-1 text-[11px] font-bold text-white disabled:opacity-40" disabled={busy} onClick={() => void mutate("retry-stage")}>{t("pipelineStrip.retryStage")}</button>
            <button className="rounded-full border border-line bg-bg px-2.5 py-1 text-[10.5px] font-bold text-dim disabled:opacity-40" disabled={busy} onClick={() => void mutate("skip-stage")}>{t("pipelineStrip.skipStage")}</button>
          </>
        ) : null}
        {finished ? null : pipeline.state === "paused" ? (
          <Hint label={t("pipelineStrip.resume")}><button className="inline-flex h-6 w-6 items-center justify-center rounded-full text-ok" disabled={busy} aria-label={t("pipelineStrip.resume")} onClick={() => void mutate("resume")}><Play className="h-3.5 w-3.5" aria-hidden /></button></Hint>
        ) : (
          <Hint label={t("pipelineStrip.pause")}><button className="inline-flex h-6 w-6 items-center justify-center rounded-full text-dim" disabled={busy} aria-label={t("pipelineStrip.pause")} onClick={() => void mutate("pause")}><Pause className="h-3.5 w-3.5" aria-hidden /></button></Hint>
        )}
        <Hint label={t("pipelineStrip.close")}><button className="inline-flex h-6 w-6 items-center justify-center rounded-full text-dim hover:text-err" disabled={busy} aria-label={t("pipelineStrip.close")} onClick={() => void mutate("close")}><X className="h-3.5 w-3.5" aria-hidden /></button></Hint>
      </span>
    </div>
  );
}
