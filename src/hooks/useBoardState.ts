"use client";

import { useEffect, useRef, useState } from "react";

import type { BoardProjectStateV1 } from "@/lib/view/types";

export type BoardPrefs = BoardProjectStateV1["prefs"];
export type BoardViewMode = BoardPrefs["viewMode"];
export type BoardSync = "current" | "pending" | "stale" | "unavailable";

const POLL_MS = 10_000;
/* Bounded PATCH retry after a network error. Re-draining synchronously spins
   thousands of failed requests in a single microtask turn and starves every
   timer (#11 review), so a failed flush waits a growing, capped, cancellable
   backoff and recovery cancels it. */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export const EMPTY_BOARD_PREFS: BoardPrefs = { manual: [], hidden: [], expanded: [], viewMode: null, taskPanelOpen: false };

/* Legacy per-browser keys #38 migrates off of. `llvTaskPanel` is global today;
   it seeds every project's per-project panel state and is left intact so a
   rollback keeps working. */
const legacyColumnsKey = (project: string) => `llvCols:${project}`;
const legacyViewKey = (project: string) => `llvEmptyView:${project}`;
const LEGACY_TASK_PANEL_KEY = "llvTaskPanel";

export interface BoardSnapshot {
  prefs: BoardPrefs;
  revision: number;
  sync: BoardSync;
  loaded: boolean;
}

export function isEmptyPrefs(prefs: BoardPrefs): boolean {
  return prefs.manual.length === 0 && prefs.hidden.length === 0 && prefs.expanded.length === 0 && prefs.viewMode === null && !prefs.taskPanelOpen;
}

/** Worth seeding the server with: anything a user actually arranged. Empty
    defaults leave the server uninitialized so the first real device wins. */
export function isMeaningfulPrefs(prefs: BoardPrefs): boolean {
  return !isEmptyPrefs(prefs);
}

function readStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

/** Reconstruct a project's arrangement from the old localStorage tiers, for the
    one-time migration seed. Returns null when nothing legacy exists. */
export function readLegacyPrefs(project: string, storage: Pick<Storage, "getItem"> | null): BoardPrefs | null {
  if (!storage) return null;
  let columns: { manual: string[]; hidden: string[]; expanded: string[] } = { manual: [], hidden: [], expanded: [] };
  let hadColumns = false;
  try {
    const raw = storage.getItem(legacyColumnsKey(project));
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      columns = { manual: readStringArray(parsed.manual), hidden: readStringArray(parsed.hidden), expanded: readStringArray(parsed.expanded) };
      hadColumns = true;
    }
  } catch {
    /* corrupt legacy blob — treat as absent */
  }
  const savedView = storage.getItem(legacyViewKey(project));
  const viewMode: BoardViewMode = savedView === "scheme" || savedView === "list" ? savedView : null;
  const taskPanelOpen = storage.getItem(LEGACY_TASK_PANEL_KEY) === "1";
  if (!hadColumns && viewMode === null && !taskPanelOpen) return null;
  return { ...columns, viewMode, taskPanelOpen };
}

/** Coalesce two partial patches: later keys win, so a burst of edits collapses
    into a single PATCH carrying the net intent. */
export function mergePatch(base: Partial<BoardPrefs> | null, next: Partial<BoardPrefs>): Partial<BoardPrefs> {
  return { ...(base ?? {}), ...next };
}

interface PendingOpen {
  manual: string[];
  expanded: string[];
}
/* Cross-project opens: a conversation added to a project's board before that
   project mounts. The intent is recorded here and flushed by that project's
   store on its next load (or at once if the store is already mounted), so the
   opened window survives the GET/PATCH race and reaches other devices. */
const pendingOpens = new Map<string, PendingOpen>();
const activeStores = new Map<string, () => void>();

/**
 * Pre-add a conversation to a project's board. A child conversation (`connected`
 * = isChildConversation, what the tree can nest) goes into the expand set so it
 * renders wired below its parent; anything else becomes a standalone manual
 * node. Records the intent and, if that project's board is mounted, flushes it.
 */
export function queueColumnOpen(project: string, path: string, connected = false): void {
  const entry = pendingOpens.get(project) ?? { manual: [], expanded: [] };
  if (connected) {
    if (!entry.expanded.includes(path)) entry.expanded.push(path);
  } else if (!entry.manual.includes(path)) {
    entry.manual.push(path);
  }
  pendingOpens.set(project, entry);
  activeStores.get(project)?.();
}

/** Test seam: clears queued cross-project opens between cases. */
export function resetPendingOpensForTest(): void {
  pendingOpens.clear();
  activeStores.clear();
}

