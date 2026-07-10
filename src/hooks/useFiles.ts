"use client";

import { useEffect, useState } from "react";

import { FLOWS_CHANGED_EVENT } from "@/components/flows/flowModel";
import { TASKS_CHANGED_EVENT } from "@/components/tasks/taskApi";
import { WORKFLOWS_CHANGED_EVENT } from "@/components/workflows/workflowModel";
import type { Flow } from "@/lib/flows/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry, FilesResponse, ProjectCatalogEntry } from "@/lib/types";
import type { Workflow } from "@/lib/workflows/types";

import { getRuntimeBus, isRuntimeUiEnabled } from "./runtimeBus";

/** The universal fallback cadence — also the only source for legacy sessions. */
const POLL_MS = 10_000;
/** Debounce after a `files.revision` event before the pure GET fires. */
const FILES_DEBOUNCE_MS = 400;

export interface FilesData {
  files: FileEntry[];
  projectCatalog: ProjectCatalogEntry[];
  flows: Flow[];
  workflows: Workflow[];
  tasks: BoardTask[];
  loaded: boolean;
}

const EMPTY: FilesData = { files: [], projectCatalog: [], flows: [], workflows: [], tasks: [], loaded: false };

export function filesApiUrl(project?: string | null): string {
  return project ? "/api/files?project=" + encodeURIComponent(project) : "/api/files";
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
export function useFiles(project?: string | null): FilesData {
  const [data, setData] = useState<FilesData>(EMPTY);
  useEffect(() => {
    let alive = true;
    let lastBody = "";
    let lastEtag = "";
    const url = filesApiUrl(project);
    const load = async () => {
      try {
        const res = await fetch(url, lastEtag ? { headers: { "If-None-Match": lastEtag } } : undefined);
        /* 304: the server confirms the payload is byte-identical to the last
           one, so there is nothing to read or re-parse. */
        if (res.status === 304) return;
        const etag = res.headers.get("ETag");
        const body = await res.text();
        if (!alive || body === lastBody) return;
        lastBody = body;
        if (etag) lastEtag = etag;
        const parsed = JSON.parse(body) as FilesResponse | FileEntry[];
        /* The flows rollout changes the payload from a bare array to
           {files, flows}; accept both so client and server can deploy in
           either order. */
        if (Array.isArray(parsed)) setData({ files: parsed, projectCatalog: [], flows: [], workflows: [], tasks: [], loaded: true });
        else {
          setData({
            files: parsed.files ?? [],
            projectCatalog: parsed.projectCatalog ?? [],
            flows: parsed.flows ?? [],
            workflows: parsed.workflows ?? [],
            tasks: parsed.tasks ?? [],
            loaded: true,
          });
        }
      } catch {
        /* keep previous list */
      } finally {
        if (alive) setData((d) => (d.loaded ? d : { ...d, loaded: true }));
      }
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
    window.addEventListener(WORKFLOWS_CHANGED_EVENT, onChanged);
    window.addEventListener(TASKS_CHANGED_EVENT, onChanged);

    let unsubBus = () => {};
    let unsubFiles = () => {};
    let filesDebounce: ReturnType<typeof setTimeout> | null = null;
    if (isRuntimeUiEnabled() && typeof window !== "undefined") {
      const bus = getRuntimeBus();
      const applyConnection = () => setCadence(filesPollCadence(bus.getState().connection));
      applyConnection();
      unsubBus = bus.subscribe(applyConnection);
      unsubFiles = bus.subscribeFilesRevision(() => {
        if (filesDebounce) clearTimeout(filesDebounce);
        filesDebounce = setTimeout(() => void load(), FILES_DEBOUNCE_MS);
      });
    } else {
      setCadence("poll");
    }

    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      if (filesDebounce) clearTimeout(filesDebounce);
      unsubBus();
      unsubFiles();
      window.removeEventListener(FLOWS_CHANGED_EVENT, onChanged);
      window.removeEventListener(WORKFLOWS_CHANGED_EVENT, onChanged);
      window.removeEventListener(TASKS_CHANGED_EVENT, onChanged);
    };
  }, [project]);
  return data;
}
