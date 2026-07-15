"use client";

import { useEffect, useState } from "react";
import { flushSync } from "react-dom";

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
const FILES_GENERATION_RETRY_MS = 25;
const FILES_GENERATION_RETRY_MAX_MS = 1_000;

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
type CompletionRetry = {
  pinnedPath?: string | null;
  revision?: number;
  targetGeneration: number;
  logicalGeneration: number;
  attempt: number;
  phase: "scheduled" | "queued" | "active" | "canceled";
  timer?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
};

export interface FilesClientCache {
  read(): FilesData;
  /** Return only the representation previously certified for this request URL. */
  readScope(pinnedPath?: string | null): FilesData;
  revalidate(pinnedPath?: string | null, revision?: number): Promise<FilesData>;
  subscribe(listener: (data: FilesData) => void, pinnedPath?: string | null): () => void;
  /** Layer one pipeline record over the server snapshot without a refetch — an
      optimistic local mutation (`confirmed: false`, held until reverted or
      confirmed) or a PATCH/POST echo (`confirmed: true`, held only until a scan
      requested after the echo lands and becomes authoritative). */
  applyPipeline(pipeline: Pipeline, confirmed: boolean): void;
  /** Drop a local overlay (a failed optimistic mutation) — the server snapshot
      is authoritative again. */
  revertPipeline(id: string): void;
  /** Cancel owned retries and detach subscribers. A disposed cache is inert. */
  dispose(): void;
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
  let disposed = false;
  const representations = new Map<string, { data: FilesData; etag?: string }>();
  const listeners = new Map<(data: FilesData) => void, string>();
  const completionRetries = new Map<string, CompletionRetry>();
  let requestedGeneration = 0;
  let appliedGeneration = 0;
  let requestQueue: Promise<void> = Promise.resolve();
  /* Locally patched pipelines (issue #221 instant stage mutations): each entry
     shadows the server row until a scan that was REQUESTED after the mutation
     confirmed (`minGeneration`) arrives — an in-flight stale scan can never
     roll an applied edit back. `pipeline: null` hides a locally deleted draft. */
  const pipelineOverlays = new Map<string, { pipeline: Pipeline | null; minGeneration: number }>();
  let serverPipelines: readonly Pipeline[] = EMPTY.pipelines;

  const pipelinesWithOverlays = (pipelines: readonly Pipeline[]): Pipeline[] => {
    if (!pipelineOverlays.size) return [...pipelines];
    const seen = new Set<string>();
    const composed = pipelines.flatMap((pipeline) => {
      const entry = pipelineOverlays.get(pipeline.id);
      if (!entry) return [pipeline];
      seen.add(pipeline.id);
      return entry.pipeline ? [entry.pipeline] : [];
    });
    for (const [id, entry] of pipelineOverlays) {
      if (!seen.has(id) && entry.pipeline) composed.push(entry.pipeline);
    }
    return composed;
  };

  const withPipelineOverlays = (data: FilesData): FilesData => ({
    ...data,
    pipelines: pipelinesWithOverlays(data.pipelines),
  });

  const exactScopeRepresentation = (requestScope: string): FilesData => {
    const representation = representations.get(requestScope)?.data
      ?? (snapshot.requestScope === requestScope ? snapshot : { ...EMPTY, requestScope });
    return withPipelineOverlays(representation);
  };

  const exactScopeSnapshot = (pinnedPath?: string | null): FilesData =>
    exactScopeRepresentation(filesApiUrl(undefined, pinnedPath));

  const publish = (requestScope?: string) => {
    if (disposed) return;
    for (const [listener, scope] of listeners) {
      if (requestScope !== undefined) {
        if (requestScope === scope) listener(snapshot);
        continue;
      }
      listener(exactScopeRepresentation(scope));
    }
  };

  const hasSubscriber = (requestScope: string): boolean =>
    [...listeners.values()].some((scope) => scope === requestScope);

  const cancelCompletionRetry = (requestScope: string) => {
    const retry = completionRetries.get(requestScope);
    if (!retry) return;
    completionRetries.delete(requestScope);
    retry.phase = "canceled";
    if (retry.timer !== undefined) clearTimeout(retry.timer);
    retry.controller?.abort();
  };

  const ownsCompletionRetry = (requestScope: string, retry: CompletionRetry): boolean =>
    retry.phase !== "canceled"
    && completionRetries.get(requestScope) === retry
    && hasSubscriber(requestScope);

  const composePipelines = () => {
    snapshot = { ...snapshot, pipelines: pipelinesWithOverlays(serverPipelines) };
  };

  /** A completed server snapshot from `generation` reflects every overlay whose
      minGeneration it reaches — those overlays retire; younger ones re-apply. */
  const settleServerPipelines = (generation: number, complete: boolean) => {
    serverPipelines = snapshot.pipelines;
    if (complete) {
      for (const [id, entry] of pipelineOverlays) {
        if (entry.minGeneration <= generation) pipelineOverlays.delete(id);
      }
    }
    if (pipelineOverlays.size) composePipelines();
  };

