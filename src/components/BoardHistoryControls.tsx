"use client";

import { Redo2, Undo2 } from "lucide-react";

import type { BoardHistoryEntry } from "@/lib/board/history";
import { useLocale } from "@/lib/i18n";

interface BoardHistoryControlsProps {
  canUndo: boolean;
  canRedo: boolean;
  /** Next action an undo would reverse — its title drives the tooltip. */
  undoEntry: BoardHistoryEntry | null;
  redoEntry: BoardHistoryEntry | null;
  onUndo: () => void;
  onRedo: () => void;
  /** Coarse-pointer sizing: 44px hit targets on phones, compact on desktop. */
  isMobile: boolean;
}

/**
 * The board undo/redo island (issue #184): two arrow buttons that step through
 * the user's recent board actions. Undo reopens the last closed card; redo
 * closes it again. Disabled at the edges of the history, and a hover/tap tooltip
 * names what the next undo would restore. A small segmented pair, sitting near
 * the other board controls in the project header.
 */
export function BoardHistoryControls({
  canUndo,
  canRedo,
  undoEntry,
  redoEntry,
  onUndo,
  onRedo,
  isMobile,
}: BoardHistoryControlsProps) {
  const { t } = useLocale();

  const undoTitle = undoEntry?.title.trim();
  const redoTitle = redoEntry?.title.trim();
  const undoTooltip = canUndo
    ? undoTitle
      ? t("board.undoReopen", { title: undoTitle })
      : t("board.undo")
    : t("board.undoNothing");
  const redoTooltip = canRedo
    ? redoTitle
      ? t("board.redoReclose", { title: redoTitle })
      : t("board.redo")
    : t("board.redoNothing");

  const button = isMobile ? "h-11 w-11" : "h-7 w-8";
  const icon = isMobile ? "h-5 w-5" : "h-4 w-4";
  const base =
    "flex items-center justify-center text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 hover:text-accent disabled:cursor-default disabled:text-muted disabled:opacity-40 disabled:hover:text-muted";

  return (
    <div
      className="inline-flex shrink-0 items-center overflow-hidden rounded-[8px] border border-border bg-card"
      role="group"
      aria-label={t("board.historyGroup")}
    >
      <button
        type="button"
        className={`${base} ${button} rounded-l-[7px]`}
        onClick={onUndo}
        disabled={!canUndo}
        aria-label={undoTooltip}
        title={undoTooltip}
      >
        <Undo2 className={icon} aria-hidden />
      </button>
      <span className="h-5 w-px shrink-0 bg-border" aria-hidden />
      <button
        type="button"
        className={`${base} ${button} rounded-r-[7px]`}
        onClick={onRedo}
        disabled={!canRedo}
        aria-label={redoTooltip}
        title={redoTooltip}
      >
        <Redo2 className={icon} aria-hidden />
      </button>
    </div>
  );
}
