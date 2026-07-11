"use client";

import { Filter, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { parseConversationHash, resolveConversationTarget, withoutArchivedPredecessors, type ConversationHash } from "@/lib/accounts/identity";
import { useAgentChimes } from "@/hooks/useAgentChimes";
import { useArchivedProjects } from "@/hooks/useArchivedProjects";
import { useEffectiveFlows } from "@/components/flows/flowModel";
import { useFiles } from "@/hooks/useFiles";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useViewPresence } from "@/hooks/useViewPresence";
import { OVERVIEW_CONTEXT, OVERVIEW_SLICE, viewBus } from "@/hooks/viewPresenceBus";
import { type TFunction, useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { attentionId, buildAttentionQueue, nextAttention, STALLED_ATTENTION_TTL, type AttentionItem } from "./attention";
import { ConnectionPill } from "./ConnectionPill";
import { OverviewBoard } from "./OverviewBoard";
import { ProjectDashboard, queueColumnOpen } from "./ProjectDashboard";
import { isChildConversation, OVERVIEW, projectKey } from "./projectModel";
import { ProjectRail } from "./ProjectRail";
import { SupervisorHealthAlert } from "./SupervisorHealthAlert";
import { DeploymentStatusPill } from "./runtime/DeploymentStatusPill";
import { cleanTitle, fmtAge } from "./utils";

const PROJECT_KEY = "llvProject";

/** Reads the location hash into its conversation/file/project intent. Recognises
    the canonical `#c=<conversationId>` deep link alongside the legacy `#f=` /
    `#p=` forms (see parseConversationHash). */
function readHash(): ConversationHash {
  return parseConversationHash(location.hash);
}

export function initialProjectFromState(hash: string, storedProject: string | null): string {
  return parseConversationHash(hash).project ?? storedProject ?? OVERVIEW;
}

function initialProject(): string {
  if (typeof window === "undefined") return OVERVIEW;
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(PROJECT_KEY);
  } catch {
    stored = null;
  }
  return initialProjectFromState(window.location.hash, stored);
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
  if (item.file.rateLimit) return t("status.rateLimited");
  const w = item.file.waitingInput;
  if (w) return w.menu?.question.split("\n")[0] || w.screenTail || t("status.awaitingTerminal");
  return t("status.stalled");
}

