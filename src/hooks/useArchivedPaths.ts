"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { FileEntry } from "@/lib/types";

const STORAGE_KEY = "llvArchived";

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

function writeStored(paths: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...paths]));
  } catch {
    // Private mode or full quota: archiving still works for the session, just doesn't persist.
  }
}

export interface UseArchivedPaths {
  archivedPaths: ReadonlySet<string>;
  archive: (path: string) => void;
  unarchive: (path: string) => void;
}

/**
 * Switchboard cards the user chose to hide. Persisted to localStorage so the
 * choice survives reloads, but real activity always wins: a path that goes
 * live again, or whose process is still running, is dropped from the set on
 * the next files update.
 */
export function useArchivedPaths(files: FileEntry[]): UseArchivedPaths {
  const [archivedPaths, setArchivedPaths] = useState<Set<string>>(() => new Set());
  /* Mirrors `archivedPaths` synchronously so the drop-live-entries effect below
     can read the latest value without listing the state as its own dependency
     (an effect that both depends on and sets the same state is what the
     set-state-in-effect lint rule flags as a cascading-render risk). */
  const archivedRef = useRef(archivedPaths);

  useEffect(() => {
    const loaded = readStored();
    archivedRef.current = loaded;
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setArchivedPaths(loaded);
  }, []);

  useEffect(() => {
    const prev = archivedRef.current;
    if (!prev.size) return;
    const next = new Set(prev);
    for (const file of files) {
      /* A running process counts as activity even after its last turn ends
         (activity "recent", not "live"), so an idle-but-alive card unhides. */
      if (file.activity === "live" || file.proc === "running") next.delete(file.path);
    }
    if (next.size === prev.size) return;
    archivedRef.current = next;
    setArchivedPaths(next);
    writeStored(next);
  }, [files]);

  const archive = useCallback((path: string) => {
    setArchivedPaths((prev) => {
      if (prev.has(path)) return prev;
      const next = new Set(prev);
      next.add(path);
      archivedRef.current = next;
      writeStored(next);
      return next;
    });
  }, []);

  const unarchive = useCallback((path: string) => {
    setArchivedPaths((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      archivedRef.current = next;
      writeStored(next);
      return next;
    });
  }, []);

  return { archivedPaths, archive, unarchive };
}
