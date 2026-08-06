"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { ProjectCatalogEntry } from "@/lib/types";

export type CreateProjectOutcome =
  | { ok: true; project: string }
  | { ok: false; code: string };

export interface UseProjectCuration {
  /** Server crowns with this tab's optimistic toggles layered on top. */
  crownedProjects: ReadonlySet<string>;
  toggleCrown: (project: string, crowned: boolean) => void;
  createProject: (name: string, root: string) => Promise<CreateProjectOutcome>;
  /** Freshly created projects, overlaid until the server catalog carries them. */
  createdCatalog: ProjectCatalogEntry[];
}

/**
 * Client seam over the server-durable crown/create state. The server list in
 * the /api/files payload is authoritative; this hook only bridges the gap
 * between a click and the next poll — an optimistic override per toggled
 * project (dropped as soon as the server agrees, reverted on a failed POST)
 * and a catalog overlay for a just-created project so its rail row exists in
 * the same frame.
 */
export function useProjectCuration(
  serverCrowned: readonly string[],
  serverCatalog: readonly ProjectCatalogEntry[],
): UseProjectCuration {
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [createdCatalog, setCreatedCatalog] = useState<ProjectCatalogEntry[]>([]);

  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- reconciling
       against the fresh server payload; the same-reference return below makes
       an already-settled state a render no-op, so nothing cascades. */
    setOverrides((previous) => {
      if (!previous.size) return previous;
      const next = new Map(previous);
      for (const [project, crowned] of previous) {
        if (serverCrowned.includes(project) === crowned) next.delete(project);
      }
      return next.size === previous.size ? previous : next;
    });
  }, [serverCrowned]);

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
    void fetch("/api/projects/crown", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, crowned }),
    }).then((response) => {
      if (response.ok) return;
      setOverrides((previous) => {
        const next = new Map(previous);
        next.delete(project);
        return next;
      });
    }).catch(() => {
      setOverrides((previous) => {
        const next = new Map(previous);
        next.delete(project);
        return next;
      });
    });
  }, []);

  const createProject = useCallback(async (name: string, root: string): Promise<CreateProjectOutcome> => {
    let response: Response;
    try {
      response = await fetch("/api/projects/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, root }),
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
      return { ok: false, code: typeof record?.error === "string" ? record.error : "ERROR" };
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
