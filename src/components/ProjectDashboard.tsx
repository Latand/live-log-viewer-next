"use client";

import { List, ListTodo, Menu, MessageSquarePlus, MoreHorizontal, Network, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { queueColumnOpen, useBoardState } from "@/hooks/useBoardState";
import { useIsMobile } from "@/hooks/useIsMobile";
import { viewBus } from "@/hooks/viewPresenceBus";
import type { Flow } from "@/lib/flows/types";
import { useLocale } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry, ProjectCatalogEntry } from "@/lib/types";
import { MAX_VISIBLE_PATHS } from "@/lib/view/types";
import type { Workflow } from "@/lib/workflows/types";

import { TaskStrip } from "./BranchPane";
import { ConversationList } from "./ConversationList";
import { clearDraftStorage, draftCwd, draftParentConversationId, draftSrc, replaceUnverifiedDraftCwd, requireDraftCwdConfirmation, seedDraftCwd, setDraftCwd, setDraftSrc, setDraftText } from "./DraftAgentPane";
import { planBoardConvergence, planClose } from "./projectBoardMutations";
import { claimedReviewerDescendantPaths, foldClaimedReviewers, isActiveFlow } from "./flows/flowModel";
import { PipelineDialog } from "./pipelines/PipelineDialog";
import { createDraftPipeline, pipelinesForProject } from "./pipelines/pipelineModel";
import { buildSchemeLayout } from "./scheme/layout";
import { collapsibleWorkerFiles, groupWorkerStacks, pipelineOriginOf, pipelineStagePipelineIds, protectedReviewerNodes } from "./scheme/workerCollapse";
import { WorkerStacks } from "./WorkerStacks";
import { MobileBottomShelf } from "./MobileBottomShelf";
import { clearWorkflowDraftStorage } from "./workflows/WorkflowDraftPane";
import { dropLegacyWorkflowDrafts, isWorkflowDraftId } from "./workflows/workflowModel";
import { TaskPanel } from "./tasks/TaskPanel";
import { TaskToastHost } from "./tasks/taskToast";
import { MobileFocusView } from "./mobile/MobileFocusView";
import { canHandoff, HandoffHandle } from "./HandoffHandle";
import { SchemeBoard } from "./scheme/SchemeBoard";
import { Switchboard } from "./Switchboard";
import {
  buildArchiveBranchGroups,
  buildBranchGroups,
  collapsedTrees,
  isChildConversation,
  projectDraftWorkingDirectory,
  projectKey,
  type ProjectView,
  resolveProjectView,
  quietHistoryRows,
  quietRootsWithActiveDescendants,
  residualItems,
} from "./projectModel";
import { ArchiveRestore } from "./icons";
import { ArchiveProjectButton, DeleteProjectButton } from "./ProjectTrash";
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
  projectCatalog?: ProjectCatalogEntry[];
  projectCwd?: string;
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
  catalogConversationCount: number;
  onArchive: (project: string) => void;
  onUnarchive: (project: string) => void;
  /** Mobile shell: the rail hides behind a drawer, this opens it. */
  onMenu?: () => void;
  /** Mobile shell: the attention badge lives in the header row instead of the
      fixed corner, so it never covers the header's own controls. */
  attention?: React.ReactNode;
  /** Dashboard-local navigation and focus (switchboard/quiet-list opens,
      drafts, pipeline and task jumps) supersede any unresolved deep-link
      intent held above; the Viewer cancels its pending hash here. */
  onUserNavigate?: () => void;
  /** Full-catalog list/search open: pins the transcript through the file feed. */
  onOpenCatalogFile?: (file: FileEntry) => void;
  /** Releases any retained list/search pin when its displayed node closes. */
  onCloseFile?: (path: string) => void;
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
const HANDOFF_CWD_RETRY_MS = 1_000;
const HANDOFF_CWD_MAX_RETRY_MS = 30_000;
const HANDOFF_CWD_MAX_ATTEMPTS = 4;

export function loadDrafts(project: string): string[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(draftsKey(project)) ?? "[]") as unknown;
    const ids = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
    /* Legacy workflow drafts (wf-*) are fenced (#136): a persisted one must not
       relaunch the removed WorkflowDraftPane through saved tab state. Drop them on
       restore and purge their pane storage + the rewritten list, for good. */
    const kept = dropLegacyWorkflowDrafts(ids);
    if (kept.length !== ids.length) {
      for (const id of ids) if (isWorkflowDraftId(id)) clearWorkflowDraftStorage(id);
      sessionStorage.setItem(draftsKey(project), JSON.stringify(kept));
    }
    return kept;
  } catch {
    return [];
  }
}

/* Pre-adding a conversation to a project's board before it mounts is recorded
   against the shared board store (queued, then flushed on that project's next
   load), so cross-project opens survive across devices — see useBoardState. */
export { queueColumnOpen };

