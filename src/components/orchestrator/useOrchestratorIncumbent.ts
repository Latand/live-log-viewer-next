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
  refresh: () => Promise<void>;
}

interface ScopedRead {
  project: string;
  incumbent: OrchestratorIncumbent | null;
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
 * what the board itself knows, which is exactly what slice A rendered.
 */
export function useOrchestratorIncumbent(project: string | null, enabled: boolean): OrchestratorIncumbentRead {
  const [read, setRead] = useState<ScopedRead | null>(() => cachedIncumbent(project));
  /* Answers carry the project they answered for, so a project switch drops the
     previous incumbent HERE, in render — never a frame of the old orchestrator's
     model under the new project's name. What replaces it is this project's own
     last reading, which the panel then matches against the seat as usual. */
  const current = read && read.project === project ? read.incumbent : cachedIncumbent(project)?.incumbent ?? null;

  const settle = useCallback((target: string, incumbent: OrchestratorIncumbent | null) => {
    const next: ScopedRead = { project: target, incumbent };
    readings.set(target, next);
    setRead(next);
  }, []);

  const refresh = useCallback(async () => {
    if (!project) return;
    try {
      settle(project, await fetchOrchestratorIncumbent(project));
    } catch {
      /* Keep the last good reading; the header simply stops advancing. */
    }
  }, [project, settle]);

  useEffect(() => {
    if (!project || !enabled) return;
    const controller = new AbortController();
    const load = () => {
      void fetchOrchestratorIncumbent(project, controller.signal)
        .then((incumbent) => settle(project, incumbent))
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, INCUMBENT_POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [project, enabled, settle]);

  return { incumbent: current, refresh };
}
