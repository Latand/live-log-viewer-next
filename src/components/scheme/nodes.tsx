"use client";

import { Check, Layers } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { ChevronRight } from "@/components/icons";
import type { Flow } from "@/lib/flows/types";
import { useLocale } from "@/lib/i18n";
import type { Activity, FileEntry } from "@/lib/types";

import { useRuntime } from "@/hooks/useRuntime";
import { deriveSessionState, hasBlockingAttention, runtimeActivity } from "@/components/runtime/runtimeModel";

import { BranchPane, kindLabel } from "@/components/BranchPane";
import { DraftAgentPane } from "@/components/DraftAgentPane";
import { FlowDialog } from "@/components/flows/FlowDialog";
import {
  activeLoopLeg,
  activeLoopRole,
  ATTENTION_STATES,
  BUSY_FLOW_STATES,
  canStartFlow,
  verdictTone,
} from "@/components/flows/flowModel";
import { FlowStrip } from "@/components/flows/FlowStrip";
import { RoleTag } from "@/components/flows/RoleTag";
import { RoundDeck } from "@/components/flows/RoundDeck";
import { RoundStateIcon } from "@/components/flows/RoundIcons";
import { canHandoff, HandoffHandle } from "@/components/HandoffHandle";
import { isWorkflowDraftId } from "@/components/workflows/workflowModel";
import { WorkflowDraftPane } from "@/components/workflows/WorkflowDraftPane";
import { activityDot, cleanTitle, engineBadge, engineEdge, fmtAge } from "@/components/utils";

import {
  LOOP_GAP,
  NODE_W,
  type DeckNode,
  type DraftNode,
  type FlowLoop,
  type MiniStack,
  type SchemeEdge,
  type SchemeLayout,
  type SchemeNode,
} from "./layout";

/* Layout reshuffles glide instead of jumping. */
export const MOVE_MS = 380;
export const MOVE_EASE = `cubic-bezier(.22,.8,.36,1)`;
export const MOVE_TRANSITION = `transform ${MOVE_MS}ms ${MOVE_EASE}`;

/** Round-chip click on a strip, delivered to that flow's deck. */
export interface DeckFocus {
  flowId: string;
  round: number;
  nonce: number;
}

/* Geometry animated via CSS (style-level `d`/`cx`/`cy` with transitions), the
   attribute stays as the fallback for engines without SVG geometry props. */
export const EdgesLayer = memo(function EdgesLayer({ edges, width, height }: { edges: SchemeEdge[]; width: number; height: number }) {
  return (
    <svg width={width} height={height} className="absolute left-0 top-0" aria-hidden>
      {edges.map((edge) => {
        const lift = Math.max(36, (edge.y2 - edge.y1) * 0.5);
        const curve = `M ${edge.x1} ${edge.y1} C ${edge.x1} ${edge.y1 + lift}, ${edge.x2} ${edge.y2 - lift}, ${edge.x2} ${edge.y2 - 7}`;
        const head = `M ${edge.x2 - 5} ${edge.y2 - 9} L ${edge.x2 + 5} ${edge.y2 - 9} L ${edge.x2} ${edge.y2 - 1} Z`;
        return (
          <g key={edge.to} opacity={edge.live ? 0.9 : 0.5}>
            <path
              d={curve}
              style={{ d: `path("${curve}")`, transition: `d ${MOVE_MS}ms ${MOVE_EASE}` } as React.CSSProperties}
              fill="none"
              stroke={edge.color}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeDasharray={edge.dashed ? "5 7" : undefined}
            />
            <circle
              cx={edge.x1}
              cy={edge.y1}
              r={3.5}
              fill={edge.color}
              style={
                {
                  cx: `${edge.x1}px`,
                  cy: `${edge.y1}px`,
                  transition: `cx ${MOVE_MS}ms ${MOVE_EASE}, cy ${MOVE_MS}ms ${MOVE_EASE}`,
                } as React.CSSProperties
              }
            />
            <path
              d={head}
              style={{ d: `path("${head}")`, transition: `d ${MOVE_MS}ms ${MOVE_EASE}` } as React.CSSProperties}
              fill={edge.color}
            />
          </g>
        );
      })}
    </svg>
  );
});

