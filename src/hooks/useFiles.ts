"use client";

import { useEffect, useState } from "react";

import { FLOWS_CHANGED_EVENT } from "@/components/flows/flowModel";
import { PIPELINES_CHANGED_EVENT } from "@/components/pipelines/pipelineModel";
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
  /** Successful request URL that produced `files`; used for scope-aware effects. */
  requestScope: string | null;
  projectCatalog: ProjectCatalogEntry[];
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
const EMPTY: FilesData = { files: [], requestScope: null, projectCatalog: [], flows: [], pipelines: [], workflows: [], tasks: [], systemHealth: HEALTHY_SYSTEM, conversationAliases: {}, loaded: false };

export function filesApiUrl(project?: string | null, pinnedPath?: string | null): string {
  const params: string[] = [];
  if (project) params.push("project=" + encodeURIComponent(project));
  /* A pending legacy `#f=` target: the scanner keeps this exact transcript in
     the capped feed so the deep link can resolve its conversation id even
     when the path is a demoted archived predecessor. */
  if (pinnedPath) params.push("path=" + encodeURIComponent(pinnedPath));
  return params.length ? "/api/files?" + params.join("&") : "/api/files";
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
export function useFiles(project?: string | null, pinnedPath?: string | null): FilesData {
  const [data, setData] = useState<FilesData>(EMPTY);
  useEffect(() => {
    let alive = true;
    let lastBody = "";
    let lastEtag = "";
    const url = filesApiUrl(project, pinnedPath);
    const performLoad = async (revision?: number): Promise<boolean> => {
      if (!alive) return true;
      try {
        const headers = filesRequestHeaders(lastEtag, revision);
        const res = await fetch(url, headers ? { headers } : undefined);
        /* 304: the server confirms the payload is byte-identical to the last
           one, so there is nothing to read or re-parse. */
        if (res.status === 304) return true;
        if (!res.ok) throw new Error(`files request failed: ${res.status}`);
        const etag = res.headers.get("ETag");
        const body = await res.text();
        if (!alive || body === lastBody) return true;
        const parsed = JSON.parse(body) as FilesResponse | FileEntry[];
        /* The flows rollout changes the payload from a bare array to
           {files, flows}; accept both so client and server can deploy in
           either order. */
        if (Array.isArray(parsed)) setData({ files: parsed, requestScope: url, projectCatalog: [], flows: [], pipelines: [], workflows: [], tasks: [], systemHealth: HEALTHY_SYSTEM, conversationAliases: {}, loaded: true });
        else {
          setData({
            files: parsed.files ?? [],
            requestScope: url,
            projectCatalog: parsed.projectCatalog ?? [],
            flows: parsed.flows ?? [],
            pipelines: parsed.pipelines ?? [],
            workflows: parsed.workflows ?? [],
            tasks: parsed.tasks ?? [],
            pipelinesError: parsed.pipelinesError,
            systemHealth: parsed.systemHealth ?? HEALTHY_SYSTEM,
            conversationAliases: parsed.conversationAliases ?? {},
            loaded: true,
          });
        }
        lastBody = body;
        if (etag) lastEtag = etag;
        return true;
      } catch {
        /* keep previous list */
        return false;
      } finally {
        if (alive) setData((d) => (d.loaded ? d : { ...d, loaded: true }));
      }
    };
    let loadQueue: Promise<void> = Promise.resolve();
    const load = (revision?: number): Promise<boolean> => {
      const result = loadQueue.then(() => performLoad(revision));
      loadQueue = result.then(() => undefined);
      return result;
    };
    void load();

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
      if (revisionTimer) clearTimeout(revisionTimer);
      unsubBus();
      unsubFiles();
      window.removeEventListener(FLOWS_CHANGED_EVENT, onChanged);
      window.removeEventListener(PIPELINES_CHANGED_EVENT, onChanged);
      window.removeEventListener(WORKFLOWS_CHANGED_EVENT, onChanged);
      window.removeEventListener(TASKS_CHANGED_EVENT, onChanged);
      window.removeEventListener(SESSION_TITLES_CHANGED_EVENT, onChanged);
    };
  }, [project, pinnedPath]);
  return data;
}
