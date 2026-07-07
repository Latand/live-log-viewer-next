"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { projectKey } from "@/components/projectModel";
import type { FileEntry } from "@/lib/types";

const STORAGE_KEY = "llvArchivedProjects";

function readStored(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function writeStored(projects: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...projects]));
  } catch {
    // Private mode or full quota: archiving still works for the session, just doesn't persist.
  }
}

export interface UseArchivedProjects {
  archivedProjects: ReadonlySet<string>;
  archiveProject: (project: string) => void;
  unarchiveProject: (project: string) => void;
}

/**
 * Projects the user shelved without deleting their transcripts from disk.
 * Same contract as archived switchboard cards: persisted to localStorage,
 * but real activity always wins — a project where any entry goes live or
 * still has a running process is dropped from the set on the next files
 * update, so a new agent run brings the project back to the rail by itself.
 */
export function useArchivedProjects(files: FileEntry[]): UseArchivedProjects {
  const [archivedProjects, setArchivedProjects] = useState<Set<string>>(() => new Set());
  /* Mirrors `archivedProjects` synchronously so the drop-live-projects effect
     below can read the latest value without listing the state as its own
     dependency (see useArchivedPaths for the cascading-render rationale). */
  const archivedRef = useRef(archivedProjects);

  useEffect(() => {
    const loaded = readStored();
    archivedRef.current = loaded;
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setArchivedProjects(loaded);
  }, []);

  useEffect(() => {
    const prev = archivedRef.current;
    if (!prev.size) return;
    const next = new Set(prev);
    for (const file of files) {
      /* A running process counts as activity even when its last turn already
         finished (activity "recent", not "live") — an idle-but-alive agent in
         an archived project must still pull the project back to the rail. */
      if (file.activity === "live" || file.proc === "running") next.delete(projectKey(file));
    }
    if (next.size === prev.size) return;
    archivedRef.current = next;
    setArchivedProjects(next);
    writeStored(next);
  }, [files]);

  const archiveProject = useCallback((project: string) => {
    setArchivedProjects((prev) => {
      if (prev.has(project)) return prev;
      const next = new Set(prev);
      next.add(project);
      archivedRef.current = next;
      writeStored(next);
      return next;
    });
  }, []);

  const unarchiveProject = useCallback((project: string) => {
    setArchivedProjects((prev) => {
      if (!prev.has(project)) return prev;
      const next = new Set(prev);
      next.delete(project);
      archivedRef.current = next;
      writeStored(next);
      return next;
    });
  }, []);

  return { archivedProjects, archiveProject, unarchiveProject };
}
