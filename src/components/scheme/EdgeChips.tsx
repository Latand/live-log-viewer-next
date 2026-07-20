"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { useCoarsePointer } from "@/hooks/useCoarsePointer";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";

import type { SchemeRect } from "./layout";
import type { Camera } from "./Minimap";
import { chipRevealWidth, offscreenClusterChips, type BoardCluster, type ChipEdge, type ClusterChip } from "./offscreenClusters";

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

/* Desktop chip with a progressive hover reveal. The chip button is the whole
   hover/focus surface — the label unfurls inside it, so moving from the arrow
   onto freshly revealed text never crosses a gap that would drop hover. Each
   pointer move that reaches the current truncated end lets one more segment
   through until the full title shows; keyboard focus reveals it all at once
   (a keyboard can't "reach the end"), and reduced motion swaps the animated
   stepping for a single settled reveal on hover. The pill's outer width is
   capped at the same viewport-clamped budget the collision geometry reserved
   (chipRevealWidth), so a full reveal can never spill past a viewport edge. */
function ChipButton({ chip, vp, onFit }: {
  chip: ClusterChip;
  vp: { w: number; h: number };
  onFit: (rect: SchemeRect) => void;
}) {
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const [step, setStep] = useState(0);
  const [focused, setFocused] = useState(false);
  const [motionReveal, setMotionReveal] = useState(false);
  const full = focused || motionReveal;
  const budget = chipRevealWidth(chip.edge, chip.x, vp);

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
function OverflowDisclosure({ edge, rows, open, onToggle, onClose, onFit, vp }: {
  edge: ChipEdge;
  rows: ClusterChip[];
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onFit: (rect: SchemeRect) => void;
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

  const vertical = edge === "left" || edge === "right";
  const x = edge === "left" ? 10 : edge === "right" ? vp.w - 10 : vp.w / 2;
  const y = edge === "top" ? 10 : edge === "bottom" ? vp.h - 10 : vp.h / 2;
  const listId = `edge-chip-overflow-${edge}`;
  return (
    <div
      ref={containerRef}
      className="pointer-events-auto absolute"
      style={{ left: x, top: y, transform: transformFor(edge) }}
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
        className="flex min-h-11 min-w-11 items-center justify-center rounded-full border border-border bg-card px-2 text-[11px] font-bold text-accent shadow-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
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
          className={`absolute z-10 flex max-h-64 min-w-[220px] flex-col gap-1 overflow-y-auto rounded-[10px] border border-border bg-card p-1 shadow-2 ${
            vertical ? "top-12" : edge === "bottom" ? "bottom-12 left-1/2 -translate-x-1/2" : "top-12 left-1/2 -translate-x-1/2"
          }`}
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
  const partition = useMemo(() => offscreenClusterChips(clusters, cam, vp, 4, obstacles), [clusters, cam, vp, obstacles]);
  const [openEdge, setOpenEdge] = useState<ChipEdge | null>(null);
  /* Touch-first and phone-width canvases fold this wayfinding into the minimap
     and mobile map instead: floating edge chips fight the finger for chat
     content and can bleed past a 390px viewport. */
  if (hidden || coarse || mobile || (!partition.visible.length && !partition.overflow.length)) return null;

  const overflowByEdge = new Map<ChipEdge, ClusterChip[]>();
  for (const chip of partition.overflow) {
    const rows = overflowByEdge.get(chip.edge) ?? [];
    rows.push(chip);
    overflowByEdge.set(chip.edge, rows);
  }

  return (
    <nav data-scheme-ui aria-label={t("scheme.offscreenNav")} className="pointer-events-none absolute inset-0 z-[39]">
      {partition.visible.map((chip) => <ChipButton key={chip.cluster.key} chip={chip} vp={vp} onFit={onFit} />)}
      {[...overflowByEdge].map(([edge, rows]) => (
        <OverflowDisclosure
          key={edge}
          edge={edge}
          rows={rows}
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