export function pendingFocusTarget(pending: string | null, files: readonly FileEntry[]): string | null {
  if (!pending) return null;
  if (pending.startsWith("draft::") || files.some((file) => file.path === pending)) return pending;
  return null;
}

/* Kept outside the component: the React Compiler's immutability check flags
   direct global mutation (location.hash = ...) inside a component body. */
function gotoProject(project: string) {
  location.hash = "#p=" + encodeURIComponent(project);
}

function ProjectViewTabs({
  value,
  onChange,
  floating = false,
  header = false,
}: {
  value: ProjectView;
  onChange: (next: ProjectView) => void;
  floating?: boolean;
  /** Compact, unpositioned pill for the mobile toolbar row (finding 7): the
      scheme/list toggle rides in the header instead of its own stacked row. */
  header?: boolean;
}) {
  const { t } = useLocale();
  return (
    <div
      className={`z-30 inline-flex shrink-0 items-center gap-0.5 rounded-full border border-line bg-panel p-0.5 shadow-card ${
        header ? "" : floating ? "absolute left-3 top-3" : "mx-3 mt-3 self-start"
      }`}
    >
      {(["scheme", "list"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
          aria-label={t(mode === "scheme" ? "dash.viewScheme" : "dash.viewList")}
          className={`inline-flex items-center justify-center gap-1 rounded-full text-[11px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
            header ? "h-11 w-11" : "px-2 py-1"
          } ${value === mode ? "bg-accent/10 text-accent" : "text-dim hover:text-ink"}`}
        >
          {mode === "scheme" ? <Network className={header ? "h-3.5 w-3.5" : "h-3 w-3"} aria-hidden /> : <List className={header ? "h-3.5 w-3.5" : "h-3 w-3"} aria-hidden />}
          {header ? null : t(mode === "scheme" ? "dash.viewScheme" : "dash.viewList")}
        </button>
      ))}
    </div>
  );
}

/** A tap-triggered popover anchored to its trigger button — the phone toolbar
    folds its secondary and create actions into these so the row never overflows
    (finding 1). Closes on outside-tap or Escape. */
