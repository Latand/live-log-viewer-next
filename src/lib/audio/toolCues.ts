"use client";

import type { FeedEntry, ToolEvent } from "@/components/feed/parse";

import type { CueRequest } from "./cues";

/**
 * Tool activity, read from the transcript the feed already parses.
 *
 * Two decisions carry this:
 *
 * - only a call that is still RUNNING ticks. A tool event whose result has
 *   attached (`ok`/`err`) is history, and history must be silent: opening a
 *   month-old conversation, or pressing «show earlier», would otherwise replay
 *   every tool it ever ran as a burst of sound. `status === "run"` is exactly
 *   "this is happening now", and the parser sets it from the absence of a
 *   result record rather than from any clock;
 * - the identity is the engine's own call id, namespaced by conversation. The
 *   feed is re-parsed on every tail tick and from scratch on a remount, so the
 *   id is the only thing that survives both unchanged. Codex synthesizes ids for
 *   records that carry none (`plain-<n>-<ts>`), and those repeat ACROSS
 *   conversations — hence the namespace, or a tick in one pane would silence a
 *   different pane's first tool.
 */

/** A Viewer MCP call is the agent reaching back into this viewer; it gets its
    own cue, one tier above ordinary tool texture. */
function cueFor(event: ToolEvent): CueRequest["cue"] {
  return event.mcp ? "viewer-mcp" : "tool-tick";
}

function requestFor(event: ToolEvent, conversation: string, pan: number): CueRequest | null {
  if (event.status !== "run") return null;
  return { cue: cueFor(event), eventId: `tool:${conversation}:${event.id}`, pan };
}

/**
 * Cue requests for every in-flight tool call in one feed snapshot. Returns them
 * all; de-duplication is the player's job, so this stays a pure read of the
 * current parse.
 */
export function toolActivityCues(
  items: readonly FeedEntry[],
  conversation: string,
  pan = 0,
): CueRequest[] {
  const requests: CueRequest[] = [];
  for (const entry of items) {
    const item = entry.item;
    if (item.kind === "tool") {
      const request = requestFor(item, conversation, pan);
      if (request) requests.push(request);
    } else if (item.kind === "cmd-group") {
      /* A folded run of consecutive calls hides its members from the row, not
         from the ear: the live trailing group is where an active call usually
         sits. */
      for (const call of item.calls) {
        const request = requestFor(call, conversation, pan);
        if (request) requests.push(request);
      }
    }
  }
  return requests;
}
