"use client";

import { useEffect, useState } from "react";

import { FLOWS_CHANGED_EVENT } from "@/components/flows/flowModel";
import { PIPELINES_CHANGED_EVENT, PIPELINES_PATCHED_EVENT } from "@/components/pipelines/pipelineEvents";
import { SESSION_TITLES_CHANGED_EVENT } from "@/components/session/sessionTitleApi";
import { TASKS_CHANGED_EVENT } from "@/components/tasks/taskApi";
import { WORKFLOWS_CHANGED_EVENT } from "@/components/workflows/workflowModel";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { TmuxEndpointHealth } from "@/lib/tmux";
import type { FileEntry, FilesResponse, ProjectCatalogEntry } from "@/lib/types";
import type { Workflow } from "@/lib/workflows/types";

import { getRuntimeBus, isRuntimeUiEnabled } from "./runtimeBus";

/** The universal fallback cadence — also the only source for legacy sessions. */
const POLL_MS = 10_000;
/** Debounce after a `files.revision` event before the pure GET fires. */
const FILES_DEBOUNCE_MS = 400;
const FILES_REVISION_RETRY_MS = 1_000;

export interface FilesData {
  files: FileEntry[];
  /** Membership added by the current deep-link request above the global cap. */
  pinOverlayPaths: string[];
  /** Successful request URL that produced `files`; used for scope-aware effects. */
  requestScope: string | null;
  projectCatalog: ProjectCatalogEntry[];
  projectCwds: Record<string, string>;
  flows: Flow[];
  pipelines: Pipeline[];
  workflows: Workflow[];
  tasks: BoardTask[];
  /** Set when the server's pipelines store failed closed for this poll. */
  pipelinesError?: string;
  systemHealth: { tmux: TmuxEndpointHealth };
  conversationAliases: Record<string, string>;
  loaded: boolean;
}

const HEALTHY_SYSTEM = { tmux: { status: "healthy" as const } };
const EMPTY: FilesData = { files: [], pinOverlayPaths: [], requestScope: null, projectCatalog: [], projectCwds: {}, flows: [], pipelines: [], workflows: [], tasks: [], systemHealth: HEALTHY_SYSTEM, conversationAliases: {}, loaded: false };

export function filesApiUrl(_project?: string | null, pinnedPath?: string | null): string {
  const params: string[] = [];
  /* A pending legacy `#f=` target: the scanner keeps this exact transcript in
     the capped feed so the deep link can resolve its conversation id even
     when the path is a demoted archived predecessor. */
  if (pinnedPath) params.push("path=" + encodeURIComponent(pinnedPath));
  return params.length ? "/api/files?" + params.join("&") : "/api/files";
}

type FilesFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface FilesClientCache {
  read(): FilesData;
  revalidate(pinnedPath?: string | null, revision?: number): Promise<FilesData>;
  /** Layer one pipeline record over the server snapshot without a refetch — an
      optimistic local mutation (`confirmed: false`, held until reverted or
      confirmed) or a PATCH/POST echo (`confirmed: true`, held only until a scan
      requested after the echo lands and becomes authoritative). */
  applyPipeline(pipeline: Pipeline, confirmed: boolean): void;
  /** Drop a local overlay (a failed optimistic mutation) — the server snapshot
      is authoritative again. */
  revertPipeline(id: string): void;
}

function equalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function patchRows<T>(previous: readonly T[], incoming: readonly T[], keyOf: (value: T) => string): T[] {
  const previousByKey = new Map(previous.map((value) => [keyOf(value), value] as const));
  return incoming.map((value) => {
    const cached = previousByKey.get(keyOf(value));
    return cached !== undefined && equalValue(cached, value) ? cached : value;
  });
}

function parsedFilesData(parsed: FilesResponse | FileEntry[], requestScope: string): FilesData {
  if (Array.isArray(parsed)) {
    return { files: parsed, pinOverlayPaths: [], requestScope, projectCatalog: [], projectCwds: {}, flows: [], pipelines: [], workflows: [], tasks: [], systemHealth: HEALTHY_SYSTEM, conversationAliases: {}, loaded: true };
  }
  return {
    files: parsed.files ?? [],
    pinOverlayPaths: parsed.pinOverlayPaths ?? [],
    requestScope,
    projectCatalog: parsed.projectCatalog ?? [],
    projectCwds: parsed.projectCwds ?? {},
    flows: parsed.flows ?? [],
    pipelines: parsed.pipelines ?? [],
    workflows: parsed.workflows ?? [],
    tasks: parsed.tasks ?? [],
    pipelinesError: parsed.pipelinesError,
    systemHealth: parsed.systemHealth ?? HEALTHY_SYSTEM,
    conversationAliases: parsed.conversationAliases ?? {},
    loaded: true,
  };
}

