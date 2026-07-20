"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { useCoarsePointer } from "@/hooks/useCoarsePointer";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";

import type { SchemeRect } from "./layout";
import type { Camera } from "./Minimap";
import { offscreenClusterChips, overflowListStyle, resolveOverflowPlacement, type BoardCluster, type ChipEdge, type ClusterChip } from "./offscreenClusters";

const transformFor = (edge: ChipEdge): string => {
  if (edge === "right") return "translate(-100%, -50%)";
  if (edge === "left") return "translate(0, -50%)";
  if (edge === "bottom") return "translate(-50%, -100%)";
  return "translate(-50%, 0)";
};

const arrowFor = (edge: ChipEdge): string =>
  edge === "right" ? "→" : edge === "left" ? "←" : edge === "bottom" ? "↓" : "↑";

/* Resting title width and the width added per reveal segment. The direction
   control lives in its own reserved, non-shrinking box, so the label starts
   truncated at REVEAL_BASE_PX and grows in bounded steps — never sliding under
   the arrow and never jumping the chip out from under the pointer. */
const REVEAL_BASE_PX = 120;
const REVEAL_STEP_PX = 72;
/* How close (px) the pointer must come to the title's truncated end to unfurl
   the next segment. */
const END_THRESHOLD_PX = 18;
/* Safety ceiling so a mis-measured overflow can never spin the reveal forever;
   a 48/60-char label needs far fewer steps than this to finish. */
const MAX_STEP = 24;

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Non-text chrome reserved inside a chip pill, added to the measured label width
   to get the full outer width: the direction control box (color dot + arrow),
   the gaps around it, the horizontal padding (px-3) and the border. Kept a touch
   generous so a measured label is reserved *at least* its true footprint — the
   chip folds a hair early rather than admitting a title it would then truncate. */
const CHIP_CHROME_PX = 68;

/* A canvas-backed measurer for the chip's rendered label width (bold 11px in the
   board's font). offscreenClusterChips reserves this *measured* width, so an
   exact 48/60-character wide-glyph title — whose real width exceeds the latin
   band CHIP_MAX_W assumes — is admitted only when it truly fits at its anchor
   and otherwise folds into «+N» instead of truncating forever (issue #474). Falls
   back to a per-character estimate wherever a 2D canvas is unavailable (SSR, or a
   headless DOM without canvas). */
function useChipMeasure(): (label: string) => number {
  return useMemo(() => {
    let ctx: { measureText: (text: string) => { width: number } } | null = null;
    if (typeof document !== "undefined") {
      try {
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (context && typeof context.measureText === "function") {
          const family = (typeof getComputedStyle === "function" && document.body
            ? getComputedStyle(document.body).fontFamily
            : "") || "system-ui, sans-serif";
          context.font = `700 11px ${family}`;
          // happy-dom returns a zero-width stub; only trust a real measurement.
          if (context.measureText("MMMMM").width > 0) ctx = context;
        }
      } catch {
        ctx = null;
      }
    }
    return (label: string): number => {
      const text = ctx ? ctx.measureText(label).width : label.length * 7;
      return Math.ceil(text) + CHIP_CHROME_PX;
    };
  }, []);
}

/* Desktop chip with a progressive hover reveal. The chip button is the whole
   hover/focus surface — the label unfurls inside it, so moving from the arrow
   onto freshly revealed text never crosses a gap that would drop hover. Each
   pointer move that reaches the current truncated end lets one more segment
   through until the full title shows; keyboard focus reveals it all at once
   (a keyboard can't "reach the end"), and reduced motion swaps the animated
   stepping for a single settled reveal on hover. The pill's outer width is
   capped at the same measured, viewport-clamped budget the collision geometry
   reserved (chip.revealWidth), so a full reveal can never spill past a viewport
   edge. */
