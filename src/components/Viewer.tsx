"use client";

import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAgentChimes } from "@/hooks/useAgentChimes";
import { useArchivedProjects } from "@/hooks/useArchivedProjects";
import { useEffectiveFlows } from "@/components/flows/flowModel";
import { useFiles } from "@/hooks/useFiles";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { attentionId } from "./attention";
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
  const { t } = useLocale();
  const { files, flows: polledFlows } = useFiles();
  /* This tab's optimistic flow closes apply before anything renders: the X
     on a flow strip clears the reviewer side of the scheme instantly. */
  const flows = useEffectiveFlows(polledFlows);
  useAgentChimes(files);
  const { archivedProjects, archiveProject, unarchiveProject } = useArchivedProjects(files);
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
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
    setDrawerOpen(false);
  }, []);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

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
    /* Toast fires on hard-blocked signals only — a stalled id must never enter
       this seen-set, so the guard narrows before the shared derivation. */
    const ids = files
      .map((file) => ({
        file,
        id: file.pendingQuestion || file.waitingInput ? attentionId(file) : null,
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
      {isMobile ? null : (
        <ProjectRail files={files} archivedProjects={archivedProjects} selected={project} onSelect={selectProject} />
      )}
      {isMobile && drawerOpen ? (
        <div className="fixed inset-0 z-50 flex">
          <ProjectRail files={files} archivedProjects={archivedProjects} selected={project} onSelect={selectProject} />
          <button
            type="button"
            className="min-w-0 flex-1 bg-ink/35"
            aria-label={t("viewer.closeProjects")}
            onClick={() => setDrawerOpen(false)}
          />
        </div>
      ) : null}
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
              <span className="block text-[11px] font-bold text-[#8a5a00]">{t("viewer.agentWaiting")}</span>
              <span className="line-clamp-2">{toastFile.title}</span>
            </button>
            <button
              className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-bg text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label={t("viewer.closeNotification")}
              onClick={() => setToastPath(null)}
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        ) : null}
        {project === OVERVIEW ? (
          <OverviewBoard
            files={files}
            archivedProjects={archivedProjects}
            onSelectProject={selectProject}
            onSelectFile={openFile}
            onMenu={isMobile ? () => setDrawerOpen(true) : undefined}
          />
        ) : (
          <ProjectDashboard
            files={files}
            flows={flows}
            project={project}
            openNonce={openNonce}
            archived={archivedProjects.has(project)}
            onArchive={archiveProject}
            onUnarchive={unarchiveProject}
            onMenu={isMobile ? () => setDrawerOpen(true) : undefined}
          />
        )}
      </main>
    </div>
  );
}