type PatchAttempt =
  | { status: "ok"; board: BoardProjectStateV1 }
  | { status: "conflict"; board: BoardProjectStateV1 }
  | { status: "error" };

export interface BoardStoreOptions {
  project: string;
  fetcher: (input: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  storage: Pick<Storage, "getItem"> | null;
  scheduler?: {
    setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>;
    clearInterval(handle: ReturnType<typeof setInterval>): void;
    setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
    clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  };
}

export interface BoardStore {
  getSnapshot(): BoardSnapshot;
  subscribe(listener: () => void): () => void;
  patch(partial: Partial<BoardPrefs>): void;
  dispose(): void;
}

/**
 * The per-project durable board arrangement, moved off per-browser storage into
 * the shared server store. It loads the server state, runs the one-time legacy
 * seed, polls for changes other devices made, and applies edits optimistically:
 * a local patch updates the UI at once, then PATCHes; a revision conflict rebases
 * exactly once onto the server's state before giving up to the next poll. Legacy
 * localStorage is only read (for the seed), never written — a rollback keeps it.
 */
export function createBoardStore(options: BoardStoreOptions): BoardStore {
  const { project, fetcher, storage } = options;
  const scheduler = options.scheduler ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
  const getUrl = "/api/board?project=" + encodeURIComponent(project);

  let snapshot: BoardSnapshot = { prefs: EMPTY_BOARD_PREFS, revision: 0, sync: "unavailable", loaded: false };
  let pending: Partial<BoardPrefs> | null = null;
  let inflight = false;
  let disposed = false;
  let retryHandle: ReturnType<typeof scheduler.setTimeout> | null = null;
  let retryDelay = RETRY_BASE_MS;
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };
  const set = (next: Partial<BoardSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    emit();
  };
  const syncFor = (): BoardSync => (inflight || pending ? "pending" : "current");
  const adopt = (board: BoardProjectStateV1) => {
    set({ prefs: board.prefs, revision: board.revision, sync: syncFor(), loaded: true });
  };

