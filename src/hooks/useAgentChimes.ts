"use client";

import { useEffect, useRef } from "react";

import { paneState, type PaneState } from "@/components/paneState";
import { isAuxTask } from "@/components/projectModel";
import { conversationIdentity, isArchivedPredecessor } from "@/lib/accounts/identity";
import { chime, type ChimeKind, panForPane, primeAudio } from "@/lib/chime";
import type { FileEntry } from "@/lib/types";

const CHIME_OF: Partial<Record<PaneState, ChimeKind>> = {
  waiting: "waiting",
  returned: "returned",
  stalled: "stalled",
};

/** Several agents finishing in one poll ring as a cascade, not a cluster chord. */
const STAGGER_MS = 220;

/* Upper bound on remembered identities. The retention exists to bridge the
   FILE_CAP feed window (~400 entries plus hydration), so an order of magnitude
   above it keeps every plausibly-returning conversation while a long-running
   tab stays flat: when the bound is hit, the longest-known identities absent
   from the current poll are evicted first. */
export const MAX_TRACKED_IDENTITIES = 4096;

/** Only what a future transition decision reads. Retaining whole FileEntry
    values would accumulate their nested payloads (plans, questions,
    migration data) for every conversation a long-running tab has observed. */
export interface TrackedConversation {
  state: PaneState;
  /** The finish chime this poll's entry would ring, derived at map build. */
  kind: ChimeKind | undefined;
  parent: string | null;
}

export interface PlannedChime {
  kind: ChimeKind;
  /** Conversation identity the chime pans toward. */
  id: string;
}

export interface ChimePlan {
  /** Baseline for the next poll: identities seen so far with their last known
      state — identities that fell out of the capped feed are retained (up to
      {@link MAX_TRACKED_IDENTITIES}), so a conversation that merely churned
      out of the recency cap and returned does not read as a brand-new agent
      (that was the storm of identical chimes). */
  tracked: Map<string, TrackedConversation>;
  /** Children that have rung their spawn blip. */
  linked: Set<string>;
  chimes: PlannedChime[];
}

export interface ScopedChimePlan extends ChimePlan {
  /** The successful /api/files request that produced this payload. */
  scope: string;
}

/**
 * Pure transition scan behind {@link useAgentChimes}: compares the current
 * poll against the accumulated baseline and plans which chimes to ring.
 * `prev === null` is the first poll after page load — it only seeds the
 * baseline, so reloading over finished work stays silent.
 */
export function planAgentChimes(
  files: readonly FileEntry[],
  prev: ReadonlyMap<string, TrackedConversation> | null,
  linked: ReadonlySet<string>,
  options: { suppressUnseen?: boolean } = {},
): ChimePlan {
  /* Keyed by the stable conversation identity (with the path as the
     pre-migration fallback): a committed account migration swaps the path
     while the conversation stays, so identity-keyed tracking keeps
     succession silent where a path-keyed scan would ring a spurious
     finish-then-spawn cascade.
     Archived predecessors share their successor's identity and would flap the
     tracked state between generations, so they are skipped outright. */
  const next = new Map<string, TrackedConversation>();
  for (const file of files) {
    if (isAuxTask(file) || isArchivedPredecessor(file)) continue;
    const id = conversationIdentity(file);
    /* Bound the current poll itself (selected-project hydration can exceed the
       cap): the feed arrives mtime-descending, so the retained slice is the
       most recently active conversations and every return path stays capped. */
    if (next.size >= MAX_TRACKED_IDENTITIES && !next.has(id)) continue;
    const state = paneState(file);
    const kind = file.pendingQuestion || file.waitingInput ? "question" : CHIME_OF[state];
    next.set(id, { state, kind, parent: file.parent });
  }
  const nextLinked = new Set(linked);
  const chimes: PlannedChime[] = [];
  if (!prev) {
    for (const [id, cur] of next) if (cur.parent) nextLinked.add(id);
    return { tracked: next, linked: nextLinked, chimes };
  }
  for (const [id, cur] of next) {
    const was = prev.get(id);
    const suppressUnseen = options.suppressUnseen === true && was === undefined;
    const finished = cur.kind !== undefined && (was?.state === "live" || was === undefined);
    if (cur.kind !== undefined && finished && !suppressUnseen) chimes.push({ kind: cur.kind, id });
    if (cur.parent && !nextLinked.has(id)) {
      nextLinked.add(id);
      /* Skip the blip when a finish chime just announced this same
         conversation — a subagent that lived its whole life between polls
         rings once. */
      if (!finished && !suppressUnseen) chimes.push({ kind: "spawned", id });
    }
  }
  /* Last-seen (LRU) order: entries present in this poll are re-inserted at
     the tail, so eviction walks least-recently-observed first. A plain merge
     would keep first-seen positions and could evict an identity that merely
     skipped one poll while truly ancient entries survived — recreating the
     phantom chime on its return. `linked` is trimmed to the survivors — an
     evicted child that ever returns is treated as new anyway. */
  const tracked = new Map(prev);
  for (const [id, cur] of next) {
    tracked.delete(id);
    tracked.set(id, cur);
  }
  if (tracked.size > MAX_TRACKED_IDENTITIES) {
    for (const id of tracked.keys()) {
      if (tracked.size <= MAX_TRACKED_IDENTITIES) break;
      if (!next.has(id)) tracked.delete(id);
    }
    for (const id of nextLinked) if (!tracked.has(id)) nextLinked.delete(id);
  }
  return { tracked, linked: nextLinked, chimes };
}

/**
 * Applies the request-scope boundary around the transition scan. A project
 * switch hydrates historical entries that this tab has never observed; those
 * entries seed the retained history silently. Conversations already tracked
 * still announce a real lifecycle transition during the same hydration.
 */
export function planScopedAgentChimes(
  files: readonly FileEntry[],
  previous: ScopedChimePlan | null,
  scope: string,
): ScopedChimePlan {
  const plan = planAgentChimes(
    files,
    previous?.tracked ?? null,
    previous?.linked ?? new Set(),
    { suppressUnseen: previous !== null && previous.scope !== scope },
  );
  return { ...plan, scope };
}

/**
 * Watches the polled file list for lifecycle transitions and rings a chime
 * when an agent finishes its turn: left `live` into an attention state, or
 * appeared already finished (a branch that ran its whole life between polls).
 * A new node joining the agent tree — a fresh subagent, or an existing
 * conversation whose parent link got resolved — rings its own `spawned`
 * blip, unless a finish chime for the same path already carries the news.
 * The first poll after page load only seeds the baseline — reloading over
 * finished work stays silent.
 */
export function useAgentChimes(files: FileEntry[], scope: string | null) {
  const historyRef = useRef<ScopedChimePlan | null>(null);

  useEffect(() => primeAudio(), []);

  useEffect(() => {
    if (!files.length || !scope) return;
    const plan = planScopedAgentChimes(files, historyRef.current, scope);
    historyRef.current = plan;
    plan.chimes.forEach((planned, voice) => chime(planned.kind, panForPane(planned.id), voice * STAGGER_MS));
  }, [files, scope]);
}
