"use client";

import { CheckCircle2, Compass, Eraser, Hammer, Network, RefreshCw, Search, ShieldCheck, Upload, X, type LucideIcon } from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";

import { effortTierLabel, roleNameById } from "@/components/builderCopy";
import { flowPresentation, patchFlow } from "@/components/flows/flowModel";
import { StageEdgeControls } from "@/components/pipelines/StageEdgeControls";
import {
  PIPELINE_ROLE_OPTIONS,
  STAGE_GLYPH,
  STAGE_TONES,
  patchPipeline,
  pipelineCursorActive,
  pipelineStagePosition,
  stageChipState,
  stageOverrideBody,
} from "@/components/pipelines/pipelineModel";
import { Select } from "@/components/ui/Select";
import { ENGINE_EFFORTS } from "@/lib/agent/efforts";
import { ENGINE_MODELS } from "@/lib/agent/models";
import type { Flow } from "@/lib/flows/types";
import { useLocale } from "@/lib/i18n";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";

import { PIPELINE_RAIL_COLOR, pipelineRailSegment } from "./agentLinks";
import { layoutStageGraph, type StageGraphEdge, type StageGraphNode } from "./stageGraphLayout";

const PipelineStageGraphFlowsContext = createContext<readonly Flow[]>([]);

export function PipelineStageGraphFlowsProvider({ flows, children }: { flows: readonly Flow[]; children: ReactNode }) {
  return <PipelineStageGraphFlowsContext.Provider value={flows}>{children}</PipelineStageGraphFlowsContext.Provider>;
}

const ROLE_ICONS: Partial<Record<NonNullable<PipelineStage["effectiveRole"]["roleId"]>, LucideIcon>> = {
  orchestrator: Network,
  reviewer: ShieldCheck,
  verifier: CheckCircle2,
  builder: Hammer,
  architect: Compass,
  cleaner: Eraser,
  "prod-auditor": Search,
  deployer: Upload,
};

function edgePath(edge: StageGraphEdge, nodes: ReadonlyMap<string, StageGraphNode>): { d: string; head: string; chevrons: string[] } {
  const source = nodes.get(edge.from)!;
  const target = nodes.get(edge.to)!;
  if (source.id === target.id) {
    const x = source.x + source.width;
    const y1 = source.y + source.height / 2 + 18;
    const y2 = source.y + source.height / 2 - 18;
    const d = `M ${x} ${y1} C ${x + 54} ${y1}, ${x + 54} ${y2}, ${x + 5} ${y2}`;
    return { d, head: `M ${x + 11} ${y2 - 5} L ${x + 11} ${y2 + 5} L ${x + 3} ${y2} Z`, chevrons: [] };
  }
  if (edge.returning) {
    const x1 = source.x;
    const y1 = source.y + source.height / 2;
    const x2 = target.x;
    const y2 = target.y + target.height / 2;
    const routeX = Math.max(8, Math.min(x1, x2) - Math.max(44, Math.abs(x2 - x1) * 0.15 + 36));
    const d = `M ${x1} ${y1} C ${routeX} ${y1}, ${routeX} ${y2}, ${x2 - 5} ${y2}`;
    return { d, head: `M ${x2 - 11} ${y2 - 5} L ${x2 - 11} ${y2 + 5} L ${x2 - 3} ${y2} Z`, chevrons: [] };
  }
  if (target.parentId === source.id) {
    const x1 = source.x + source.width / 2;
    const y1 = source.y + source.height;
    const x2 = target.x + target.width / 2;
    const y2 = target.y;
    const mid = (y1 + y2) / 2;
    const d = `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2 - 5}`;
    return { d, head: `M ${x2 - 5} ${y2 - 10} L ${x2 + 5} ${y2 - 10} L ${x2} ${y2 - 2} Z`, chevrons: [] };
  }
  const rail = pipelineRailSegment(
    { x: source.x, y: source.y, w: source.width, h: source.height },
    { x: target.x, y: target.y, w: target.width, h: target.height },
    0,
  );
  const d = `M ${rail.x1} ${rail.y1} L ${rail.x2 - 5} ${rail.y2}`;
  return {
    d,
    head: `M ${rail.x2 - 10} ${rail.y2 - 5} L ${rail.x2 - 10} ${rail.y2 + 5} L ${rail.x2 - 2} ${rail.y2} Z`,
    chevrons: rail.chevrons,
  };
}