  const attempt = async (patch: Partial<BoardPrefs>, baseRevision: number): Promise<PatchAttempt> => {
    try {
      const res = await fetcher("/api/board", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, project, baseRevision, patch }),
      });
      if (res.ok) return { status: "ok", board: ((await res.json()) as { board: BoardProjectStateV1 }).board };
      if (res.status === 409) return { status: "conflict", board: ((await res.json()) as { board: BoardProjectStateV1 }).board };
      return { status: "error" };
    } catch {
      return { status: "error" };
    }
  };

  const applyPatch = (partial: Partial<BoardPrefs>) => {
    /* Optimistic: reflect the edit immediately, then queue the PATCH. */
    snapshot = { ...snapshot, prefs: { ...snapshot.prefs, ...partial }, sync: "pending" };
    emit();
    pending = mergePatch(pending, partial);
    void drain();
  };

  /* Flush any cross-project opens queued for this project into a single patch.
     Runs after the store has loaded, so it merges onto the server's arrangement
     rather than an empty placeholder. */
  const drainOpens = () => {
    if (!snapshot.loaded || disposed) return;
    const open = pendingOpens.get(project);
    if (!open || (open.manual.length === 0 && open.expanded.length === 0)) return;
    pendingOpens.delete(project);
    const opened = new Set([...open.manual, ...open.expanded]);
    applyPatch({
      manual: [...new Set([...snapshot.prefs.manual, ...open.manual])],
      expanded: [...new Set([...snapshot.prefs.expanded, ...open.expanded])],
      hidden: snapshot.prefs.hidden.filter((path) => !opened.has(path)),
    });
  };

  /* Cancel a scheduled backoff and reset the delay — called on any accepted
     PATCH and on disposal, so a healed network starts the next failure fresh. */
  const cancelRetry = () => {
    if (retryHandle !== null) {
      scheduler.clearTimeout(retryHandle);
      retryHandle = null;
    }
    retryDelay = RETRY_BASE_MS;
  };
  /* Arm the bounded backoff after a network error: one timer at a time, delay
     doubling up to the cap. The queued patch drains when it fires. */
  const scheduleRetry = () => {
    if (retryHandle !== null || disposed) return;
    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    retryHandle = scheduler.setTimeout(() => {
      retryHandle = null;
      void drain();
    }, delay);
  };

  const drain = async () => {
    if (inflight || !pending || disposed) return;
    const patch = pending;
    pending = null;
    inflight = true;
    set({ sync: "pending" });
    const first = await attempt(patch, snapshot.revision);
    if (first.status === "ok") {
      cancelRetry();
      adopt(first.board);
    } else if (first.status === "conflict") {
      /* Rebase exactly once: take the server's state, replay this intent on top,
         resubmit. A second conflict means another writer keeps winning — adopt
         the server and let the poll reconcile. */
      set({ prefs: { ...first.board.prefs, ...patch }, revision: first.board.revision });
      const second = await attempt(patch, first.board.revision);
      if (second.status === "ok") cancelRetry();
      adopt(second.status === "ok" ? second.board : first.board);
    } else {
      /* Network error: keep the optimistic prefs and requeue, then back off on a
         cancellable timer. Re-draining synchronously here spins thousands of
         failed PATCHes in one microtask turn and starves every timer (#11); the
         backoff retries and any accepted PATCH cancels it. */
      pending = mergePatch(patch, pending ?? {});
      inflight = false;
      set({ sync: syncFor() });
      scheduleRetry();
      return;
    }
    inflight = false;
    set({ sync: syncFor() });
    if (pending) void drain();
  };

  const load = async () => {
    let board: BoardProjectStateV1 | null = null;
    try {
      const res = await fetcher(getUrl);
      if (res.ok) board = ((await res.json()) as { board: BoardProjectStateV1 }).board;
    } catch {
      board = null;
    }
    if (disposed) return;
    if (!board) {
      set({ sync: "unavailable", loaded: true });
      return;
    }
    if (board.revision === 0 && isEmptyPrefs(board.prefs)) {
      const seed = readLegacyPrefs(project, storage);
      if (seed && isMeaningfulPrefs(seed)) {
        set({ prefs: seed, revision: 0, sync: "pending", loaded: true });
        inflight = true;
        const result = await attempt(seed, 0);
        inflight = false;
        if (!disposed) {
          adopt(result.status === "error" ? board : result.board);
          /* An edit made while the seed PATCH was inflight parked in `pending`
             (drain early-returns during inflight); flush it now instead of
             leaving it stranded until the next edit. */
          if (pending) void drain();
        }
        return;
      }
    }
    adopt(board);
  };

  const poll = () => {
    if (inflight || pending || disposed) return;
    void (async () => {
      try {
        const res = await fetcher(getUrl);
        if (!res.ok) return;
        const board = ((await res.json()) as { board: BoardProjectStateV1 }).board;
        /* Another device moved the board: adopt it, but never clobber a local
           edit that has not yet flushed (guarded by the pending/inflight check). */
        if (!inflight && !pending && !disposed && board.revision !== snapshot.revision) adopt(board);
      } catch {
        /* transient — next tick retries */
      }
    })();
  };

  activeStores.set(project, drainOpens);
  void load().then(drainOpens);
  const interval = scheduler.setInterval(poll, POLL_MS);

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    patch(partial) {
      applyPatch(partial);
    },
    dispose() {
      disposed = true;
      cancelRetry();
      if (activeStores.get(project) === drainOpens) activeStores.delete(project);
      scheduler.clearInterval(interval);
      listeners.clear();
    },
  };
}

const UNAVAILABLE_SNAPSHOT: BoardSnapshot = { prefs: EMPTY_BOARD_PREFS, revision: 0, sync: "unavailable", loaded: false };

export interface BoardState extends BoardSnapshot {
  patchColumns(columns: Pick<BoardPrefs, "manual" | "hidden" | "expanded">): void;
  setViewMode(viewMode: BoardViewMode): void;
  setTaskPanelOpen(open: boolean): void;
}

/**
 * React binding over `createBoardStore`: one store per project, its snapshot
 * mirrored into component state. `project === null` (overview) has no board — it
 * returns the unavailable snapshot with inert setters.
 */
export function useBoardState(project: string | null): BoardState {
  const storeRef = useRef<BoardStore | null>(null);
  const [snapshot, setSnapshot] = useState<BoardSnapshot>(UNAVAILABLE_SNAPSHOT);

  useEffect(() => {
    if (typeof window === "undefined" || project === null) {
      storeRef.current = null;
      /* eslint-disable-next-line react-hooks/set-state-in-effect */
      setSnapshot(UNAVAILABLE_SNAPSHOT);
      return;
    }
    let storage: Pick<Storage, "getItem"> | null = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    const store = createBoardStore({ project, fetcher: (input, init) => fetch(input, init), storage });
    storeRef.current = store;
    setSnapshot(store.getSnapshot());
    const unsubscribe = store.subscribe(() => setSnapshot(store.getSnapshot()));
    return () => {
      unsubscribe();
      store.dispose();
      storeRef.current = null;
    };
  }, [project]);

  return {
    ...snapshot,
    patchColumns(columns) {
      storeRef.current?.patch(columns);
    },
    setViewMode(viewMode) {
      storeRef.current?.patch({ viewMode });
    },
    setTaskPanelOpen(open) {
      storeRef.current?.patch({ taskPanelOpen: open });
    },
  };
}
