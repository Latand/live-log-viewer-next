"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  FILES_REVALIDATED_EVENT,
  FILES_REVALIDATION_STARTED_EVENT,
  type FilesRevalidatedDetail,
  type FilesRevalidationStartedDetail,
} from "@/lib/filesEvents";
import type { ProjectCatalogEntry } from "@/lib/types";

export type CreateProjectOutcome =
  | { ok: true; project: string }
  | { ok: false; code: string; message?: string };

export interface CreateProjectRequestOptions {
  /** Ask the server to mkdir a missing root before creating the project. */
  createRoot?: boolean;
}

export interface UseProjectCuration {
  /** Server crowns with this tab's optimistic toggles layered on top. */
  crownedProjects: ReadonlySet<string>;
  toggleCrown: (project: string, crowned: boolean) => void;
  createProject: (name: string, root: string, options?: CreateProjectRequestOptions) => Promise<CreateProjectOutcome>;
  /** Freshly created projects, overlaid until the server catalog carries them. */
  createdCatalog: ProjectCatalogEntry[];
}

/**
 * Client seam over the server-durable crown/create state. The server list in
 * the /api/files payload is authoritative; this hook only bridges the gap
 * between a click and the next poll — an optimistic override per toggled
 * project (dropped after its latest POST succeeds and a later poll agrees,
 * reverted on a failed POST) and a catalog overlay for a just-created project
 * so its rail row exists in the same frame.
 */
export function useProjectCuration(
  serverCrowned: readonly string[],
  serverCatalog: readonly ProjectCatalogEntry[],
): UseProjectCuration {
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [createdCatalog, setCreatedCatalog] = useState<ProjectCatalogEntry[]>([]);
  const crownMutationQueues = useRef(new Map<string, Promise<void>>());
  const crownMutationSequences = useRef(new Map<string, number>());
  const crownMutationAcknowledgements = useRef(new Map<string, { sequence: number; afterPoll: number }>());
  const crownPollSequence = useRef(0);

  const reconcileCrownPoll = useCallback((pollSequence: number, polledCrowned: readonly string[]) => {
    /* Reconcile against the fresh server payload. The same-reference return
       below makes an already-settled state a render no-op. */
    setOverrides((previous) => {
      if (!previous.size) return previous;
      const next = new Map(previous);
      for (const [project, crowned] of previous) {
        const acknowledgement = crownMutationAcknowledgements.current.get(project);
        const latestSequence = crownMutationSequences.current.get(project);
        if (acknowledgement
          && acknowledgement.sequence === latestSequence
          && pollSequence > acknowledgement.afterPoll
          && polledCrowned.includes(project) === crowned) {
          next.delete(project);
          crownMutationAcknowledgements.current.delete(project);
        }
      }
      return next.size === previous.size ? previous : next;
    });
  }, []);

  useEffect(() => {
    const onStarted = (event: Event) => {
      const requestId = (event as CustomEvent<FilesRevalidationStartedDetail>).detail.requestId;
      crownPollSequence.current = Math.max(crownPollSequence.current, requestId);
    };
    const onRevalidated = (event: Event) => {
      const { requestId, crownedProjects } = (event as CustomEvent<FilesRevalidatedDetail>).detail;
      reconcileCrownPoll(requestId, crownedProjects);
    };
    window.addEventListener(FILES_REVALIDATION_STARTED_EVENT, onStarted);
    window.addEventListener(FILES_REVALIDATED_EVENT, onRevalidated);
    return () => {
      window.removeEventListener(FILES_REVALIDATION_STARTED_EVENT, onStarted);
      window.removeEventListener(FILES_REVALIDATED_EVENT, onRevalidated);
    };
  }, [reconcileCrownPoll]);

  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- same
       server-payload reconciliation as the overrides above. */
    setCreatedCatalog((previous) => {
      if (!previous.length) return previous;
      const known = new Set(serverCatalog.map((entry) => entry.project));
      const next = previous.filter((entry) => !known.has(entry.project));
      return next.length === previous.length ? previous : next;
    });
  }, [serverCatalog]);

  const crownedProjects = useMemo(() => {
    const next = new Set(serverCrowned);
    for (const [project, crowned] of overrides) {
      if (crowned) next.add(project);
      else next.delete(project);
    }
    return next;
  }, [serverCrowned, overrides]);

  const toggleCrown = useCallback((project: string, crowned: boolean) => {
    setOverrides((previous) => new Map(previous).set(project, crowned));
    const sequence = (crownMutationSequences.current.get(project) ?? 0) + 1;
    crownMutationSequences.current.set(project, sequence);
    crownMutationAcknowledgements.current.delete(project);
    const previousMutation = crownMutationQueues.current.get(project) ?? Promise.resolve();
    const mutation = previousMutation.then(async () => {
      let succeeded = false;
      try {
        const response = await fetch("/api/projects/crown", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project, crowned }),
        });
        succeeded = response.ok;
      } catch {
        // The still-current optimistic choice is reverted below.
      }
      if (crownMutationSequences.current.get(project) !== sequence) return;
      if (succeeded) {
        crownMutationAcknowledgements.current.set(project, {
          sequence,
          afterPoll: crownPollSequence.current,
        });
        return;
      }
      crownMutationAcknowledgements.current.delete(project);
      setOverrides((previous) => {
        const next = new Map(previous);
        next.delete(project);
        return next;
      });
    });
    crownMutationQueues.current.set(project, mutation);
    void mutation.finally(() => {
      if (crownMutationQueues.current.get(project) !== mutation) return;
      crownMutationQueues.current.delete(project);
    });
  }, []);

  const createProject = useCallback(async (name: string, root: string, options?: CreateProjectRequestOptions): Promise<CreateProjectOutcome> => {
    let response: Response;
    try {
      response = await fetch("/api/projects/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(options?.createRoot ? { name, root, createRoot: true } : { name, root }),
      });
    } catch {
      return { ok: false, code: "NETWORK" };
    }
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // error shape below covers the empty body
    }
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
    if (!response.ok || typeof record?.project !== "string") {
      return {
        ok: false,
        code: typeof record?.error === "string" ? record.error : "ERROR",
        message: typeof record?.message === "string" ? record.message : undefined,
      };
    }
    const entry: ProjectCatalogEntry = {
      project: record.project,
      displayName: typeof record.displayName === "string" ? record.displayName : record.project,
      projectRoot: typeof record.root === "string" ? record.root : undefined,
      smt: typeof record.createdAt === "number" ? record.createdAt : Math.floor(Date.now() / 1000),
      conversations: 0,
    };
    setCreatedCatalog((previous) => [
      ...previous.filter((existing) => existing.project !== entry.project),
      entry,
    ]);
    return { ok: true, project: entry.project };
  }, []);

  return { crownedProjects, toggleCrown, createProject, createdCatalog };
}