  const trimRepresentations = () => {
    while (representations.size > 8) {
      const evictable = [...representations.keys()].find((url) => !hasSubscriber(url));
      if (evictable === undefined) break;
      representations.delete(evictable);
    }
  };

  const rememberRepresentation = (url: string, data: FilesData, etag?: string) => {
    representations.delete(url);
    representations.set(url, { data, etag });
    trimRepresentations();
  };

  const performRevalidate = async (
    pinnedPath?: string | null,
    revision?: number,
    requiredGeneration?: number,
    logicalGeneration?: number,
    completionRetryAttempt = 0,
    completionRetry?: CompletionRetry,
  ): Promise<FilesData> => {
    if (disposed) return snapshot;
    const url = filesApiUrl(undefined, pinnedPath);
    if (completionRetry) {
      if (!ownsCompletionRetry(url, completionRetry)) return snapshot;
      completionRetry.phase = "active";
      completionRetry.controller = new AbortController();
    }
    const generation = ++requestedGeneration;
    const representation = representations.get(url);
    const headers = filesRequestHeaders(representation?.etag ?? "", revision, requiredGeneration);
    const init = headers || completionRetry?.controller
      ? { ...(headers ? { headers } : {}), ...(completionRetry?.controller ? { signal: completionRetry.controller.signal } : {}) }
      : undefined;
    let response: Response;
    try {
      response = await fetcher(url, init);
    } finally {
      if (completionRetry) completionRetry.controller = undefined;
    }
    if (disposed) return snapshot;
    if (completionRetry && !ownsCompletionRetry(url, completionRetry)) return snapshot;
    const servedGeneration = responseGeneration(response, "x-llv-files-generation");
    const targetGeneration = responseGeneration(response, "x-llv-files-target-generation");
    const generationIncomplete = servedGeneration !== undefined
      && targetGeneration !== undefined
      && servedGeneration < targetGeneration;
    if (response.status === 304) {
      if (!representation) throw new Error("files request returned 304 without a cached representation");
      if (generation < appliedGeneration) return snapshot;
      snapshot = restoreNotModified(snapshot, representation.data, url);
      appliedGeneration = generation;
      rememberRepresentation(url, snapshot, representation.etag);
      settleServerPipelines(logicalGeneration ?? generation, !generationIncomplete);
      publish(url);
      if (generationIncomplete) {
        scheduleCompletionRetry(
          url,
          pinnedPath,
          revision,
          targetGeneration,
          logicalGeneration ?? generation,
          completionRetryAttempt,
          completionRetry,
        );
      } else {
        cancelCompletionRetry(url);
      }
      return snapshot;
    }
    if (!response.ok) throw new Error(`files request failed: ${response.status}`);
    const parsed = JSON.parse(await response.text()) as FilesResponse | FileEntry[];
    if (completionRetry && !ownsCompletionRetry(url, completionRetry)) return snapshot;
    if (generation < appliedGeneration) return snapshot;
    const incoming = parsedFilesData(parsed, url);
    /* A restarted server can acknowledge a pinned target generation with its
       global-only stale snapshot before the pin hydration resumes. Keep the
       last URL-scoped completed representation mounted until that generation
       supplies the target, so the deep-link owner retains its subscription. */
    const scopedIncoming = generationIncomplete && pinnedPath
      && representation?.data.files.some((file) => file.path === pinnedPath)
      ? { ...representation.data, requestScope: url }
      : incoming;
    snapshot = patchFilesData(snapshot, scopedIncoming);
    appliedGeneration = generation;
    const etag = response.headers.get("ETag");
    rememberRepresentation(url, snapshot, etag ?? undefined);
    settleServerPipelines(logicalGeneration ?? generation, !generationIncomplete);
    publish(url);
    if (generationIncomplete) {
      scheduleCompletionRetry(
        url,
        pinnedPath,
        revision,
        targetGeneration,
        logicalGeneration ?? generation,
        completionRetryAttempt,
        completionRetry,
      );
    } else {
      cancelCompletionRetry(url);
    }
    return snapshot;
  };

