"use client";

import { useEffect, useState } from "react";

import { FLOWS_CHANGED_EVENT } from "@/components/flows/flowModel";
import { TASKS_CHANGED_EVENT } from "@/components/tasks/taskApi";
import { WORKFLOWS_CHANGED_EVENT } from "@/components/workflows/workflowModel";
import type { Flow } from "@/lib/flows/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry, FilesResponse } from "@/lib/types";
import type { Workflow } from "@/lib/workflows/types";

const POLL_MS = 10_000;

export interface FilesData {
  files: FileEntry[];
  flows: Flow[];
  workflows: Workflow[];
  tasks: BoardTask[];
}

const EMPTY: FilesData = { files: [], flows: [], workflows: [], tasks: [] };

/** Polls /api/files. Keeps the last good list on transient fetch errors. */
export function useFiles(): FilesData {
  const [data, setData] = useState<FilesData>(EMPTY);
  useEffect(() => {
    let alive = true;
    let lastBody = "";
    let lastEtag = "";
    const load = async () => {
      try {
        const res = await fetch("/api/files", lastEtag ? { headers: { "If-None-Match": lastEtag } } : undefined);
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
        if (Array.isArray(parsed)) setData({ files: parsed, flows: [], workflows: [], tasks: [] });
        else {
          setData({
            files: parsed.files ?? [],
            flows: parsed.flows ?? [],
            workflows: parsed.workflows ?? [],
            tasks: parsed.tasks ?? [],
          });
        }
      } catch {
        /* keep previous list */
      }
    };
    void load();
    const t = setInterval(load, POLL_MS);
    /* Flow, workflow and task mutations refresh out of band: strips and
       cards must not sit on stale state for up to a full poll interval. */
    const onChanged = () => void load();
    window.addEventListener(FLOWS_CHANGED_EVENT, onChanged);
    window.addEventListener(WORKFLOWS_CHANGED_EVENT, onChanged);
    window.addEventListener(TASKS_CHANGED_EVENT, onChanged);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener(FLOWS_CHANGED_EVENT, onChanged);
      window.removeEventListener(WORKFLOWS_CHANGED_EVENT, onChanged);
      window.removeEventListener(TASKS_CHANGED_EVENT, onChanged);
    };
  }, []);
  return data;
}
