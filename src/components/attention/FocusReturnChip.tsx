"use client";

import { CornerUpLeft } from "lucide-react";

import type { TFunction } from "@/lib/i18n";

/**
 * The one affordance an automatic focus leaves behind.
 *
 * Automatic desktop focus moves the view without asking, so the operator needs a
 * way back to what they were looking at — and nothing else. There is no consent
 * to collect (the move already happened), nothing to preview, and nothing to
 * decline, so the whole confirmation cluster that used to live here is gone.
 *
 * Deliberately the smallest thing that can carry the action: one 28px icon
 * button in the same pill the board's own view controls use, docked under them
 * in the chrome column. No banner, no panel, no sentence — a passive
 * announcement of a move that has already finished would be a second
 * interruption on top of the first.
 *
 * It also must not read as a mode. `Back` names a single jump to a captured
 * viewpoint; anything shaped like "following" or "stop following" would imply
 * the view is still being held, which is exactly the sticky behaviour this
 * change removes.
 */

export interface FocusReturnChipProps {
  onReturn: () => void;
  /** False once the captured viewpoint has aged out of its window: the control
      still restores what it can, and says so in its own name rather than
      disappearing and stranding the operator. */
  precise: boolean;
  t: TFunction;
}

export function FocusReturnChip({ onReturn, precise, t }: FocusReturnChipProps) {
  const label = precise ? t("attention.return") : t("attention.returnLine");
  return (
    <div
      data-scheme-ui
      data-testid="focus-return-chip"
      /* Docked below the board's view-control pill, in the same chrome column
         and the same visual language, so it reads as one more board control
         rather than as a notification laid over the board. */
      className="absolute left-3 top-[52px] z-40 flex items-center rounded-[10px] border border-border bg-card/95 p-1 shadow-1"
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
  );
}