function patchFilesData(previous: FilesData, incoming: FilesData): FilesData {
  return {
    ...incoming,
    files: patchRows(previous.files, incoming.files, (file) => file.path),
    projectCatalog: patchRows(previous.projectCatalog, incoming.projectCatalog, (entry) => entry.project),
    projectCwds: equalValue(previous.projectCwds, incoming.projectCwds) ? previous.projectCwds : incoming.projectCwds,
    flows: patchRows(previous.flows, incoming.flows, (flow) => flow.id),
    pipelines: patchRows(previous.pipelines, incoming.pipelines, (pipeline) => pipeline.id),
    workflows: patchRows(previous.workflows, incoming.workflows, (workflow) => workflow.id),
    tasks: patchRows(previous.tasks, incoming.tasks, (task) => task.id),
    systemHealth: equalValue(previous.systemHealth, incoming.systemHealth) ? previous.systemHealth : incoming.systemHealth,
    conversationAliases: equalValue(previous.conversationAliases, incoming.conversationAliases)
      ? previous.conversationAliases
      : incoming.conversationAliases,
  };
}

/** Restore the exact URL-specific representation certified by a strong ETag.
    Structural patching keeps unchanged row identities without carrying rows
    that only appeared in another request scope. */
function restoreNotModified(current: FilesData, representation: FilesData, requestScope: string): FilesData {
  return patchFilesData(current, { ...representation, requestScope });
}

