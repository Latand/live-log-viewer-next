"use client";

import { ListTodo, Menu } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";
import type { Flow } from "@/lib/flows/types";
import { useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { TaskStrip } from "./BranchPane";
import { clearDraftStorage, draftSrc, setDraftSrc } from "./DraftAgentPane";
import { claimedReviewerPaths } from "./flows/flowModel";
import { TaskPanel } from "./tasks/TaskPanel";
import { TaskToastHost } from "./tasks/taskToast";
import { MobileFocusView } from "./mobile/MobileFocusView";
import { SchemeBoard } from "./scheme/SchemeBoard";
import { Switchboard } from "./Switchboard";
import { buildBranchGroups, collapsedTrees, projectKey, residualItems } from "./projectModel";
import { ArchiveRestore } from "./icons";
import { ArchiveProjectButton, DeleteProjectButton, QuietFileList } from "./ProjectTrash";
import { SoundToggle } from "./SoundToggle";
import { ResidualStrip } from "./TreeAside";

/** How long an opened node keeps its highlight ring on the scheme. */
const HIGHLIGHT_MS = 1800;

interface Props {
  files: FileEntry[];
  flows: Flow[];
  tasks: BoardTask[];
  project: string;
  /** Bumped by Viewer on every openFile so a same-project open re-reads prefs
      even though `project` itself did not change. */
  openNonce: number;
  /** Attention-queue jump: glide the board to this node and ring it. The nonce
      re-flashes repeated jumps to the same path; prefs stay untouched — a
      read-only jump must not mutate manual column state. */
  focusRequest?: { path: string; nonce: number } | null;
  /** «Show only needs me»: non-null dims every scheme node not in the set. */
  attentionPaths?: ReadonlySet<string> | null;
  /** The project is shelved: hidden from the rail and the overview. */
  archived: boolean;
  onArchive: (project: string) => void;
  onUnarchive: (project: string) => void;
  /** Mobile shell: the rail hides behind a drawer, this opens it. */
  onMenu?: () => void;
}

/** Manual additions and removals of scheme nodes, persisted per project. */
interface ColumnPrefs {
  manual: string[];
  hidden: string[];
}

const prefsKey = (project: string) => `llvCols:${project}`;
/* Conversation drafts survive remounts and reloads within the tab: an agent
   booted from a draft keeps its waiting pane until the transcript arrives. */
const draftsKey = (project: string) => `llvDrafts:${project}`;

function loadDrafts(project: string): string[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(draftsKey(project)) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function loadPrefs(project: string): ColumnPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(prefsKey(project)) ?? "{}") as Partial<ColumnPrefs>;
    return { manual: raw.manual ?? [], hidden: raw.hidden ?? [] };
  } catch {
    return { manual: [], hidden: [] };
  }
}

/** Pre-adds a conversation as a manual scheme node of its project. */
export function queueColumnOpen(project: string, path: string) {
  const prefs = loadPrefs(project);
  if (!prefs.manual.includes(path)) prefs.manual.push(path);
  prefs.hidden = prefs.hidden.filter((item) => item !== path);
  localStorage.setItem(prefsKey(project), JSON.stringify(prefs));
}

/* Kept outside the component: the React Compiler's immutability check flags
   direct global mutation (location.hash = ...) inside a component body. */
function gotoProject(project: string) {
  location.hash = "#p=" + encodeURIComponent(project);
}

