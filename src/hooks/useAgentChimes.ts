"use client";

import { useEffect, useRef } from "react";

import { paneState, type PaneState } from "@/components/paneState";
import { isAuxTask } from "@/components/projectModel";
import { chime, type ChimeKind, panForPane, primeAudio } from "@/lib/chime";
import type { FileEntry } from "@/lib/types";

const CHIME_OF: Partial<Record<PaneState, ChimeKind>> = {
  waiting: "waiting",
  returned: "returned",
  stalled: "stalled",
};

/** Several agents finishing in one poll ring as a cascade, not a cluster chord. */
const STAGGER_MS = 220;

/**
 * Watches the polled file list for lifecycle transitions and rings a chime
 * when an agent finishes its turn: left `live` into an attention state, or
 * appeared already finished (a branch that ran its whole life between polls).
 * The first poll after page load only seeds the baseline — reloading over
 * finished work stays silent.
 */
export function useAgentChimes(files: FileEntry[]) {
  const prevRef = useRef<Map<string, PaneState> | null>(null);

  useEffect(() => primeAudio(), []);

  useEffect(() => {
    if (!files.length) return;
    const next = new Map<string, PaneState>();
    for (const file of files) {
      if (!isAuxTask(file)) next.set(file.path, paneState(file));
    }
    const prev = prevRef.current;
    prevRef.current = next;
    if (!prev) return;
    let voice = 0;
    for (const [path, state] of next) {
      const file = files.find((item) => item.path === path);
      const kind = file?.pendingQuestion || file?.waitingInput ? "question" : CHIME_OF[state];
      if (!kind) continue;
      const was = prev.get(path);
      if (was === "live" || was === undefined) chime(kind, panForPane(path), voice++ * STAGGER_MS);
    }
  }, [files]);
}