/** Session-wide stale-while-revalidate cache over the global scan snapshot. */
export function createFilesClientCache(fetcher: FilesFetcher): FilesClientCache {
  let snapshot = EMPTY;
  const representations = new Map<string, { data: FilesData; etag?: string }>();
  let requestedGeneration = 0;
  let appliedGeneration = 0;
  let requestQueue: Promise<void> = Promise.resolve();
  /* Locally patched pipelines (issue #221 instant stage mutations): each entry
     shadows the server row until a scan that was REQUESTED after the mutation
     confirmed (`minGeneration`) arrives — an in-flight stale scan can never
     roll an applied edit back. `pipeline: null` hides a locally deleted draft. */
  const pipelineOverlays = new Map<string, { pipeline: Pipeline | null; minGeneration: number }>();
  let serverPipelines: readonly Pipeline[] = EMPTY.pipelines;

  const composePipelines = () => {
    if (!pipelineOverlays.size) {
      snapshot = { ...snapshot, pipelines: [...serverPipelines] };
      return;
    }
    const seen = new Set<string>();
    const pipelines = serverPipelines.flatMap((pipeline) => {
      const entry = pipelineOverlays.get(pipeline.id);
      if (!entry) return [pipeline];
      seen.add(pipeline.id);
      return entry.pipeline ? [entry.pipeline] : [];
    });
    for (const [id, entry] of pipelineOverlays) {
      if (!seen.has(id) && entry.pipeline) pipelines.push(entry.pipeline);
    }
    snapshot = { ...snapshot, pipelines };
  };

  /** The server snapshot from `generation` reflects every overlay whose
      minGeneration it reaches — those overlays retire; younger ones re-apply. */
  const settleServerPipelines = (generation: number) => {
    serverPipelines = snapshot.pipelines;
    for (const [id, entry] of pipelineOverlays) {
      if (entry.minGeneration <= generation) pipelineOverlays.delete(id);
    }
    if (pipelineOverlays.size) composePipelines();
  };

  const rememberRepresentation = (url: string, data: FilesData, etag?: string) => {
    representations.delete(url);
    representations.set(url, { data, etag });
    while (representations.size > 8) {
      const oldest = representations.keys().next().value;
      if (oldest === undefined) break;
      representations.delete(oldest);
    }
  };

  const performRevalidate = async (pinnedPath?: string | null, revision?: number): Promise<FilesData> => {
    const generation = ++requestedGeneration;
    const url = filesApiUrl(undefined, pinnedPath);
    const representation = representations.get(url);
    const headers = filesRequestHeaders(representation?.etag ?? "", revision);
    const response = await fetcher(url, headers ? { headers } : undefined);
    if (response.status === 304) {
      if (!representation) throw new Error("files request returned 304 without a cached representation");
      if (generation < appliedGeneration) return snapshot;
      snapshot = restoreNotModified(snapshot, representation.data, url);
      appliedGeneration = generation;
      rememberRepresentation(url, snapshot, representation.etag);
      settleServerPipelines(generation);
      return snapshot;
    }
    if (!response.ok) throw new Error(`files request failed: ${response.status}`);
    const parsed = JSON.parse(await response.text()) as FilesResponse | FileEntry[];
    if (generation < appliedGeneration) return snapshot;
    const incoming = parsedFilesData(parsed, url);
    snapshot = patchFilesData(snapshot, incoming);
    appliedGeneration = generation;
    const etag = response.headers.get("ETag");
    rememberRepresentation(url, snapshot, etag ?? undefined);
    settleServerPipelines(generation);
    return snapshot;
  };

  const revalidate = (pinnedPath?: string | null, revision?: number): Promise<FilesData> => {
    const result = requestQueue.then(() => performRevalidate(pinnedPath, revision));
    requestQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  const applyPipeline = (pipeline: Pipeline, confirmed: boolean) => {
    /* A deleted/closed draft echo carries hiddenAt — locally it just disappears
       (the server's visibility filter drops it from the next scan too). */
    const hidden = Boolean(pipeline.hiddenAt) && !pipeline.restored;
    pipelineOverlays.set(pipeline.id, {
      pipeline: hidden ? null : pipeline,
      /* An unconfirmed (optimistic) overlay outlives every scan until its PATCH
         echoes or fails; a confirmed one only until a younger scan carries it. */
      minGeneration: confirmed ? requestedGeneration + 1 : Number.POSITIVE_INFINITY,
    });
    composePipelines();
  };

  const revertPipeline = (id: string) => {
    if (!pipelineOverlays.delete(id)) return;
    composePipelines();
  };

  return { read: () => snapshot, revalidate, applyPipeline, revertPipeline };
}

const defaultFilesFetcher: FilesFetcher = (input, init) => fetch(input, init);
let filesClientCache = createFilesClientCache(defaultFilesFetcher);

export function resetFilesClientCacheForTests(): void {
  filesClientCache = createFilesClientCache(defaultFilesFetcher);
}

/**
 * Apply a locally-known pipeline record (an optimistic mutation or a PATCH/POST
 * echo) straight into the client cache and notify every mounted `useFiles` —
 * the board updates in the same frame, with NO /api/files refetch (issue #221:
 * instant stage add/remove). `confirmed: false` marks a not-yet-persisted
 * optimistic state; confirm it with the echo or roll it back with
 * {@link revertPipelineSnapshot}.
 */
export function applyPipelineSnapshot(pipeline: Pipeline, confirmed: boolean): void {
  filesClientCache.applyPipeline(pipeline, confirmed);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PIPELINES_PATCHED_EVENT));
}

/** Roll back a failed optimistic pipeline mutation to the server snapshot. */
export function revertPipelineSnapshot(id: string): void {
  filesClientCache.revertPipeline(id);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PIPELINES_PATCHED_EVENT));
}

export function filesRequestHeaders(etag: string, revision?: number): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (etag) headers["If-None-Match"] = etag;
  if (revision !== undefined) headers["x-llv-files-revision"] = String(revision);
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * The recurring `/api/files` cadence given the runtime connection: a healthy
 * live stream removes the timer entirely (`live`, freshness rides
 * `files.revision`), every other state keeps the bounded 10s fallback poll.
 */
export function filesPollCadence(connection: "live" | "reconnecting" | "degraded" | "offline"): "poll" | "live" {
  return connection === "live" ? "live" : "poll";
}