  const enqueueRevalidate = (
    pinnedPath?: string | null,
    revision?: number,
    requiredGeneration?: number,
    logicalGeneration?: number,
    completionRetryAttempt?: number,
    completionRetry?: CompletionRetry,
  ): Promise<FilesData> => {
    if (disposed) return Promise.resolve(snapshot);
    const result = requestQueue.then(() => performRevalidate(
      pinnedPath,
      revision,
      requiredGeneration,
      logicalGeneration,
      completionRetryAttempt,
      completionRetry,
    ));
    requestQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  const scheduleCompletionRetry = (
    url: string,
    pinnedPath: string | null | undefined,
    revision: number | undefined,
    targetGeneration: number,
    logicalGeneration: number,
    attempt: number,
    owner?: CompletionRetry,
  ) => {
    if (disposed) return;
    if (!hasSubscriber(url)) {
      if (owner) cancelCompletionRetry(url);
      return;
    }
    const pending = completionRetries.get(url);
    if (owner) {
      if (pending !== owner || owner.phase === "canceled") return;
    } else if (pending) {
      if (pending.targetGeneration < targetGeneration) {
        pending.pinnedPath = pinnedPath;
        pending.revision = revision;
        pending.targetGeneration = targetGeneration;
        pending.logicalGeneration = logicalGeneration;
      }
      return;
    }
    const retry: CompletionRetry = owner ?? {
      pinnedPath,
      revision,
      targetGeneration,
      logicalGeneration,
      attempt,
      phase: "scheduled",
    };
    retry.pinnedPath = pinnedPath;
    retry.revision = revision;
    retry.targetGeneration = targetGeneration;
    retry.logicalGeneration = logicalGeneration;
    retry.attempt = attempt;
    retry.phase = "scheduled";
    if (!owner) completionRetries.set(url, retry);
    const delay = Math.min(
      FILES_GENERATION_RETRY_MAX_MS,
      FILES_GENERATION_RETRY_MS * 2 ** Math.min(attempt, 10),
    );
    retry.timer = setTimeout(() => {
      retry.timer = undefined;
      if (!ownsCompletionRetry(url, retry)) {
        cancelCompletionRetry(url);
        return;
      }
      retry.phase = "queued";
      const nextAttempt = retry.attempt + 1;
      void enqueueRevalidate(
        retry.pinnedPath,
        retry.revision,
        retry.targetGeneration,
        retry.logicalGeneration,
        nextAttempt,
        retry,
      ).catch(() => {
        scheduleCompletionRetry(
          url,
          retry.pinnedPath,
          retry.revision,
          retry.targetGeneration,
          retry.logicalGeneration,
          nextAttempt,
          retry,
        );
      });
    }, delay);
  };

  const revalidate = (pinnedPath?: string | null, revision?: number): Promise<FilesData> =>
    enqueueRevalidate(pinnedPath, revision);

  const applyPipeline = (pipeline: Pipeline, confirmed: boolean) => {
    if (disposed) return;
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
    publish();
  };

  const revertPipeline = (id: string) => {
    if (disposed) return;
    if (!pipelineOverlays.delete(id)) return;
    composePipelines();
    publish();
  };

  const subscribe = (listener: (data: FilesData) => void, pinnedPath?: string | null) => {
    if (disposed) return () => {};
    const requestScope = filesApiUrl(undefined, pinnedPath);
    listeners.set(listener, requestScope);
    return () => {
      listeners.delete(listener);
      if (!hasSubscriber(requestScope)) cancelCompletionRetry(requestScope);
      trimRepresentations();
    };
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const requestScope of [...completionRetries.keys()]) cancelCompletionRetry(requestScope);
    listeners.clear();
  };

  return { read: () => snapshot, readScope: exactScopeSnapshot, revalidate, subscribe, applyPipeline, revertPipeline, dispose };
}

const defaultFilesFetcher: FilesFetcher = (input, init) => fetch(input, init);
let filesClientCache = createFilesClientCache(defaultFilesFetcher);

export function resetFilesClientCacheForTests(): void {
  filesClientCache.dispose();
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
  flushSync(() => filesClientCache.applyPipeline(pipeline, confirmed));
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PIPELINES_PATCHED_EVENT));
}

/** Roll back a failed optimistic pipeline mutation to the server snapshot. */
export function revertPipelineSnapshot(id: string): void {
  flushSync(() => filesClientCache.revertPipeline(id));
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PIPELINES_PATCHED_EVENT));
}

function responseGeneration(response: Response, name: string): number | undefined {
  const value = response.headers.get(name);
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const generation = Number(value);
  return Number.isSafeInteger(generation) ? generation : undefined;
}

export function filesRequestHeaders(
  etag: string,
  revision?: number,
  generation?: number,
): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (etag) headers["If-None-Match"] = etag;
  if (revision !== undefined) headers["x-llv-files-revision"] = String(revision);
  if (generation !== undefined) headers["x-llv-files-generation"] = String(generation);
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
  const [data, setData] = useState<FilesData>(() => filesClientCache.readScope(pinnedPath));
  const requestScope = filesApiUrl(undefined, pinnedPath);
  useEffect(() => {
    let alive = true;
    const cache = filesClientCache;
    const unsubscribeCache = cache.subscribe((next) => {
      if (alive) setData(next);
    }, pinnedPath);
    const performLoad = async (revision?: number): Promise<boolean> => {
      if (!alive) return true;
      try {
        const next = await cache.revalidate(pinnedPath, revision);
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
      unsubscribeCache();
      unsubBus();
      unsubFiles();
      window.removeEventListener(FLOWS_CHANGED_EVENT, onChanged);
      window.removeEventListener(PIPELINES_CHANGED_EVENT, onChanged);
      window.removeEventListener(WORKFLOWS_CHANGED_EVENT, onChanged);
      window.removeEventListener(TASKS_CHANGED_EVENT, onChanged);
      window.removeEventListener(SESSION_TITLES_CHANGED_EVENT, onChanged);
    };
  }, [pinnedPath]);
  return data.requestScope === requestScope ? data : filesClientCache.readScope(pinnedPath);
}
