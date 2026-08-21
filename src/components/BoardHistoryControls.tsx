"use client";

import { Redo2, Undo2 } from "lucide-react";

import { Hint } from "@/components/Hint";
import type { BoardHistoryEntry } from "@/lib/board/history";
import { useLocale } from "@/lib/i18n";

/* The keyboard shortcuts the island discloses on its labels — the feature ships
   them (ProjectDashboard's global Ctrl+Z / Ctrl+Shift+Z handler) but the UI
   never named them before (finding 4). Plain key names, not localized prose. */
const UNDO_SHORTCUT = "Ctrl+Z";
const REDO_SHORTCUT = "Ctrl+Shift+Z";

interface BoardHistoryControlsProps {
  canUndo: boolean;
  canRedo: boolean;
  /** Next action an undo would reverse — its title drives the tooltip. */
  undoEntry: BoardHistoryEntry | null;
  redoEntry: BoardHistoryEntry | null;
  onUndo: () => void;
  onRedo: () => void;
}

/**
 * The board undo/redo island (issue #184): steps through the user's recent
 * board actions. Undo reopens the last closed card; redo closes it again.
 *
 * Desktop chrome. Presence is deliberate resting-chrome hygiene (findings 1, 2):
 * the island stays hidden until the log has something to act on — it appears on
 * the first close, the teachable moment. The phone has no island at all: both
 * directions are items in the header's «⋯» menu, because the 390px row's five
 * 44px slots are spoken for and global search took the one undo used to hold
 * (issue #1054 review). The keyboard shortcuts stay active regardless.
 */
export function BoardHistoryControls({
  canUndo,
  canRedo,
  undoEntry,
  redoEntry,
  onUndo,
  onRedo,
}: BoardHistoryControlsProps) {
  const { t } = useLocale();

  const undoTitle = undoEntry?.title.trim();
  const redoTitle = redoEntry?.title.trim();
  const undoLabel = canUndo
    ? withShortcut(undoTitle ? t("board.undoReopen", { title: undoTitle }) : t("board.undo"), UNDO_SHORTCUT)
    : t("board.undoNothing");
  const redoLabel = canRedo
    ? withShortcut(redoTitle ? t("board.redoReclose", { title: redoTitle }) : t("board.redo"), REDO_SHORTCUT)
    : t("board.redoNothing");

  const icon = "h-4 w-4";
  const base =
    "flex items-center justify-center text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 hover:text-accent disabled:cursor-default disabled:text-muted disabled:opacity-40 disabled:hover:text-muted";

  /* Desktop: the segmented pair, hidden until the log is non-empty (finding 2).
     No overflow-hidden clip so the Hint bubbles can escape; the transparent
     buttons need no inner radius (finding 3). */
  if (!canUndo && !canRedo) return null;
  return (
    <div
      className="inline-flex shrink-0 items-center rounded-control border border-border bg-card"
      role="group"
      aria-label={t("board.historyGroup")}
    >
      <Hint label={undoLabel}>
        <button
          type="button"
          className={`${base} h-7 w-8`}
          onClick={onUndo}
          disabled={!canUndo}
          aria-label={undoLabel}
        >
          <Undo2 className={icon} aria-hidden />
        </button>
      </Hint>
      <span className="h-5 w-px shrink-0 bg-border" aria-hidden />
      <Hint label={redoLabel}>
        <button
          type="button"
          className={`${base} h-7 w-8`}
          onClick={onRedo}
          disabled={!canRedo}
          aria-label={redoLabel}
        >
          <Redo2 className={icon} aria-hidden />
        </button>
      </Hint>
    </div>
  );
}

/** «Скасувати (Ctrl+Z)» — the label names what it does and how to reach it. */
function withShortcut(label: string, shortcut: string): string {
  return `${label} (${shortcut})`;
}