function ChipButton({ chip, onFit }: {
  chip: ClusterChip;
  onFit: (rect: SchemeRect) => void;
}) {
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const [step, setStep] = useState(0);
  const [focused, setFocused] = useState(false);
  const [motionReveal, setMotionReveal] = useState(false);
  const full = focused || motionReveal;
  const budget = chip.revealWidth;

  const advanceOnMove = (clientX: number) => {
    if (full || prefersReducedMotion()) return;
    const el = titleRef.current;
    if (!el) return;
    const overflowing = el.scrollWidth - el.clientWidth > 1;
    if (!overflowing) return;
    if (clientX >= el.getBoundingClientRect().right - END_THRESHOLD_PX) {
      setStep((current) => Math.min(current + 1, MAX_STEP));
    }
  };

  return (
    <button
      type="button"
      data-edge-chip={chip.cluster.key}
      className="pointer-events-auto absolute inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border bg-card/95 px-3 text-[11px] font-bold text-primary shadow-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      style={{ left: chip.x, top: chip.y, transform: transformFor(chip.edge), maxWidth: budget }}
      title={chip.cluster.label}
      onClick={() => onFit(chip.cluster.rect)}
      onPointerEnter={() => { if (prefersReducedMotion()) setMotionReveal(true); }}
      onPointerMove={(event) => advanceOnMove(event.clientX)}
      onPointerLeave={() => { setStep(0); setMotionReveal(false); }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <span data-edge-chip-control className="flex shrink-0 items-center gap-1.5" aria-hidden>
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: chip.cluster.color }} />
        <span>{arrowFor(chip.edge)}</span>
      </span>
      <span
        ref={titleRef}
        data-edge-chip-title
        data-reveal={full ? "full" : String(step)}
        className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap transition-[max-width] duration-150 ease-out motion-reduce:transition-none"
        style={{ maxWidth: full ? undefined : `${Math.min(REVEAL_BASE_PX + step * REVEAL_STEP_PX, budget)}px` }}
      >
        {chip.cluster.label}
      </span>
    </button>
  );
}

/* The «+N» trigger is a plain disclosure (aria-expanded + aria-controls), not a
   menu — the list is ordinary tab-reachable buttons, so menu roles would promise
   arrow-key semantics the widget doesn't have (round-1 review). Escape closes
   and returns focus to the trigger; a press outside dismisses. */
