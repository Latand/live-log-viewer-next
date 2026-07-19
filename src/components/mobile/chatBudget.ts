/**
 * Mobile chat-first viewport budget (issue #419).
 *
 * The phone stacks a fixed band of chrome above and below the scrolling
 * transcript. Left unchecked, project navigation, the conversation header's
 * memory/goal chips, the detailed runtime controls, and the pipeline / handoff
 * shelves squeeze the transcript into the smallest region on screen — the
 * reopened production failure at 390×844.
 *
 * This module is the arithmetic contract behind the repair. It enumerates every
 * persistent surface's mobile height so "the transcript owns at least 60% of the
 * usable viewport before the keyboard opens" is a checked property, and it proves
 * the secondary surfaces MUST default to collapsed (zero reserved height) to
 * clear that bar. `BranchPane` folds exactly those surfaces behind one compact
 * conversation-details disclosure; `MobileFocusView` stamps
 * `MIN_TRANSCRIPT_SHARE` onto the focus root so the contract travels with the
 * DOM it governs.
 *
 * The pipeline summary and bottom shelf are counted here even though they are
 * themselves conditional: including them is the conservative worst case, so the
 * guarantee holds a fortiori on the many screens where they are absent.
 */

/** The transcript's guaranteed share of the usable viewport, keyboard closed. */
export const MIN_TRANSCRIPT_SHARE = 0.6;

/** Persistent chrome, always on screen with a conversation focused. Each value
    is the rendered mobile height in CSS px (a Tailwind row plus its padding).
    Every secondary surface — pipelines, tasks, handoff, hidden strips — is a
    compact icon trigger in the top chrome now (issue #419 reopened), so the
    focused chat reserves NO bottom row for any of them. */
export const PERSISTENT_CHROME = {
  /** Project shell header: name, undo, shelf/create/more triggers (`min-h-[52px]`). */
  shellHeader: 52,
  /** Conversation-switch strip in MobileFocusView, also holding the map,
      pipelines, and tasks icon triggers (h-11 targets). */
  focusStrip: 56,
  /** One compact conversation header row in BranchPane. */
  conversationHeader: 56,
  /** Composer primary row: the input field with its mic + send controls. */
  composerPrimary: 56,
} as const;

/** Secondary chrome, each behind a disclosure or overlay. Closed it reserves
    zero height; the value is what it WOULD add back to the band if it were still
    an inline row. Every pipeline/task/history/handoff surface lives here now
    (issue #419 reopened): the focused chat viewport reserves none of their
    height by default, and the model proves that folding them is load-bearing. */
export const SECONDARY_CHROME = {
  /** Header metadata chips: memory (plan), goal, model/reasoning, ctx, account. */
  conversationMeta: 40,
  /** Detailed runtime controls: Stop, compact, terminal. */
  runtimeControls: 48,
  /** The docked-pipeline summary/rail that used to sit as a persistent row below
      the transcript — now reached from the focus-strip pipelines icon. */
  pipelineRail: 44,
  /** The handoff control + hidden worker/quiet/readiness strips that used to sit
      as a persistent bottom row — now an overlay from the header shelf trigger. */
  handoffHidden: 44,
} as const;

export type SecondaryKey = keyof typeof SECONDARY_CHROME;

export interface Viewport {
  /** Visual viewport height in CSS px (e.g. 844 at iPhone 390×844). */
  height: number;
  /** Safe-area inset consumed at the bottom (home indicator). Default 0. */
  safeBottom?: number;
  /** Safe-area inset at the top not already excluded by the browser. Default 0. */
  safeTop?: number;
  /** Which secondary disclosures are open. Absent/empty = the default: all closed. */
  open?: readonly SecondaryKey[];
}

export interface ChatBudget {
  /** Viewport height minus the safe-area insets. */
  usable: number;
  /** Total persistent + opened-secondary chrome height. */
  chrome: number;
  /** Height left for the transcript, never negative. */
  transcript: number;
  /** transcript / usable, clamped to [0, 1]. */
  share: number;
  /** True when the transcript clears `MIN_TRANSCRIPT_SHARE`. */
  meetsMinimum: boolean;
}

function total(values: Record<string, number>): number {
  return Object.values(values).reduce((carry, value) => carry + value, 0);
}

/** The transcript's height and share for a viewport and disclosure state. */
export function chatBudget({ height, safeBottom = 0, safeTop = 0, open = [] }: Viewport): ChatBudget {
  const usable = Math.max(0, height - safeBottom - safeTop);
  const openSet = new Set(open);
  const secondary = (Object.keys(SECONDARY_CHROME) as SecondaryKey[]).reduce(
    (carry, key) => carry + (openSet.has(key) ? SECONDARY_CHROME[key] : 0),
    0,
  );
  const chrome = total(PERSISTENT_CHROME) + secondary;
  const transcript = Math.max(0, usable - chrome);
  const share = usable > 0 ? Math.min(1, transcript / usable) : 0;
  return { usable, chrome, transcript, share, meetsMinimum: share >= MIN_TRANSCRIPT_SHARE };
}
