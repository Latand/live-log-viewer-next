"use client";

import { useEffect } from "react";

import type { FeedEntry } from "@/components/feed/parse";
import { playCue } from "@/lib/audio/app";
import { toolActivityCues } from "@/lib/audio/toolCues";
import { panForPane } from "@/lib/chime";

/**
 * Rings the tool-activity cues for one conversation's feed.
 *
 * Runs on every parse the pane produces, which is the point: the player owns
 * de-duplication, so re-parsing the same window, remounting the pane, or two
 * panes rendering the same conversation cannot double-ring. The hook stays this
 * thin deliberately — the moment it starts remembering what it played, there are
 * two answers to "did this event already sound" and they drift.
 */
export function useToolActivityCues(items: readonly FeedEntry[], conversation: string | null): void {
  useEffect(() => {
    if (!conversation) return;
    for (const request of toolActivityCues(items, conversation, panForPane(conversation))) playCue(request);
  }, [items, conversation]);
}
