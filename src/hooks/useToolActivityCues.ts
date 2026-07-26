"use client";

import { useEffect, useRef } from "react";

import type { FeedEntry } from "@/components/feed/parse";
import { playCue } from "@/lib/audio/app";
import { createToolCueScanner, type ToolCueScanner } from "@/lib/audio/toolCues";
import { panForPane } from "@/lib/chime";

/**
 * Rings the tool-activity cues for one conversation's feed.
 *
 * Runs on every parse the pane produces. The scanner holds the one fact the
 * parse alone cannot carry — where the previously heard window ended — so a
 * call that settled inside a single tail tick still reads as newly appended.
 * What actually sounds stays the player's call: it de-duplicates on the call
 * id tab-wide, so re-parsing the same window, remounting the pane, or two
 * panes rendering the same conversation cannot double-ring.
 *
 * `ready` gates the baseline: until the tail delivered its first window the
 * feed is empty because nothing has LOADED, not because nothing has run, and
 * baselining on that emptiness would replay the whole history as sound.
 */
export function useToolActivityCues(
  items: readonly FeedEntry[],
  conversation: string | null,
  path: string | null,
  windowEnd: number,
  ready: boolean,
): void {
  const scannerRef = useRef<{ key: string; scanner: ToolCueScanner } | null>(null);
  useEffect(() => {
    if (!conversation || !path || !ready) return;
    /* The window-end floor only means something within one transcript's line
       stream, so the scanner lives exactly as long as one path in one pane.
       The conversation identity, by contrast, names the cue events — it can
       outlive a path (lineage continuation) and the player carries the
       already-rung ids across. */
    const key = `${conversation}\n${path}`;
    if (scannerRef.current?.key !== key) {
      const switching = scannerRef.current !== null;
      scannerRef.current = { key, scanner: createToolCueScanner(conversation) };
      /* A pane switching transcripts renders one commit where the new key is
         still paired with the OLD file's window — the tail hook's reset lands
         a commit later. Baselining on that mixed commit would anchor the floor
         in the wrong stream and ring the newly loaded history; skip it and let
         a clean later commit take the baseline. A fresh mount has no old
         window, so it baselines immediately. */
      if (switching) return;
    }
    const requests = scannerRef.current.scanner.scan(items, windowEnd, panForPane(conversation));
    for (const request of requests) playCue(request);
  }, [items, conversation, path, windowEnd, ready]);
}
