"use client";

import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAgentChimes } from "@/hooks/useAgentChimes";
import { useFiles } from "@/hooks/useFiles";
import type { FileEntry } from "@/lib/types";

import { OverviewBoard } from "./OverviewBoard";
import { ProjectDashboard, queueColumnOpen } from "./ProjectDashboard";
import { OVERVIEW, projectKey } from "./projectModel";
import { ProjectRail } from "./ProjectRail";

const PROJECT_KEY = "llvProject";

function readHash(): { filePath: string | null; project: string | null } {
  const fileMatch = location.hash.match(/^#f=(.+)$/);
  if (fileMatch) {
    const raw = (fileMatch[1] ?? "").replace(/#question$/, "");
    try {
      return { filePath: decodeURIComponent(raw), project: null };
    } catch {
      return { filePath: raw, project: null };
    }
  }
  const projectMatch = location.hash.match(/^#p=(.+)$/);
  if (projectMatch) {
    try {
      return { filePath: null, project: decodeURIComponent(projectMatch[1]) };
    } catch {
      return { filePath: null, project: projectMatch[1] };
    }
  }
  return { filePath: null, project: null };
}

function writeHash(project: string) {
  if (project !== OVERVIEW) {
    history.replaceState(null, "", "#p=" + encodeURIComponent(project));
    return;
  }
  history.replaceState(null, "", location.pathname);
}

export function Viewer() {
  const files = useFiles();
  useAgentChimes(files);
  const [project, setProject] = useState<string>(OVERVIEW);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [toastPath, setToastPath] = useState<string | null>(null);
  const seenQuestionsRef = useRef<Set<string> | null>(null);
  /* Reopening a file whose project is already selected does not change
     `project`, so ProjectDashboard would never remount or re-read prefs.
     Bumping this on every same-project open gives it an explicit signal. */
  const [openNonce, setOpenNonce] = useState(0);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const initial = readHash();
    if (initial.filePath) setPendingPath(initial.filePath);
    const savedProject = initial.project ?? localStorage.getItem(PROJECT_KEY);
    if (savedProject) setProject(savedProject);
  }, []);

  useEffect(() => {
    const onHash = () => {
      const next = readHash();
      if (next.filePath) setPendingPath(next.filePath);
      else if (next.project) setProject(next.project);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const selectProject = useCallback((nextProject: string) => {
    setProject(nextProject);
    localStorage.setItem(PROJECT_KEY, nextProject);
    writeHash(nextProject);
  }, []);

  /* A file open (overview card, deep link) becomes a column of its project. */
  const openFile = useCallback(
    (file: FileEntry) => {
      const key = projectKey(file);
      queueColumnOpen(key, file.path);
      selectProject(key);
      setOpenNonce((value) => value + 1);
    },
    [selectProject],
  );

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!pendingPath || files.length === 0) return;
    const hit = files.find((file) => file.path === pendingPath);
    if (hit) openFile(hit);
    setPendingPath(null);
  }, [pendingPath, files, openFile]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    const count = files.filter((file) => file.pendingQuestion || file.waitingInput).length;
    document.title = count ? `(${count}) Agent Log Viewer` : "Agent Log Viewer";
  }, [files]);

  useEffect(() => {
    const ids = files
      .map((file) => ({
        file,
        id: file.pendingQuestion?.toolUseId ?? (file.waitingInput ? `${file.path}:waiting:${Math.floor(file.waitingInput.since)}` : null),
      }))
      .filter((item): item is { file: FileEntry; id: string } => item.id !== null);
    if (seenQuestionsRef.current === null) {
      seenQuestionsRef.current = new Set(ids.map((item) => item.id));
      return;
    }
    const next = ids.find((item) => !seenQuestionsRef.current!.has(item.id));
    for (const item of ids) seenQuestionsRef.current.add(item.id);
    if (next) queueMicrotask(() => setToastPath(next.file.path));
  }, [files]);

  const toastFile = toastPath ? files.find((file) => file.path === toastPath) : null;

  return (
    <div className="flex h-full">
      <ProjectRail files={files} selected={project} onSelect={selectProject} />
      <main className="flex min-w-0 flex-1 flex-col">
        {toastFile ? (
          <div className="fixed right-4 top-4 z-50 flex max-w-[360px] gap-2 rounded-[8px] border border-[#e0ae45]/45 bg-[#fff9ed] px-4 py-3 text-[13px] font-semibold text-ink shadow-card">
            <button
              className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              onClick={() => {
                openFile(toastFile);
                setToastPath(null);
              }}
            >
              <span className="block text-[11px] font-bold text-[#8a5a00]">Агент чекає відповіді</span>
              <span className="line-clamp-2">{toastFile.title}</span>
            </button>
            <button
              className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-bg text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label="Закрити сповіщення"
              onClick={() => setToastPath(null)}
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        ) : null}
        {project === OVERVIEW ? (
          <OverviewBoard files={files} onSelectProject={selectProject} onSelectFile={openFile} />
        ) : (
          <ProjectDashboard files={files} project={project} openNonce={openNonce} />
        )}
      </main>
    </div>
  );
}
