"use client";

import { List, ListTodo, Menu, Network } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { queueColumnOpen, useBoardState } from "@/hooks/useBoardState";
import { useIsMobile } from "@/hooks/useIsMobile";
import { viewBus } from "@/hooks/viewPresenceBus";
import type { Flow } from "@/lib/flows/types";
import { useLocale } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { MAX_VISIBLE_PATHS } from "@/lib/view/types";
import type { Workflow } from "@/lib/workflows/types";

import { TaskStrip } from "./BranchPane";
import { clearDraftStorage, draftSrc, setDraftSrc, setDraftText } from "./DraftAgentPane";
import { planBoardConvergence, planClose } from "./projectBoardMutations";
import { claimedReviewerDescendantPaths, foldClaimedReviewers, isActiveFlow } from "./flows/flowModel";
import { PipelineDialog } from "./pipelines/PipelineDialog";
import { PipelineStrip } from "./pipelines/PipelineStrip";
import { pipelinesForProject, pipelineStripDomId, renderableFlowIds } from "./pipelines/pipelineModel";
import { buildSchemeLayout } from "./scheme/layout";
import { deckKey } from "./scheme/agentLinks";
import { clearWorkflowDraftStorage } from "./workflows/WorkflowDraftPane";
import { WorkflowStrip } from "./workflows/WorkflowStrip";
import { isWorkflowDraftId, workflowsForProject } from "./workflows/workflowModel";
import { TaskPanel } from "./tasks/TaskPanel";
import { TaskToastHost } from "./tasks/taskToast";
import { MobileFocusView } from "./mobile/MobileFocusView";
import { SchemeBoard } from "./scheme/SchemeBoard";
import { Switchboard } from "./Switchboard";
import {
  buildArchiveBranchGroups,
  buildBranchGroups,
  collapsedTrees,
  isChildConversation,
  projectKey,
  type ProjectView,
  resolveProjectView,
  quietHistoryRows,
  quietRootsWithActiveDescendants,
  residualItems,
} from "./projectModel";
import { ArchiveRestore } from "./icons";
import { ArchiveProjectButton, DeleteProjectButton, QuietFileList } from "./ProjectTrash";
import { SoundToggle } from "./SoundToggle";
import { ResidualStrip } from "./TreeAside";

/** How long an opened node keeps its highlight ring on the scheme. */
const HIGHLIGHT_MS = 1800;

interface Props {
  files: FileEntry[];
  flows: Flow[];
  pipelines: Pipeline[];
  /** Server-side pipelines store failed closed; pipelines above are empty. */
  pipelinesError?: string;
  workflows: Workflow[];
  tasks: BoardTask[];
  project: string;
  loaded: boolean;
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
  catalogKnown: boolean;
  onArchive: (project: string) => void;
  onUnarchive: (project: string) => void;
  /** Mobile shell: the rail hides behind a drawer, this opens it. */
  onMenu?: () => void;
  /** Mobile shell: the attention badge lives in the header row instead of the
      fixed corner, so it never covers the header's own controls. */
  attention?: React.ReactNode;
}

/** Manual additions and removals of scheme nodes, persisted per project. */
interface ColumnPrefs {
  manual: string[];
  hidden: string[];
  /** Connected conversations the user expanded from a collapsed view: they
      render as nodes wired below their parent (fed into the scheme's
      expandedConversationPaths), surviving reloads. */
  expanded: string[];
}

/* Conversation drafts survive remounts and reloads within the tab: an agent
   booted from a draft keeps its waiting pane until the transcript arrives. They
   are unspawned composer state, not shared board arrangement, so they stay
   per-tab in sessionStorage and do not sync (#38). */
const draftsKey = (project: string) => `llvDrafts:${project}`;