function OverflowDisclosure({ edge, rows, open, onToggle, onClose, onFit, anchor, vp }: {
  /** The border the aggregate actually docks against — its own edge, or a clear
      edge it was re-homed to when its own edge was fully blocked (issue #474). */
  edge: ChipEdge;
  rows: ClusterChip[];
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onFit: (rect: SchemeRect) => void;
  /** The resolved, obstacle-clear anchor for this disclosure's trigger. */
  anchor: { x: number; y: number };
  /** Viewport the list is clamped inside so it opens inward and never carries a
      keyboard-focused row past a border/corner (issue #474). */
  vp: { w: number; h: number };
}) {
  const { t } = useLocale();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && containerRef.current?.contains(event.target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, onClose]);

  const { x, y } = anchor;
  const listId = `edge-chip-overflow-${edge}`;
  /* The list opens inward from the resolved edge, width-constrained to the room
     left toward the opposite border and clamped along its cross axis so the
     whole column stays inside the viewport — every row keyboard-reachable for
     all four edges and a re-homed anchor anywhere along its border. Computed in
     nav/viewport space, so the trigger keeps its own edge transform while the
     list sits in an untransformed zero-size container at the anchor. */
  const list = overflowListStyle(edge, anchor, vp);
  return (
    <div
      ref={containerRef}
      className="pointer-events-auto absolute"
      style={{ left: x, top: y }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        onClose();
        triggerRef.current?.focus();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="absolute left-0 top-0 flex min-h-11 min-w-11 items-center justify-center rounded-full border border-border bg-card px-2 text-[11px] font-bold text-accent shadow-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        style={{ transform: transformFor(edge) }}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={t("scheme.offscreenMore", { count: rows.length })}
        onClick={onToggle}
      >
        +{rows.length}
      </button>
      {open ? (
        <div
          id={listId}
          data-overflow-list={edge}
          className="absolute z-10 flex flex-col gap-1 overflow-y-auto rounded-[10px] border border-border bg-card p-1 shadow-2"
          style={{ left: list.left, right: list.right, top: list.top, bottom: list.bottom, width: list.width, maxHeight: list.maxHeight }}
        >
          {rows.map((chip) => (
            <button
              type="button"
              data-overflow-chip={chip.cluster.key}
              key={chip.cluster.key}
              className="flex min-h-11 items-center gap-2 rounded-[8px] px-2 text-left text-[11px] font-semibold text-primary hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              onClick={() => { onFit(chip.cluster.rect); onClose(); }}
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: chip.cluster.color }} aria-hidden />
              <span className="truncate">{chip.cluster.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function EdgeChips({ clusters, cam, vp, hidden, obstacles = [], onFit }: {
  clusters: readonly BoardCluster[];
  cam: Camera;
  vp: { w: number; h: number };
  hidden: boolean;
  /** Screen-space boxes of rendered conversation surfaces: a chip that would
      paint over one folds into the edge's «+N» disclosure (issue #292). */
  obstacles?: readonly SchemeRect[];
  onFit: (rect: SchemeRect) => void;
}) {
  const { t } = useLocale();
  const coarse = useCoarsePointer();
  const mobile = useIsMobile();
  const measure = useChipMeasure();
  const partition = useMemo(() => offscreenClusterChips(clusters, cam, vp, 4, obstacles, measure), [clusters, cam, vp, obstacles, measure]);
  /* Group each edge's folded rows, then resolve where its «+N» aggregate docks:
     its own edge when clear, a re-homed clear edge when its own edge is fully
     blocked, and nowhere (suppressed) only when the whole viewport border is
     blocked. Re-homed rows merge into the target edge's disclosure so they stay
     one keyboard-reachable list — a fully blocked edge never docks its aggregate
     over a pane/avatar/round/composer keep-out (issue #474). */
  const disclosures = useMemo(() => {
    const byEdge = new Map<ChipEdge, ClusterChip[]>();
    for (const chip of partition.overflow) {
      const rows = byEdge.get(chip.edge) ?? [];
      rows.push(chip);
      byEdge.set(chip.edge, rows);
    }
    const placed = new Map<ChipEdge, { anchor: { x: number; y: number }; rows: ClusterChip[] }>();
    for (const [edge, rows] of byEdge) {
      const placement = resolveOverflowPlacement(edge, vp, obstacles);
      if (!placement) continue; // whole border blocked: suppress rather than overlap
      const bucket = placed.get(placement.edge);
      if (bucket) bucket.rows.push(...rows);
      else placed.set(placement.edge, { anchor: { x: placement.x, y: placement.y }, rows: [...rows] });
    }
    return placed;
  }, [partition.overflow, vp, obstacles]);
  const [openEdge, setOpenEdge] = useState<ChipEdge | null>(null);
  /* Touch-first and phone-width canvases fold this wayfinding into the minimap
     and mobile map instead: floating edge chips fight the finger for chat
     content and can bleed past a 390px viewport. */
  if (hidden || coarse || mobile || (!partition.visible.length && !partition.overflow.length)) return null;

  return (
    <nav data-scheme-ui aria-label={t("scheme.offscreenNav")} className="pointer-events-none absolute inset-0 z-[39]">
      {partition.visible.map((chip) => <ChipButton key={chip.cluster.key} chip={chip} onFit={onFit} />)}
      {[...disclosures].map(([edge, { anchor, rows }]) => (
        <OverflowDisclosure
          key={edge}
          edge={edge}
          rows={rows}
          anchor={anchor}
          vp={vp}
          open={openEdge === edge}
          onToggle={() => setOpenEdge((current) => current === edge ? null : edge)}
          onClose={() => setOpenEdge(null)}
          onFit={onFit}
        />
      ))}
    </nav>
  );
}
