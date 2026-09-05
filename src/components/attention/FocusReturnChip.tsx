"use client";

import { CornerUpLeft } from "lucide-react";

import type { TFunction } from "@/lib/i18n";

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

export function FocusReturnChip({ onReturn, precise, t, arrival }: FocusReturnChipProps) {
  const label = precise ? t("attention.return") : t("attention.returnLine");
  return (
    <div data-scheme-ui className="pointer-events-none absolute left-3 top-[52px] z-40 flex max-w-[min(28rem,calc(100%-1.5rem))] flex-col items-start gap-2">
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