function loadDrafts(project: string): string[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(draftsKey(project)) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/* Pre-adding a conversation to a project's board before it mounts is recorded
   against the shared board store (queued, then flushed on that project's next
   load), so cross-project opens survive across devices — see useBoardState. */
export { queueColumnOpen };

/* Kept outside the component: the React Compiler's immutability check flags
   direct global mutation (location.hash = ...) inside a component body. */
function gotoProject(project: string) {
  location.hash = "#p=" + encodeURIComponent(project);
}

function ProjectViewTabs({
  value,
  onChange,
  floating = false,
}: {
  value: ProjectView;
  onChange: (next: ProjectView) => void;
  floating?: boolean;
}) {
  const { t } = useLocale();
  return (
    <div
      className={`z-30 inline-flex items-center gap-0.5 rounded-full border border-line bg-panel p-0.5 shadow-card ${
        floating ? "absolute left-3 top-3" : "mx-3 mt-3 self-start"
      }`}
    >
      {(["scheme", "list"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
            value === mode ? "bg-accent/10 text-accent" : "text-dim hover:text-ink"
          }`}
        >
          {mode === "scheme" ? <Network className="h-3 w-3" aria-hidden /> : <List className="h-3 w-3" aria-hidden />}
          {t(mode === "scheme" ? "dash.viewScheme" : "dash.viewList")}
        </button>
      ))}
    </div>
  );
}

export function ProjectDashboard({
  files,
  flows,
  pipelines,
  pipelinesError,
  workflows,
  tasks,
  project,
  loaded,
  openNonce,
  focusRequest,
  attentionPaths,
  archived,
  catalogKnown,
  onArchive,
  onUnarchive,
  onMenu,
  attention,
}: Props) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const highlightTimer = useRef<number | null>(null);
  const pendingFocusRef = useRef<string | null>(null);
  /* The board arrangement (which windows, hidden/expanded, view mode, task
     panel) now lives in the shared server store, synced across devices, with a
     one-time seed from the old per-browser localStorage (#38). Reads stay
     optimistic — a local edit shows at once, then PATCHes. */
  const board = useBoardState(project);
  const prefs = useMemo<ColumnPrefs>(
    () => ({ manual: board.prefs.manual, hidden: board.prefs.hidden, expanded: board.prefs.expanded }),
    [board.prefs],
  );
  const taskPanelOpen = board.prefs.taskPanelOpen;
  const [drafts, setDrafts] = useState<string[]>([]);
  const [pipelineDialogOpen, setPipelineDialogOpen] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  /* Jump targets the scheme would otherwise skip (a stalled root builds no
     automatic group; a stalled branch hides inside a mini stack) materialize
     as ephemeral nodes: React state only, never written to prefs, gone on
     reload — the queue can route to its quietest members while the manual
     column state stays untouched. */
  const [ephemeral, setEphemeral] = useState<string[]>([]);

  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setDrafts(loadDrafts(project));
  }, [project, openNonce]);
  const toggleTaskPanel = () => board.setTaskPanelOpen(!taskPanelOpen);
  useEffect(
    () => () => {
      if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
    },
    [],
  );

  /* Reviewer transcripts of active flows live inside their round decks:
     they never build their own groups, quiet trees or residual chips. */
  const expandedFlowConversations = useMemo(() => {
    /* Only ACTIVE flows expand their subtree into scheme nodes. A closed flow's
       reviewer is still claimed (folded off the board) via the full flows list,
       but promoting its idle reviewer descendants would re-open the whole
       implementer→reviewer→subtask tree as an active group — a closed flow must
       stay quiet history. So gate expansion on active ownership. */
    const activeFlows = flows.filter(isActiveFlow);
    const paths = claimedReviewerDescendantPaths(files, activeFlows);
    for (const flow of activeFlows) paths.add(flow.implementerPath);
    return paths;
  }, [files, flows]);
  /* Flow-driven expansions plus the ones the user opened by hand from a
     collapsed view: a connected conversation the user expanded renders as a
     node wired below its parent, just like an active-group child. */
  const expandedConversations = useMemo(() => {
    const paths = new Set(expandedFlowConversations);
    for (const path of prefs.expanded) paths.add(path);
    return paths;
  }, [expandedFlowConversations, prefs.expanded]);
  const groupFiles = useMemo(() => foldClaimedReviewers(files, flows), [files, flows]);
  const projectPipelines = useMemo(() => pipelinesForProject(pipelines, project, files), [pipelines, project, files]);
  /* Stage actions that route to a transcript are disabled once it leaves the
     scan, so gate them on the current file paths (AC4). */
  const renderablePaths = useMemo(() => new Set(files.map((entry) => entry.path)), [files]);
  const projectWorkflows = useMemo(() => workflowsForProject(workflows, project, files), [workflows, project, files]);
  const groups = useMemo(
    () => buildBranchGroups(groupFiles, project, { expandedConversationPaths: expandedConversations }),
    [groupFiles, project, expandedConversations],
  );
  const activeRoots = useMemo(() => new Set(groups.map((group) => group.key)), [groups]);
  const cards = useMemo(() => collapsedTrees(groupFiles, project, activeRoots), [groupFiles, project, activeRoots]);
  const quietActiveRoots = useMemo(
    () => quietRootsWithActiveDescendants(groupFiles, project, activeRoots),
    [groupFiles, project, activeRoots],
  );
  const residual = useMemo(
    () => residualItems(groupFiles, project, activeRoots, quietActiveRoots),
    [groupFiles, project, activeRoots, quietActiveRoots],
  );
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

  const chooseEmptyView = (next: ProjectView) => board.setViewMode(next);

  /* randomUUID needs a secure context; LAN http access gets the fallback. */
  const newDraftId = () =>
    typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  /* The «+ Agent» flow: a draft conversation lands on the scheme as a full
     pane and the camera glides to it — engine, directory and the first prompt
     are picked right inside that pane. */
  const addDraft = () => {
    const id = newDraftId();
    persistDrafts([...drafts, id]);
    pendingFocusRef.current = "draft::" + id;
  };

  /* The «+ Workflow» sibling (W6): the same draft-card pattern, its pane
     carries the template picker, the repo directory and the task brief. */
  const addWorkflowDraft = () => {
    const id = "wf-" + newDraftId();
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
    if (isWorkflowDraftId(id)) clearWorkflowDraftStorage(id);
    else clearDraftStorage(id);
    persistDrafts(drafts.filter((item) => item !== id));
  };

  /* «Send» on a task card, new-agent flavor: a fresh draft pane lands on the
     scheme seeded with the task text as its first prompt — the user picks the
     engine and directory and launches it. Nothing runs until they do. */
  const openTaskDraft = (task: BoardTask) => {
    const id = newDraftId();
    setDraftText(id, task.text);
    persistDrafts([...drafts, id]);
    pendingFocusRef.current = "draft::" + id;
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
    /* One durable close, independent of the node's current render class: the
       server reducer tombstones the path and strips manual/expanded membership,
       so a node closed while momentarily outside `autoPaths` no longer loses its
       tombstone and reappears (#60). The matching ephemeral jump target, if any,
       clears locally. */
    board.mutate([planClose(path, ephemeral).mutation]);
    setEphemeral((prev) => planClose(path, prev).ephemeral);
  };

  /* Latest manual list behind a ref so the convergence effect below reads
     current board state without re-running on every prefs change. */
  const prefsSnapshotRef = useRef(prefs);
  useEffect(() => {
    prefsSnapshotRef.current = prefs;
  });

  /* Every conversation the current catalog knows for this project, keyed by
     path — the convergence planner retires a manual entry that has left it. */
  const projectCatalog = useMemo(
    () => new Map(groupFiles.filter((file) => projectKey(file) === project).map((file) => [file.path, file] as const)),
    [groupFiles, project],
  );
  /* Only the root key and orphan flag of each group matter to reconciliation. */
  const rootGroups = useMemo(() => groups.map((group) => ({ key: group.key, orphanTask: group.orphanTask })), [groups]);

  /* Board membership convergence, as one ordered mutation batch:
       1. succession remap — a predecessor's tombstone/placement follows the
          stable conversation identity to its successor path;
       2. root reconciliation — seed every current root and retire child/subagent
          or catalog-absent pollution from `manual`, preserving tombstones.
     Remap precedes reconciliation so a hidden successor is honored and never
     re-seeded. Both mutations are idempotent, so a batch that changes nothing is
     dropped by the store before transport — no revision churn, no 40-entry
     oscillation. Runs only after the shared board has loaded, so it replays onto
     the server arrangement. */
  useEffect(() => {
    if (!board.loaded || board.sync === "unavailable") return;
    board.mutate(
      planBoardConvergence({
        files,
        groups: rootGroups,
        manual: prefsSnapshotRef.current.manual,
        catalog: projectCatalog,
        project,
      }),
    );
    /* eslint-disable-next-line react-hooks/exhaustive-deps -- board.mutate is
       delegated to a ref-stable store; manual is read through that ref. */
  }, [rootGroups, files, projectCatalog, project, board.loaded, board.sync]);

  /* Any open lands on the scheme: a card of another project pre-adds its node
     and switches the project; a conversation of this project joins the managed
     node list (or gets flashed when already there). */
  const openSwitchboardFile = (file: FileEntry) => {
    const fileProject = projectKey(file);
    if (fileProject !== project) {
      queueColumnOpen(fileProject, file.path, isChildConversation(file));
      gotoProject(fileProject);
      return;
    }
    const visible =
      (autoPaths.has(file.path) && !hiddenSet.has(file.path)) || manualNodes.some((item) => item.path === file.path);
    if (visible) {
      flashNode(file.path);
      return;
    }
    /* An explicit open is a restore: it lifts any tombstone and places the node
       by role. A child conversation expands as a node wired below its parent
       (the scheme promotes it via expandedConversationPaths); the predicate must
       match what buildBranchGroups can actually promote (isChildConversation).
       A compaction predecessor belongs outside the conversation and child
       categories, so routing it to expanded renders nothing. A node that is
       already an auto column restores in place (no stored
       membership); everything else becomes a standalone manual node. */
    if (isChildConversation(file)) {
      board.restore(file.path, "expanded");
    } else if (autoPaths.has(file.path)) {
      board.restore(file.path, "auto");
    } else {
      board.restore(file.path, "manual");
    }
    pendingFocusRef.current = file.path;
  };

  /* The pipeline strip renders in the header of both views, but its focus targets
     only exist on the scheme; from the list view the board is unmounted and the
     flash/restore would silently no-op. Switch to the scheme first so the
     scheduled focus actually lands. */
  const revealOnScheme = () => {
    if (board.prefs.viewMode !== "scheme") board.setViewMode("scheme");
  };
  /* Pipeline strip/verdict "open transcript": a run stage owns a board node, so
     route its agent path through the same board open. */
  const openPipelinePath = (path: string) => {
    const file = files.find((entry) => entry.path === path);
    if (!file) return;
    revealOnScheme();
    openSwitchboardFile(file);
  };
  /* A review-loop stage's reviewer transcript is folded into the flow's round
     deck, so glide to that deck (a byPath key); the reviewer node is removed, so
     openPipelinePath on its path would reveal nothing (#93 §2.2). */
  const openPipelineFlow = (flowId: string) => {
    revealOnScheme();
    flashNode(deckKey(flowId));
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
  const historyRows = useMemo(() => quietHistoryRows(files, project), [files, project]);
  const archiveGroups = useMemo(
    () => (hasNodes ? [] : buildArchiveBranchGroups(groupFiles.filter((file) => !hiddenSet.has(file.path)), project, 100)),
    [hasNodes, groupFiles, hiddenSet, project],
  );
  const hasArchiveNodes = archiveGroups.length > 0;
  const schemeAvailable = hasNodes || hasArchiveNodes;
  /* A review-loop action only lands if its flow has a rendered deck, and a deck
     exists only for an implementer placed as a board node — the same layout the
     scheme draws. Derive availability from that layout's nodes, so a scanned but
     unplaced (hidden/tombstoned) implementer disables the action (#93 finding). */
  const pipelineLayout = buildSchemeLayout(hasNodes ? schemeGroups : archiveGroups, hasNodes ? schemeManual : [], files, flows, hasNodes ? drafts : [], pipelines);
  const renderableFlows = renderableFlowIds(flows, new Set(pipelineLayout.nodes.map((node) => node.file.path)));
  const listAvailable = historyRows.length > 0;
  const projectView = resolveProjectView({
    preferredView: board.prefs.viewMode,
    hasNodes,
    hasArchiveNodes,
    hasHistoryRows: listAvailable,
  });
  const viewToggle = schemeAvailable && listAvailable;

  /* Presence context: which project is open and how its durable board is
     syncing. Reported here so every leaf's slice merges under it. */
  useEffect(() => {
    const revision = board.sync === "unavailable" ? null : board.revision;
    viewBus.reportContext({ project, board: { renderedRevision: revision, durableRevision: revision, sync: board.sync } });
  }, [project, board.revision, board.sync]);

  /* Presence slice for the non-scheme leaves: the flat history list reports its
     rows in rendered (visual) order; an empty project reports an empty view.
     When the scheme is shown, SchemeBoard / MobileFocusView owns the slice. */
  useEffect(() => {
    if (projectView === "scheme" && schemeAvailable) return;
    const visiblePaths = listAvailable ? historyRows.map((row) => row.path).slice(0, MAX_VISIBLE_PATHS) : [];
    /* A quiet history list is "list" on either platform; a truly empty project
       on the phone is the mobile-focus empty state. */
    const mode = listAvailable ? "list" : isMobile ? "mobile-focus" : "list";
    viewBus.reportSlice({ mode, focusedPath: null, selectedPaths: [], visiblePaths, camera: null });
  }, [projectView, schemeAvailable, listAvailable, historyRows, isMobile]);

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
        {/* The phone header hosts the create buttons and the attention badge;
            the status summary is the first thing to give up its room. */}
        {isMobile ? null : (
          <span className="truncate text-[11.5px] text-dim">{statusBits.length ? statusBits.join(" · ") : t("common.nothingRunning")}</span>
        )}
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
          <ArchiveProjectButton files={projectFiles} allowEmpty={catalogKnown} onArchive={() => onArchive(project)} compact={isMobile} />
        )}
        <DeleteProjectButton files={projectFiles} />
        {isMobile ? (
          <>
            <span className="ml-auto" aria-hidden />
            {attention}
            <button
              type="button"
              onClick={addDraft}
              aria-label={t("dash.newConvo")}
              className="flex shrink-0 items-center gap-1 rounded-[8px] border border-line bg-panel px-2.5 py-1 text-[11.5px] font-bold text-ink shadow-card hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <span className="text-[13px] leading-none text-accent">+</span> {t("dash.agent")}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={toggleTaskPanel}
            aria-pressed={taskPanelOpen}
            aria-label={t("tasks.panelToggleAria")}
            className={`ml-auto flex shrink-0 items-center gap-1 rounded-[8px] border px-2.5 py-1 text-[11.5px] font-bold shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
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
        <button
          type="button"
          onClick={() => setPipelineDialogOpen(true)}
          aria-label={t("dash.newPipeline")}
          className="flex shrink-0 items-center gap-1 rounded-[8px] border border-line bg-panel px-2.5 py-1 text-[11.5px] font-bold text-ink shadow-card hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <span className="text-[13px] leading-none text-accent">+</span> {t("dash.pipeline")}
        </button>
        <button
          type="button"
          onClick={addWorkflowDraft}
          aria-label={t("dash.newWorkflow")}
          className="flex shrink-0 items-center gap-1 rounded-[8px] border border-line bg-panel px-2.5 py-1 text-[11.5px] font-bold text-ink shadow-card hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <span className="text-[13px] leading-none text-accent">+</span> {t("dash.workflow")}
        </button>
      </div>

      {pipelineDialogOpen ? (
        /* Keyed by project: this dashboard survives project switches, so a
           key remount drops project A's task/repo/stages, which keeps them out of
           project B's draft (and stops A's repo from submitting under B). */
        <PipelineDialog key={project} project={project} onClose={() => setPipelineDialogOpen(false)} />
      ) : null}

      {pipelinesError ? (
        <div className="shrink-0 border-b border-line bg-[#fdf6ec] px-3 py-1.5 text-[11.5px] text-[#8a5b00]" role="alert">
          {t("dash.pipelinesUnavailable")}
        </div>
      ) : null}

      {projectPipelines.length || projectWorkflows.length ? (
        <div className="flex shrink-0 flex-col gap-1.5 border-b border-line bg-[#fbfbfd] px-3 py-1.5">
          {projectPipelines.map((pipeline) => (
            <div key={pipeline.id} id={pipelineStripDomId(pipeline.id)} tabIndex={-1} className="scroll-mt-2 rounded-[14px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
              <PipelineStrip pipeline={pipeline} flows={flows} renderablePaths={renderablePaths} renderableFlows={renderableFlows} onOpenPath={openPipelinePath} onOpenFlow={openPipelineFlow} />
            </div>
          ))}
          {projectWorkflows.map((wf) => (
            <WorkflowStrip key={wf.id} wf={wf} />
          ))}
        </div>
      ) : null}

      {dockedTasks.length ? (
        <div className="shrink-0 border-b border-line bg-[#fbfbfd]">
          {dockedTasks.map((task) => (
            <div
              key={task.path}
              className={`border-l-4 ${task.activity === "live" ? "border-l-ok bg-[#f2faf4]" : "border-l-[#9a9aa4]"}`}
            >
              <TaskStrip file={task} />
            </div>
          ))}
        </div>
      ) : null}

      {isMobile ? (
        <>
          {viewToggle ? <ProjectViewTabs value={projectView} onChange={chooseEmptyView} /> : null}
          {projectView === "scheme" && schemeAvailable ? (
            <MobileFocusView
              project={project}
              groups={hasNodes ? schemeGroups : archiveGroups}
              manual={hasNodes ? schemeManual : []}
              files={files}
              flows={flows}
              pipelines={pipelines}
              tasks={hasNodes ? projectTasks : []}
              drafts={hasNodes ? drafts : []}
              loaded={loaded}
              focus={highlight}
              onSelect={openSwitchboardFile}
              onClose={closeNode}
              onDraftClose={removeDraft}
              onDraftSpawned={draftSpawned}
              onHandoff={addHandoffDraft}
            />
          ) : listAvailable ? (
            <QuietFileList files={historyRows} activeRootPaths={quietActiveRoots} onOpen={openSwitchboardFile} />
          ) : (
            <div className="flex flex-1 items-center justify-center px-4 py-5 text-center">
              <div>
                <div className="text-[13.5px] font-semibold text-dim">{t("dash.emptyTitle")}</div>
                <div className="mt-0.5 text-[12px] text-dim">{t("dash.emptyHint")}</div>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1">
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {viewToggle ? (
              <ProjectViewTabs value={projectView} onChange={chooseEmptyView} floating />
            ) : null}
            {projectView === "scheme" && schemeAvailable ? (
              <SchemeBoard
                project={project}
                groups={hasNodes ? schemeGroups : archiveGroups}
                manual={hasNodes ? schemeManual : []}
                files={files}
                flows={flows}
                pipelines={pipelines}
                tasks={hasNodes ? projectTasks : []}
                drafts={hasNodes ? drafts : []}
                focus={highlight}
                attentionPaths={attentionPaths}
                onSelect={openSwitchboardFile}
                onClose={closeNode}
                onDraftClose={removeDraft}
                onDraftSpawned={draftSpawned}
                onHandoff={addHandoffDraft}
                onTaskDraft={openTaskDraft}
              />
            ) : listAvailable ? (
              <QuietFileList files={historyRows} activeRootPaths={quietActiveRoots} onOpen={openSwitchboardFile} />
            ) : (
              <div className="flex flex-1 items-center justify-center px-4 py-5 text-center">
                <div>
                  <div className="text-[13.5px] font-semibold text-dim">{t("dash.emptyTitle")}</div>
                  <div className="mt-0.5 text-[12px] text-dim">{t("dash.emptyHint")}</div>
                </div>
              </div>
            )}
            {/* The create button floats in the bottom-left corner of the board —
                away from the fixed attention pill in the top-right, above the
                residual strip. On the phone the header keeps this button. */}
            <div className="pointer-events-none absolute bottom-4 left-4 z-30 flex items-center gap-2">
              <button
                type="button"
                onClick={addDraft}
                aria-label={t("dash.newConvo")}
                className="pointer-events-auto flex shrink-0 items-center gap-1 rounded-[8px] border border-line bg-panel px-3 py-1.5 text-[11.5px] font-bold text-ink shadow-card hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <span className="text-[13px] leading-none text-accent">+</span> {t("dash.agent")}
              </button>
              <button
                type="button"
                onClick={() => setPipelineDialogOpen(true)}
                aria-label={t("board.newPipeline")}
                className="pointer-events-auto flex shrink-0 items-center gap-1 rounded-[8px] border border-line bg-panel px-3 py-1.5 text-[11.5px] font-bold text-ink shadow-card hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <span className="text-[13px] leading-none text-accent">+</span> {t("board.pipeline")}
              </button>
            </div>
          </div>
          {taskPanelOpen ? <TaskPanel tasks={tasks} project={project} onOpenTask={openTask} onClose={toggleTaskPanel} /> : null}
        </div>
      )}

      {/* The corner pill would sit on the focused pane's composer; on the
          phone the strip, the map and the toast cover its job. */}
      {isMobile ? null : <Switchboard files={files} flows={flows} project={project} loaded={loaded} onOpenFile={openSwitchboardFile} />}

      {!hasArchiveNodes && residual.length ? (
        <ResidualStrip items={residual} activeRootPaths={quietActiveRoots} onSelect={openSwitchboardFile} />
      ) : null}

      <TaskToastHost />
    </div>
  );
}
