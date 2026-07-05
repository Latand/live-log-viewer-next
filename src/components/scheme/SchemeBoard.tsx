"use client";

import { Hand, Layers, Maximize2, Minus, MousePointer2, Plus } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChevronRight } from "@/components/icons";
import type { Flow } from "@/lib/flows/types";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { BranchPane, kindLabel } from "@/components/BranchPane";
import { DraftAgentPane } from "@/components/DraftAgentPane";
import { FlowDialog } from "@/components/flows/FlowDialog";
import {
  activeLoopLeg,
  activeLoopRole,
  ATTENTION_STATES,
  BUSY_FLOW_STATES,
  canStartFlow,
  flowByImplementer,
  VERDICT_GLYPHS,
  verdictTone,
} from "@/components/flows/flowModel";
import { FlowStrip } from "@/components/flows/FlowStrip";
import { RoleTag } from "@/components/flows/RoleTag";
import { RoundDeck } from "@/components/flows/RoundDeck";
import { canHandoff, HandoffHandle } from "@/components/HandoffHandle";
import type { BranchGroup } from "@/components/projectModel";
import { activityDot, cleanTitle, engineBadge, engineEdge, fmtAge } from "@/components/utils";

import {
  buildSchemeLayout,
  LOOP_GAP,
  NODE_W,
  stackItemAt,
  type DeckNode,
  type DraftNode,
  type FlowLoop,
  type MiniStack,
  type SchemeEdge,
  type SchemeLayout,
  type SchemeNode,
  type SchemeRect,
} from "./layout";
import { type Camera, Minimap } from "./Minimap";

const MIN_Z = 0.12;
const MAX_Z = 1.6;
/* At least this much of the world stays inside the viewport when panning. */
const EDGE_KEEP = 120;
/* Below this zoom the big node labels fade in over the unreadable panes. */
const LABEL_Z = 0.45;
/* Layout reshuffles glide instead of jumping. */
const MOVE_MS = 380;
const MOVE_EASE = `cubic-bezier(.22,.8,.36,1)`;
const MOVE_TRANSITION = `transform ${MOVE_MS}ms ${MOVE_EASE}`;

const MODE_KEY = "llvSchemeMode";

type Mode = "hand" | "select";

interface Props {
  project: string;
  groups: BranchGroup[];
  manual: FileEntry[];
  files: FileEntry[];
  flows: Flow[];
  /** Ids of not-yet-spawned conversation drafts drawn as full panes. */
  drafts: string[];
  /** Path to glide the camera to and ring briefly (set by openers). */
  focus: string | null;
  /** Path to ring without moving the camera, used by the mobile full-map overlay. */
  ring?: string | null;
  onSelect: (file: FileEntry) => void;
  /** Optional map-mode node pick handler; receives the selected node key. */
  onNodePick?: (key: string) => void;
  onClose: (path: string) => void;
  onDraftClose: (id: string) => void;
  /** A draft's agent booted and its transcript arrived: open it as a real node. */
  onDraftSpawned: (id: string, file: FileEntry) => void;
  /** The handoff handle under a pane: drop a draft that continues this
      conversation. Absent in map mode — the handle stays hidden there. */
  onHandoff?: (file: FileEntry) => void;
}

/** Round-chip click on a strip, delivered to that flow's deck. */
interface DeckFocus {
  flowId: string;
  round: number;
  nonce: number;
}

/* Geometry animated via CSS (style-level `d`/`cx`/`cy` with transitions), the
   attribute stays as the fallback for engines without SVG geometry props. */