function StageNode({
  pipeline,
  node,
  resting,
  onOpenConversation,
}: {
  pipeline: Pipeline;
  node: StageGraphNode;
  resting: boolean;
  onOpenConversation: (conversationId: string) => void;
}) {
  const { t } = useLocale();
  const attempt = node.attempts.at(-1) ?? null;
  const state = stageChipState(pipeline, node.stage);
  const tone = STAGE_TONES[state];
  const conversationId = attempt?.conversationId ?? null;
  const ghost = node.attempts.length === 0;
  const current = pipeline.cursor?.stageId === node.id && pipelineCursorActive(pipeline) && pipeline.state !== "paused";
  const dimmed = state === "failed" || state === "skipped";
  const roleId = node.stage.role?.roleId ?? node.stage.effectiveRole.roleId;
  const RoleIcon = (roleId && ROLE_ICONS[roleId]) || (node.stage.kind === "review-loop" ? ShieldCheck : Hammer);
  const reviewRound = node.stage.kind === "review-loop" ? attempt?.n ?? node.attempts.length : 0;
  const reviewLimit = node.stage.kind === "review-loop" ? node.stage.onFail?.maxRounds ?? Math.max(1, reviewRound) : 0;
  const editable = node.attempts.length === 0 && pipeline.state !== "completed" && pipeline.state !== "closed";
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [wasEditable, setWasEditable] = useState(editable);
  if (wasEditable !== editable) {
    setWasEditable(editable);
    if (!editable && settingsOpen) {
      setSettingsOpen(false);
      setNotice(t("stageGraph.startedNotice"));
    }
  }

  return (
    <article
      data-stage-graph-node={node.id}
      data-stage-kind={node.stage.kind}
      data-stage-role={roleId ?? undefined}
      data-stage-state={state}
      data-attempt-model={attempt?.effectiveRole.model ?? undefined}
      data-review-round={node.stage.kind === "review-loop" && reviewRound ? `${reviewRound}/${reviewLimit}` : undefined}
      data-ghost={ghost ? "true" : undefined}
      data-current={current ? "true" : undefined}
      data-resting={resting ? "true" : undefined}
      className={`absolute rounded-control border bg-card text-left shadow-1 ${ghost ? `border-dashed ${settingsOpen ? "" : "opacity-55"}` : "border-border"} ${dimmed ? "opacity-60" : ""} ${current ? "motion-safe:animate-pulse" : ""}`}
      style={{
        left: node.x,
        top: node.y,
        width: settingsOpen ? Math.max(280, node.width) : node.width,
        height: settingsOpen ? (pipeline.state === "draft" ? 430 : 276) : node.height,
        borderColor: ghost ? undefined : tone.color,
        zIndex: settingsOpen ? 30 : 10,
      }}
    >
      <button
        type="button"
        data-open-stage
        disabled={!editable && !conversationId}
        onClick={() => {
          if (editable) {
            setNotice(null);
            setSettingsOpen(true);
          } else if (conversationId) onOpenConversation(conversationId);
        }}
        className={`flex w-full flex-col gap-2 overflow-hidden rounded-control px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/45 disabled:cursor-default ${settingsOpen ? "h-[76px] border-b border-border" : "h-full"} ${node.attempts.length > 1 ? "pb-8" : ""}`}
        aria-label={`${node.stage.id}: ${t(`pipelineChipState.${state}`)}`}
      >
        <span className="flex w-full items-center gap-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full" style={{ color: tone.color, backgroundColor: tone.soft }}>
            <RoleIcon className="h-3.5 w-3.5" aria-hidden />
          </span>
          <strong className="min-w-0 flex-1 truncate text-ui font-bold text-primary">{node.stage.id}</strong>
          <span className="text-caption font-bold" style={{ color: tone.color }} aria-hidden>{STAGE_GLYPH[state]}</span>
        </span>
        <span className="text-caption font-semibold text-muted">
          {node.stage.kind === "review-loop" && reviewRound
            ? t("stageGraph.roundProgress", { round: reviewRound, total: reviewLimit })
            : t(`pipelineChipState.${state}`)}
          {attempt?.effectiveRole.model ? ` · ${attempt.effectiveRole.model}` : ""}
        </span>
      </button>
      {settingsOpen ? (
        <InlineStageSettings
          pipeline={pipeline}
          stage={node.stage}
          onCancel={() => setSettingsOpen(false)}
          onError={setNotice}
          onSaved={() => {
            setNotice(t("groupOverride.savedStage"));
            setSettingsOpen(false);
          }}
        />
      ) : null}
      {notice && !settingsOpen ? <p role="status" className="px-2 py-1 text-caption font-semibold text-warning">{notice}</p> : null}
      {node.attempts.length > 1 ? (
        <details data-attempt-stack className="absolute bottom-1 left-2 right-2 z-20 text-caption">
          <summary className="cursor-pointer select-none rounded-control bg-sunken px-2 py-1 font-bold text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            {t("pipelineHub.attempt", { n: attempt?.n ?? node.attempts.length })}
          </summary>
          <div className="absolute left-0 top-full mt-1 flex min-w-full flex-col gap-1 rounded-control border border-border bg-card p-1.5 shadow-2">
            {node.attempts.map((candidate) => (
              <button
                key={candidate.n}
                type="button"
                data-attempt-conversation={candidate.conversationId ?? undefined}
                disabled={!candidate.conversationId}
                onClick={() => candidate.conversationId && onOpenConversation(candidate.conversationId)}
                className="whitespace-nowrap rounded-control px-2 py-1 text-left font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:text-muted"
              >
                {t("pipelineVerdict.attemptLine", { n: candidate.n, status: t(`pipelineChipState.${candidate.state}`) })}
              </button>
            ))}
          </div>
        </details>
      ) : null}
    </article>
  );
}

