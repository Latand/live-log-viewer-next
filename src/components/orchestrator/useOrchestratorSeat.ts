"use client";

import { useCallback, useEffect, useState } from "react";

import { parseSeatStatus, type OrchestratorSeatStatus } from "./seatState";

/** How often the panel re-reads the project's seat. The seat only moves when
    the operator (or a rotation) moves it, so this is a slow status read — the
    conversation itself streams through the feed's own channel. */
export const SEAT_POLL_MS = 6_000;

export interface OrchestratorSeatRead {
  /** Null until the first answer for THIS project; a later failure keeps the
      last good read rather than blanking the panel. */
  status: OrchestratorSeatStatus | null;
  /** The last attempt failed. With no `status` yet, the panel says so instead
      of showing an empty draft — which would invite a second orchestrator. */
  failed: boolean;
  refresh: () => Promise<void>;
}

interface ScopedRead {
  /** The project this answer is about; an answer for any other project is
      reconciled away at render time rather than shown for a frame. */
  project: string;
  status: OrchestratorSeatStatus | null;
  failed: boolean;
}

/**
 * Every answer this tab has been given, keyed by project (#1149).
 *
 * The panel is RE-SEATED on a project switch — a fresh mount, because its draft
 * belongs to one project — so the answer cannot live in its state and survive.
 * Here it does: a project the operator has already visited paints its last
 * answer in the FIRST commit after the switch and the effect below revalidates
 * behind it, instead of paying a round-trip to be told what it already knew.
 * The loading state is left to a project this tab has never answered for.
 *
 * Session-only, in memory: a seat that changed while the tab was closed must
 * still be READ, never restored from disk.
 */
const answers = new Map<string, ScopedRead>();

export function resetOrchestratorSeatCacheForTests(): void {
  answers.clear();
}

export async function fetchOrchestratorSeat(project: string, signal?: AbortSignal): Promise<OrchestratorSeatStatus> {
  const response = await fetch("/api/orchestrator/seat?project=" + encodeURIComponent(project), signal ? { signal } : undefined);
  if (!response.ok) throw new Error(`orchestrator seat read failed: ${response.status}`);
  return parseSeatStatus(await response.json());
}

const cachedSeat = (project: string | null): ScopedRead | null => (project ? answers.get(project) ?? null : null);

/**
 * The project's orchestrator seat, polled — and answered at once for a project
 * this tab already read (stale while it revalidates, #1149).
 *
 * `project` null (Overview, or the panel closed) reads nothing at all.
 */
export function useOrchestratorSeat(project: string | null): OrchestratorSeatRead {
  const [read, setRead] = useState<ScopedRead | null>(() => cachedSeat(project));
  /* Every answer carries the project it answered for, so a project switch
     invalidates the previous seat HERE, in render, with no effect and no frame
     in which the old incumbent shows under the new project's name. What takes
     its place is what THIS project last answered, not «loading». */
  const current = read && read.project === project ? read : cachedSeat(project);

  const settle = useCallback((target: string, status: OrchestratorSeatStatus | null, failed: boolean) => {
    const next: ScopedRead = {
      project: target,
      /* A failed re-read keeps the last good answer for the SAME project; the
         cache is keyed by project, so it can never resurrect another's. */
      status: status ?? answers.get(target)?.status ?? null,
      failed,
    };
    answers.set(target, next);
    setRead(next);
  }, []);

  const refresh = useCallback(async () => {
    if (!project) return;
    try {
      settle(project, await fetchOrchestratorSeat(project), false);
    } catch {
      settle(project, null, true);
    }
  }, [project, settle]);

  useEffect(() => {
    if (!project) return;
    const controller = new AbortController();
    const load = () => {
      void fetchOrchestratorSeat(project, controller.signal)
        .then((status) => settle(project, status, false))
        .catch((cause: unknown) => {
          if ((cause as { name?: string }).name !== "AbortError") settle(project, null, true);
        });
    };
    load();
    const timer = setInterval(load, SEAT_POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [project, settle]);

  return { status: current?.status ?? null, failed: current?.failed ?? false, refresh };
}
