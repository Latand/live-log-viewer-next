"use client";

import { ArrowLeft, ArrowRight, Pause, Play, RefreshCw, Settings2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { currentRound } from "@/components/scheme/agentLinks";
import type { Flow } from "@/lib/flows/types";
import { useLocale } from "@/lib/i18n";
import type { Pipeline, PipelineAction, PipelineStage, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { StageSlot } from "@/components/scheme/layout";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

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
  stageHasNavigableHistory,
  compactStageOpenTarget,
  verdictStatusLabel,
} from "./pipelineModel";
import { StagePlaceholderPane } from "./StagePlaceholderPane";
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

/** Stable, compact clock value for a completed stage evidence row. */
function attemptDuration(attempt: PipelineStageAttempt): string | null {
  if (!attempt.startedAt || !attempt.completedAt) return null;
  const elapsed = Date.parse(attempt.completedAt) - Date.parse(attempt.startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const seconds = Math.round(elapsed / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function StageChip({
  pipeline,
  stage,
  previousStage,
  index,
  flows,
  files,
  renderableFlows,
  renderablePaths,
  mobile,
  open,
  configurationOpen,
  onToggleVerdict,
  onCloseVerdict,
  onToggleConfiguration,
  onCloseConfiguration,
  onOpenPath,
  onOpenFlow,
}: {
  pipeline: Pipeline;
  stage: PipelineStage;
  previousStage: PipelineStage | null;
  index: number;
  flows: Flow[];
  files: readonly FileEntry[];
  /** Ids of flows that still have a board deck; gates review-loop actions. */
  renderableFlows: ReadonlySet<string>;
  /** Transcript paths still in the scan; gates run-stage actions. */
  renderablePaths?: ReadonlySet<string>;
  mobile: boolean;
  open: boolean;
  configurationOpen: boolean;
  onToggleVerdict: () => void;
  onCloseVerdict: () => void;
  onToggleConfiguration: (stageId: string) => void;
  onCloseConfiguration: () => void;
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
  const targetFor = (candidate: PipelineStage) => {
    const candidateAttempt = latestAttempt(pipeline, candidate.id);
    return compactStageOpenTarget(candidate, candidateAttempt, flows, renderableFlows, renderablePaths, files);
  };
  const openTarget = targetFor(stage);
  const stageConfigurable = (candidate: PipelineStage) =>
    stageAttempts(pipeline, candidate.id).length === 0 && pipeline.state !== "completed" && pipeline.state !== "closed";
  const configurable = stageConfigurable(stage);
  const canUseTarget = (target: ReturnType<typeof targetFor>) => target
    ? (target.kind === "flow" ? Boolean(onOpenFlow) : Boolean(onOpenPath))
    : false;
  const openResolvedTarget = (target: ReturnType<typeof targetFor>) => {
    if (!target) return;
    if (target.kind === "flow") onOpenFlow?.(target.flowId);
    else onOpenPath?.(target.path);
  };
  const canOpen = configurable || canUseTarget(openTarget);
  const openStage = () => {
    if (configurable) {
      onToggleConfiguration(stage.id);
      return;
    }
    openResolvedTarget(openTarget);
  };
  const chipRef = useRef<HTMLLIElement>(null);
  const stageButtonRef = useRef<HTMLButtonElement>(null);
  const configurationWasOpen = useRef(false);
  useEffect(() => {
    if (configurationWasOpen.current && !configurationOpen) stageButtonRef.current?.focus();
    configurationWasOpen.current = configurationOpen;
  }, [configurationOpen]);
  /* Keep the popover available for visible evidence and openable retry or
     review-round history. */
  const evidence = stageHasEvidence(pipeline, stage, attempt)
    || stageHasNavigableHistory(pipeline, stage, attempt, flows, renderablePaths, files);
  const terminalEvidence = Boolean(attempt && ["passed", "failed", "needs_decision", "skipped"].includes(attempt.state));
  const duration = attempt ? attemptDuration(attempt) : null;
  const model = attempt?.effectiveRole.model ?? t("pipelineStrip.defaultModel");
  const verdict = attempt?.verdict ? verdictStatusLabel(t, attempt.verdict.status) : chipState;
  /* Only offer the popover's open actions for targets the board can still reveal. */
  const canOpenFlow = Boolean(attempt?.flowId && renderableFlows.has(attempt.flowId));
  const canOpenPath = Boolean(attempt?.agentPath && (!renderablePaths || renderablePaths.has(attempt.agentPath)));

  const previousTarget = previousStage ? targetFor(previousStage) : null;
  const previousConfigurable = previousStage ? stageConfigurable(previousStage) : false;
  const previousLabel = previousStage ? stageChipLabel(t, previousStage) : "";
  const previousState = previousStage ? t(`pipelineChipState.${stageChipState(pipeline, previousStage)}`) : "";
  const configurationSlot: StageSlot = {
    key: `pipeline-config::${pipeline.id}::${stage.id}`,
    pipeline,
    stage,
    index,
    total: pipeline.stages.length,
    x: 0,
    y: 0,
    w: 600,
    h: 620,
  };

  return (
    <li ref={chipRef} className="relative flex shrink-0 items-center gap-1.5" data-pipeline-stage={stage.id} data-stage-state={state}>
      {previousStage ? (
        <span
          role="group"
          aria-label={t("pipelineStrip.lineageAria", { from: previousLabel, to: label })}
          className="inline-flex h-7 shrink-0 items-center rounded-full border border-border bg-sunken px-0.5 text-muted"
        >
          <button
            type="button"
            disabled={!previousConfigurable && !canUseTarget(previousTarget)}
            onClick={() => {
              if (previousStage && previousConfigurable) onToggleConfiguration(previousStage.id);
              else openResolvedTarget(previousTarget);
            }}
            aria-label={t("pipelineStrip.previousStage", { label: previousLabel, state: previousState })}
            className="inline-flex h-6 w-6 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-35"
          >
            <ArrowLeft className="h-3 w-3" aria-hidden />
          </button>
          <span className="h-px w-3 bg-strong" aria-hidden />
          <button
            type="button"
            disabled={!canOpen}
            onClick={openStage}
            aria-label={t("pipelineStrip.nextStage", { label, state: chipState })}
            className="inline-flex h-6 w-6 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-35"
          >
            <ArrowRight className="h-3 w-3" aria-hidden />
          </button>
        </span>
      ) : null}
      <span className={`inline-flex items-stretch rounded-control border ${terminalEvidence ? "border-border bg-sunken" : "border-transparent"}`}>
        <button
          ref={stageButtonRef}
          type="button"
          disabled={!canOpen}
          onClick={openStage}
          aria-expanded={configurable ? configurationOpen : undefined}
          className={`inline-flex min-h-7 max-w-[180px] items-center gap-1 truncate rounded-l-control ${evidence ? "" : "rounded-r-control"} px-2 text-label font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default ${pulse ? "animate-pulse" : ""}`}
          style={{ backgroundColor: tone.soft, color: tone.color }}
          title={title}
          aria-label={configurable
            ? t("pipelineStrip.configureStage", { label, state: chipState })
            : openTarget
              ? t("pipelineStrip.openTranscript", { label, state: chipState })
              : t("pipelineStrip.chipAria", { label, state: chipState })}
        >
          <span aria-hidden>{configurable ? <Settings2 className="h-3 w-3" /> : stage.kind === "review-loop" ? "⟳" : "▸"}</span>
          <span className="min-w-0 truncate">{label}</span>
          {glyph ? <span aria-hidden>{glyph}</span> : null}
          <span className="text-caption font-semibold opacity-80">{chipState}</span>
          {round > 0 ? <span aria-hidden>{t("pipelineStrip.roundShort", { n: round })}</span> : null}
          {attemptCount > 1 ? <span aria-hidden>{t("pipelineStrip.attemptSuffix", { n: attemptCount })}</span> : null}
        </button>
        {evidence ? (
          <button
            type="button"
            onClick={onToggleVerdict}
            aria-expanded={open}
            aria-label={t("pipelineStrip.openVerdict", { label, state: chipState })}
            className={`inline-flex h-6 items-center rounded-r-full border-l border-card/60 px-1 text-label font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${mobile ? "min-h-11 min-w-11 justify-center" : ""}`}
            style={{ backgroundColor: tone.soft, color: tone.color }}
          >
            <span aria-hidden>{attempt!.verdict ? (attempt!.verdict.status === "pass" ? "✓" : attempt!.verdict.status === "fail" ? "✕" : "●") : "!"}</span>
          </button>
        ) : null}
        {terminalEvidence && attempt ? (
          <span
            data-stage-evidence={attempt.state}
            aria-label={t("pipelineStrip.evidenceAria", {
              label,
              verdict,
              duration: duration ?? t("pipelineStrip.unknownDuration"),
              model,
            })}
            className="inline-flex min-h-7 max-w-[240px] items-center gap-1.5 border-l border-border px-2 text-caption font-semibold text-secondary"
          >
            <span className="text-strong">{verdict}</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{duration ?? t("pipelineStrip.unknownDuration")}</span>
            <span aria-hidden>·</span>
            <span className="max-w-[100px] truncate" title={model}>{model}</span>
          </span>
        ) : null}
      </span>
      {open && attempt ? (
        <AnchoredVerdict anchorRef={chipRef}>
          <VerdictPopover pipeline={pipeline} stage={stage} attempt={attempt} flows={flows} files={files} availablePaths={renderablePaths} mobile={mobile} canOpenFlow={canOpenFlow} canOpenPath={canOpenPath} onClose={onCloseVerdict} onOpenPath={onOpenPath} onOpenFlow={onOpenFlow} />
        </AnchoredVerdict>
      ) : null}
      {configurationOpen ? (
        <AnchoredVerdict anchorRef={chipRef}>
          <div
            role="dialog"
            aria-modal="false"
            aria-label={t("pipelineStrip.configAria", { label })}
            className={`relative h-[min(620px,calc(100vh-24px))] w-[min(600px,calc(100vw-24px))] rounded-surface bg-card shadow-3 ${mobile ? "[&_button]:min-h-11 [&_button]:min-w-11" : ""}`}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              onCloseConfiguration();
            }}
          >
            <button
              type="button"
              autoFocus
              onClick={onCloseConfiguration}
              aria-label={t("pipelineStrip.closeConfig")}
              className="absolute right-2 top-2 z-20 inline-flex h-7 w-7 items-center justify-center rounded-control border border-border bg-card text-muted shadow-1 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
            <StagePlaceholderPane slot={configurationSlot} interactive />
          </div>
        </AnchoredVerdict>
      ) : null}
    </li>
  );
}

export function PipelineStrip({
  pipeline,
  flows = [],
  files = [],
  renderablePaths,
  renderableFlows = EMPTY_PATHS,
  compact = false,
  mobile = false,
  linkedTasks = [],
  onOpenPath,
  onOpenFlow,
  onOpenTask,
}: {
  pipeline: Pipeline;
  flows?: Flow[];
  files?: readonly FileEntry[];
  /** Transcript paths currently in the scan; a run chip / "open transcript" is
      disabled for an attempt whose path is absent (AC4). Omitted → no gating. */
  renderablePaths?: ReadonlySet<string>;
  /** Flow ids that actually have a board deck (their implementer is placed);
      review-loop chip / "Open review" is disabled for a flow absent from it. */
  renderableFlows?: ReadonlySet<string>;
  /** Board variant (§2.2): trimmed to node width — drops the "PIPELINE" kicker
      and tightens padding so the chips + controls fit over a single node. */
  compact?: boolean;
  mobile?: boolean;
  linkedTasks?: BoardTask[];
  onOpenPath?: (path: string) => void;
  onOpenFlow?: (flowId: string) => void;
  onOpenTask?: (task: BoardTask) => void;
}) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openVerdict, setOpenVerdict] = useState<string | null>(null);
  const [openConfiguration, setOpenConfiguration] = useState<string | null>(null);
  useEffect(() => {
    if (!openConfiguration) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpenConfiguration(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [openConfiguration]);
  const mutate = async (action: PipelineAction) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setError(await patchPipeline(pipeline.id, action));
    setBusy(false);
  };
  const attention = PIPELINE_ATTENTION_STATES.has(pipeline.state);
  const busyState = PIPELINE_BUSY_STATES.has(pipeline.state);
  const draft = pipeline.state === "draft";
  const finished = pipeline.state === "completed" || pipeline.state === "closed";
  const detail = parkedDetail(pipeline);
  /* 1-based cursor position for the readable "stage k/n" counter; a finished
     chain reads n/n. */
  const total = pipeline.stages.length;
  const cursorIndex = pipeline.cursor ? pipeline.stages.findIndex((stage) => stage.id === pipeline.cursor!.stageId) : -1;
  const position = cursorIndex >= 0 ? cursorIndex + 1 : total;
  /* Redesigned container header (issue #196): the status is a readable tinted
     badge and the controls are labeled design-system buttons — no icon soup.
     Tone matrix (§3) matches the hub + rail: busy → accent, needs_decision +
     paused → warning, completed → success, draft → warning, else muted. */
  const statusBadge = busyState
    ? "bg-accent-soft text-accent"
    : attention || draft
      ? "bg-warning-soft text-warning"
      : pipeline.state === "completed"
        ? "bg-success-soft text-success"
        : "bg-sunken text-muted";
  const actionBtn =
    "inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-control border px-2.5 text-ui font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40";
  const neutralBtn = `${actionBtn} border-border bg-card text-secondary hover:text-primary`;
  const quietDangerBtn = `${actionBtn} border-border bg-card text-secondary hover:border-danger/40 hover:text-danger`;
  return (
    <div
      data-scheme-ui
      role="group"
      aria-label={t("pipelineStrip.groupAria", { task: pipeline.task })}
      className={`pointer-events-auto flex min-h-9 w-full flex-wrap items-center gap-x-2.5 gap-y-1 rounded-surface border bg-card/95 py-1 shadow-1 ${compact ? "px-2.5" : "px-3"} ${mobile ? "[&_button]:min-h-11 [&_button]:min-w-11" : ""} ${draft ? "border-2 border-dashed border-warning" : attention ? "border-warning/70" : "border-border"}`}
    >
      <span className="flex min-w-0 max-w-full shrink-0 items-center gap-2 sm:max-w-[46%]">
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${
            busyState ? "animate-pulse bg-accent" : attention ? "bg-warning" : pipeline.state === "completed" ? "bg-success" : draft ? "bg-warning" : "bg-strong"
          }`}
          aria-hidden
        />
        {/* One title, one status badge (issue #221 §2): the compact (on-canvas)
            strip sits under the group label chip that already names the
            pipeline, so it carries only the status; the standalone strip keeps
            the title. The state badge is the single draft marker — no separate
            DRAFT pill. */}
        {compact ? null : (
          <span className="min-w-0 truncate text-ui font-semibold text-primary" title={pipeline.task}>{pipeline.task}</span>
        )}
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-caption font-semibold ${statusBadge}`}>
          {pipelineStateLabel(t, pipeline.state)}
        </span>
        {!draft && total ? (
          <span className="shrink-0 text-label font-semibold tabular-nums text-muted">
            {t("pipelineStrip.stageOf", { k: position, n: total })}
          </span>
        ) : null}
        {detail ? <span className={`min-w-0 truncate text-ui font-semibold ${attention ? "text-warning" : "text-danger"}`} title={detail}>{detail}</span> : null}
      </span>
      <ol className="no-scrollbar flex min-w-0 flex-1 items-center justify-center gap-1.5 overflow-x-auto" aria-label={t("pipelineStrip.stagesAria")}>
        {pipeline.stages.map((stage, index) => (
          <StageChip
            key={stage.id}
            pipeline={pipeline}
            stage={stage}
            previousStage={pipeline.stages[index - 1] ?? null}
            index={index}
            flows={flows}
            files={files}
            renderableFlows={renderableFlows}
            renderablePaths={renderablePaths}
            mobile={mobile}
            open={openVerdict === stage.id}
            configurationOpen={openConfiguration === stage.id}
            onToggleVerdict={() => {
              setOpenConfiguration(null);
              setOpenVerdict((prev) => (prev === stage.id ? null : stage.id));
            }}
            onCloseVerdict={() => setOpenVerdict(null)}
            onToggleConfiguration={(stageId) => {
              setOpenVerdict(null);
              setOpenConfiguration((prev) => (prev === stageId ? null : stageId));
            }}
            onCloseConfiguration={() => setOpenConfiguration(null)}
            onOpenPath={onOpenPath}
            onOpenFlow={onOpenFlow}
          />
        ))}
      </ol>
      {linkedTasks.length ? (
        <span className="no-scrollbar flex max-w-[420px] min-w-0 shrink items-center gap-1 overflow-x-auto" aria-label={t("pipelineStrip.linkedTasks")}>
          <span className="text-caption font-semibold text-muted" aria-hidden>↗</span>
          {linkedTasks.map((task) => {
            const label = task.text.split("\n", 1)[0]?.trim() || task.id;
            return (
              <button
                key={task.id}
                type="button"
                disabled={!onOpenTask}
                onClick={() => onOpenTask?.(task)}
                aria-label={t("pipelineStrip.openTask", { label })}
                className="inline-flex h-7 max-w-[150px] items-center truncate rounded-control border border-border bg-sunken px-2 text-caption font-semibold text-secondary hover:border-accent/40 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
              >
                {label}
              </button>
            );
          })}
        </span>
      ) : null}
      <span className="flex shrink-0 flex-wrap items-center gap-1.5">
        {error ? <span className="max-w-[220px] truncate text-caption font-semibold text-danger" title={error}>{error}</span> : null}
        {busy ? <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted" aria-hidden /> : null}
        {draft ? (
          /* A draft may be empty (assembled on the canvas, #136) — Start is gated on
             the 2-stage floor here too, matching the builder panel and mobile dock,
             so the halo strip never fires a rejected PATCH. */
          <button
            className={`${actionBtn} border-warning bg-warning text-white hover:opacity-90`}
            aria-label={t("pipelineStrip.start")}
            disabled={busy || pipeline.stages.length < 2}
            title={pipeline.stages.length < 2 ? t("groupOverride.startNeedsStages") : undefined}
            onClick={() => void mutate("start")}
          >
            <Play className="h-3.5 w-3.5" aria-hidden /> {t("pipelineStrip.start")}
          </button>
        ) : pipeline.state === "needs_decision" ? (
          <>
            <button className={`${actionBtn} border-accent bg-accent text-white hover:opacity-90`} aria-label={t("pipelineStrip.retryStage")} disabled={busy} onClick={() => void mutate("retry-stage")}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> {t("pipelineStrip.retryStage")}
            </button>
            <button className={neutralBtn} aria-label={t("pipelineStrip.skipStage")} disabled={busy} onClick={() => void mutate("skip-stage")}>{t("pipelineStrip.skipStage")}</button>
          </>
        ) : null}
        {draft || finished ? null : pipeline.state === "paused" ? (
          <button className={`${actionBtn} border-success/40 bg-success-soft text-success hover:opacity-90`} aria-label={t("pipelineStrip.resume")} disabled={busy} onClick={() => void mutate("resume")}>
            <Play className="h-3.5 w-3.5" aria-hidden /> {t("pipelineStrip.resume")}
          </button>
        ) : (
          <button className={neutralBtn} aria-label={t("pipelineStrip.pause")} disabled={busy} onClick={() => void mutate("pause")}>
            <Pause className="h-3.5 w-3.5" aria-hidden /> {t("pipelineStrip.pause")}
          </button>
        )}
        <button className={quietDangerBtn} aria-label={t(draft ? "pipelineStrip.discard" : "pipelineStrip.close")} disabled={busy} onClick={() => void mutate(draft ? "delete" : "close")}>
          <X className="h-3.5 w-3.5" aria-hidden /> {t(draft ? "pipelineStrip.discard" : "pipelineStrip.close")}
        </button>
      </span>
    </div>
  );
}
