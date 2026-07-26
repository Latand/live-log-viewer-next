"use client";

import type { FeedEntry, ToolEvent } from "@/components/feed/parse";

import type { CueRequest } from "./cues";

/**
 * Tool activity, read from the transcript the feed already parses.
 *
 * Three decisions carry this:
 *
 * - a call is NEW when its source line lies at or past the end of the last
 *   window this pane has heard. A short call settles inside one tail tick —
 *   the parse only ever sees it with `ok`/`err` attached — so status cannot
 *   mean "new": the transcript position is what distinguishes a freshly
 *   appended call (any status) from settled history. Prepended pages and
 *   re-parsed windows sit below the heard end and stay silent;
 * - the first scan is the baseline and absorbs the whole window silently —
 *   opening a month-old conversation, or remounting a pane, must not replay
 *   every tool it ever ran as a burst of sound. The one exception is a call
 *   still RUNNING at baseline: that is happening now, and it ticks;
 * - the identity is the engine's own call id, namespaced by conversation. The
 *   feed is re-parsed on every tail tick and from scratch on a remount, so the
 *   id is the only thing that survives both unchanged. Codex synthesizes ids
 *   for records that carry none (`plain-<n>-<ts>`), and those repeat ACROSS
 *   conversations — hence the namespace, or a tick in one pane would silence a
 *   different pane's first tool. The player's tab-wide de-duplication on that
 *   identity is what keeps duplicate scanners honest: a remounted pane or a
 *   second pane on the same conversation re-baselines and re-requests, and the
 *   player answers "already considered".
 */

/** A Viewer MCP call is the agent reaching back into this viewer; it gets its
    own cue, one tier above ordinary tool texture. */
function cueFor(event: ToolEvent): CueRequest["cue"] {
  return event.mcp ? "viewer-mcp" : "tool-tick";
}

function requestFor(event: ToolEvent, conversation: string, pan: number): CueRequest {
  return { cue: cueFor(event), eventId: `tool:${conversation}:${event.id}`, pan };
}

/** Walks every tool event in one feed snapshot, folded command groups
    included: the live trailing group is where an active call usually sits. */
function eachToolEvent(items: readonly FeedEntry[], visit: (event: ToolEvent) => void): void {
  for (const entry of items) {
    const item = entry.item;
    if (item.kind === "tool") visit(item);
    else if (item.kind === "cmd-group") for (const call of item.calls) visit(call);
  }
}

export interface ToolCueScanner {
  /**
   * Cue requests earned by one parse of the pane's window. `windowEnd` is the
   * absolute line index just past the window (`linesStart + lines.length`),
   * measured in the same stream as each event's `srcCall`; it becomes the
   * floor future scans use to tell appended calls from revealed history.
   */
  scan(items: readonly FeedEntry[], windowEnd: number, pan?: number): CueRequest[];
}

/**
 * One pane's view of one conversation. State is exactly one number — the end
 * of the last heard window — so a scanner lost to a remount costs nothing: the
 * replacement re-baselines silently and the player still owns what actually
 * sounds. A truncated transcript (indices restart at zero) simply moves the
 * floor back down with the window; the id-keyed de-duplication in the player
 * is what guarantees that even then nothing rings twice.
 */
/** Audio-clock stagger between simultaneously discovered tool cues. */
export const TOOL_CUE_STAGGER_MS = 220;

export function createToolCueScanner(conversation: string): ToolCueScanner {
  /** Absolute index just past the last scanned window; null before baseline. */
  let heardEnd: number | null = null;
  return {
    scan(items, windowEnd, pan = 0) {
      const floor = heardEnd;
      heardEnd = windowEnd;
      const requests: CueRequest[] = [];
      eachToolEvent(items, (event) => {
        const appended = floor !== null && event.srcCall >= floor;
        if (appended || event.status === "run") requests.push(requestFor(event, conversation, pan));
      });
      for (let i = 1; i < requests.length; i += 1) {
        requests[i] = { ...requests[i], delayMs: i * TOOL_CUE_STAGGER_MS };
      }
      return requests;
    },
  };
}

/**
 * Cue requests for every in-flight tool call in one feed snapshot — the
 * stateless view a baseline scan also produces. De-duplication is the player's
 * job, so this stays a pure read of the current parse.
 */
export function toolActivityCues(
  items: readonly FeedEntry[],
  conversation: string,
  pan = 0,
): CueRequest[] {
  const requests: CueRequest[] = [];
  eachToolEvent(items, (event) => {
    if (event.status === "run") requests.push(requestFor(event, conversation, pan));
  });
  return requests;
}