/* Vertical anchors of the cycle arcs inside a loop corridor, relative to the
   pair's top edge — high enough to sit next to both cards' headers. */
const LOOP_ARC_TOP = 150;
const LOOP_ARC_BOT = 330;
/* How far the arcs bulge out of the corridor and how far the control points
   reach along it: together they round the two legs into an ellipse-ish ring. */
const LOOP_BULGE = 56;
const LOOP_REACH = 52;
/* Each leg's end offset along the corridor — the arc stops this far short of
   the node so the arrowhead caps it. */
const LOOP_HEAD_INSET = 7;

/* End-tangent angle of each leg. A cubic's direction at its end is P3 − P2
   (endpoint minus its near control point); with fixed control offsets these
   are constant, so the filled arrowhead can ride the curve's direction instead
   of always lying flat. Forward descends right into the reviewer; the return
   climbs left into the implementer. */
const FWD_HEAD_ANGLE = Math.atan2(LOOP_BULGE, LOOP_REACH - LOOP_HEAD_INSET);
const BACK_HEAD_ANGLE = Math.atan2(-LOOP_BULGE, LOOP_HEAD_INSET - LOOP_REACH);

/* A filled arrowhead whose tip sits at (x, y) with its body swept back along
   `angle`, so the triangle aligns with the arc's travel vector. */
function loopArrowHead(x: number, y: number, angle: number): string {
  const len = 9;
  const half = 5;
  const bx = x - len * Math.cos(angle);
  const by = y - len * Math.sin(angle);
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle);
  return `M ${bx + half * nx} ${by + half * ny} L ${bx - half * nx} ${by - half * ny} L ${x} ${y} Z`;
}

/** Hub color of a loop: green while a side works, amber when it waits on the
    user, verdict green once approved, gray otherwise. */
function loopTone(flow: FlowLoop["flow"]): string {
  if (flow.state === "approved") return "#1a8a3e";
  if (BUSY_FLOW_STATES.has(flow.state)) return "#5a51e0";
  if (ATTENTION_STATES.has(flow.state)) return "#e0ae45";
  return "#9a9aa4";
}

/* The implement↔review pair drawn as an explicit cycle: a forward arc into
   the reviewer, a return arc back into the implementer, and a ⟳ hub between
   them. The leg traffic is currently on runs an animated dash in its travel
   direction; the other leg stays quiet. Geometry transitions mirror
   EdgesLayer so layout reshuffles glide. */
export const LoopsLayer = memo(function LoopsLayer({ loops, width, height }: { loops: FlowLoop[]; width: number; height: number }) {
  if (!loops.length) return null;
  return (
    <svg width={width} height={height} className="absolute left-0 top-0" aria-hidden>
      {loops.map((loop) => {
        const leg = activeLoopLeg(loop.flow);
        const tone = loopTone(loop.flow);
        const yTop = loop.y + LOOP_ARC_TOP;
        const yBot = loop.y + LOOP_ARC_BOT;
        const midX = (loop.x1 + loop.x2) / 2;
        const midY = (yTop + yBot) / 2;
        const forward = `M ${loop.x1} ${yTop} C ${loop.x1 + LOOP_REACH} ${yTop - LOOP_BULGE}, ${loop.x2 - LOOP_REACH} ${
          yTop - LOOP_BULGE
        }, ${loop.x2 - LOOP_HEAD_INSET} ${yTop}`;
        const back = `M ${loop.x2} ${yBot} C ${loop.x2 - LOOP_REACH} ${yBot + LOOP_BULGE}, ${loop.x1 + LOOP_REACH} ${
          yBot + LOOP_BULGE
        }, ${loop.x1 + LOOP_HEAD_INSET} ${yBot}`;
        const forwardHead = loopArrowHead(loop.x2 - LOOP_HEAD_INSET, yTop, FWD_HEAD_ANGLE);
        const backHead = loopArrowHead(loop.x1 + LOOP_HEAD_INSET, yBot, BACK_HEAD_ANGLE);
        const arc = (d: string, live: boolean) => ({
          d,
          fill: "none" as const,
          stroke: live ? "#5a51e0" : "#c9c9d1",
          strokeWidth: live ? 3 : 2.5,
          strokeLinecap: "round" as const,
          className: live ? "loop-arc-live" : undefined,
          style: { d: `path("${d}")`, transition: `d ${MOVE_MS}ms ${MOVE_EASE}` } as React.CSSProperties,
        });
        const headStyle = (d: string) =>
          ({ d: `path("${d}")`, transition: `d ${MOVE_MS}ms ${MOVE_EASE}` }) as React.CSSProperties;
        return (
          <g key={loop.key}>
            <path {...arc(forward, leg === "forward")} />
            <path d={forwardHead} style={headStyle(forwardHead)} fill={leg === "forward" ? "#5a51e0" : "#c9c9d1"} />
            <path {...arc(back, leg === "back")} />
            <path d={backHead} style={headStyle(backHead)} fill={leg === "back" ? "#5a51e0" : "#c9c9d1"} />
            <circle
              cx={midX}
              cy={midY}
              r={17}
              fill="#ffffff"
              stroke={tone}
              strokeWidth={2}
              style={{ cx: `${midX}px`, cy: `${midY}px`, transition: `cx ${MOVE_MS}ms ${MOVE_EASE}, cy ${MOVE_MS}ms ${MOVE_EASE}` } as React.CSSProperties}
            />
            <text
              x={midX}
              y={midY + 6}
              textAnchor="middle"
              fontSize={17}
              fontWeight={700}
              fill={tone}
              style={{ x: `${midX}px`, y: `${midY + 6}px`, transition: `x ${MOVE_MS}ms ${MOVE_EASE}, y ${MOVE_MS}ms ${MOVE_EASE}` } as React.CSSProperties}
            >
              ⟳
            </text>
          </g>
        );
      })}
    </svg>
  );
});

