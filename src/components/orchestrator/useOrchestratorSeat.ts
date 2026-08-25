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

export async function fetchOrchestratorSeat(project: string, signal?: AbortSignal): Promise<OrchestratorSeatStatus> {
  const response = await fetch("/api/orchestrator/seat?project=" + encodeURIComponent(project), signal ? { signal } : undefined);
  if (!response.ok) throw new Error(`orchestrator seat read failed: ${response.status}`);
  return parseSeatStatus(await response.json());
}

/**
 * The project's orchestrator seat, polled. `project` null (Overview, or the
 * panel closed) reads nothing at all.
 */
export function useOrchestratorSeat(project: string | null): OrchestratorSeatRead {
  const [read, setRead] = useState<ScopedRead | null>(null);
  /* Every answer carries the project it answered for, so a project switch
     invalidates the previous seat HERE, in render, with no effect and no frame
     in which the old incumbent shows under the new project's name. */
  const current = read && read.project === project ? read : null;

  const settle = useCallback((target: string, status: OrchestratorSeatStatus | null, failed: boolean) => {
    setRead((previous) => ({
      project: target,
      /* A failed re-read keeps the last good answer for the SAME project; it
         never resurrects another project's. */
      status: status ?? (previous?.project === target ? previous.status : null),
      failed,
    }));
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
