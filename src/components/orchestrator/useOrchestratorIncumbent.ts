"use client";

import { useCallback, useEffect, useState } from "react";

import { parseIncumbent, type OrchestratorIncumbent } from "./incumbent";

/**
 * How often the panel re-reads the incumbent's wear (PRD #976 slice B).
 *
 * Deliberately much slower than {@link SEAT_POLL_MS}. The seat read decides
 * whether the panel is a draft or a conversation, so it has to be quick and it
 * stays a directory lookup; THIS read parses the transcript and asks the
 * liveness plane to answer «how full is the context window».
 *
 * That parse is the expensive thing on the panel's account, so the cadence is
 * set by what the answer is FOR: context pressure and a rotation recommendation
 * both move over tens of minutes, and nothing here is ever acted on
 * automatically. The moments that do matter — the seat changing, and opening
 * the rotate draft — refresh on their own instead of waiting for a tick.
 */
export const INCUMBENT_POLL_MS = 60_000;

export interface OrchestratorIncumbentRead {
  /** Null until the first answer for THIS project. A later failure keeps the
      last good reading rather than blanking the header mid-conversation. */
  incumbent: OrchestratorIncumbent | null;
  /**
   * TRUE while the reading on hand is not something a status read has confirmed
   * during THIS mount: it was restored from the session cache, or the newest
   * attempt failed and the last good answer is being held over.
   *
   * The header is welcome to a stale reading — an engine and a context percent
   * from a minute ago beat a row of dashes. Liveness is not: a cached «alive»
   * held over across a viewer restart would let the panel accuse a seat of
   * failing to bind on evidence no longer being answered for (issue #1182).
   */
  stale: boolean;
  refresh: () => Promise<void>;
}

interface ScopedRead {
  project: string;
  incumbent: OrchestratorIncumbent | null;
  /** False only on an answer this hook instance received and nothing has
      failed over since. See {@link OrchestratorIncumbentRead.stale}. */
  stale: boolean;
}

/** Every reading this tab has taken, keyed by project — the incumbent half of
    the same session cache the seat keeps (#1149). A revisited header shows the
    wear it was last read at while the poll below refreshes it, rather than
    dropping back to what the board alone knows for a round-trip. */
const readings = new Map<string, ScopedRead>();

export function resetOrchestratorIncumbentCacheForTests(): void {
  readings.clear();
}

const cachedIncumbent = (project: string | null): ScopedRead | null => (project ? readings.get(project) ?? null : null);

/** A reading coming back out of the session cache is HEADER material and
    nothing more. It was answered for in some earlier episode — possibly before
    the viewer restarted this panel is now waiting on — so it re-enters stale
    and only a fresh answer clears it (#1182). */
const restored = (read: ScopedRead | null): ScopedRead | null => (read ? { ...read, stale: true } : null);

export async function fetchOrchestratorIncumbent(project: string, signal?: AbortSignal): Promise<OrchestratorIncumbent | null> {
  const response = await fetch(
    "/api/orchestrator/seat/status?project=" + encodeURIComponent(project),
    signal ? { signal } : undefined,
  );
  if (!response.ok) throw new Error(`orchestrator status read failed: ${response.status}`);
  return parseIncumbent(await response.json());
}

/**
 * The project's incumbent orchestrator, polled.
 *
 * A failure is not reported as a state of its own: the seat read already owns
 * «the panel cannot be read», and this one only ever ADDS detail to a
 * conversation that is already on screen. Silence here degrades the header to
 * what the board itself knows, which is exactly what slice A rendered — and it
 * marks the retained reading stale, so a consumer that needs CURRENT evidence
 * can tell «the server said alive» from «the server said alive, once».
 */
export function useOrchestratorIncumbent(project: string | null, enabled: boolean): OrchestratorIncumbentRead {
  const [read, setRead] = useState<ScopedRead | null>(() => restored(cachedIncumbent(project)));
  /* Answers carry the project they answered for, so a project switch drops the
     previous incumbent HERE, in render — never a frame of the old orchestrator's
     model under the new project's name. What replaces it is this project's own
     last reading, which the panel then matches against the seat as usual. */
  const current = read && read.project === project ? read : restored(cachedIncumbent(project));

  const settle = useCallback((target: string, incumbent: OrchestratorIncumbent | null) => {
    const next: ScopedRead = { project: target, incumbent, stale: false };
    readings.set(target, next);
    setRead(next);
  }, []);

  /* The reading survives; its standing as current evidence does not. The cache
     is left alone — anything restored from it is stale by construction. */
  const markStale = useCallback((target: string) => {
    setRead((previous) => (previous && previous.project === target && !previous.stale ? { ...previous, stale: true } : previous));
  }, []);

  const refresh = useCallback(async () => {
    if (!project) return;
    try {
      settle(project, await fetchOrchestratorIncumbent(project));
    } catch {
      /* Keep the last good reading; the header simply stops advancing. */
      markStale(project);
    }
  }, [project, settle, markStale]);

  useEffect(() => {
    if (!project || !enabled) return;
    const controller = new AbortController();
    const load = () => {
      void fetchOrchestratorIncumbent(project, controller.signal)
        .then((incumbent) => settle(project, incumbent))
        /* An abort is this effect being torn down, not the server failing to
           answer: the reading it would have replaced belongs to a panel that is
           no longer asking, so it is left exactly as it was. */
        .catch(() => {
          if (!controller.signal.aborted) markStale(project);
        });
    };
    load();
    const timer = setInterval(load, INCUMBENT_POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [project, enabled, settle, markStale]);

  return { incumbent: current?.incumbent ?? null, stale: current?.stale !== false, refresh };
}