export function Viewer() {
  const { t } = useLocale();
  /* The one presence publisher for the whole app: it reads the shared view bus
     that the board/scheme/mobile components report into and ships an ephemeral
     per-tab snapshot to the server. Renders nothing. */
  useViewPresence();
  const [project, setProject] = useState<string>(() => initialProject());
  const [pendingHash, setPendingHash] = useState<ConversationHash | null>(null);
  const { files: allFiles, projectCatalog, flows: polledFlows, pipelines, pipelinesError, workflows, tasks, systemHealth, conversationAliases, loaded } = useFiles(project === OVERVIEW ? null : project, pendingHash?.filePath ?? pendingHash?.conversationId ?? null);
  /* A committed account migration keeps the archived predecessor entry in the
     payload (for chain history) but it must never render as a second standalone
     card — every surface below sees only current generations. A no-op (same
     array identity) until something actually migrates. */
  const files = useMemo(() => withoutArchivedPredecessors(allFiles), [allFiles]);
  /* This tab's optimistic flow closes apply before anything renders: the X
     on a flow strip clears the reviewer side of the scheme instantly. */
  const flows = useEffectiveFlows(polledFlows);
  useAgentChimes(files);
  const { archivedProjects, archiveProject, unarchiveProject } = useArchivedProjects(files);
  const catalogProjects = useMemo(() => new Set(projectCatalog.map((entry) => entry.project)), [projectCatalog]);
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [toastPath, setToastPath] = useState<string | null>(null);
  const seenQuestionsRef = useRef<Set<string> | null>(null);
  /* Reopening a file whose project is already selected does not change
     `project`, so ProjectDashboard would never remount or re-read prefs.
     Bumping this on every same-project open gives it an explicit signal. */
  const [openNonce, setOpenNonce] = useState(0);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const initial = readHash();
    if (initial.filePath || initial.conversationId) setPendingHash(initial);
    const savedProject = initial.project ?? localStorage.getItem(PROJECT_KEY);
    if (savedProject) setProject(savedProject);
  }, []);

  useEffect(() => {
    const onHash = () => {
      const next = readHash();
      if (next.filePath || next.conversationId) setPendingHash(next);
      else {
        /* Navigation moved off the conversation link: the old target must
           stop pinning polls and must not open later out of nowhere. */
        setPendingHash(null);
        if (next.project) setProject(next.project);
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const selectProject = useCallback((nextProject: string) => {
    setProject(nextProject);
    /* Explicit project navigation replaces the hash without a hashchange
       event, so any unresolved conversation intent is cancelled here. */
    setPendingHash(null);
    localStorage.setItem(PROJECT_KEY, nextProject);
    writeHash(nextProject);
    setDrawerOpen(false);
  }, []);

  /* The overview board has no project view state to report: presence publishes
     the overview context/slice here, and ProjectDashboard takes over the moment
     a project opens. */
  useEffect(() => {
    if (project !== OVERVIEW) return;
    viewBus.reportContext(OVERVIEW_CONTEXT);
    viewBus.reportSlice(OVERVIEW_SLICE);
  }, [project]);

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
      queueColumnOpen(key, file.path, isChildConversation(file));
      selectProject(key);
      setOpenNonce((value) => value + 1);
    },
    [selectProject],
  );

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!pendingHash || allFiles.length === 0) return;
    /* Resolves against the UNFILTERED payload (finding 6): a legacy `#f=` path
       may point at an archived predecessor, which `withoutArchivedPredecessors`
       has already folded out of `files`. Resolving against `allFiles` keeps that
       predecessor visible long enough to redirect the link to its current
       generation; the canonical `#c=` id resolves the same way. */
    const hit = resolveConversationTarget(allFiles, pendingHash, conversationAliases);
    /* A miss keeps the request pending: the pinned `path` param asks the
       scanner to include the exact transcript on the next poll, so a fresh
       `#f=` link to a demoted archived predecessor resolves once that poll
       lands instead of being cleared after the first cap-limited payload. */
    if (hit) {
      openFile(hit);
      setPendingHash(null);
    }
  }, [pendingHash, allFiles, conversationAliases, openFile]);
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
  const cancelPendingIntent = useCallback(() => setPendingHash(null), []);
  const requestFocus = useCallback((path: string) => {
    /* A user-driven focus (N/Shift-N cycle, attention jump) supersedes any
       unresolved deep-link intent; a stale pin must never re-steal focus when
       its target shows up in a later poll. */
    setPendingHash(null);
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
        id: file.pendingQuestion || file.rateLimit || file.waitingInput ? attentionId(file) : null,
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

  /* Desktop keeps the badge in the fixed top-right anchor; the phone embeds
     this same node into the board header row, where it cannot cover the
     header's own buttons. The queue popover then drops as a full-width sheet
     under the header instead of hanging off the pill. */
  const attentionBadge = queue.length ? (
    <div ref={queueRef} className="pointer-events-auto relative">
      <div className="flex items-center overflow-hidden rounded-full border border-[#e0ae45]/45 bg-[#fff9ed] shadow-card">
        <button
          type="button"
          className="px-3 py-1 text-[12px] font-bold text-[#8a5a00] hover:bg-[#e0ae45]/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
          aria-expanded={queueOpen}
          aria-label={t("attention.badge", { count: queue.length })}
          title={t("attention.openQueue")}
          onClick={() => setQueueOpen((value) => !value)}
        >
          {isMobile ? (
            <span className="inline-flex items-center gap-1">
              <TriangleAlert className="h-3 w-3" aria-hidden /> {queue.length}
            </span>
          ) : (
            t("attention.badge", { count: queue.length })
          )}
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
        <div
          className={`${
            isMobile ? "fixed inset-x-3 top-12" : "absolute right-0 top-[calc(100%+6px)] w-[340px] max-w-[calc(100vw-2rem)]"
          } z-50 max-h-[60vh] overflow-y-auto rounded-[10px] border border-line bg-panel p-1.5 shadow-card`}
        >
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
  ) : null;

  return (
    <div className="flex h-full">
      <SupervisorHealthAlert health={systemHealth.tmux} />
      {isMobile ? null : (
        <ProjectRail files={files} projectCatalog={projectCatalog} pipelines={pipelines} workflows={workflows} archivedProjects={archivedProjects} selected={project} now={clock} loaded={loaded} onSelect={selectProject} />
      )}
      {isMobile && drawerOpen ? (
        <div className="fixed inset-0 z-50 flex">
          <ProjectRail files={files} projectCatalog={projectCatalog} pipelines={pipelines} workflows={workflows} archivedProjects={archivedProjects} selected={project} now={clock} loaded={loaded} onSelect={selectProject} />
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
          {isMobile ? null : attentionBadge}
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
            projectCatalog={projectCatalog}
            pipelines={pipelines}
            workflows={workflows}
            archivedProjects={archivedProjects}
            now={clock}
            onSelectProject={selectProject}
            onSelectFile={openFile}
            onMenu={isMobile ? () => setDrawerOpen(true) : undefined}
            attention={isMobile ? attentionBadge : undefined}
          />
        ) : (
          <ProjectDashboard
            files={files}
            flows={flows}
            pipelines={pipelines}
            pipelinesError={pipelinesError}
            workflows={workflows}
            tasks={tasks}
            project={project}
            loaded={loaded}
            openNonce={openNonce}
            focusRequest={focusRequest}
            attentionPaths={attentionPaths}
            archived={archivedProjects.has(project)}
            catalogKnown={catalogProjects.has(project)}
            onArchive={archiveProject}
            onUnarchive={unarchiveProject}
            onMenu={isMobile ? () => setDrawerOpen(true) : undefined}
            attention={isMobile ? attentionBadge : undefined}
            onUserNavigate={cancelPendingIntent}
          />
        )}
      </main>
      {/* Runtime connection pill — mounts the tab-wide bus and shows live /
          reconnecting / degraded / offline. Renders nothing while slice-one is
          disabled, so on the landing page it is inert. Docked bottom-left, clear
          of the bottom-right CornerStatus and the top-right attention anchor. */}
      {isMobile ? null : <ConnectionPill />}
      <DeploymentStatusPill />
    </div>
  );
}
