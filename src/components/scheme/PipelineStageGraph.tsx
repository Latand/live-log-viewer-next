"use client";

import { CheckCircle2, Compass, Eraser, Hammer, Network, Search, ShieldCheck, Upload, type LucideIcon } from "lucide-react";
import { useState } from "react";

import { effortTierLabel, roleNameById } from "@/components/builderCopy";
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
import { useLocale } from "@/lib/i18n";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";

import { PIPELINE_RAIL_COLOR, pipelineRailSegment } from "./agentLinks";
import { layoutStageGraph, type StageGraphEdge, type StageGraphNode } from "./stageGraphLayout";

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
              <StageNode pipeline={pipeline} node={root} resting={root.id === restingStageId} onOpenConversation={onOpenConversation} />
              {children.map((node) => <StageNode key={node.id} pipeline={pipeline} node={node} resting={node.id === restingStageId} onOpenConversation={onOpenConversation} />)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