/** Quiet history chip inside an expanded under-deck panel. */
function UnderRow({ file, onSelect }: { file: FileEntry; onSelect: (file: FileEntry) => void }) {
  const badge = engineBadge(file);
  return (
    <button
      className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-[8px] px-2 text-left hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      title={cleanTitle(file.title)}
      onClick={() => onSelect(file)}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityDot(file.activity)}`} />
      <span className="shrink-0 rounded-full px-1.5 text-[9px] font-bold" style={badge.style}>
        {badge.label}
      </span>
      <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold">{cleanTitle(file.cmdDesc || file.title, 80)}</span>
      <span className="shrink-0 text-[10.5px] text-dim">{fmtAge(file.mtime)}</span>
    </button>
  );
}

/**
 * Far-zoom identity of a node: when panes shrink below readability the label
 * takes over. Sized in world-inverse units (CSS vars set on the world div),
 * so it keeps a constant on-screen size at any zoom without re-rendering.
 */
function FarLabel({ file }: { file: FileEntry }) {
  const badge = engineBadge(file);
  return (
    <div
      className="pointer-events-none absolute inset-0 z-[3] flex items-center justify-center"
      style={{ opacity: "var(--label-o, 0)", transition: "opacity .25s" }}
      aria-hidden
    >
      <div
        className="flex max-w-[94%] items-center gap-[0.5em] rounded-[0.55em] border border-line bg-panel/95 px-[0.75em] py-[0.45em] shadow-[0_2px_14px_rgb(20_20_30/0.14)]"
        /* Constant on-screen size until ~2.6× (z≈0.38); further out it shrinks
           with the world so neighboring labels never overlap. */
        style={{ fontSize: "calc(13px * min(var(--inv-z, 1), 2.6))" }}
      >
        <span className={`h-[0.6em] w-[0.6em] shrink-0 rounded-full ${activityDot(file.activity)}`} />
        <span className="shrink-0 rounded-full px-[0.45em] font-bold" style={{ ...badge.style, fontSize: "0.72em" }}>
          {badge.label}
        </span>
        <span className="line-clamp-2 min-w-0 font-bold">{cleanTitle(file.title, 70)}</span>
      </div>
    </div>
  );
}

const liteNoop = () => undefined;

/* «Show only needs me» dimming: opacity only — geometry, edges and hit areas
   stay exactly where they were, so toggling the filter never reshuffles the
   board (D6). */
const dimClass = (dimmed: boolean) => (dimmed ? " opacity-35" : "");

/* The flow strip is the loop's shared header: it spans the whole
   implementer↔reviewer pair. */
const PAIR_W = NODE_W * 2 + LOOP_GAP;

/* Map mode (the phone's full-screen overlay) draws every conversation as a
   static identity card. A full pane per node would run a polling LogFeed and
   hold thousands of transcript lines each — multiplied across the project it
   exceeds the mobile tab's memory budget and iOS kills the renderer. The card
   carries what a pick decision needs; the transcript opens after the pick. */
function LiteNodeShell({ node, ringed, dimmed, flow }: { node: SchemeNode; ringed: boolean; dimmed: boolean; flow: Flow | null }) {
  const { t } = useLocale();
  const badge = engineBadge(node.file);
  return (
    <div
      data-scheme-node={node.file.path}
      className={`scheme-enter absolute${dimClass(dimmed)}`}
      style={{ transform: `translate(${node.x}px, ${node.y}px)`, width: node.w, height: node.h, transition: MOVE_TRANSITION }}
    >
      {flow ? (
        <div className="absolute -top-[60px] left-0 z-[4]" style={{ width: PAIR_W }}>
          <FlowStrip flow={flow} onFocusRound={liteNoop} />
        </div>
      ) : null}
      {node.under.length ? (
        <>
          <div className="absolute inset-x-4 -bottom-4 h-5 rounded-[10px] border border-line bg-panel/70 shadow-card" aria-hidden />
          <div className="absolute inset-x-2 -bottom-2 h-5 rounded-[10px] border border-line bg-panel/90 shadow-card" aria-hidden />
        </>
      ) : null}
      <div
        className={`relative z-[1] flex h-full min-w-0 flex-col overflow-hidden rounded-[10px] border border-line bg-panel shadow-card ${
          ringed ? "ring-2 ring-accent/60 ring-offset-2 ring-offset-bg" : ""
        }`}
      >
        <span aria-hidden className="h-1 w-full shrink-0" style={engineEdge(node.file)} />
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${activityDot(node.file.activity)}`} />
          <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold" style={badge.style}>
            {badge.label}
          </span>
          {node.file.model ? <span className="min-w-0 truncate font-mono text-[11px] text-dim">{node.file.model}</span> : null}
          <span className="ml-auto shrink-0 text-[11px] text-dim">{fmtAge(node.file.mtime)}</span>
        </div>
        <div className="min-w-0 flex-1 px-3 py-2.5 text-[14px] font-semibold leading-snug">
          <span className="line-clamp-5">{cleanTitle(node.file.title, 180)}</span>
        </div>
        {node.under.length ? (
          <div className="shrink-0 px-3 pb-2.5 text-[11px] font-semibold text-dim">
            {node.under.length} {t("scheme.underneath")}
          </div>
        ) : null}
      </div>
      {flow ? <RoleTag role="implementer" active={activeLoopRole(flow) === "implementer"} /> : null}
      <FarLabel file={node.file} />
    </div>
  );
}