function HeaderMenu({
  triggerLabel,
  icon,
  children,
}: {
  triggerLabel: string;
  icon: React.ReactNode;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerLabel}
        title={triggerLabel}
        onClick={() => setOpen((value) => !value)}
        className="flex h-11 w-11 items-center justify-center rounded-[8px] border border-line bg-panel text-ink shadow-card hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        {icon}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+6px)] z-50 flex w-[210px] max-w-[calc(100vw-1.5rem)] flex-col gap-0.5 rounded-[12px] border border-line bg-panel p-1.5 shadow-[0_10px_36px_rgb(20_20_30/0.18)]"
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

/** One 44px-tall row inside a HeaderMenu popover. */
function HeaderMenuItem({ icon, label, onSelect, disabled = false }: { icon: React.ReactNode; label: string; onSelect: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      disabled={disabled}
      className="flex min-h-11 w-full items-center gap-2 rounded-[9px] px-2.5 text-left text-[13px] font-semibold text-ink hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45"
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-accent">{icon}</span>
      {label}
    </button>
  );
}

export function ProjectDashboard({
  files,
  flows,
  pipelines,
  pipelinesError,
  workflows,
  tasks,
  projectCatalog: projectCatalogEntries = [],
  projectCwd,
  project,
  loaded,
  openNonce,
  focusRequest,
  attentionPaths,
  archived,
  catalogKnown,
  catalogConversationCount,
  onArchive,
  onUnarchive,
  onMenu,
  attention,
  onUserNavigate,
  onOpenCatalogFile,
  onCloseFile,
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
  const [pendingRestoredHandoffs, setPendingRestoredHandoffs] = useState<Set<string>>(() => new Set());
  /* The phone focus view reports its currently-focused conversation here so the
     footer shelf can dock that pane's handoff control on its single row (issue
     #177 item 5). */
  const [mobileActiveFile, setMobileActiveFile] = useState<FileEntry | null>(null);
  /* Desktop `+ Task`: bump drops the inline sticky composer in a free slot on
     the board (pinned near the button). */
  const [newTaskNonce, setNewTaskNonce] = useState(0);
  /* Mobile `+ Task`: bump opens the TaskSheet's create view. */
  const [taskSheetNonce, setTaskSheetNonce] = useState(0);
  /* Place-on-map: the unplaced task whose next board click pins it. */
  const [placeTask, setPlaceTask] = useState<BoardTask | null>(null);
  const [pipelineDialogOpen, setPipelineDialogOpen] = useState(false);
  /* The canvas builder (#136): the draft pipeline whose group panel auto-opens
     right after `+ Пайплайн` drops it, so the operator lands in the builder with
     no hunting for its chip. */
  const [builderPipelineId, setBuilderPipelineId] = useState<string | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  /* Jump targets the scheme would otherwise skip (a stalled root builds no
     automatic group; a stalled branch hides inside a mini stack) materialize
     as ephemeral nodes: React state only, never written to prefs, gone on
     reload — the queue can route to its quietest members while the manual
     column state stays untouched. */
  const [ephemeral, setEphemeral] = useState<string[]>([]);
  /* Wall clock for the worker auto-collapse idle window (issue #112). Starts at
     0 so the server render and first client render agree (no hydration skew);
     the first tick lands the real time, and reviewer verdicts collapse without
     waiting on the clock at all. */
  const [nowMs, setNowMs] = useState(0);
  const projectCwdFallbacks = useMemo(() => [
    ...pipelines.filter((pipeline) => pipeline.project === project).map((pipeline) => pipeline.repoDir),
    ...workflows.filter((workflow) => workflow.project === project).map((workflow) => workflow.repoDir),
    ...(projectCwd ? [projectCwd] : []),
  ], [pipelines, project, projectCwd, workflows]);
  const resolvedDraftCwd = useMemo(
    () => projectDraftWorkingDirectory(files, project, projectCatalogEntries, undefined, projectCwdFallbacks, ""),
    [files, project, projectCatalogEntries, projectCwdFallbacks],
  );
  const initialDraftCwd = resolvedDraftCwd || "/";
  const initialDraftCwdVerified = Boolean(resolvedDraftCwd);

  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    const retryTimers = new Set<number>();
    const restored = loadDrafts(project);
    const unresolved: Array<{ id: string; sourcePath: string }> = [];
    for (const id of restored) {
      if (!isWorkflowDraftId(id)) {
        const sourcePath = draftSrc(id) || undefined;
        if (draftCwd(id)) {
          if (!sourcePath && initialDraftCwdVerified) replaceUnverifiedDraftCwd(id, initialDraftCwd);
          continue;
        }
        const sourceCwd = sourcePath
          ? files.find((file) => file.path === sourcePath)?.cwd?.trim()
          : undefined;
        if (sourceCwd) requireDraftCwdConfirmation(id, sourceCwd);
        else if (sourcePath) unresolved.push({ id, sourcePath });
        else if (initialDraftCwdVerified) seedDraftCwd(id, initialDraftCwd);
        else requireDraftCwdConfirmation(id, initialDraftCwd);
      }
    }
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setDrafts(restored);
    setPendingRestoredHandoffs(new Set(unresolved.map(({ id }) => id)));
    const resolveSourceCwd = (id: string, sourcePath: string, attempt = 0) => {
      void fetch("/api/spawn?project=" + encodeURIComponent(project) + "&src=" + encodeURIComponent(sourcePath))
        .then(async (response) => {
          if (!response.ok) throw new Error(`spawn suggestions failed: ${response.status}`);
          return response.json() as Promise<{ cwd?: string | null; cwdExists?: boolean }>;
        })
        .then((body) => {
          const sourceCwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
          if (!sourceCwd) throw new Error("spawn suggestions omitted the source cwd");
          if (cancelled) return;
          if (body.cwdExists === false) requireDraftCwdConfirmation(id, sourceCwd);
          else seedDraftCwd(id, sourceCwd);
          setPendingRestoredHandoffs((current) => {
            if (!current.has(id)) return current;
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        })
        .catch(() => {
          if (cancelled) return;
          if (attempt + 1 >= HANDOFF_CWD_MAX_ATTEMPTS) {
            requireDraftCwdConfirmation(id, initialDraftCwd);
            setPendingRestoredHandoffs((current) => {
              if (!current.has(id)) return current;
              const next = new Set(current);
              next.delete(id);
              return next;
            });
            return;
          }
          const delay = attempt < 2
            ? 0
            : Math.min(HANDOFF_CWD_RETRY_MS * (2 ** (attempt - 2)), HANDOFF_CWD_MAX_RETRY_MS);
          const timer = window.setTimeout(() => {
            retryTimers.delete(timer);
            resolveSourceCwd(id, sourcePath, attempt + 1);
          }, delay);
          retryTimers.add(timer);
        });
    };
    for (const { id, sourcePath } of unresolved) {
      resolveSourceCwd(id, sourcePath);
    }
    return () => {
      cancelled = true;
      for (const timer of retryTimers) window.clearTimeout(timer);
    };
  /* Source rows are sampled when restoration starts; the dedicated lookup
     retries independently and `initialDraftCwd` carries ordinary root changes. */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, openNonce, loaded, initialDraftCwd, initialDraftCwdVerified]);
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
  /* Worker-class auto-collapse (issue #112): a card is pinned against collapse
     by a GENUINE user placement (`explicitManual`, not the roots reconcile-roots
     auto-seeds into `prefs.manual`) or a manual expansion. */
  const pinnedPaths = useMemo(
    () => new Set([...board.explicitManual, ...prefs.expanded]),
    [board.explicitManual, prefs.expanded],
  );
  /* Fold every reviewer transcript into its round deck. Reviewers with no deck
     that must stay visible — an owner-pinned one opened from a worker stack, or
     one carrying authorship protection — are recovered by protectedReviewerNodes
     and materialized as standalone nodes (issue #112), so folding is
     unconditional here. */
  const groupFiles = useMemo(() => foldClaimedReviewers(files, flows), [files, flows]);
  /* Collapse-eligible worker conversations, derived BEFORE layout so their
     quiet full columns are removed from the scheme rather than left as
     full-size cards (a spawned worker stays a column under an active parent
     otherwise). Reviewers of active flows stay in their round deck and are
     kept out of the stacks after layout via deckReviewerPaths. */
  const collapsibleWorkers = useMemo(
    () => collapsibleWorkerFiles({ files, project, flows, pipelines, pinnedPaths, nowMs }),
    [files, project, flows, pipelines, pinnedPaths, nowMs],
  );
  const collapsedPaths = useMemo(() => new Set(collapsibleWorkers.map((file) => file.path)), [collapsibleWorkers]);
  /* Per-origin stack grouping inputs (issue #136): a worker folds under its
     pipeline, else its spawner — the topmost resolvable ancestor of its
     `parent` chain — so one origin is one chip regardless of how many workers or
     rounds it bred. Pipeline ownership resolves through the ancestor chain so a
     stage's spawned child stays in the pipeline stack, not a second origin one. */
  const filesByPath = useMemo(() => new Map(files.map((file) => [file.path, file] as const)), [files]);
  const pipelineIdByPath = useMemo(() => pipelineStagePipelineIds(pipelines, flows), [pipelines, flows]);
  const pipelineIdOf = useMemo(
    () => (path: string): string | null => {
      const file = filesByPath.get(path);
      return file ? pipelineOriginOf(file, filesByPath, pipelineIdByPath) : null;
    },
    [filesByPath, pipelineIdByPath],
  );
  const spawnerRootOf = useMemo(
    () => (file: FileEntry): string | null => {
      let cursor = file;
      const seen = new Set<string>([file.path]);
      for (;;) {
        const parent = cursor.parent ? filesByPath.get(cursor.parent) : undefined;
        if (!parent || seen.has(parent.path)) break;
        seen.add(parent.path);
        cursor = parent;
      }
      return cursor.path === file.path ? null : cursor.path;
    },
    [filesByPath],
  );
  /* The board layout's file set with collapsed workers removed. Kept separate
     from `groupFiles` so board-membership reconciliation still sees the full
     catalog and never retires a collapsed worker's durable placement. */
  const sceneFiles = useMemo(
    () => (collapsedPaths.size ? groupFiles.filter((file) => !collapsedPaths.has(file.path)) : groupFiles),
    [groupFiles, collapsedPaths],
  );
  const groups = useMemo(
    () => buildBranchGroups(sceneFiles, project, { expandedConversationPaths: expandedConversations }),
    [sceneFiles, project, expandedConversations],
  );
  const activeRoots = useMemo(() => new Set(groups.map((group) => group.key)), [groups]);
  const cards = useMemo(() => collapsedTrees(sceneFiles, project, activeRoots), [sceneFiles, project, activeRoots]);
  const quietActiveRoots = useMemo(
    () => quietRootsWithActiveDescendants(sceneFiles, project, activeRoots),
    [sceneFiles, project, activeRoots],
  );
  const residual = useMemo(
    () => residualItems(sceneFiles, project, activeRoots, quietActiveRoots),
    [sceneFiles, project, activeRoots, quietActiveRoots],
  );
  const autoPaths = useMemo(
    () => new Set(groups.flatMap((group) => group.columns.map((column) => column.file.path))),
    [groups],
  );
  const hiddenSet = useMemo(() => new Set(prefs.hidden), [prefs.hidden]);
  const projectTasks = useMemo(() => tasks.filter((task) => task.project === project), [tasks, project]);
  const manualNodes = useMemo(() => {
    const byPath = new Map(sceneFiles.map((file) => [file.path, file]));
    return prefs.manual
      .map((path) => byPath.get(path))
      .filter(
        (file): file is FileEntry =>
          file !== undefined && projectKey(file) === project && !autoPaths.has(file.path) && !hiddenSet.has(file.path),
      );
  }, [prefs.manual, sceneFiles, project, autoPaths, hiddenSet]);
  /* Ephemeral jump targets render exactly like manual nodes; paths the scheme
     already draws (auto columns, manual entries) filter out. Resolved against
     the full catalog (not sceneFiles) so an explicit jump can still reveal a
     collapsed worker as a transient node (#112). */
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
    /* Reviewers whose flow has NO rendered deck (a closed flow, or an active flow
       whose implementer is hidden/unplaced) render as standalone nodes so an
       owner-pinned or owner-touched reviewer is always on the board. Resolved
       from the full file set (they are folded out of groupFiles) and skipped when
       a deck already shows them. `placedNodePaths` is what the layout actually
       draws — a hidden group column is NOT placed (so it has no deck), but a
       hidden implementer revealed by an ephemeral jump IS placed (its deck
       renders, so its reviewer must not be duplicated here). */
    const placedNodePaths = new Set<string>([
      ...[...autoPaths].filter((path) => !hiddenSet.has(path)),
      ...manualPaths,
      ...extra.map((file) => file.path),
    ]);
    const protectedNodes = protectedReviewerNodes({ files, flows, renderedNodePaths: placedNodePaths, hiddenPaths: hiddenSet, pinnedPaths })
      .filter((file) => projectKey(file) === project);
    const extras = [...extra, ...protectedNodes];
    return extras.length ? [...manualNodes, ...extras] : manualNodes;
  }, [ephemeral, groupFiles, files, flows, project, autoPaths, hiddenSet, manualNodes, pinnedPaths]);
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
    onUserNavigate?.();
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
    const target = pendingFocusTarget(pending, files);
    if (!target) return;
    pendingFocusRef.current = null;
    flashNode(target);
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

  /* Desktop `+ Task`: drop the inline sticky composer in a free slot near the
     button (the board resolves the world anchor + findFreeSlot). Voice, images
     and a deadline all live in that on-board composer. */
  const addTask = () => {
    onUserNavigate?.();
    setNewTaskNonce((n) => n + 1);
  };
  /* Mobile `+ Task`: open the full-screen sheet's create view. */
  const addTaskMobile = () => {
    onUserNavigate?.();
    setTaskSheetNonce((n) => n + 1);
  };
  /* `place on map`: close the panel focus into board placement mode; the next
     canvas click pins the card exactly where clicked (identity unchanged). */
  const placeOnMap = (task: BoardTask) => {
    board.setTaskPanelOpen(false);
    setPlaceTask(task);
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
    if (!loaded) return;
    onUserNavigate?.();
    const id = newDraftId();
    if (initialDraftCwdVerified) setDraftCwd(id, initialDraftCwd);
    else requireDraftCwdConfirmation(id, initialDraftCwd);
    persistDrafts([...drafts, id]);
    pendingFocusRef.current = "draft::" + id;
  };

  /* `+ Пайплайн` on the canvas (#136): drop an empty DRAFT group and open its
     builder panel — no form. If the repo can't be resolved (or the POST fails),
     fall back to the creation dialog so the operator can fix it there. */
  const addPipelineDraft = async () => {
    if (draftBusy) return;
    onUserNavigate?.();
    setDraftBusy(true);
    const result = await createDraftPipeline(project);
    setDraftBusy(false);
    if (result.pipeline) setBuilderPipelineId(result.pipeline.id);
    else setPipelineDialogOpen(true);
  };

  /* The handoff handle under a pane: a draft that continues this conversation
     hangs right below it, inheriting the transcript and its directory. A
     repeat click refocuses the existing draft instead of stacking duplicates. */
  const addHandoffDraft = (file: FileEntry) => {
    onUserNavigate?.();
    const existing = drafts.find((id) => (file.conversationId
      && draftParentConversationId(id) === file.conversationId)
      || draftSrc(id) === file.path);
    if (existing) {
      flashNode("draft::" + existing);
      return;
    }
    const id = newDraftId();
    setDraftSrc(id, file.path, file.conversationId);
    const handoffCwd = projectDraftWorkingDirectory(files, project, projectCatalogEntries, file.path, projectCwdFallbacks, initialDraftCwd);
    requireDraftCwdConfirmation(id, handoffCwd);
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
    onUserNavigate?.();
    const id = newDraftId();
    setDraftText(id, task.text);
    if (initialDraftCwdVerified) setDraftCwd(id, initialDraftCwd);
    else requireDraftCwdConfirmation(id, initialDraftCwd);
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
    onCloseFile?.(path);
  };

  /* Latest manual list behind a ref so the convergence effect below reads
     current board state without re-running on every prefs change. */
  const prefsSnapshotRef = useRef(prefs);
  useEffect(() => {
    prefsSnapshotRef.current = prefs;
  });

  /* Every scheme-hydrated conversation for this project, keyed by path. The
     full catalog count tells the planner whether absence proves deletion. */
  const projectCatalog = useMemo(
    () => new Map(groupFiles.filter((file) => projectKey(file) === project).map((file) => [file.path, file] as const)),
    [groupFiles, project],
  );
  const schemeConversationCount = useMemo(
    () => files.filter((file) => projectKey(file) === project && file.root !== "claude-tasks").length,
    [files, project],
  );
  const catalogComplete = catalogKnown && schemeConversationCount >= catalogConversationCount;
  /* Only the root key and orphan flag of each group matter to reconciliation. */
  const rootGroups = useMemo(() => groups.map((group) => ({ key: group.key, orphanTask: group.orphanTask })), [groups]);

  /* Board membership convergence, as one ordered mutation batch:
       1. succession remap — a predecessor's tombstone/placement follows the
          stable conversation identity to its successor path;
       2. root reconciliation — seed every current root, retire child/subagent
          pollution, and retire absent paths only with complete membership.
     Remap precedes reconciliation so a hidden successor is honored and never
     re-seeded. Both mutations are idempotent, so a batch that changes nothing is
     dropped by the store before transport — no revision churn, no 40-entry
     oscillation. Runs only after the shared board has loaded, so it replays onto
     the server arrangement. */
  useEffect(() => {
    if (!board.loaded || board.sync === "unavailable") return;
    if (focusRequest && !pendingFocusTarget(focusRequest.path, files)) return;
    board.mutate(
      planBoardConvergence({
        files,
        groups: rootGroups,
        manual: prefsSnapshotRef.current.manual,
        catalog: projectCatalog,
        catalogComplete,
        project,
      }),
    );
    /* eslint-disable-next-line react-hooks/exhaustive-deps -- board.mutate is
       delegated to a ref-stable store; manual is read through that ref. */
  }, [rootGroups, files, projectCatalog, catalogComplete, project, board.loaded, board.sync, focusRequest]);

  /* Any open lands on the scheme: a card of another project pre-adds its node
     and switches the project; a conversation of this project joins the managed
     node list (or gets flashed when already there). */
  const openSwitchboardFile = (file: FileEntry) => {
    onUserNavigate?.();
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
  const openFullCatalogFile = onOpenCatalogFile ?? openSwitchboardFile;

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
  /* Active pipelines for this project (issue #136): the scheme must be available
     — and carry each pipeline's plan — even before its first stage transcript
     lands or after every stage node is hidden, now the persistent band is gone.
     They dock as placeholder groups in the layout (buildSchemeLayout). */
  const activePipelines = useMemo(() => pipelinesForProject(pipelines, project, files), [pipelines, project, files]);
  const visibleDrafts = drafts.filter((id) => !pendingRestoredHandoffs.has(id));
  const hasNodes =
    schemeGroups.length > 0 || schemeManual.length > 0 || visibleDrafts.length > 0 || projectTasks.length > 0 || activePipelines.length > 0;
  /* Scheme-visible project files, freshest first. They gate live activity for
     project actions; the deletion flow loads its complete target set from the
     uncapped conversation catalog before confirmation. */
  const projectFiles = useMemo(
    () => files.filter((file) => projectKey(file) === project).sort((a, b) => b.mtime - a.mtime),
    [files, project],
  );
  const historyRows = useMemo(() => quietHistoryRows(files, project), [files, project]);
  /* The archive fallback rebuilds from the full catalog, so it must honor the
     same two removals the live scene does — closed columns (`hiddenSet`) AND
     auto-collapsed workers (`collapsedPaths`). Without the collapse filter a
     quiet worker-only or closed-flow project would resurrect every folded
     worker as a full archive card, undoing the collapse the stacks promise. */
  const archiveGroups = useMemo(
    () => (hasNodes
      ? []
      : buildArchiveBranchGroups(
        groupFiles.filter((file) => !hiddenSet.has(file.path) && !collapsedPaths.has(file.path)),
        project,
        100,
      )),
    [hasNodes, groupFiles, hiddenSet, collapsedPaths, project],
  );
  const hasArchiveNodes = archiveGroups.length > 0;
  const schemeAvailable = hasNodes || hasArchiveNodes;
  /* A review-loop action only lands if its flow has a rendered deck, and a deck
     exists only for an implementer placed as a board node — the same layout the
     scheme draws. Derive availability from that layout's nodes, so a scanned but
     unplaced (hidden/tombstoned) implementer disables the action (#93 finding). */
  const pipelineLayout = buildSchemeLayout(hasNodes ? schemeGroups : archiveGroups, hasNodes ? schemeManual : [], files, flows, hasNodes ? visibleDrafts : [], pipelines);
  /* Worker rows the scheme still draws in a retained form — an active flow's
     reviewer round deck keeps its finished rounds as deck tabs. Those are
     re-admitted here so a folded reviewer is never listed twice (its deck AND a
     worker stack). Derived inline (like pipelineLayout above) so the React
     Compiler owns the caching — a manual useMemo over the non-memoized
     pipelineLayout can't be preserved. */
  const deckReviewerPaths = new Set<string>();
  for (const deck of pipelineLayout.decks) for (const round of deck.rounds) if (round.file) deckReviewerPaths.add(round.file.path);
  /* Stacks render regardless of `hasNodes` (the WorkerStacks strip sits outside
     the scheme/list switch), so a worker-only or fully-closed project still
     shows its folded workers instead of an empty board. `hiddenSet` joins the
     exclude set: a closed worker is a tombstone — it must not resurface as a
     stack member (its manual/expanded pin was dropped on close, so it would
     otherwise re-qualify as a plain collapse candidate). */
  const workerStacks = groupWorkerStacks(collapsibleWorkers, flows, new Set([...deckReviewerPaths, ...hiddenSet]), {
    pipelineIdOf,
    originOf: spawnerRootOf,
  });
  const listAvailable = catalogKnown || historyRows.length > 0;
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
      <div
        className={
          isMobile
            ? "flex min-h-[52px] shrink-0 items-center gap-1.5 border-b border-line bg-panel px-2 py-1.5"
            : "flex h-10 shrink-0 items-center gap-2.5 border-b border-line bg-panel px-4"
        }
      >
        {onMenu ? (
          <button
            type="button"
            className={`flex shrink-0 items-center justify-center rounded-[8px] border border-line bg-bg text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
              isMobile ? "h-11 w-11" : "-ml-1.5 h-7 w-7"
            }`}
            aria-label={t("dash.openProjects")}
            onClick={onMenu}
          >
            <Menu className={isMobile ? "h-5 w-5" : "h-4 w-4"} aria-hidden />
          </button>
        ) : null}
        <h1 className={`truncate text-[13.5px] font-bold ${isMobile ? "min-w-0 flex-1" : ""}`}>{project}</h1>
        {isMobile ? (
          <>
            {/* Toolbar folds to a single row (findings 1, 7): the scheme/list
                toggle rides here instead of its own stacked row, all create
                actions collapse into one `+` menu, and the secondary project
                actions into a `⋯` menu — every control is a 44px hit target. */}
            {viewToggle ? <ProjectViewTabs value={projectView} onChange={chooseEmptyView} header /> : null}
            <span className="min-w-0 max-w-[42vw] shrink truncate">{attention}</span>
            <HeaderMenu triggerLabel={t("dash.createMenu")} icon={<Plus className="h-5 w-5" aria-hidden />}>
              {(close) => (
                <>
                  <HeaderMenuItem icon={<MessageSquarePlus className="h-4 w-4" aria-hidden />} label={t("dash.agent")} disabled={!loaded} onSelect={() => { close(); addDraft(); }} />
                  <HeaderMenuItem icon={<ListTodo className="h-4 w-4" aria-hidden />} label={t("dash.task")} onSelect={() => { close(); addTaskMobile(); }} />
                  <HeaderMenuItem icon={<span className="text-[15px] font-bold leading-none">≡</span>} label={t("dash.pipeline")} onSelect={() => { close(); setPipelineDialogOpen(true); }} />
                </>
              )}
            </HeaderMenu>
            <HeaderMenu triggerLabel={t("dash.moreMenu")} icon={<MoreHorizontal className="h-5 w-5" aria-hidden />}>
              {() => (
                <>
                  <div className="flex min-h-11 items-center gap-2 px-1.5"><span className="text-[13px] font-semibold text-ink">{t("dash.soundMenu")}</span><SoundToggle /></div>
                  <div className="flex min-h-11 items-center px-1.5">
                    {archived ? (
                      <button
                        type="button"
                        className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-line bg-bg px-3 text-[13px] font-semibold text-dim hover:border-accent/40 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                        onClick={() => onUnarchive(project)}
                      >
                        <ArchiveRestore className="h-4 w-4" aria-hidden /> {t("dash.unarchive")}
                      </button>
                    ) : (
                      <ArchiveProjectButton files={projectFiles} allowEmpty={catalogKnown} onArchive={() => onArchive(project)} />
                    )}
                  </div>
                  <div className="flex min-h-11 items-center px-1.5"><DeleteProjectButton project={project} files={projectFiles} available={catalogKnown} /></div>
                </>
              )}
            </HeaderMenu>
          </>
        ) : (
          <>
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
              <ArchiveProjectButton files={projectFiles} allowEmpty={catalogKnown} onArchive={() => onArchive(project)} />
            )}
            <DeleteProjectButton project={project} files={projectFiles} available={catalogKnown} />
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
            <button
              type="button"
              onClick={() => setPipelineDialogOpen(true)}
              aria-label={t("dash.newPipeline")}
              className="flex shrink-0 items-center gap-1 rounded-[8px] border border-line bg-panel px-2.5 py-1 text-[11.5px] font-bold text-ink shadow-card hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <span className="text-[13px] leading-none text-accent">+</span> {t("dash.pipeline")}
            </button>
          </>
        )}
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
          {/* The scheme/list toggle moved into the header row (finding 7), so the
              phone shell is two nav rows at most: header + the focus-view strip. */}
          {projectView === "scheme" && schemeAvailable ? (
            <MobileFocusView
              project={project}
              groups={hasNodes ? schemeGroups : archiveGroups}
              manual={hasNodes ? schemeManual : []}
              files={files}
              flows={flows}
              pipelines={pipelines}
              surfacePipelines={activePipelines}
              workerStacks={workerStacks}
              tasks={hasNodes ? projectTasks : []}
              drafts={hasNodes ? visibleDrafts : []}
              loaded={loaded}
              focus={highlight}
              onSelect={openSwitchboardFile}
              onClose={closeNode}
              onDraftClose={removeDraft}
              onDraftSpawned={draftSpawned}
              onActiveChange={setMobileActiveFile}
              taskSheetNonce={taskSheetNonce}
            />
          ) : listAvailable ? (
            <ConversationList project={project} enabled={loaded && projectView === "list"} onOpen={openFullCatalogFile} />
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
                surfacePipelines={activePipelines}
                tasks={hasNodes ? projectTasks : []}
                workerStacks={workerStacks}
                drafts={hasNodes ? visibleDrafts : []}
                focus={highlight}
                attentionPaths={attentionPaths}
                onSelect={openSwitchboardFile}
                onClose={closeNode}
                onDraftClose={removeDraft}
                onDraftSpawned={draftSpawned}
                onHandoff={addHandoffDraft}
                onTaskDraft={openTaskDraft}
                placeTaskId={placeTask?.id ?? null}
                onTaskPlaced={() => setPlaceTask(null)}
                newTaskNonce={newTaskNonce}
                builderPipelineId={builderPipelineId}
                onBuilderOpened={() => setBuilderPipelineId(null)}
              />
            ) : listAvailable ? (
              <ConversationList project={project} enabled={loaded && projectView === "list"} onOpen={openFullCatalogFile} />
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
                disabled={!loaded}
                aria-label={t("dash.newConvo")}
                className="pointer-events-auto flex shrink-0 items-center gap-1 rounded-[8px] border border-line bg-panel px-3 py-1.5 text-[11.5px] font-bold text-ink shadow-card hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <span className="text-[13px] leading-none text-accent">+</span> {t("dash.agent")}
              </button>
              <button
                type="button"
                onClick={addTask}
                aria-label={t("dash.newTask")}
                className="pointer-events-auto flex shrink-0 items-center gap-1 rounded-[8px] border border-line bg-panel px-3 py-1.5 text-[11.5px] font-bold text-ink shadow-card hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <span className="text-[13px] leading-none text-accent">+</span> {t("dash.task")}
              </button>
              <button
                type="button"
                onClick={() => void addPipelineDraft()}
                disabled={draftBusy}
                aria-label={t("pipelineBuilder.createDraftAria")}
                className="pointer-events-auto flex shrink-0 items-center gap-1 rounded-[8px] border border-line bg-panel px-3 py-1.5 text-[11.5px] font-bold text-ink shadow-card hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
              >
                <span className="text-[13px] leading-none text-accent">+</span> {t("board.pipeline")}
              </button>
            </div>
          </div>
          {taskPanelOpen ? (
            <TaskPanel tasks={tasks} project={project} onOpenTask={openTask} onPlaceOnMap={placeOnMap} onClose={toggleTaskPanel} />
          ) : null}
        </div>
      )}

      {/* The corner pill would sit on the focused pane's composer; on the
          phone the strip, the map and the toast cover its job. */}
      {isMobile ? null : <Switchboard files={files} flows={flows} project={project} loaded={loaded} onOpenFile={openSwitchboardFile} onOpenCatalogFile={openFullCatalogFile} />}

      {/* Worker-class cards that have auto-collapsed fold into one stack per
          origin — flow / pipeline / spawner (issue #112, #136) — instead of
          vanishing to the switchboard; owner-touched and live cards are never
          included. The quiet `residual` strip is derived from `sceneFiles`,
          which already excludes every collapsed worker, so a card never appears
          in both a stack and here.

          On the phone the handoff control, the collapsed-worker strip, and the
          quiet strip share one footer row (issue #177 item 5): the handoff docks
          beside a single disclosure that folds both strips. Desktop renders the
          two strips directly, side by side. */}
      {(() => {
        const workerTotal = workerStacks.reduce((sum, stack) => sum + stack.items.length, 0);
        const quietTotal = !hasArchiveNodes ? residual.length : 0;
        const strips = (
          <>
            <WorkerStacks stacks={workerStacks} files={files} flows={flows} pipelines={pipelines} onSelect={openSwitchboardFile} />
            {!hasArchiveNodes && residual.length ? (
              <ResidualStrip items={residual} activeRootPaths={quietActiveRoots} onSelect={openSwitchboardFile} />
            ) : null}
          </>
        );
        if (!isMobile) return strips;
        /* Only the scheme focus view has a focused conversation to hand off; the
           list view and empty states dock no handoff. */
        const handoffFile = projectView === "scheme" && mobileActiveFile && canHandoff(mobileActiveFile) ? mobileActiveFile : null;
        const leading = handoffFile ? <HandoffHandle file={handoffFile} onHandoff={() => addHandoffDraft(handoffFile)} inline /> : null;
        return (
          <MobileBottomShelf total={workerTotal + quietTotal} leading={leading}>
            {strips}
          </MobileBottomShelf>
        );
      })()}

      <TaskToastHost />
    </div>
  );
}
