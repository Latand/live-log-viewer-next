"use client";

import { viewBus } from "@/hooks/viewPresenceBus";

/**
 * What the operator is looking at, composed for the orchestrator's next turn.
 *
 * The floating orchestrator is Viewer-global: it stays beside the operator while
 * they move between projects, and the motivating gesture is "navigate somewhere,
 * select something, ask the orchestrator to work on it" — without re-docking or
 * re-opening anything. The agent on the other end cannot see the operator's
 * screen, so the composer tells it: the current project, the focused
 * conversation and the explicit selection, read from the SAME view bus the
 * board/scheme/mobile surfaces already report into for presence. No new
 * publisher, no second notion of "what is on screen".
 *
 * Deliberately in-tab and client-side only. Cross-process resolution (what the
 * MCP plane can see, stage/prod identity) is a different lane; this line is
 * plain text riding the conversation's own send path, which the agent reads like
 * any other part of the operator's message.
 *
 * Empty when it would add nothing: the overview with no selection, or the
 * operator looking at the orchestrator conversation itself.
 */

/** Paths listed before the count folds the rest — enough to act on, bounded so a
    65-pane lasso never turns a one-line prelude into a page. */
const MAX_LISTED = 6;

export interface ViewerContextSelf {
  /** The orchestrator conversation's own transcript path and project: what the
      operator is looking at only counts as context when it is something else. */
  path: string;
  project: string;
}

export function composeViewerContextPrelude(
  context: { project: string | null },
  slice: { focusedPath: string | null; selectedPaths: readonly string[] },
  self: ViewerContextSelf,
): string {
  const focused = slice.focusedPath && slice.focusedPath !== self.path ? slice.focusedPath : null;
  const selected = slice.selectedPaths.filter((path) => path !== self.path && path !== focused);
  const projectDiffers = Boolean(context.project && context.project !== self.project);
  if (!projectDiffers && !focused && selected.length === 0) return "";
  const parts: string[] = [];
  if (context.project) parts.push(`project ${context.project}`);
  if (focused) parts.push(`focused conversation ${focused}`);
  if (selected.length > 0) {
    const listed = selected.slice(0, MAX_LISTED);
    const folded = selected.length - listed.length;
    parts.push(`selected ${listed.join(", ")}${folded > 0 ? ` (+${folded} more)` : ""}`);
  }
  return `[viewer context — the operator is looking at: ${parts.join("; ")}]`;
}

/** The live read, from the app-wide bus presence already publishes from. */
export function viewerContextPrelude(self: ViewerContextSelf): string {
  return composeViewerContextPrelude(viewBus.getContext(), viewBus.getSlice(), self);
}