/** Draft placeholder on the map: a pick jumps back to the focused draft pane. */
function LiteDraftShell({ draft, ringed, dimmed }: { draft: DraftNode; ringed: boolean; dimmed: boolean }) {
  const { t } = useLocale();
  return (
    <div
      data-scheme-node={draft.key}
      className={`scheme-enter absolute${dimClass(dimmed)}`}
      style={{ transform: `translate(${draft.x}px, ${draft.y}px)`, width: draft.w, height: draft.h, transition: MOVE_TRANSITION }}
    >
      <div
        className={`flex h-full items-center justify-center rounded-[10px] border border-dashed border-line bg-panel/70 ${
          ringed ? "ring-2 ring-accent/60 ring-offset-2 ring-offset-bg" : ""
        }`}
      >
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-dim">
          <span className="text-[15px] leading-none text-accent">＋</span> {t("mobile.agent")}
        </span>
      </div>
    </div>
  );
}

/** Review deck on the map: the latest round's state without mounting its feed. */
function LiteDeckShell({ deck, dimmed }: { deck: DeckNode; dimmed: boolean }) {
  const { t } = useLocale();
  const latest = deck.rounds.at(-1) ?? null;
  const round = latest?.round ?? null;
  const tone = verdictTone(round?.verdict ?? null);
  return (
    <div
      data-scheme-node={deck.key}
      className={`scheme-enter absolute${dimClass(dimmed)}`}
      style={{ transform: `translate(${deck.x}px, ${deck.y}px)`, width: deck.w, height: deck.h, transition: MOVE_TRANSITION }}
    >
      <div className="flex h-full flex-col overflow-hidden rounded-[10px] border border-line bg-panel shadow-card">
        {round ? (
          <>
            <div
              className="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-2.5"
              style={{ backgroundColor: tone.soft, color: tone.color }}
            >
              <span className="flex shrink-0 items-center gap-1 text-[12px] font-bold">
                R{round.n} <RoundStateIcon verdict={round.verdict} error={!!round.error} className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 truncate text-[11px] font-semibold">
                {round.error ? t("roundDeck.aborted") : (round.verdict ?? t("roundDeck.reviewInProgress"))}
              </span>
            </div>
            <div className="min-w-0 flex-1 px-3 py-2.5 text-[13px] font-semibold leading-snug">
              <span className="line-clamp-4">
                {latest?.file ? cleanTitle(latest.file.title, 140) : t("roundDeck.spawningReviewer")}
              </span>
            </div>
            {deck.rounds.length > 1 ? (
              <div className="shrink-0 px-3 pb-2.5 text-[11px] font-semibold text-dim">
                {t("roundDeck.moreRounds", { count: deck.rounds.length - 1 })}
              </div>
            ) : null}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-[12px] font-semibold text-dim">{t("roundDeck.waitingFirst")}</div>
        )}
      </div>
      <RoleTag role="reviewer" active={activeLoopRole(deck.flow) === "reviewer"} />
    </div>
  );
}