/** Polls /api/files. Keeps the last good list on transient fetch errors. */
export function useFiles(_project?: string | null, pinnedPath?: string | null): FilesData {
  const [data, setData] = useState<FilesData>(() => filesClientCache.read());
  useEffect(() => {
    let alive = true;
    const performLoad = async (revision?: number): Promise<boolean> => {
      if (!alive) return true;
      try {
        const next = await filesClientCache.revalidate(pinnedPath, revision);
        if (alive) setData(next);
        return true;
      } catch {
        /* keep previous list */
        return false;
      }
    };
    let loadQueue: Promise<void> = Promise.resolve();
    const load = (revision?: number): Promise<boolean> => {
      const result = loadQueue.then(() => performLoad(revision));
      loadQueue = result.then(() => undefined);
      return result;
    };
    let initialRetryTimer: ReturnType<typeof setTimeout> | null = null;
    const hydrateInitial = async () => {
      const hydrated = await load();
      if (!alive || hydrated) return;
      initialRetryTimer = setTimeout(() => {
        initialRetryTimer = null;
        void hydrateInitial();
      }, FILES_REVISION_RETRY_MS);
    };
    void hydrateInitial();

    /*
     * Recurring poll cadence. With the runtime bus off (the default,
     * landing-disabled slice) this stays a flat 10s poll — identical to before.
     * With the bus healthy the recurring timer is removed entirely: freshness
     * rides `files.revision` events (a debounced pure GET), satisfying "healthy
     * SSE disables the recurring /api/files timer". When the bus degrades, the
     * 10s fallback poll is restored.
     */
    let timer: ReturnType<typeof setInterval> | null = null;
    let mode: "poll" | "live" | null = null;
    const setCadence = (next: "poll" | "live") => {
      if (next === mode) return;
      mode = next;
      if (timer) clearInterval(timer);
      timer = next === "poll" ? setInterval(load, POLL_MS) : null;
    };

    /* Flow, workflow and task mutations refresh out of band: strips and
       cards must not sit on stale state for up to a full poll interval. */
    const onChanged = () => void load();
    /* A locally-applied pipeline patch (optimistic mutation / PATCH echo) is
       already in the cache — re-read it, never refetch. */
    const onPatched = () => {
      if (alive) setData(filesClientCache.read());
    };
    window.addEventListener(PIPELINES_PATCHED_EVENT, onPatched);
    window.addEventListener(FLOWS_CHANGED_EVENT, onChanged);
    window.addEventListener(PIPELINES_CHANGED_EVENT, onChanged);
    window.addEventListener(WORKFLOWS_CHANGED_EVENT, onChanged);
    window.addEventListener(TASKS_CHANGED_EVENT, onChanged);
    window.addEventListener(SESSION_TITLES_CHANGED_EVENT, onChanged);

    let unsubBus = () => {};
    let unsubFiles = () => {};
    let revisionTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingRevision: number | null = null;
    let revisionHydrating = false;
    const scheduleRevisionHydration = (delay: number) => {
      if (revisionTimer) clearTimeout(revisionTimer);
      revisionTimer = setTimeout(() => {
        revisionTimer = null;
        void hydratePendingRevision();
      }, delay);
    };
    const hydratePendingRevision = async () => {
      if (revisionHydrating || pendingRevision === null) return;
      revisionHydrating = true;
      const requestedRevision = pendingRevision;
      const hydrated = await load(requestedRevision);
      revisionHydrating = false;
      if (!alive) return;
      if (hydrated && pendingRevision === requestedRevision) pendingRevision = null;
      if (pendingRevision !== null) {
        scheduleRevisionHydration(hydrated ? 0 : FILES_REVISION_RETRY_MS);
      }
    };
    if (isRuntimeUiEnabled() && typeof window !== "undefined") {
      const bus = getRuntimeBus();
      const applyConnection = () => setCadence(filesPollCadence(bus.getState().connection));
      applyConnection();
      unsubBus = bus.subscribe(applyConnection);
      unsubFiles = bus.subscribeFilesRevision((revision) => {
        pendingRevision = pendingRevision === null ? revision : Math.max(pendingRevision, revision);
        scheduleRevisionHydration(FILES_DEBOUNCE_MS);
      });
    } else {
      setCadence("poll");
    }

    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      if (initialRetryTimer) clearTimeout(initialRetryTimer);
      if (revisionTimer) clearTimeout(revisionTimer);
      unsubBus();
      unsubFiles();
      window.removeEventListener(PIPELINES_PATCHED_EVENT, onPatched);
      window.removeEventListener(FLOWS_CHANGED_EVENT, onChanged);
      window.removeEventListener(PIPELINES_CHANGED_EVENT, onChanged);
      window.removeEventListener(WORKFLOWS_CHANGED_EVENT, onChanged);
      window.removeEventListener(TASKS_CHANGED_EVENT, onChanged);
      window.removeEventListener(SESSION_TITLES_CHANGED_EVENT, onChanged);
    };
  }, [pinnedPath]);
  return data;
}