function InlineStageSettings({
  pipeline,
  stage,
  onCancel,
  onError,
  onSaved,
}: {
  pipeline: Pipeline;
  stage: PipelineStage;
  onCancel: () => void;
  onError: (message: string) => void;
  onSaved: () => void;
}) {
  const { t } = useLocale();
  const engine = stage.effectiveRole.engine;
  const [roleId, setRoleId] = useState(stage.role?.roleId ?? "");
  const [model, setModel] = useState(stage.effectiveRole.model ?? "");
  const [effort, setEffort] = useState(stage.effectiveRole.effort ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const knownModels = ENGINE_MODELS[engine];
  const modelKnown = !model || knownModels.some((option) => option.id === model);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const failure = await patchPipeline(
      pipeline.id,
      "override-stage",
      stageOverrideBody(stage, { roleId, engine, model, effort, prompt: stage.prompt }),
    );
    setBusy(false);
    if (failure) {
      setError(failure);
      onError(failure);
    }
    else onSaved();
  };

  return (
    <div
      data-stage-settings={stage.id}
      className="flex flex-col gap-2 bg-card p-2"
    >
      <div className="grid grid-cols-2 gap-2">
        <label className="flex min-w-0 flex-col gap-1 text-caption font-semibold text-muted">
          {t("groupOverride.role")}
          <Select data-stage-setting="role" value={roleId} onChange={(event) => setRoleId(event.target.value)}>
            <option value="">{t("groupOverride.noRole")}</option>
            {PIPELINE_ROLE_OPTIONS.map((id) => <option key={id} value={id}>{roleNameById(t, id)}</option>)}
          </Select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-caption font-semibold text-muted">
          {t("groupOverride.effort")}
          <Select data-stage-setting="effort" value={effort} onChange={(event) => setEffort(event.target.value)}>
            <option value="">{t("groupOverride.effortDefault")}</option>
            {ENGINE_EFFORTS[engine].map((tier) => <option key={tier} value={tier}>{effortTierLabel(t, tier)}</option>)}
          </Select>
        </label>
      </div>
      <label className="flex min-w-0 flex-col gap-1 text-caption font-semibold text-muted">
        {t("groupOverride.model")}
        <Select data-stage-setting="model" value={model} onChange={(event) => setModel(event.target.value)}>
          <option value="">{t("groupOverride.modelPlaceholder")}</option>
          {!modelKnown ? <option value={model}>{model}</option> : null}
          {knownModels.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </Select>
      </label>
      {error ? <p role="alert" className="text-caption font-semibold text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-1.5">
        <button type="button" onClick={onCancel} className="h-7 rounded-control border border-border px-2 text-caption font-bold text-muted">{t("common.cancel")}</button>
        <button data-save-stage-settings type="button" onClick={() => void save()} disabled={busy} className="h-7 rounded-control bg-accent px-2.5 text-caption font-bold text-white disabled:opacity-50">
          {t("groupOverride.applyStage")}
        </button>
      </div>
      {pipeline.state === "draft" ? <StageEdgeControls pipeline={pipeline} stage={stage} disabled={busy} /> : null}
    </div>
  );
}

function CollapsedReviewGroup({
  pipeline,
  owner,
  reviewers,
  expanded,
  onExpand,
}: {
  pipeline: Pipeline;
  owner: StageGraphNode;
  reviewers: StageGraphNode[];
  expanded: boolean;
  onExpand: () => void;
}) {
  const { t } = useLocale();
  const flows = useContext(PipelineStageGraphFlowsContext);
  return (
    <button
      type="button"
      data-review-group-collapsed={owner.id}
      aria-expanded={expanded}
      onClick={onExpand}
      className={`absolute z-10 flex flex-col gap-1 rounded-control border border-dashed border-border bg-card/90 p-1.5 text-left shadow-1 transition-[transform,opacity] duration-300 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${expanded ? "pointer-events-none scale-[0.97] opacity-0" : "opacity-100"}`}
      style={{ left: owner.x + 12, top: owner.y + owner.height + 12, width: owner.width - 24 }}
    >
      {reviewers.map((reviewer) => {
        const attempt = reviewer.attempts.at(-1) ?? null;
        const flow = attempt?.flowId ? flows.find((candidate) => candidate.id === attempt.flowId) : null;
        const state = stageChipState(pipeline, reviewer.stage);
        const tone = STAGE_TONES[state];
        const round = flow?.rounds.at(-1)?.n ?? attempt?.n ?? reviewer.attempts.length;
        const limit = flow ? (flow.roundLimit === 0 ? "∞" : flow.roundLimit) : reviewer.stage.onFail?.maxRounds ?? Math.max(1, round);
        return (
          <span
            key={reviewer.id}
            data-stage-graph-node={reviewer.id}
            data-review-group-stage={reviewer.id}
            data-stage-kind="review-loop"
            data-stage-state={state}
            data-attempt-model={attempt?.effectiveRole.model ?? undefined}
            data-review-round={round ? `${round}/${limit}` : undefined}
            data-ghost={reviewer.attempts.length === 0 ? "true" : undefined}
            className="flex min-h-9 items-center gap-2 rounded-[7px] bg-sunken px-2 py-1"
          >
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" style={{ color: tone.color }} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-caption font-bold text-primary">{reviewer.id}</span>
            <span className="shrink-0 text-[10px] font-semibold text-muted">
              {round ? t("stageGraph.roundProgress", { round, total: limit }) : t(`pipelineChipState.${state}`)}
              {attempt?.effectiveRole.model ? ` · ${attempt.effectiveRole.model}` : ""}
            </span>
          </span>
        );
      })}
    </button>
  );
}

function ReviewCycle({
  pipeline,
  owner,
  reviewers,
  expanded,
  restingStageId,
  onCollapse,
  onOpenConversation,
}: {
  pipeline: Pipeline;
  owner: StageGraphNode;
  reviewers: StageGraphNode[];
  expanded: boolean;
  restingStageId: string | null;
  onCollapse: () => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const { locale, t } = useLocale();
  const flows = useContext(PipelineStageGraphFlowsContext);
  const reviewer = reviewers.find((candidate) => candidate.id === pipeline.cursor?.stageId)
    ?? [...reviewers].reverse().find((candidate) => candidate.attempts.length > 0)
    ?? reviewers[0]!;
  const implementerAttempt = owner.attempts.at(-1) ?? null;
  const reviewerAttempt = reviewer.attempts.at(-1) ?? null;
  const flowId = reviewerAttempt?.flowId ?? null;
  const flow = flowId ? flows.find((candidate) => candidate.id === flowId) ?? null : null;
  const round = flow?.rounds.at(-1)?.n ?? reviewerAttempt?.n ?? reviewer.attempts.length;
  const limit = flow ? (flow.roundLimit === 0 ? "∞" : flow.roundLimit) : reviewer.stage.onFail?.maxRounds ?? Math.max(1, round);
  const editable = reviewer.attempts.length === 0 && pipeline.state !== "completed" && pipeline.state !== "closed";
  const roundConfigKey = `${reviewer.id}:${flowId ?? "pending"}`;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeRoundConfigKey, setActiveRoundConfigKey] = useState(roundConfigKey);
  const [roundModel, setRoundModel] = useState(flow?.roles.reviewer.model ?? reviewer.stage.effectiveRole.model ?? "");
  const [roundEffort, setRoundEffort] = useState(flow?.roles.reviewer.effort ?? reviewer.stage.effectiveRole.effort ?? "");
  const [roundBusy, setRoundBusy] = useState(false);
  const [roundError, setRoundError] = useState<string | null>(null);
  const [roundSaved, setRoundSaved] = useState<string | null>(null);
  const engine = flow?.roles.reviewer.engine ?? reviewer.stage.effectiveRole.engine;
  const roundModelKnown = !roundModel || ENGINE_MODELS[engine].some((option) => option.id === roundModel);
  const pendingRoundAction = flow ? flowPresentation(t, flow, locale).pending : null;
  const [wasEditable, setWasEditable] = useState(editable);
  if (activeRoundConfigKey !== roundConfigKey) {
    setActiveRoundConfigKey(roundConfigKey);
    setRoundModel(flow?.roles.reviewer.model ?? reviewer.stage.effectiveRole.model ?? "");
    setRoundEffort(flow?.roles.reviewer.effort ?? reviewer.stage.effectiveRole.effort ?? "");
    setSettingsOpen(false);
    setNotice(null);
    setRoundError(null);
    setRoundSaved(null);
  } else if (wasEditable !== editable) {
    setWasEditable(editable);
    if (!editable && settingsOpen) {
      setSettingsOpen(false);
      setNotice(t("stageGraph.startedNotice"));
    }
  }

  const runRoundAction = async (label: string, action: () => Promise<string | null>) => {
    if (roundBusy) return;
    setRoundBusy(true);
    setRoundError(null);
    setRoundSaved(null);
    const failure = await action();
    if (failure) setRoundError(failure);
    else setRoundSaved(label);
    setRoundBusy(false);
  };

  return (
    <section
      data-review-cycle={owner.id}
      data-review-cycle-state={expanded ? "expanded" : "collapsed"}
      data-review-round={round ? `${round}/${limit}` : undefined}
      aria-hidden={!expanded}
      inert={!expanded}
      className={`absolute z-20 rounded-[14px] border border-border bg-canvas p-3 shadow-2 transition-[transform,opacity] duration-300 [transform-origin:top_left] [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${expanded ? "pointer-events-auto scale-100 opacity-100" : "pointer-events-none scale-[0.96] opacity-0"}`}
      style={{ left: owner.x, top: owner.y, width: 480, minHeight: settingsOpen ? 390 : 244 }}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-caption font-bold text-muted">
          {round ? t("stageGraph.roundProgress", { round, total: limit }) : t("pipelineChipState.pending")}
        </span>
        <button
          type="button"
          data-collapse-review-cycle
          tabIndex={expanded ? 0 : -1}
          onClick={() => {
            setSettingsOpen(false);
            onCollapse();
          }}
          className="grid h-7 w-7 place-items-center rounded-full text-muted hover:bg-card hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label={t("common.close")}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      <svg viewBox="0 0 456 118" className="pointer-events-none absolute left-3 top-10 h-[118px] w-[456px]" aria-hidden>
        <path data-review-cycle-arrow="forward" d="M 170 36 C 220 2, 276 2, 326 36" fill="none" stroke={PIPELINE_RAIL_COLOR.ok} strokeWidth="4" strokeLinecap="round" />
        <path d="M 317 29 L 329 36 L 316 42 Z" fill={PIPELINE_RAIL_COLOR.ok} />
        <path data-review-cycle-arrow="back" d="M 326 82 C 276 116, 220 116, 170 82" fill="none" stroke="var(--color-warning)" strokeWidth="4" strokeLinecap="round" strokeDasharray="8 7" />
        <path d="M 179 75 L 167 82 L 180 88 Z" fill="var(--color-warning)" />
      </svg>

      <button
        type="button"
        data-cycle-role="implementer"
        tabIndex={expanded ? 0 : -1}
        disabled={!implementerAttempt?.conversationId}
        onClick={() => implementerAttempt?.conversationId && onOpenConversation(implementerAttempt.conversationId)}
        className="absolute left-5 top-[76px] flex h-[76px] w-[154px] flex-col justify-center gap-1 rounded-control border border-border bg-card px-3 text-left shadow-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default"
      >
        <span className="flex items-center gap-2 text-ui font-bold text-primary"><Hammer className="h-4 w-4 text-accent" aria-hidden />{owner.id}</span>
        <span className="text-caption font-semibold text-muted">{t(`pipelineChipState.${stageChipState(pipeline, owner.stage)}`)}</span>
      </button>

      <button
        type="button"
        data-cycle-role="reviewer"
        data-open-stage
        data-ghost={reviewer.attempts.length === 0 ? "true" : undefined}
        data-attempt-model={reviewerAttempt?.effectiveRole.model ?? undefined}
        data-resting={reviewer.id === restingStageId ? "true" : undefined}
        tabIndex={expanded ? 0 : -1}
        disabled={!editable && !reviewerAttempt?.conversationId}
        onClick={() => {
          if (editable) {
            setNotice(null);
            setSettingsOpen(true);
          } else if (reviewerAttempt?.conversationId) onOpenConversation(reviewerAttempt.conversationId);
        }}
        className="absolute right-5 top-[76px] flex h-[76px] w-[154px] flex-col justify-center gap-1 rounded-control border border-border bg-card px-3 text-left shadow-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default"
      >
        <span className="flex items-center gap-2 text-ui font-bold text-primary"><ShieldCheck className="h-4 w-4 text-warning" aria-hidden />{reviewer.id}</span>
        <span className="text-caption font-semibold text-muted">{round ? t("stageGraph.roundProgress", { round, total: limit }) : t("pipelineChipState.pending")}</span>
      </button>

      {settingsOpen ? (
        <div className="absolute left-[176px] top-[158px] z-30 w-[280px] overflow-hidden rounded-control border border-border bg-card shadow-2">
          <InlineStageSettings
            pipeline={pipeline}
            stage={reviewer.stage}
            onCancel={() => setSettingsOpen(false)}
            onError={setNotice}
            onSaved={() => {
              setNotice(t("groupOverride.savedStage"));
              setSettingsOpen(false);
            }}
          />
        </div>
      ) : null}
      {!settingsOpen && flowId && flow ? (
        <div data-review-round-controls className="absolute bottom-3 left-5 right-5 grid grid-cols-[1.4fr_1fr_auto_auto] items-end gap-1.5 border-t border-border pt-2">
          <label className="flex min-w-0 flex-col gap-1 text-[9px] font-bold uppercase tracking-wide text-muted">
            {t("groupOverride.model")}
            <Select value={roundModel} onChange={(event) => setRoundModel(event.target.value)} disabled={roundBusy}>
              <option value="">{t("groupOverride.modelPlaceholder")}</option>
              {!roundModelKnown ? <option value={roundModel}>{roundModel}</option> : null}
              {ENGINE_MODELS[engine].map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </Select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-[9px] font-bold uppercase tracking-wide text-muted">
            {t("groupOverride.effort")}
            <Select value={roundEffort} onChange={(event) => setRoundEffort(event.target.value)} disabled={roundBusy}>
              <option value="">{t("groupOverride.effortDefault")}</option>
              {ENGINE_EFFORTS[engine].map((tier) => <option key={tier} value={tier}>{effortTierLabel(t, tier)}</option>)}
            </Select>
          </label>
          <button
            type="button"
            disabled={roundBusy}
            onClick={() => void runRoundAction(t("groupOverride.savedReviewer"), () => patchFlow(flowId, {
              action: "set-roles",
              roles: { reviewer: { engine, model: roundModel || null, effort: roundEffort || null } },
            }))}
            className="h-7 rounded-full border border-border bg-card px-2 text-[10px] font-bold text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
          >
            {t("groupOverride.applyRole")}
          </button>
          {pendingRoundAction ? (
            <button
              type="button"
              data-trigger-review-round
              data-review-round-action={pendingRoundAction.action}
              disabled={roundBusy}
              onClick={() => void runRoundAction(t(pendingRoundAction.labelKey), () => patchFlow(flowId, { action: pendingRoundAction.action }))}
              className="inline-flex h-7 items-center gap-1 rounded-full border border-accent bg-accent px-2.5 text-[10px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40"
            >
              <RefreshCw className={`h-3 w-3 ${roundBusy ? "animate-spin" : ""}`} aria-hidden /> {t(pendingRoundAction.labelKey)}
            </button>
          ) : <span aria-hidden />}
          {roundError ? <p role="alert" className="col-span-4 text-caption font-semibold text-danger">{roundError}</p> : null}
          {roundSaved ? <p role="status" className="col-span-4 text-caption font-semibold text-success">{roundSaved}</p> : null}
        </div>
      ) : null}
      {notice && !settingsOpen ? <p role="status" className={`absolute left-5 right-5 text-caption font-semibold text-warning ${flowId ? "bottom-[74px]" : "bottom-3"}`}>{notice}</p> : null}
    </section>
  );
}

function ReviewCluster({
  pipeline,
  owner,
  reviewers,
  restingStageId,
  onOpenConversation,
}: {
  pipeline: Pipeline;
  owner: StageGraphNode;
  reviewers: StageGraphNode[];
  restingStageId: string | null;
  onOpenConversation: (conversationId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <StageNode pipeline={pipeline} node={owner} resting={owner.id === restingStageId} onOpenConversation={onOpenConversation} />
      <CollapsedReviewGroup pipeline={pipeline} owner={owner} reviewers={reviewers} expanded={expanded} onExpand={() => setExpanded(true)} />
      <ReviewCycle
        pipeline={pipeline}
        owner={owner}
        reviewers={reviewers}
        expanded={expanded}
        restingStageId={restingStageId}
        onCollapse={() => setExpanded(false)}
        onOpenConversation={onOpenConversation}
      />
    </>
  );
}

export function PipelineStageGraph({
  pipeline,
  onOpenConversation,
}: {
  pipeline: Pipeline;
  onOpenConversation: (conversationId: string) => void;
}) {
  const graph = layoutStageGraph(pipeline.stages, pipeline.runs);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const rootNodes = graph.nodes.filter((node) => node.parentId === null);
  const restingStageId = pipeline.stages[pipelineStagePosition(pipeline).k - 1]?.id ?? null;

  return (
    <div data-pipeline-stage-graph className="max-h-[360px] w-full overflow-x-auto overflow-y-auto overscroll-contain rounded-control border border-border/70 bg-canvas/80">
      <div className="relative min-w-full" style={{ width: graph.size.width, height: graph.size.height }}>
        <svg width={graph.size.width} height={graph.size.height} className="pointer-events-none absolute inset-0" aria-hidden>
          {graph.edges.map((edge) => {
            const geometry = edgePath(edge, nodes);
            const cursorTookEdge = pipeline.cursor?.stageId === edge.targetStageId
              && pipeline.cursor.activatedBy?.stageId === edge.sourceStageId
              && pipeline.cursor.activatedBy.edge === edge.kind;
            const taken = edge.taken || cursorTookEdge;
            const color = edge.kind === "fail" ? "var(--color-warning)" : taken ? PIPELINE_RAIL_COLOR.ok : PIPELINE_RAIL_COLOR.dim;
            return (
              <g
                key={edge.id}
                data-stage-graph-edge={edge.id}
                data-edge-kind={edge.kind}
                data-edge-taken={taken ? "true" : "false"}
                data-edge-return={edge.returning ? "true" : undefined}
                opacity={taken ? 0.95 : 0.42}
              >
                <path d={geometry.d} fill="none" stroke={color} strokeWidth={taken ? 3 : 2} strokeLinecap="round" strokeDasharray={edge.kind === "fail" ? "6 6" : undefined} />
                {geometry.chevrons.map((chevron, index) => <path key={index} d={chevron} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />)}
                <path d={geometry.head} fill={color} />
              </g>
            );
          })}
        </svg>
        {rootNodes.map((root) => {
          const children = graph.nodes.filter((node) => node.parentId === root.id);
          const bottom = Math.max(root.y + root.height, ...children.map((node) => node.y + node.height));
          return (
            <div key={root.id} data-stage-group-owner={root.id} className="contents">
              {children.length ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute rounded-control border border-dashed border-border/80 bg-card/35"
                  style={{ left: root.x - 8, top: root.y - 8, width: root.width + 16, height: bottom - root.y + 16 }}
                />
              ) : null}
              {children.length ? (
                <ReviewCluster pipeline={pipeline} owner={root} reviewers={children} restingStageId={restingStageId} onOpenConversation={onOpenConversation} />
              ) : (
                <StageNode pipeline={pipeline} node={root} resting={root.id === restingStageId} onOpenConversation={onOpenConversation} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
