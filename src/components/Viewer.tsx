"use client";

import { Filter, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAgentChimes } from "@/hooks/useAgentChimes";
import { useArchivedProjects } from "@/hooks/useArchivedProjects";
import { useEffectiveFlows } from "@/components/flows/flowModel";
import { useFiles } from "@/hooks/useFiles";
import { useIsMobile } from "@/hooks/useIsMobile";
import { type TFunction, useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { attentionId, buildAttentionQueue, nextAttention, STALLED_ATTENTION_TTL, type AttentionItem } from "./attention";
import { OverviewBoard } from "./OverviewBoard";
import { ProjectDashboard, queueColumnOpen } from "./ProjectDashboard";
import { OVERVIEW, projectKey } from "./projectModel";
import { ProjectRail } from "./ProjectRail";
import { cleanTitle, fmtAge } from "./utils";

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

/** One-line reason a queue item waits: question header, screen tail, or the stalled wording. */
function attentionSnippet(t: TFunction, item: AttentionItem): string {
  const q = item.file.pendingQuestion;
  if (q) {
    if (q.kind === "plan") return t("status.awaitingPlan");
    const first = q.questions?.[0];
    return first?.header || first?.question.split("\n")[0] || t("status.awaitingAnswer");
  }
  const w = item.file.waitingInput;
  if (w) return w.menu?.question.split("\n")[0] || w.screenTail || t("status.awaitingTerminal");
  return t("status.stalled");
}

export function Viewer() {
  const { t } = useLocale();
  const { files, flows: polledFlows, tasks } = useFiles();
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

  /* The one queue every counter shows: badge, popover and the tab title all
     read the same list, stalled tail included (D10). The clock advances when
     the oldest stalled entry crosses its 2h TTL: useFiles keeps the array
     identity while the /api/files body is unchanged, so without this tick an
     expired stalled item would sit in the badge until an unrelated change. */
  const [clock, setClock] = useState(() => Date.now() / 1000);
  const queue = useMemo(() => buildAttentionQueue(files, clock), [files, clock]);
  useEffect(() => {
    const expiries = files
      .filter((file) => file.activity === "stalled")
      .map((file) => file.mtime + STALLED_ATTENTION_TTL)
      .filter((at) => at > clock);
    if (!expiries.length) return;
    const delay = Math.max(0, (Math.min(...expiries) - Date.now() / 1000) * 1000) + 500;
    const timer = window.setTimeout(() => setClock(Date.now() / 1000), delay);
    return () => window.clearTimeout(timer);
  }, [files, clock]);
  const [queueOpen, setQueueOpen] = useState(false);
  const queueRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    document.title = queue.length ? `(${queue.length}) Agent Log Viewer` : "Agent Log Viewer";
  }, [queue.length]);

  useEffect(() => {
    if (!queueOpen) return;
    const onDown = (event: PointerEvent) => {
      if (!queueRef.current?.contains(event.target as Node)) setQueueOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQueueOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [queueOpen]);

  /* «Show only needs me» filter: React-only state that auto-disables when the
     queue empties — a filter surviving reload would silently gray the whole
     board (D6). The popover follows the same emptiness rule. Desktop-only,
     like the F key: the mobile strip and map render without the dimming
     channel, so the funnel stays hidden there and the state clears if the
     viewport shrinks into the phone layout mid-session. */
  const [attentionFilter, setAttentionFilter] = useState(false);
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (isMobile) setAttentionFilter(false);
  }, [isMobile]);
  useEffect(() => {
    if (queue.length) return;
    setQueueOpen(false);
    setAttentionFilter(false);
  }, [queue.length]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /* The jump channel into the board: nonce so repeated jumps to the same node
     re-flash (D9); consumed by ProjectDashboard's pendingFocusRef path. */
  const [focusRequest, setFocusRequest] = useState<{ path: string; nonce: number } | null>(null);
  const requestFocus = useCallback((path: string) => {
    setFocusRequest((prev) => ({ path, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  /* The N-cycle position anchors to an id: an item answered elsewhere drops
     out without moving the pointer's neighbors (D12). */
  const cycleRef = useRef<string | null>(null);

  /* Membership key first, Set second: polls rebuild the queue array, but the
     set identity only moves when membership does, so the memoized node layers
     never re-render for an unchanged filter (D6). */
  const attentionKey = useMemo(() => queue.map((item) => item.file.path).sort().join("\n"), [queue]);
  const attentionPaths = useMemo<ReadonlySet<string> | null>(
    () => (attentionFilter ? new Set(attentionKey.split("\n").filter(Boolean)) : null),
    [attentionFilter, attentionKey],
  );

  /* N never leaves the current project (D4): the same items and order
     buildAttentionQueue(files, now, project) yields, taken off the global memo. */
  const projectQueue = useMemo(
    () => (project === OVERVIEW ? [] : queue.filter((item) => item.project === project)),
    [queue, project],
  );

  useEffect(() => {
    /* N and F are desktop keys (D4/D6): the phone layout renders without the
       scheme dimming channel, and a hardware keyboard there must never drive
       hidden filter state or focus jumps. */
    if (isMobile) return;
    /* Same guard as useSchemeCamera: hotkeys stay quiet while a composer or
       any form control is focused. */
    const typing = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el || !el.tagName) return false;
      return ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(el.tagName) || el.isContentEditable;
    };
    const onDown = (event: KeyboardEvent) => {
      if (typing(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "n" || event.key === "N") {
        const next = nextAttention(projectQueue, cycleRef.current, event.shiftKey ? -1 : 1);
        if (!next) return;
        event.preventDefault();
        cycleRef.current = next.id;
        requestFocus(next.file.path);
      } else if (event.key === "f" || event.key === "F") {
        if (!queue.length) return;
        event.preventDefault();
        setAttentionFilter((value) => !value);
      }
    };
    window.addEventListener("keydown", onDown);
    return () => window.removeEventListener("keydown", onDown);
  }, [isMobile, projectQueue, queue.length, requestFocus]);

  /* A popover click is a deliberate act, so unlike the N hotkey it may switch
     the project; the focus hand-off glides the board to the node. */
  const jumpToItem = useCallback(
    (item: AttentionItem) => {
      setQueueOpen(false);
      if (item.project !== project) selectProject(item.project);
      cycleRef.current = item.id;
      requestFocus(item.file.path);
    },
    [project, selectProject, requestFocus],
  );

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
        <ProjectRail files={files} archivedProjects={archivedProjects} selected={project} now={clock} onSelect={selectProject} />
      )}
      {isMobile && drawerOpen ? (
        <div className="fixed inset-0 z-50 flex">
          <ProjectRail files={files} archivedProjects={archivedProjects} selected={project} now={clock} onSelect={selectProject} />
          <button
            type="button"
            className="min-w-0 flex-1 bg-ink/35"
            aria-label={t("viewer.closeProjects")}
            onClick={() => setDrawerOpen(false)}
          />
        </div>
      ) : null}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* The corner attention anchor: the badge pill sits where the toast
            appears, so a new toast visually docks into it (D7). */}
        <div className="pointer-events-none fixed right-4 top-4 z-50 flex flex-col items-end gap-2">
          {queue.length ? (
            <div ref={queueRef} className="pointer-events-auto relative">
              <div className="flex items-center overflow-hidden rounded-full border border-[#e0ae45]/45 bg-[#fff9ed] shadow-card">
                <button
                  type="button"
                  className="px-3 py-1 text-[12px] font-bold text-[#8a5a00] hover:bg-[#e0ae45]/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
                  aria-expanded={queueOpen}
                  title={t("attention.openQueue")}
                  onClick={() => setQueueOpen((value) => !value)}
                >
                  {t("attention.badge", { count: queue.length })}
                </button>
                {isMobile ? null : (
                  <>
                    <div className="h-4 w-px shrink-0 bg-[#e0ae45]/45" aria-hidden />
                    <button
                      type="button"
                      className={`px-2 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${
                        attentionFilter ? "bg-[#e0ae45]/30 text-[#8a5a00]" : "text-[#b8860b]/70 hover:bg-[#e0ae45]/15 hover:text-[#8a5a00]"
                      }`}
                      aria-pressed={attentionFilter}
                      title={attentionFilter ? t("attention.filterOff") : t("attention.filterOn")}
                      aria-label={attentionFilter ? t("attention.filterOff") : t("attention.filterOn")}
                      onClick={() => setAttentionFilter((value) => !value)}
                    >
                      <Filter className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </>
                )}
              </div>
              {queueOpen ? (
                <div className="absolute right-0 top-[calc(100%+6px)] max-h-[60vh] w-[340px] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-[10px] border border-line bg-panel p-1.5 shadow-card">
                  <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-bold uppercase tracking-wide text-dim">
                    {t("attention.popoverTitle")}
                  </div>
                  {queue.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="flex w-full min-w-0 flex-col gap-0.5 rounded-[8px] px-2.5 py-2 text-left hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                      onClick={() => jumpToItem(item)}
                    >
                      <span className="flex w-full min-w-0 items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink">
                          {cleanTitle(item.file.title, 90)}
                        </span>
                        <span className="shrink-0 rounded-full border border-line bg-bg px-1.5 text-[10px] font-semibold text-dim">
                          {item.project}
                        </span>
                        <span className="shrink-0 text-[10.5px] text-dim">{fmtAge(item.since)}</span>
                      </span>
                      <span className={`w-full truncate text-[11px] ${item.tier === "stalled" ? "text-[#b8860b]" : "text-dim"}`}>
                        {attentionSnippet(t, item)}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {toastFile ? (
          <div className="pointer-events-auto flex max-w-[360px] gap-2 rounded-[8px] border border-[#e0ae45]/45 bg-[#fff9ed] px-4 py-3 text-[13px] font-semibold text-ink shadow-card">
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
        </div>
        {project === OVERVIEW ? (
          <OverviewBoard
            files={files}
            archivedProjects={archivedProjects}
            now={clock}
            onSelectProject={selectProject}
            onSelectFile={openFile}
            onMenu={isMobile ? () => setDrawerOpen(true) : undefined}
          />
        ) : (
          <ProjectDashboard
            files={files}
            flows={flows}
            tasks={tasks}
            project={project}
            openNonce={openNonce}
            focusRequest={focusRequest}
            attentionPaths={attentionPaths}
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
