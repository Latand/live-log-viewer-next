"use client";

import { CornerUpLeft } from "lucide-react";

import type { TFunction } from "@/lib/i18n";
import { MIN_WIDTH, RAIL_WIDTH, RESERVED_BESIDE_DOCK } from "../orchestrator/OrchestratorDock";
import { useLeftShellInset } from "../shellLayout";
import { Z } from "@/components/layers";

/** Back stays available after the passive arrival explanation expires. */

export interface FocusReturnChipProps {
  onReturn: () => void;
  /** False once the captured viewpoint has aged out of its window: the control
      still restores what it can, and says so in its own name rather than
      disappearing and stranding the operator. */
  precise: boolean;
  t: TFunction;
  arrival?: string;
}

/** Where the attention cluster sits: beside the rendered dock, in the board's
    own chrome column. The store holds the preferred dock width; its CSS
    viewport clamp is applied too, so resizing the window keeps the cluster
    beside the dock rather than under it. */
function useClusterLeft(): string {
  const inset = useLeftShellInset();
  return inset > 0
    ? `calc(${RAIL_WIDTH + 12}px + max(${MIN_WIDTH}px, min(${inset - RAIL_WIDTH}px, calc(100vw - ${RESERVED_BESIDE_DOCK}px))))`
    : `${RAIL_WIDTH + 12}px`;
}

/**
 * A lane the board drew from a row the server pushed and then turned out not
 * to hold (#1836 item 1): the placeholder is already gone, and this says why.
 *
 * Deliberately not a control. Nothing is owed in reply — the board is already
 * showing the truth — so it stands in the same column as the arrival line, for
 * the same bounded moment, and then takes itself off.
 */
export function LaneWithdrawnNote({ text }: { text: string }) {
  const left = useClusterLeft();
  return (
    <div
      data-scheme-ui
      style={{ left, maxWidth: `min(28rem, calc(100vw - ${left} - 12px))` }}
      className={`pointer-events-none absolute top-[100px] ${Z.dock} flex flex-col items-start gap-2`}
    >
      <div
        data-testid="attention-lane-withdrawn"
        role="status"
        className="rounded-[10px] border border-border bg-card/95 px-3 py-2 text-sm text-primary shadow-1 [overflow-wrap:anywhere]"
      >
        {text}
      </div>
    </div>
  );
}

export function FocusReturnChip({ onReturn, precise, t, arrival }: FocusReturnChipProps) {
  const label = precise ? t("attention.return") : t("attention.returnLine");
  const left = useClusterLeft();
  return (
    // AttentionHost mounts at the Viewer root, outside the board's flex column.
    <div
      data-scheme-ui
      style={{ left, maxWidth: `min(28rem, calc(100vw - ${left} - 12px))` }}
      className={`pointer-events-none absolute top-[100px] ${Z.dock} flex flex-col items-start gap-2`}
    >
      {arrival && (
        <div
          data-testid="attention-arrival"
          role="status"
          className="rounded-[10px] border border-border bg-card/95 px-3 py-2 text-sm text-primary shadow-1 [overflow-wrap:anywhere]"
        >
          {arrival}
        </div>
      )}
      <div
        data-scheme-ui
        data-testid="focus-return-chip"
        /* Docked below the board's view-control pill, in the same chrome column
           and the same visual language, so it reads as one more board control
           rather than as a notification laid over the board. */
        className="pointer-events-auto flex items-center rounded-[10px] border border-border bg-card/95 p-1 shadow-1"
      >
        <button
          type="button"
          data-testid="attention-return"
          onClick={onReturn}
          title={label}
          aria-label={label}
          className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] text-muted hover:bg-canvas hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <CornerUpLeft className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
