"use client";

import { useMemo, useState } from "react";

import { useLocale } from "@/lib/i18n";

import type { SchemeRect } from "./layout";
import type { Camera } from "./Minimap";
import { offscreenClusterChips, type BoardCluster, type ChipEdge, type ClusterChip } from "./offscreenClusters";

const transformFor = (edge: ChipEdge): string => {
  if (edge === "right") return "translate(-100%, -50%)";
  if (edge === "left") return "translate(0, -50%)";
  if (edge === "bottom") return "translate(-50%, -100%)";
  return "translate(-50%, 0)";
};

function ChipButton({ chip, onFit }: { chip: ClusterChip; onFit: (rect: SchemeRect) => void }) {
  return (
    <button
      type="button"
      data-edge-chip={chip.cluster.key}
      className="pointer-events-auto absolute inline-flex min-h-11 max-w-[240px] items-center gap-1.5 rounded-full border border-border bg-card/95 px-3 text-[11px] font-bold text-primary shadow-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      style={{ left: chip.x, top: chip.y, transform: transformFor(chip.edge) }}
      title={chip.cluster.label}
      onClick={() => onFit(chip.cluster.rect)}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: chip.cluster.color }} aria-hidden />
      <span aria-hidden>{chip.edge === "right" ? "→" : chip.edge === "left" ? "←" : chip.edge === "bottom" ? "↓" : "↑"}</span>
      <span className="truncate">{chip.cluster.label}</span>
    </button>
  );
}

export function EdgeChips({ clusters, cam, vp, hidden, onFit }: {
  clusters: readonly BoardCluster[];
  cam: Camera;
  vp: { w: number; h: number };
  hidden: boolean;
  onFit: (rect: SchemeRect) => void;
}) {
  const { t } = useLocale();
  const partition = useMemo(() => offscreenClusterChips(clusters, cam, vp), [clusters, cam, vp]);
  const [openEdge, setOpenEdge] = useState<ChipEdge | null>(null);
  if (hidden || (!partition.visible.length && !partition.overflow.length)) return null;

  const overflowByEdge = new Map<ChipEdge, ClusterChip[]>();
  for (const chip of partition.overflow) {
    const rows = overflowByEdge.get(chip.edge) ?? [];
    rows.push(chip);
    overflowByEdge.set(chip.edge, rows);
  }

  return (
    <nav data-scheme-ui aria-label={t("scheme.offscreenNav")} className="pointer-events-none absolute inset-0 z-[39]">
      {partition.visible.map((chip) => <ChipButton key={chip.cluster.key} chip={chip} onFit={onFit} />)}
      {[...overflowByEdge].map(([edge, rows]) => {
        const vertical = edge === "left" || edge === "right";
        const x = edge === "left" ? 10 : edge === "right" ? vp.w - 10 : vp.w / 2;
        const y = edge === "top" ? 10 : edge === "bottom" ? vp.h - 10 : vp.h / 2;
        return (
          <div key={edge} className="pointer-events-auto absolute" style={{ left: x, top: y, transform: transformFor(edge) }}>
            <button
              type="button"
              className="flex min-h-11 min-w-11 items-center justify-center rounded-full border border-border bg-card px-2 text-[11px] font-bold text-accent shadow-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-expanded={openEdge === edge}
              aria-label={t("scheme.offscreenMore", { count: rows.length })}
              onClick={() => setOpenEdge((current) => current === edge ? null : edge)}
            >
              +{rows.length}
            </button>
            {openEdge === edge ? (
              <div
                role="menu"
                className={`absolute z-10 flex max-h-64 min-w-[220px] flex-col gap-1 overflow-y-auto rounded-[10px] border border-border bg-card p-1 shadow-2 ${
                  vertical ? "top-12" : edge === "bottom" ? "bottom-12 left-1/2 -translate-x-1/2" : "top-12 left-1/2 -translate-x-1/2"
                }`}
              >
                {rows.map((chip) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={chip.cluster.key}
                    className="flex min-h-11 items-center gap-2 rounded-[8px] px-2 text-left text-[11px] font-semibold text-primary hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    onClick={() => { onFit(chip.cluster.rect); setOpenEdge(null); }}
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: chip.cluster.color }} aria-hidden />
                    <span className="truncate">{chip.cluster.label}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}