export function ProjectDashboard({
  files,
  flows,
  tasks,
  project,
  openNonce,
  focusRequest,
  attentionPaths,
  archived,
  onArchive,
  onUnarchive,
  onMenu,
}: Props) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const highlightTimer = useRef<number | null>(null);
  const pendingFocusRef = useRef<string | null>(null);
  const [prefs, setPrefs] = useState<ColumnPrefs>({ manual: [], hidden: [] });
  const [drafts, setDrafts] = useState<string[]>([]);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  /* Jump targets the scheme would otherwise skip (a stalled root builds no
     automatic group; a stalled branch hides inside a mini stack) materialize
     as ephemeral nodes: React state only, never written to prefs, gone on
     reload — the queue can route to its quietest members while the manual
     column state stays untouched. */
  const [ephemeral, setEphemeral] = useState<string[]>([]);
  /* Mirrors `prefs` synchronously so the missing-nodes effect below can read
     the value the project-switch load just set, even within the same commit
     (state updates from sibling effects are not visible via closure yet). */
  const prefsRef = useRef(prefs);

  useEffect(() => {
    const loaded = loadPrefs(project);
    prefsRef.current = loaded;
    /* eslint-disable react-hooks/set-state-in-effect */
    setPrefs(loaded);
    setDrafts(loadDrafts(project));
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [project, openNonce]);
  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setTaskPanelOpen(localStorage.getItem("llvTaskPanel") === "1");
  }, []);
  const toggleTaskPanel = () => {
    setTaskPanelOpen((open) => {
      localStorage.setItem("llvTaskPanel", open ? "0" : "1");
      return !open;
    });
  };
  useEffect(
    () => () => {
      if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
    },
    [],
  );

  const persistPrefs = (next: ColumnPrefs) => {
    prefsRef.current = next;
    setPrefs(next);
    localStorage.setItem(prefsKey(project), JSON.stringify(next));
  };

  /* Reviewer transcripts of active flows live inside their round decks:
     they never build their own groups, quiet trees or residual chips. */
  const groupFiles = useMemo(() => {
    const claimed = claimedReviewerPaths(flows);
    return claimed.size ? files.filter((file) => !claimed.has(file.path)) : files;
  }, [files, flows]);
  const groups = useMemo(() => buildBranchGroups(groupFiles, project), [groupFiles, project]);
  const activeRoots = useMemo(() => new Set(groups.map((group) => group.key)), [groups]);
  const cards = useMemo(() => collapsedTrees(groupFiles, project, activeRoots), [groupFiles, project, activeRoots]);
  const residual = useMemo(() => residualItems(groupFiles, project, activeRoots), [groupFiles, project, activeRoots]);
  const autoPaths = useMemo(
    () => new Set(groups.flatMap((group) => group.columns.map((column) => column.file.path))),
    [groups],
  );
  const hiddenSet = useMemo(() => new Set(prefs.hidden), [prefs.hidden]);
  const projectTasks = useMemo(() => tasks.filter((task) => task.project === project), [tasks, project]);
  const manualNodes = useMemo(() => {
    const byPath = new Map(groupFiles.map((file) => [file.path, file]));
    return prefs.manual
      .map((path) => byPath.get(path))
      .filter(
        (file): file is FileEntry =>
          file !== undefined && projectKey(file) === project && !autoPaths.has(file.path) && !hiddenSet.has(file.path),
      );
  }, [prefs.manual, groupFiles, project, autoPaths, hiddenSet]);
  /* Ephemeral jump targets render exactly like manual nodes; paths the scheme
     already draws (auto columns, manual entries) filter out. */
  const schemeManual = useMemo(() => {
    const byPath = new Map(groupFiles.map((file) => [file.path, file]));
    const manualPaths = new Set(manualNodes.map((file) => file.path));
    /* A hidden column's file still materializes: the user closed the column
       earlier, but a jump must land somewhere visible. */
    const extra = ephemeral
      .map((path) => byPath.get(path))
      .filter(
        (file): file is FileEntry =>
          file !== undefined &&
          projectKey(file) === project &&
          !manualPaths.has(file.path) &&
          (!autoPaths.has(file.path) || hiddenSet.has(file.path)),
      );
    return extra.length ? [...manualNodes, ...extra] : manualNodes;
  }, [ephemeral, groupFiles, project, autoPaths, hiddenSet, manualNodes]);
  const liveCount = useMemo(
    () =>
      groups.reduce(
        (sum, group) =>
          sum +
          group.columns.reduce(
            (colSum, column) =>
              colSum +
              (column.file.activity === "live" ? 1 : 0) +
              column.tasks.filter((task) => task.activity === "live").length,
            0,
          ),
        0,
      ),
    [groups],
  );
  const treeGroups = groups.filter((group) => !group.orphanTask).length;

  /* The highlight drives the scheme: the camera glides to the node and rings it. */
  const flashNode = (path: string) => {
    setHighlight(path);
    if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
  };

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setEphemeral([]);
  }, [project]);

  /* An attention jump rides the same channel as switchboard opens: the ref is
     set here and the every-render effect below flashes it, whether the node is
     already in the layout or enters it on this render. */
  useEffect(() => {
    if (!focusRequest) return;
    pendingFocusRef.current = focusRequest.path;
    setEphemeral((prev) => (prev.includes(focusRequest.path) ? prev : [...prev, focusRequest.path]));
  }, [focusRequest]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /* A node added from the switchboard enters the layout on the next render;
     flash it then so the camera has something to glide to. */
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    pendingFocusRef.current = null;
    flashNode(pending);
  });

  /* A task-panel row from another project switches the dashboard first; the
     glide target waits in sessionStorage until this project has the task. */
  useEffect(() => {
    const pending = sessionStorage.getItem("llvTaskFocus");
    if (!pending || !projectTasks.some((task) => task.id === pending)) return;
    sessionStorage.removeItem("llvTaskFocus");
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    flashNode("task::" + pending);
  });

  const openTask = (task: BoardTask) => {
    if (task.project !== project) {
      sessionStorage.setItem("llvTaskFocus", task.id);
      gotoProject(task.project);
      return;
    }
    flashNode("task::" + task.id);
  };

  const persistDrafts = (next: string[]) => {
    setDrafts(next);
    sessionStorage.setItem(draftsKey(project), JSON.stringify(next));
  };

  /* randomUUID needs a secure context; LAN http access gets the fallback. */
  const newDraftId = () =>
    typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  /* The «+ Агент» flow: a draft conversation lands on the scheme as a full
     pane and the camera glides to it — engine, directory and the first prompt
     are picked right inside that pane. */
  const addDraft = () => {
    const id = newDraftId();
    persistDrafts([...drafts, id]);
    pendingFocusRef.current = "draft::" + id;
  };

  /* The handoff handle under a pane: a draft that continues this conversation
     hangs right below it, inheriting the transcript and its directory. A
     repeat click refocuses the existing draft instead of stacking duplicates. */
  const addHandoffDraft = (file: FileEntry) => {
    const existing = drafts.find((id) => draftSrc(id) === file.path);
    if (existing) {
      flashNode("draft::" + existing);
      return;
    }
    const id = newDraftId();
    setDraftSrc(id, file.path);
    persistDrafts([...drafts, id]);
    pendingFocusRef.current = "draft::" + id;
  };

  const removeDraft = (id: string) => {
    clearDraftStorage(id);
    persistDrafts(drafts.filter((item) => item !== id));
  };

  /* The draft's agent booted and its transcript arrived: the real node takes
     the draft's place (openSwitchboardFile also covers a cwd from another
     project by switching there). */
  const draftSpawned = (id: string, file: FileEntry) => {
    removeDraft(id);
    openSwitchboardFile(file);
  };

  const closeNode = (path: string) => {
    /* Closing a chat also puts out its tmux pane; fire-and-forget, since the
       node disappears either way and a pane that survived a failed request
       just stays for the next close. Branch nodes are filtered server-side —
       they share the root's pane. */
    void fetch("/api/tmux", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "kill", path }),
    }).catch(() => {});
    const manual = prefs.manual.filter((item) => item !== path);
    const hidden = autoPaths.has(path) ? [...new Set([...prefs.hidden, path])] : prefs.hidden;
    persistPrefs({ manual, hidden });
    setEphemeral((prev) => (prev.includes(path) ? prev.filter((item) => item !== path) : prev));
  };

  /* A node never vanishes on its own: every auto node is recorded as a
     manual one, so a branch that goes quiet keeps its place until the user
     closes it. Capped so old projects do not accumulate forever. */
  useEffect(() => {
    const prev = prefsRef.current;
    const missing = [...autoPaths].filter((path) => !prev.manual.includes(path) && !prev.hidden.includes(path));
    if (!missing.length) return;
    const next = { ...prev, manual: [...prev.manual, ...missing].slice(-40) };
    prefsRef.current = next;
    setPrefs(next);
    localStorage.setItem(prefsKey(project), JSON.stringify(next));
  }, [autoPaths, project]);

  /* Any open lands on the scheme: a card of another project pre-adds its node
     and switches the project; a conversation of this project joins the managed
     node list (or gets flashed when already there). */
  const openSwitchboardFile = (file: FileEntry) => {
    const fileProject = projectKey(file);
    if (fileProject !== project) {
      queueColumnOpen(fileProject, file.path);
      gotoProject(fileProject);
      return;
    }
    const visible =
      (autoPaths.has(file.path) && !hiddenSet.has(file.path)) || manualNodes.some((item) => item.path === file.path);
    if (visible) {
      flashNode(file.path);
      return;
    }
    const hidden = prefs.hidden.filter((item) => item !== file.path);
    const manual = autoPaths.has(file.path) ? prefs.manual : [...new Set([...prefs.manual, file.path])];
    persistPrefs({ manual, hidden });
    pendingFocusRef.current = file.path;
  };

  const statusBits: string[] = [];
  if (liveCount) {
    statusBits.push(
      `${t("dash.branchesLive", { count: liveCount })} · ${t("dash.trees", { count: treeGroups })}`,
    );
  } else if (treeGroups) {
    statusBits.push(t("dash.recentConvos", { count: treeGroups }));
  }
  if (cards.length) {
    statusBits.push(t("dash.quietTrees", { count: cards.length }));
  }

  const visibleGroups = groups
    .map((group) => ({ ...group, columns: group.columns.filter((column) => !hiddenSet.has(column.file.path)) }))
    .filter((group) => group.columns.length);
  /* Parentless background processes dock as colored strips at the top of the
     canvas instead of hanging as lone stub nodes in the middle of it. */
  const dockedTasks = visibleGroups.filter((group) => group.orphanTask).map((group) => group.columns[0]!.file);
  const schemeGroups = visibleGroups.filter((group) => !group.orphanTask);
  const hasNodes = schemeGroups.length > 0 || schemeManual.length > 0 || drafts.length > 0 || projectTasks.length > 0;
  /* Everything the project has on disk, freshest first. Powers the
     delete-project button and the fallback list of an empty scheme —
     transcripts whose tree lives elsewhere (scratchpad one-offs) build no
     groups/cards/residual chips, yet keep the project in the rail. */
  const projectFiles = useMemo(
    () => files.filter((file) => projectKey(file) === project).sort((a, b) => b.mtime - a.mtime),
    [files, project],
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-line bg-panel px-4">
        {onMenu ? (
          <button
            type="button"
            className="-ml-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-line bg-bg text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-label={t("dash.openProjects")}
            onClick={onMenu}
          >
            <Menu className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
        <h1 className="truncate text-[13.5px] font-bold">{project}</h1>
        <span className="truncate text-[11.5px] text-dim">{statusBits.length ? statusBits.join(" · ") : t("common.nothingRunning")}</span>
        <SoundToggle />
        {archived ? (
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-bg px-2 py-0.5 text-[11px] font-semibold text-dim hover:border-accent/40 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onClick={() => onUnarchive(project)}
          >
            <ArchiveRestore className="h-3 w-3" aria-hidden /> {t("dash.unarchive")}
          </button>
        ) : (
          <ArchiveProjectButton files={projectFiles} onArchive={() => onArchive(project)} />
        )}
        <DeleteProjectButton files={projectFiles} />
        <button
          type="button"
          onClick={addDraft}
          aria-label={t("dash.newConvo")}
          className="ml-auto flex shrink-0 items-center gap-1 rounded-[8px] border border-line bg-panel px-2.5 py-1 text-[11.5px] font-bold text-ink shadow-card hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <span className="text-[13px] leading-none text-accent">+</span> {t("dash.agent")}
        </button>
        {isMobile ? null : (
          <button
            type="button"
            onClick={toggleTaskPanel}
            aria-pressed={taskPanelOpen}
            aria-label={t("tasks.panelToggleAria")}
            className={`flex shrink-0 items-center gap-1 rounded-[8px] border px-2.5 py-1 text-[11.5px] font-bold shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
              taskPanelOpen ? "border-accent/45 bg-accent/10 text-accent" : "border-line bg-panel text-ink hover:border-accent/45 hover:text-accent"
            }`}
          >
            <ListTodo className="h-3.5 w-3.5" aria-hidden /> {t("tasks.panelTitle")}
            {projectTasks.filter((task) => task.status !== "done").length ? (
              <span className="rounded-full bg-accent/10 px-1.5 text-[10px] font-bold text-accent">
                {projectTasks.filter((task) => task.status !== "done").length}
              </span>
            ) : null}
          </button>
        )}
      </div>

      {dockedTasks.length ? (
        <div className="shrink-0 border-b border-line bg-[#fbfbfd]">
          {dockedTasks.map((task) => (
            <div
              key={task.path}
              className={`border-l-4 ${task.activity === "live" ? "border-l-ok bg-[#f2faf4]" : "border-l-[#9a9aa4]"}`}
            >
              <TaskStrip file={task} files={files} onSelect={openSwitchboardFile} />
            </div>
          ))}
        </div>
      ) : null}

      {isMobile ? (
        hasNodes ? (
          <MobileFocusView
            project={project}
            groups={schemeGroups}
            manual={schemeManual}
            files={files}
            flows={flows}
            tasks={projectTasks}
            drafts={drafts}
            focus={highlight}
            onSelect={openSwitchboardFile}
            onClose={closeNode}
            onDraftClose={removeDraft}
            onDraftSpawned={draftSpawned}
            onHandoff={addHandoffDraft}
          />
        ) : projectFiles.length ? (
          <QuietFileList files={projectFiles} onOpen={openSwitchboardFile} />
        ) : (
          <div className="flex flex-1 items-center justify-center px-4 py-5 text-center">
            <div>
              <div className="text-[13.5px] font-semibold text-dim">{t("dash.emptyTitle")}</div>
              <div className="mt-0.5 text-[12px] text-dim">{t("dash.emptyHint")}</div>
            </div>
          </div>
        )
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1">
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {hasNodes ? (
              <SchemeBoard
                project={project}
                groups={schemeGroups}
                manual={schemeManual}
                files={files}
                flows={flows}
                tasks={projectTasks}
                drafts={drafts}
                focus={highlight}
                attentionPaths={attentionPaths}
                onSelect={openSwitchboardFile}
                onClose={closeNode}
                onDraftClose={removeDraft}
                onDraftSpawned={draftSpawned}
                onHandoff={addHandoffDraft}
              />
            ) : projectFiles.length ? (
              <QuietFileList files={projectFiles} onOpen={openSwitchboardFile} />
            ) : (
              <div className="flex flex-1 items-center justify-center px-4 py-5 text-center">
                <div>
                  <div className="text-[13.5px] font-semibold text-dim">{t("dash.emptyTitle")}</div>
                  <div className="mt-0.5 text-[12px] text-dim">{t("dash.emptyHint")}</div>
                </div>
              </div>
            )}
          </div>
          {taskPanelOpen ? <TaskPanel tasks={tasks} project={project} onOpenTask={openTask} onClose={toggleTaskPanel} /> : null}
        </div>
      )}

      {/* The corner pill would sit on the focused pane's composer; on the
          phone the strip, the map and the toast cover its job. */}
      {isMobile ? null : <Switchboard files={files} flows={flows} project={project} onOpenFile={openSwitchboardFile} />}

      {residual.length ? <ResidualStrip items={residual} onSelect={openSwitchboardFile} /> : null}

      <TaskToastHost />
    </div>
  );
}