const EdgesLayer = memo(function EdgesLayer({ edges, width, height }: { edges: SchemeEdge[]; width: number; height: number }) {
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
const LoopsLayer = memo(function LoopsLayer({ loops, width, height }: { loops: FlowLoop[]; width: number; height: number }) {
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
        }, ${loop.x2 - 7} ${yTop}`;
        const back = `M ${loop.x2} ${yBot} C ${loop.x2 - LOOP_REACH} ${yBot + LOOP_BULGE}, ${loop.x1 + LOOP_REACH} ${
          yBot + LOOP_BULGE
        }, ${loop.x1 + 7} ${yBot}`;
        const forwardHead = `M ${loop.x2 - 9} ${yTop - 5} L ${loop.x2 - 9} ${yTop + 5} L ${loop.x2 - 1} ${yTop} Z`;
        const backHead = `M ${loop.x1 + 9} ${yBot - 5} L ${loop.x1 + 9} ${yBot + 5} L ${loop.x1 + 1} ${yBot} Z`;
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

/* The flow strip spans the whole implementer↔reviewer pair, not just the
   implementer's card — it is the loop's shared header. */
const PAIR_W = NODE_W * 2 + LOOP_GAP;

/* Map mode (the phone's full-screen overlay) draws every conversation as a
   static identity card. A full pane per node would run a polling LogFeed and
   hold thousands of transcript lines each — multiplied across the project it
   exceeds the mobile tab's memory budget and iOS kills the renderer. The card
   carries what a pick decision needs; the transcript opens after the pick. */
function LiteNodeShell({ node, ringed, flow }: { node: SchemeNode; ringed: boolean; flow: Flow | null }) {
  const { t } = useLocale();
  const badge = engineBadge(node.file);
  return (
    <div
      data-scheme-node={node.file.path}
      className="scheme-enter absolute"
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
        className={`relative z-[1] flex h-full min-w-0 flex-col overflow-hidden rounded-[10px] border border-t-4 bg-panel shadow-card ${
          ringed ? "ring-2 ring-accent/60 ring-offset-2 ring-offset-bg" : ""
        }`}
        style={engineEdge(node.file)}
      >
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
function LiteDraftShell({ draft, ringed }: { draft: DraftNode; ringed: boolean }) {
  const { t } = useLocale();
  return (
    <div
      data-scheme-node={draft.key}
      className="scheme-enter absolute"
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
function LiteDeckShell({ deck }: { deck: DeckNode }) {
  const { t } = useLocale();
  const latest = deck.rounds.at(-1) ?? null;
  const round = latest?.round ?? null;
  const tone = verdictTone(round?.verdict ?? null);
  return (
    <div
      data-scheme-node={deck.key}
      className="scheme-enter absolute"
      style={{ transform: `translate(${deck.x}px, ${deck.y}px)`, width: deck.w, height: deck.h, transition: MOVE_TRANSITION }}
    >
      <div className="flex h-full flex-col overflow-hidden rounded-[10px] border border-line bg-panel shadow-card">
        {round ? (
          <>
            <div
              className="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-2.5"
              style={{ backgroundColor: tone.soft, color: tone.color }}
            >
              <span className="shrink-0 text-[12px] font-bold">
                R{round.n} {round.verdict ? VERDICT_GLYPHS[round.verdict] : round.error ? "!" : "⏳"}
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
function MiniStackShell({ stack, onSelect }: { stack: MiniStack; onSelect: (file: FileEntry) => void }) {
  const { t } = useLocale();
  return (
    <div
      data-scheme-node={stack.key}
      className="scheme-enter absolute"
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
  files,
  ringed,
  flow,
  canFlow,
  onSelect,
  onClose,
  onFocusRound,
  onHandoff,
}: {
  node: SchemeNode;
  files: FileEntry[];
  ringed: boolean;
  /** Active review-loop flow attached to this conversation, if any. */
  flow: Flow | null;
  /** This node may host a new flow (root claude/codex conversation without one). */
  canFlow: boolean;
  onSelect: (file: FileEntry) => void;
  onClose: (path: string) => void;
  onFocusRound: (flowId: string, round: number) => void;
  onHandoff?: (file: FileEntry) => void;
}) {
  const { t } = useLocale();
  const [underOpen, setUnderOpen] = useState(false);
  const [flowOpen, setFlowOpen] = useState(false);
  return (
    <div
      data-scheme-node={node.file.path}
      className={`scheme-enter absolute ${underOpen || flowOpen ? "z-20" : ""}`}
      style={{ transform: `translate(${node.x}px, ${node.y}px)`, width: node.w, height: node.h, transition: MOVE_TRANSITION }}
    >
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
          files={files}
          onSelect={onSelect}
          isRoot={node.isRoot}
          onClose={() => onClose(node.file.path)}
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
  onDraftClose,
  onDraftSpawned,
}: {
  draft: DraftNode;
  project: string;
  files: FileEntry[];
  ringed: boolean;
  onDraftClose: (id: string) => void;
  onDraftSpawned: (id: string, file: FileEntry) => void;
}) {
  return (
    <div
      data-scheme-node={draft.key}
      className="scheme-enter absolute"
      style={{ transform: `translate(${draft.x}px, ${draft.y}px)`, width: draft.w, height: draft.h, transition: MOVE_TRANSITION }}
    >
      <div className={`flex h-full ${ringed ? "rounded-[10px] ring-2 ring-accent/60 ring-offset-2 ring-offset-bg" : ""}`}>
        <DraftAgentPane
          draftId={draft.id}
          project={project}
          files={files}
          onClose={() => onDraftClose(draft.id)}
          onSpawned={(file) => onDraftSpawned(draft.id, file)}
        />
      </div>
    </div>
  );
}

/** The review deck as a scheme citizen: positioned like a child node. */
function DeckShell({
  deck,
  files,
  focus,
  onSelect,
}: {
  deck: DeckNode;
  files: FileEntry[];
  focus: DeckFocus | null;
  onSelect: (file: FileEntry) => void;
}) {
  const focusRound = focus && focus.flowId === deck.flow.id ? focus.round + focus.nonce / 1000 : null;
  return (
    <div
      data-scheme-node={deck.key}
      className="scheme-enter absolute"
      style={{ transform: `translate(${deck.x}px, ${deck.y}px)`, width: deck.w, height: deck.h, transition: MOVE_TRANSITION }}
    >
      <RoundDeck flow={deck.flow} rounds={deck.rounds} files={files} onSelect={onSelect} focusRound={focusRound} />
      <RoleTag role="reviewer" active={activeLoopRole(deck.flow) === "reviewer"} />
    </div>
  );
}

const NodesLayer = memo(function NodesLayer({
  layout,
  project,
  files,
  interactive,
  lite,
  selected,
  focus,
  flowsByImpl,
  deckFocus,
  onSelect,
  onClose,
  onFocusRound,
  onDraftClose,
  onDraftSpawned,
  onHandoff,
}: {
  layout: SchemeLayout;
  project: string;
  files: FileEntry[];
  interactive: boolean;
  /** Map mode: identity cards instead of live panes (no feeds, no polling). */
  lite: boolean;
  selected: string | null;
  focus: string | null;
  flowsByImpl: Map<string, Flow>;
  deckFocus: DeckFocus | null;
  onSelect: (file: FileEntry) => void;
  onClose: (path: string) => void;
  onFocusRound: (flowId: string, round: number) => void;
  onDraftClose: (id: string) => void;
  onDraftSpawned: (id: string, file: FileEntry) => void;
  onHandoff?: (file: FileEntry) => void;
}) {
  return (
    <div className={interactive ? undefined : "pointer-events-none select-none"}>
      {layout.stacks.map((stack) => (
        <MiniStackShell key={stack.key} stack={stack} onSelect={onSelect} />
      ))}
      {layout.decks.map((deck) =>
        lite ? (
          <LiteDeckShell key={deck.key} deck={deck} />
        ) : (
          <DeckShell key={deck.key} deck={deck} files={files} focus={deckFocus} onSelect={onSelect} />
        ),
      )}
      {layout.drafts.map((draft) =>
        lite ? (
          <LiteDraftShell key={draft.key} draft={draft} ringed={selected === draft.key || focus === draft.key} />
        ) : (
          <DraftShell
            key={draft.key}
            draft={draft}
            project={project}
            files={files}
            ringed={selected === draft.key || focus === draft.key}
            onDraftClose={onDraftClose}
            onDraftSpawned={onDraftSpawned}
          />
        ),
      )}
      {layout.nodes.map((node) =>
        lite ? (
          <LiteNodeShell
            key={node.file.path}
            node={node}
            ringed={selected === node.file.path || focus === node.file.path}
            flow={flowsByImpl.get(node.file.path) ?? null}
          />
        ) : (
          <NodeShell
            key={node.file.path}
            node={node}
            files={files}
            ringed={selected === node.file.path || focus === node.file.path}
            flow={flowsByImpl.get(node.file.path) ?? null}
            canFlow={canStartFlow(node.file, flowsByImpl)}
            onSelect={onSelect}
            onClose={onClose}
            onFocusRound={onFocusRound}
            onHandoff={onHandoff}
          />
        ),
      )}
    </div>
  );
});

function ToolButton({
  active,
  title,
  onClick,
  children,
}: {
  active?: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`inline-flex h-7 w-7 items-center justify-center rounded-[8px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        active ? "bg-accent/10 text-accent" : "text-dim hover:bg-bg hover:text-ink"
      }`}
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The scheme canvas — the only presentation of a project: conversations as
 * positioned cards on a pannable, zoomable world. Subagents sit below their
 * parent with bezier arrows, quiet branches hang as mini-card stacks, quiet
 * history lies under each card as a deck. Navigation: hand/select modes,
 * wheel pan, ctrl+wheel and pinch zoom, double-click to fit or focus, and a
 * minimap. The camera never re-renders panes: node/edge layers are memoized
 * and far-zoom labels scale through CSS vars.
 */
export function SchemeBoard({
  project,
  groups,
  manual,
  files,
  flows,
  drafts,
  focus,
  ring,
  onSelect,
  onNodePick,
  onClose,
  onDraftClose,
  onDraftSpawned,
  onHandoff,
}: Props) {
  const { t } = useLocale();
  const mapMode = Boolean(onNodePick);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const tapRef = useRef<{ x: number; y: number } | null>(null);
  const [cam, setCam] = useState<Camera>({ x: 0, y: 0, z: 0.5 });
  const [mode, setModeState] = useState<Mode>("select");
  const [spacePan, setSpacePan] = useState(false);
  const [panning, setPanning] = useState(false);
  const [glide, setGlide] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [vp, setVp] = useState({ w: 1, h: 1 });
  const panRef = useRef<{ sx: number; sy: number; cx: number; cy: number } | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ d: number; cx: number; cy: number } | null>(null);
  const modeRef = useRef<Mode>(mode);
  const spaceRef = useRef(spacePan);
  const glideTimer = useRef<number | null>(null);
  const initedFor = useRef<string | null>(null);
  const focusHandled = useRef<string | null>(null);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    spaceRef.current = spacePan;
  }, [spacePan]);

  /* Saved tool wins; a touch-first device without a saved tool starts on the
     hand — panes are still fully usable after an explicit switch to select. */
  useEffect(() => {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === "hand" || saved === "select") {
      /* eslint-disable-next-line react-hooks/set-state-in-effect */
      setModeState(saved);
      return;
    }
    if (window.matchMedia("(pointer: coarse)").matches) {
       
      setModeState("hand");
    }
  }, []);
  const setMode = useCallback((next: Mode) => {
    setModeState(next);
    localStorage.setItem(MODE_KEY, next);
  }, []);

  const layout = useMemo(() => buildSchemeLayout(groups, manual, files, flows, drafts), [groups, manual, files, flows, drafts]);
  const flowsByImpl = useMemo(() => flowByImplementer(flows), [flows]);
  const [deckFocus, setDeckFocus] = useState<DeckFocus | null>(null);
  const focusRound = useCallback((flowId: string, round: number) => {
    setDeckFocus((prev) => ({ flowId, round, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  const visualFocus = ring ?? focus;

  /* Handlers passed into the memoized nodes layer must stay identity-stable,
     otherwise every camera frame re-renders every pane. */
  const selectRef = useRef(onSelect);
  const nodePickRef = useRef(onNodePick);
  const closeRef = useRef(onClose);
  const draftCloseRef = useRef(onDraftClose);
  const draftSpawnedRef = useRef(onDraftSpawned);
  const handoffRef = useRef(onHandoff);
  useEffect(() => {
    selectRef.current = onSelect;
    nodePickRef.current = onNodePick;
    closeRef.current = onClose;
    draftCloseRef.current = onDraftClose;
    draftSpawnedRef.current = onDraftSpawned;
    handoffRef.current = onHandoff;
  });
  const stableSelect = useCallback((file: FileEntry) => {
    const nodePick = nodePickRef.current;
    if (nodePick) {
      nodePick(file.path);
      return;
    }
    selectRef.current(file);
  }, []);
  const stableClose = useCallback((path: string) => closeRef.current(path), []);
  const stableDraftClose = useCallback((id: string) => draftCloseRef.current(id), []);
  const stableDraftSpawned = useCallback((id: string, file: FileEntry) => draftSpawnedRef.current(id, file), []);
  const stableHandoff = useCallback((file: FileEntry) => handoffRef.current?.(file), []);
  /* The handle renders only when the opener wired a handler (not in map mode). */
  const handoffForNodes = onHandoff ? stableHandoff : undefined;

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      setVp({ w: Math.max(1, rect.width), h: Math.max(1, rect.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* The world can never be thrown fully off-screen: a strip of it always
     stays visible, so there is no "lost the canvas" state to recover from. */
  const clampCam = useCallback(
    (c: Camera): Camera => {
      const x = Math.min(Math.max(c.x, EDGE_KEEP - layout.width * c.z), vp.w - EDGE_KEEP);
      const y = Math.min(Math.max(c.y, EDGE_KEEP - layout.height * c.z), vp.h - EDGE_KEEP);
      return x === c.x && y === c.y ? c : { ...c, x, y };
    },
    [layout.width, layout.height, vp],
  );

  /* High-rate gestures (wheel, pointermove, pinch) coalesce into one camera
     update per frame: updater functions queue up and compose inside a single
     rAF, so deltas are never lost but React renders at most once per frame. */
  const camQueue = useRef<((c: Camera) => Camera)[]>([]);
  const camRaf = useRef<number | null>(null);
  const queueCam = useCallback((fn: (c: Camera) => Camera) => {
    camQueue.current.push(fn);
    if (camRaf.current != null) return;
    camRaf.current = requestAnimationFrame(() => {
      camRaf.current = null;
      const fns = camQueue.current;
      camQueue.current = [];
      setCam((c) => fns.reduce((acc, apply) => apply(acc), c));
    });
  }, []);
  useEffect(
    () => () => {
      if (camRaf.current != null) cancelAnimationFrame(camRaf.current);
    },
    [],
  );

  const applyZoom = useCallback(
    (cx: number, cy: number, factor: number) => {
      queueCam((c) => {
        const z = Math.min(MAX_Z, Math.max(MIN_Z, c.z * factor));
        if (z === c.z) return c;
        const k = z / c.z;
        return clampCam({ z, x: cx - (cx - c.x) * k, y: cy - (cy - c.y) * k });
      });
    },
    [clampCam, queueCam],
  );

  const zoomCenter = useCallback(
    (factor: number) => {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (rect) applyZoom(rect.width / 2, rect.height / 2, factor);
    },
    [applyZoom],
  );

  /* Absolute zoom around the viewport center (the % button, the "1" key). */
  const zoomTo = useCallback(
    (targetZ: number) => {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      setCam((c) => {
        const z = Math.min(MAX_Z, Math.max(MIN_Z, targetZ));
        if (z === c.z) return c;
        const k = z / c.z;
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        return clampCam({ z, x: cx - (cx - c.x) * k, y: cy - (cy - c.y) * k });
      });
    },
    [clampCam],
  );

  const fitCam = useCallback((): Camera | null => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect || (!layout.nodes.length && !layout.drafts.length)) return null;
    const z = Math.min(MAX_Z, Math.max(MIN_Z, Math.min((rect.width - 48) / layout.width, (rect.height - 48) / layout.height, 1)));
    return { z, x: (rect.width - layout.width * z) / 2, y: (rect.height - layout.height * z) / 2 };
  }, [layout]);

  const glideTo = useCallback((next: Camera | ((c: Camera) => Camera)) => {
    setGlide(true);
    setCam(next);
    if (glideTimer.current) window.clearTimeout(glideTimer.current);
    glideTimer.current = window.setTimeout(() => setGlide(false), 500);
  }, []);
  useEffect(
    () => () => {
      if (glideTimer.current) window.clearTimeout(glideTimer.current);
    },
    [],
  );

  const fit = useCallback(() => {
    const c = fitCam();
    if (c) glideTo(c);
  }, [fitCam, glideTo]);

  /* Glide a node into view: centered horizontally, its head near the top so
     a tall pane starts readable instead of vertically split. */
  const centerOn = useCallback(
    (node: SchemeRect, zMin: number) => {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      glideTo((c) => {
        const z = Math.min(MAX_Z, Math.max(c.z, zMin));
        return {
          z,
          x: rect.width / 2 - (node.x + node.w / 2) * z,
          y: Math.min(rect.height / 2 - node.y * z, rect.height * 0.08 - (node.y - 40) * z),
        };
      });
    },
    [glideTo],
  );

  /* First layout of a project: restore the saved camera or fit everything.
     The map always opens fitted — its job is the whole picture. */
  useEffect(() => {
    if (initedFor.current === project || (!layout.nodes.length && !layout.drafts.length)) return;
    initedFor.current = project;
    if (!mapMode) {
      try {
        const raw = sessionStorage.getItem("llvCam:" + project);
        if (raw) {
          const saved = JSON.parse(raw) as Camera;
          if (Number.isFinite(saved.x) && Number.isFinite(saved.y) && Number.isFinite(saved.z) && saved.z >= MIN_Z && saved.z <= MAX_Z) {
            /* eslint-disable-next-line react-hooks/set-state-in-effect */
            setCam(saved);
            return;
          }
        }
      } catch {
        /* corrupt saved camera — fall through to fit */
      }
    }
    const c = fitCam();
    if (c) {

      setCam(c);
    }
  }, [project, layout, fitCam, mapMode]);

  /* Debounced: a pan produces hundreds of camera frames, storage needs only
     the resting position. The map never writes — the desktop camera survives. */
  useEffect(() => {
    if (mapMode || initedFor.current !== project) return;
    const t = window.setTimeout(() => sessionStorage.setItem("llvCam:" + project, JSON.stringify(cam)), 300);
    return () => window.clearTimeout(t);
  }, [cam, project, mapMode]);

  /* An opened conversation glides into view once its node exists in the layout. */
  useEffect(() => {
    if (!focus) {
      focusHandled.current = null;
      return;
    }
    if (focusHandled.current === focus) return;
    const node = layout.byPath.get(focus);
    if (!node) return;
    focusHandled.current = focus;
    centerOn(node, 0.55);
  }, [focus, layout, centerOn]);

  /* Wheel: plain — pan (shift turns it horizontal); ctrl/cmd (and trackpad
     pinch) — zoom at the cursor. In select mode a wheel over a scrollable
     feed keeps native scrolling. */
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest("[data-scheme-ui]")) return;
      const rect = el.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        applyZoom(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * 0.0022));
        return;
      }
      if (modeRef.current === "select" && !spaceRef.current) {
        for (let node = event.target as HTMLElement | null; node && node !== el; node = node.parentElement) {
          if (node.scrollHeight > node.clientHeight + 1) {
            const overflowY = getComputedStyle(node).overflowY;
            if (overflowY === "auto" || overflowY === "scroll") return;
          }
        }
      }
      event.preventDefault();
      const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
      const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
      queueCam((c) => clampCam({ ...c, x: c.x - dx, y: c.y - dy }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyZoom, clampCam, queueCam]);

  /* Keyboard: H/V tools, Space-hold temporary hand, +/−/1 zoom, 0 fit,
     arrows pan, Esc drops the selection. */
  useEffect(() => {
    const typing = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el || !el.tagName) return false;
      return ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(el.tagName) || el.isContentEditable;
    };
    const onDown = (event: KeyboardEvent) => {
      if (typing(event.target)) return;
      if (event.key === " ") {
        event.preventDefault();
        if (!event.repeat) setSpacePan(true);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "h" || event.key === "H") setMode("hand");
      else if (event.key === "v" || event.key === "V") setMode("select");
      else if (event.key === "Escape") setSelected(null);
      else if (event.key === "0") fit();
      else if (event.key === "1") zoomTo(1);
      else if (event.key === "+" || event.key === "=") zoomCenter(1.25);
      else if (event.key === "-") zoomCenter(0.8);
      else if (event.key.startsWith("Arrow")) {
        event.preventDefault();
        const step = 160;
        const dx = event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0;
        const dy = event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
        setCam((c) => clampCam({ ...c, x: c.x + dx, y: c.y + dy }));
      }
    };
    const onUp = (event: KeyboardEvent) => {
      if (event.key === " ") setSpacePan(false);
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, [fit, zoomCenter, zoomTo, setMode, clampCam]);

  const localPoint = (event: { clientX: number; clientY: number }) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: event.clientX, y: event.clientY };
  };

  const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
    panRef.current = { sx: event.clientX, sy: event.clientY, cx: cam.x, cy: cam.y };
    setPanning(true);
    try {
      viewportRef.current?.setPointerCapture(event.pointerId);
    } catch {
      /* pointer already gone — pan still tracks via move events */
    }
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-scheme-ui]")) return;
    /* Map mode: remember where the press started, the click handler turns a
       stationary press into a node pick. */
    if (mapMode && event.isPrimary) tapRef.current = { x: event.clientX, y: event.clientY };
    /* Second finger anywhere turns the gesture into a pinch. */
    if (event.pointerType === "touch") {
      pointersRef.current.set(event.pointerId, localPoint(event));
      if (pointersRef.current.size === 2) {
        const [a, b] = [...pointersRef.current.values()];
        pinchRef.current = { d: dist(a!, b!), cx: (a!.x + b!.x) / 2, cy: (a!.y + b!.y) / 2 };
        panRef.current = null;
        setPanning(false);
        return;
      }
    }
    if (event.button === 1) {
      event.preventDefault();
      startPan(event);
      return;
    }
    if (event.button !== 0) return;
    const handLike = mapMode || mode === "hand" || spacePan;
    if (!handLike) {
      const nodeEl = target.closest("[data-scheme-node]");
      if (nodeEl) {
        setSelected(nodeEl.getAttribute("data-scheme-node"));
        return;
      }
      setSelected(null);
      if (target.closest("button, a, input, textarea, select")) return;
    }
    startPan(event);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch" && pointersRef.current.has(event.pointerId)) {
      pointersRef.current.set(event.pointerId, localPoint(event));
      const pinch = pinchRef.current;
      if (pinch && pointersRef.current.size >= 2) {
        const [a, b] = [...pointersRef.current.values()];
        const d = dist(a!, b!);
        const cx = (a!.x + b!.x) / 2;
        const cy = (a!.y + b!.y) / 2;
        const factor = pinch.d > 0 ? d / pinch.d : 1;
        queueCam((c) => {
          const z = Math.min(MAX_Z, Math.max(MIN_Z, c.z * factor));
          const k = z / c.z;
          return clampCam({ z, x: cx - (pinch.cx - c.x) * k, y: cy - (pinch.cy - c.y) * k });
        });
        pinchRef.current = { d, cx, cy };
        return;
      }
    }
    const pan = panRef.current;
    if (!pan) return;
    const dx = event.clientX - pan.sx;
    const dy = event.clientY - pan.sy;
    queueCam((c) => clampCam({ ...c, x: pan.cx + dx, y: pan.cy + dy }));
  };

  /* Gestures end on window-level listeners: a pointerup outside the viewport
     (or one React's delegation misses) must never leave the camera glued to
     the cursor. Implicit capture release handles the capture itself. */
  useEffect(() => {
    const end = (event: PointerEvent) => {
      pointersRef.current.delete(event.pointerId);
      if (pointersRef.current.size < 2) pinchRef.current = null;
      panRef.current = null;
      setPanning(false);
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, []);

  /* Double-click: empty canvas fits everything; a node in hand mode zooms in
     on that conversation (in select mode double-click keeps selecting text). */
  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-scheme-ui]")) return;
    const nodeEl = target.closest("[data-scheme-node]");
    if (!nodeEl) {
      fit();
      return;
    }
    if (mode !== "hand" && !spacePan) return;
    const node = layout.byPath.get(nodeEl.getAttribute("data-scheme-node") ?? "");
    if (node) centerOn(node, 0.9);
  };

  const handLike = mapMode || mode === "hand" || spacePan;

  /* World-coordinate hit test: with panes non-interactive on the map, a tap
     resolves against the layout geometry instead of the DOM. */
  const pickAt = (wx: number, wy: number): string | null => {
    const hit = (r: SchemeRect) => wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h;
    for (const node of layout.nodes) if (hit(node)) return node.file.path;
    for (const draft of layout.drafts) if (hit(draft)) return draft.key;
    for (const stack of layout.stacks) {
      if (hit(stack)) return stackItemAt(stack, wy)?.path ?? null;
    }
    for (const deck of layout.decks) {
      if (!hit(deck)) continue;
      return deck.key;
    }
    return null;
  };

  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onNodePick) return;
    const start = tapRef.current;
    tapRef.current = null;
    if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 9) return;
    if ((event.target as HTMLElement).closest("[data-scheme-ui]")) return;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const key = pickAt((event.clientX - rect.left - cam.x) / cam.z, (event.clientY - rect.top - cam.y) / cam.z);
    if (key) onNodePick(key);
  };

  const jump = useCallback(
    (wx: number, wy: number) => setCam((c) => clampCam({ ...c, x: vp.w / 2 - wx * c.z, y: vp.h / 2 - wy * c.z })),
    [vp, clampCam],
  );

  const tile = 24 * cam.z;

  return (
    <div
      ref={viewportRef}
      className={`relative min-h-0 flex-1 overflow-hidden ${
        panning ? "cursor-grabbing select-none" : handLike ? "cursor-grab" : ""
      } ${handLike ? "touch-none" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onDoubleClick={onDoubleClick}
      onClick={onClick}
    >
      {/* Dot grid on its own composited layer: panning moves it with a
          transform (modulo one tile) instead of repainting the viewport
          background every frame. */}
      <div
        aria-hidden
        className="pointer-events-none absolute"
        style={{
          inset: -tile,
          backgroundImage: "radial-gradient(rgba(28,28,34,0.09) 1px, transparent 1px)",
          backgroundSize: `${tile}px ${tile}px`,
          transform: `translate(${((cam.x % tile) + tile) % tile}px, ${((cam.y % tile) + tile) % tile}px)`,
          willChange: "transform",
        }}
      />
      <div
        key={project}
        className={`absolute left-0 top-0 ${panning ? "scheme-panning" : ""}`}
        style={
          {
            width: layout.width,
            height: layout.height,
            transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`,
            transformOrigin: "0 0",
            transition: glide ? `transform .45s ${MOVE_EASE}` : undefined,
            willChange: "transform",
            "--inv-z": String(1 / cam.z),
            "--label-o": cam.z < LABEL_Z ? "1" : "0",
          } as React.CSSProperties
        }
      >
        <EdgesLayer edges={layout.edges} width={layout.width} height={layout.height} />
        <LoopsLayer loops={layout.loops} width={layout.width} height={layout.height} />
        <NodesLayer
          layout={layout}
          project={project}
          files={files}
          interactive={!handLike}
          lite={mapMode}
          selected={selected}
          focus={visualFocus}
          flowsByImpl={flowsByImpl}
          deckFocus={deckFocus}
          onSelect={stableSelect}
          onClose={stableClose}
          onFocusRound={focusRound}
          onDraftClose={stableDraftClose}
          onDraftSpawned={stableDraftSpawned}
          onHandoff={handoffForNodes}
        />
      </div>

      <div data-scheme-ui className="absolute left-3 top-3 z-40 flex items-center gap-1 rounded-[10px] border border-line bg-panel/95 p-1 shadow-card">
        {mapMode ? null : (
          <>
            <ToolButton active={handLike} title={t("scheme.handTool")} onClick={() => setMode("hand")}>
              <Hand className="h-4 w-4" aria-hidden />
            </ToolButton>
            <ToolButton active={!handLike} title={t("scheme.selectTool")} onClick={() => setMode("select")}>
              <MousePointer2 className="h-4 w-4" aria-hidden />
            </ToolButton>
            <div className="mx-0.5 h-5 w-px bg-line" aria-hidden />
          </>
        )}
        <ToolButton title={t("scheme.zoomOut")} onClick={() => zoomCenter(0.8)}>
          <Minus className="h-4 w-4" aria-hidden />
        </ToolButton>
        <button
          className="min-w-[46px] rounded-[8px] px-1 text-center text-[11px] font-semibold text-dim hover:bg-bg hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          title={t("scheme.zoom100")}
          onClick={() => zoomTo(1)}
        >
          {Math.round(cam.z * 100)}%
        </button>
        <ToolButton title={t("scheme.zoomIn")} onClick={() => zoomCenter(1.25)}>
          <Plus className="h-4 w-4" aria-hidden />
        </ToolButton>
        <ToolButton title={t("scheme.fit")} onClick={fit}>
          <Maximize2 className="h-4 w-4" aria-hidden />
        </ToolButton>
      </div>

      <Minimap layout={layout} cam={cam} vp={vp} onJump={jump} />
    </div>
  );
}