/**
 * Quiet branches of a pane as a column of collapsed mini cards: the subtree
 * stays readable on the diagram even when nothing in it runs. A click opens
 * the branch as a full node.
 */
function MiniStackShell({ stack, dimmed, onSelect }: { stack: MiniStack; dimmed: boolean; onSelect: (file: FileEntry) => void }) {
  const { t } = useLocale();
  return (
    <div
      data-scheme-node={stack.key}
      className={`scheme-enter absolute${dimClass(dimmed)}`}
      style={{ transform: `translate(${stack.x}px, ${stack.y}px)`, width: stack.w, height: stack.h, transition: MOVE_TRANSITION }}
    >
      <div className="flex h-full flex-col gap-1.5 overflow-y-auto rounded-[10px] border border-dashed border-[#c9c9d1] bg-panel/60 p-2">
        {stack.items.map(({ file, branches }) => {
          const badge = engineBadge(file);
          return (
            <button
              key={file.path}
              className="flex min-h-[52px] w-full min-w-0 flex-col justify-center gap-0.5 rounded-[8px] border border-line bg-panel px-2 py-1 text-left shadow-card hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              title={cleanTitle(file.title)}
              onClick={() => onSelect(file)}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityDot(file.activity)}`} />
                <span className="shrink-0 rounded-full px-1.5 text-[9px] font-bold" style={badge.style}>
                  {badge.label}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold">{cleanTitle(file.title, 70)}</span>
              </span>
              <span className="flex items-center gap-2 pl-3 text-[10.5px] text-dim">
                <span>{kindLabel(t, file.kind)}</span>
                <span>{fmtAge(file.mtime)}</span>
                {branches ? <span>⤷ {branches}</span> : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NodeShell({
  node,
  ringed,
  marked,
  dimmed,
  dormant,
  flow,
  canFlow,
  onSelect,
  onClose,
  onFocusRound,
  onHandoff,
  onExpand,
}: {
  node: SchemeNode;
  ringed: boolean;
  /** Member of the selection session: checkmark badge + exempt from dimming. */
  marked: boolean;
  /** «Show only needs me» attention filter dim. */
  dimmed: boolean;
  /** Far zoom: pane feeds sleep behind the identity labels. */
  dormant: boolean;
  /** Active review-loop flow attached to this conversation, if any. */
  flow: Flow | null;
  /** This node may host a new flow (root claude/codex conversation without one). */
  canFlow: boolean;
  onSelect: (file: FileEntry) => void;
  onClose: (path: string) => void;
  onFocusRound: (flowId: string, round: number) => void;
  onHandoff?: (file: FileEntry) => void;
  /** Header control: open this conversation as the full-window overlay. */
  onExpand: (path: string) => void;
}) {
  const { t } = useLocale();
  const [underOpen, setUnderOpen] = useState(false);
  const [flowOpen, setFlowOpen] = useState(false);
  return (
    <div
      data-scheme-node={node.file.path}
      data-lasso-selected={marked ? "true" : undefined}
      className={`scheme-enter absolute ${underOpen || flowOpen ? "z-20" : ""}${dimClass(dimmed)}`}
      style={{ transform: `translate(${node.x}px, ${node.y}px)`, width: node.w, height: node.h, transition: MOVE_TRANSITION }}
    >
      {marked ? (
        <>
          <span className="absolute -right-2.5 -top-2.5 z-[5] flex h-6 w-6 items-center justify-center rounded-full border-2 border-bg bg-accent text-white shadow-card">
            <Check className="h-3.5 w-3.5" aria-hidden />
          </span>
          {/* The promised member tint: readable at far zoom, panes stay legible. */}
          <div aria-hidden className="pointer-events-none absolute inset-0 z-[4] rounded-[10px] bg-accent/[0.06]" />
        </>
      ) : null}
      {/* The loop's shared header hovers above the implementer↔reviewer pair. */}
      {flow ? (
        <div className="absolute -top-[60px] left-0 z-[4]" style={{ width: PAIR_W }}>
          <FlowStrip flow={flow} onFocusRound={(round) => onFocusRound(flow.id, round)} />
        </div>
      ) : canFlow ? (
        <div className="absolute -top-11 left-0 z-[4]">
          <button
            data-scheme-ui
            className="inline-flex h-7 items-center gap-1 rounded-full border border-line bg-panel px-2.5 text-[11px] font-semibold text-dim shadow-card hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-expanded={flowOpen}
            title={t("scheme.flowTitle")}
            onClick={() => setFlowOpen((value) => !value)}
          >
            <span className="text-[13px] leading-none text-accent">⟳</span> {t("scheme.flow")}
          </button>
        </div>
      ) : null}
      {flowOpen ? (
        <div className="absolute left-0 top-[-8px] z-40 -translate-y-full">
          <FlowDialog file={node.file} onClose={() => setFlowOpen(false)} />
        </div>
      ) : null}
      {/* The hidden stack peeking from under the card: previous chats and
          finished tasks lie beneath the conversation, deck-style. */}
      {node.under.length ? (
        <>
          <div className="absolute inset-x-4 -bottom-4 h-5 rounded-[10px] border border-line bg-panel/70 shadow-card" aria-hidden />
          <div className="absolute inset-x-2 -bottom-2 h-5 rounded-[10px] border border-line bg-panel/90 shadow-card" aria-hidden />
        </>
      ) : null}
      <div className={`relative z-[1] flex h-full ${ringed ? "rounded-[10px] ring-2 ring-accent/60 ring-offset-2 ring-offset-bg" : ""}`}>
        <BranchPane
          file={node.file}
          tasks={node.tasks}
          isRoot={node.isRoot}
          dormant={dormant}
          onClose={() => onClose(node.file.path)}
          onToggleExpand={() => onExpand(node.file.path)}
        />
      </div>
      {flow ? <RoleTag role="implementer" active={activeLoopRole(flow) === "implementer"} /> : null}
      <FarLabel file={node.file} />
      {/* The handoff handle pinned outside the card's bottom-left corner —
          where child arrows start; a click hangs a draft conversation below. */}
      {onHandoff && canHandoff(node.file) ? <HandoffHandle file={node.file} onHandoff={() => onHandoff(node.file)} /> : null}
      {node.under.length ? (
        <button
          className="absolute -bottom-11 left-1/2 z-[2] inline-flex h-7 -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-panel px-2.5 text-[11px] font-semibold text-dim shadow-card hover:border-accent/40 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-expanded={underOpen}
          title={t("scheme.collapsedTitle")}
          onClick={() => setUnderOpen((value) => !value)}
        >
          <Layers className="h-3.5 w-3.5" aria-hidden />
          {node.under.length} {t("scheme.underneath")}
          <ChevronRight className={`h-3 w-3 transition-transform ${underOpen ? "rotate-90" : ""}`} aria-hidden />
        </button>
      ) : null}
      {underOpen ? (
        <div className="absolute left-0 top-[calc(100%+52px)] z-30 max-h-[280px] w-full overflow-y-auto rounded-[10px] border border-line bg-panel p-1.5 shadow-[0_10px_36px_rgb(20_20_30/0.18)]">
          {node.under.map((file) => (
            <UnderRow key={file.path} file={file} onSelect={onSelect} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A conversation draft as a scheme citizen: positioned like a fresh root node. */
function DraftShell({
  draft,
  project,
  files,
  ringed,
  dimmed,
  onDraftClose,
  onDraftSpawned,
}: {
  draft: DraftNode;
  project: string;
  files: FileEntry[];
  ringed: boolean;
  dimmed: boolean;
  onDraftClose: (id: string) => void;
  onDraftSpawned: (id: string, file: FileEntry) => void;
}) {
  return (
    <div
      data-scheme-node={draft.key}
      className={`scheme-enter absolute${dimClass(dimmed)}`}
      style={{ transform: `translate(${draft.x}px, ${draft.y}px)`, width: draft.w, height: draft.h, transition: MOVE_TRANSITION }}
    >
      <div className={`flex h-full ${ringed ? "rounded-[10px] ring-2 ring-accent/60 ring-offset-2 ring-offset-bg" : ""}`}>
        {isWorkflowDraftId(draft.id) ? (
          <WorkflowDraftPane
            draftId={draft.id}
            project={project}
            onClose={() => onDraftClose(draft.id)}
            onLaunched={() => onDraftClose(draft.id)}
          />
        ) : (
          <DraftAgentPane
            draftId={draft.id}
            project={project}
            files={files}
            onClose={() => onDraftClose(draft.id)}
            onSpawned={(file) => onDraftSpawned(draft.id, file)}
          />
        )}
      </div>
    </div>
  );
}

/** The review deck as a scheme citizen: positioned like a child node. */
function DeckShell({
  deck,
  focus,
  dimmed,
  dormant,
}: {
  deck: DeckNode;
  focus: DeckFocus | null;
  dimmed: boolean;
  dormant: boolean;
}) {
  const focusRound = focus && focus.flowId === deck.flow.id ? focus.round + focus.nonce / 1000 : null;
  return (
    <div
      data-scheme-node={deck.key}
      className={`scheme-enter absolute${dimClass(dimmed)}`}
      style={{ transform: `translate(${deck.x}px, ${deck.y}px)`, width: deck.w, height: deck.h, transition: MOVE_TRANSITION }}
    >
      <RoundDeck flow={deck.flow} rounds={deck.rounds} focusRound={focusRound} dormant={dormant} />
      <RoleTag role="reviewer" active={activeLoopRole(deck.flow) === "reviewer"} />
    </div>
  );
}

export const NodesLayer = memo(function NodesLayer({
  layout,
  project,
  files,
  interactive,
  lite,
  dormant,
  selected,
  multi,
  session,
  focus,
  attentionPaths,
  flowsByImpl,
  deckFocus,
  onSelect,
  onClose,
  onFocusRound,
  onDraftClose,
  onDraftSpawned,
  onHandoff,
  onExpand,
}: {
  layout: SchemeLayout;
  project: string;
  files: FileEntry[];
  interactive: boolean;
  /** Map mode: identity cards instead of live panes (no feeds, no polling). */
  lite: boolean;
  /** Far zoom: live panes keep their DOM but stop polling behind the labels. */
  dormant: boolean;
  selected: string | null;
  /** Selection-session member paths; visuals only change on commit. */
  multi: ReadonlySet<string>;
  /** Session active: members carry checkmarks, everything else dims via CSS. */
  session: boolean;
  focus: string | null;
  /** «Show only needs me»: non-null dims every shell without a queue member.
      Identity is stable while membership is, so camera frames never see it move. */
  attentionPaths: ReadonlySet<string> | null;
  flowsByImpl: Map<string, Flow>;
  deckFocus: DeckFocus | null;
  onSelect: (file: FileEntry) => void;
  onClose: (path: string) => void;
  onFocusRound: (flowId: string, round: number) => void;
  onDraftClose: (id: string) => void;
  onDraftSpawned: (id: string, file: FileEntry) => void;
  onHandoff?: (file: FileEntry) => void;
  /** Opens a conversation as the full-window overlay (desktop panes only). */
  onExpand: (path: string) => void;
}) {
  /* Hosted session nodes take their status dot from the runtime bus's
     session-status events instead of the poll-derived activity (Fable §7).
     Empty while the bus is off, and legacy tmux nodes are skipped, so today's
     derivation is unchanged everywhere the bus does not own the session. */
  const { store, enabled: runtimeEnabled } = useRuntime();
  const runtimeActivityByPath = useMemo(() => {
    const map = new Map<string, Activity>();
    if (!runtimeEnabled) return map;
    for (const s of Object.values(store.sessions)) {
      if (s.hostKind === "tmux-legacy" || !s.artifactPath) continue;
      map.set(s.artifactPath, runtimeActivity(deriveSessionState(s, hasBlockingAttention(store, s))));
    }
    return map;
  }, [store, runtimeEnabled]);
  const withRuntimeActivity = (node: SchemeNode): SchemeNode => {
    const activity = runtimeActivityByPath.get(node.file.path);
    return activity ? { ...node, file: { ...node.file, activity } } : node;
  };

  /* A stack or deck stays lit when any conversation inside it is in the
     queue — a stalled branch may live in a mini stack, and a blocked
     reviewer inside a round deck. */
  const stackDimmed = (stack: MiniStack) =>
    attentionPaths !== null && !stack.items.some((item) => attentionPaths.has(item.file.path));
  const deckDimmed = (deck: DeckNode) =>
    attentionPaths !== null && !deck.rounds.some((round) => round.file && attentionPaths.has(round.file.path));
  return (
    <div
      className={`${interactive ? "" : "pointer-events-none select-none"} ${session ? "scheme-session" : ""}`.trim() || undefined}
    >
      {layout.stacks.map((stack) => (
        <MiniStackShell key={stack.key} stack={stack} dimmed={stackDimmed(stack)} onSelect={onSelect} />
      ))}
      {layout.decks.map((deck) =>
        lite ? (
          <LiteDeckShell key={deck.key} deck={deck} dimmed={deckDimmed(deck)} />
        ) : (
          <DeckShell
            key={deck.key}
            deck={deck}
            focus={deckFocus}
            dimmed={deckDimmed(deck)}
            dormant={dormant}
          />
        ),
      )}
      {layout.drafts.map((draft) =>
        lite ? (
          <LiteDraftShell
            key={draft.key}
            draft={draft}
            ringed={selected === draft.key || focus === draft.key}
            dimmed={attentionPaths !== null}
          />
        ) : (
          <DraftShell
            key={draft.key}
            draft={draft}
            project={project}
            files={files}
            ringed={selected === draft.key || focus === draft.key}
            dimmed={attentionPaths !== null}
            onDraftClose={onDraftClose}
            onDraftSpawned={onDraftSpawned}
          />
        ),
      )}
      {layout.nodes.map((rawNode) => {
        const node = withRuntimeActivity(rawNode);
        return lite ? (
          <LiteNodeShell
            key={node.file.path}
            node={node}
            ringed={selected === node.file.path || focus === node.file.path}
            dimmed={attentionPaths !== null && !attentionPaths.has(node.file.path)}
            flow={flowsByImpl.get(node.file.path) ?? null}
          />
        ) : (
          <NodeShell
            key={node.file.path}
            node={node}
            ringed={session ? multi.has(node.file.path) : selected === node.file.path || focus === node.file.path}
            marked={session && multi.has(node.file.path)}
            dimmed={attentionPaths !== null && !attentionPaths.has(node.file.path)}
            dormant={dormant}
            flow={flowsByImpl.get(node.file.path) ?? null}
            canFlow={canStartFlow(node.file, flowsByImpl)}
            onSelect={onSelect}
            onClose={onClose}
            onFocusRound={onFocusRound}
            onHandoff={onHandoff}
            onExpand={onExpand}
          />
        );
      })}
    </div>
  );
});
