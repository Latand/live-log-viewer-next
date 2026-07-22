"use client";

import { BoxSelect, Focus, Hand, Maximize2, Minus, MousePointer2, Plus, StickyNote } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cameraToPresence, orderedSelection, schemeFocusedPath, schemeVisiblePaths, viewBus } from "@/hooks/viewPresenceBus";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import { useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { MAX_VISIBLE_PATHS } from "@/lib/view/types";

import { appendComposerDraft } from "@/components/TmuxComposer";
import { conversationIdentity } from "@/lib/accounts/identity";
import { BranchPane } from "@/components/BranchPane";
import { flowByImplementer } from "@/components/flows/flowModel";
import type { BranchGroup } from "@/components/projectModel";
import { deleteTask, handoffTask, unassignTask, updateTask } from "@/components/tasks/taskApi";
import { taskRelationsByPath } from "@/components/tasks/taskRelations";
import { taskTitle } from "@/components/tasks/taskModel";
import { pushTaskToast } from "@/components/tasks/taskToast";
import { cleanTitle } from "@/components/utils";
import { taskDeliveryText } from "@/lib/tasks/helpers";

import { compactPipelineLayoutFlows, compactPipelineOpenTarget, pipelineAnnouncement, pipelineLinkedTasks, pipelineStripByPath, renderableFlowIds } from "@/components/pipelines/pipelineModel";
import { BulkActionBar } from "./BulkActionBar";
import { EdgeChips } from "./EdgeChips";
import { nodesInRect, pruneSelection, selectionBBox } from "./lasso";
import { resolveExpandedNode } from "./expandedNode";
import { autoEditTokenFor, clearStaleRename, requestRename, type RenameRequest } from "./renameRequest";
import { currentWorkRect, currentWorkRects, rectUnion } from "./currentWork";
import { buildSchemeLayout } from "./layout";
import { Minimap, stackDotsFor, type StackDot } from "./Minimap";
import { boardClusters, chipObstacleRects, screenKeepoutObstacles } from "./offscreenClusters";
import type { WorkerStack } from "./workerCollapse";
import { AgentLinksLayer, EdgesLayer, GroupsLayer, LoopsLayer, MOVE_EASE, NodesLayer, type DeckFocus } from "./nodes";
import type { TaskCardHandlers } from "./TaskCard";
import { TaskEdgesLayer } from "./TaskEdgesLayer";
import { TasksLayer } from "./TasksLayer";
import { findFreeSlot } from "./findFreeSlot";
import {
  buildTaskEdges,
  buildTaskTargetIndex,
  isPlacedTask,
  routePathsBounds,
  routeTaskEdges,
  TASK_W,
  taskEdgesSignature,
  taskRect,
  taskWorldBounds,
  type SchemeRect,
} from "./taskGeometry";
import { resolveTaskPlacements } from "./taskPlacement";
import { useLasso } from "./useLasso";
import { useSchemeCamera } from "./useSchemeCamera";
import { useSpatialNav } from "./useSpatialNav";
import { createSubagentBadgeAnchorRegistry } from "./subagentBadgeAnchors";
import type { SubagentTrayApi } from "./SubagentTrayView";

/* Below this zoom the big node labels fade in over the unreadable panes. */
const LABEL_Z = 0.45;
/* Feed-sleep hysteresis around LABEL_Z: panes go dormant a notch below the
   label threshold and wake a notch above it, so pinching around the boundary
   never flaps every pane's polling on and off. */
const DORMANT_ENTER_Z = LABEL_Z * 0.95;
const DORMANT_EXIT_Z = LABEL_Z * 1.1;

const EMPTY_PATHS: ReadonlySet<string> = new Set();
const EMPTY_PIPELINE_STRIPS = new Map<string, Pipeline>();

interface Props {
  project: string;
  groups: BranchGroup[];
  manual: FileEntry[];
  files: FileEntry[];
  flows: Flow[];
  /** Synthetic direct one-shot review groups (issue #325): joined with `flows`
      for the layout so their decks/loops render, but excluded from every
      PATCH-backed flow control (FlowStrip, FlowHub, renderableFlows, halos). */
  reviewGroups?: Flow[];
  pipelines?: Pipeline[];
  /** This project's board tasks — sticky cards over the panes. */
  tasks: BoardTask[];
  /** Full project task list, including compact status stacks. */
  allTasks?: BoardTask[];
  /** Collapsed worker stacks (issue #136): drawn as one minimap dot per origin so
      folded workers read as a handful of dots, not an agent flood. */
  workerStacks?: WorkerStack[];
  /** Active project pipelines rendered as world-space desktop containers. */
  surfacePipelines?: Pipeline[];
  /** Ids of not-yet-spawned conversation drafts drawn as full panes. */
  drafts: string[];
  /** Durable identities the user has crowned (issue #224): their roots lift into
      a band pinned at the top of the scheme. */
  favorites?: ReadonlySet<string>;
  /** Compact transcript paths opened for one-pane history inspection. */
  isolatedManualPaths?: ReadonlySet<string>;
  /** Path to glide the camera to and ring briefly (set by openers). */
  focus: string | null;
  /** Path to ring without moving the camera, used by the mobile full-map overlay. */
  ring?: string | null;
  /** «Show only needs me» filter: non-null dims every shell without a queue member. */
  attentionPaths?: ReadonlySet<string> | null;
  /** Engine-native subagent tray surface (issue #142): trays keyed by durable
      parent id + folded-child exclusion + durable-intent callbacks. */
  trayApi?: SubagentTrayApi;
  onSelect: (file: FileEntry) => void;
  /** Optional map-mode node pick handler; receives the selected node key. */
  onNodePick?: (key: string) => void;
  /** Mobile map framing selection; desktop leaves this unset. */
  mapFrame?: "all" | "current";
  onClose: (path: string) => void;
  onDraftClose: (id: string) => void;
  /** A draft's agent booted and its transcript arrived: open it as a real node. */
  onDraftSpawned: (id: string, file: FileEntry) => void;
  /** The handoff handle under a pane: drop a draft that continues this
      conversation. Absent in map mode — the handle stays hidden there. */
  onHandoff?: (file: FileEntry) => void;
  /** Retry a terminal structured launch as a fresh editable draft. */
  onSpawnRetry?: (file: FileEntry) => void;
  /** «Send» on a task card with no aimed agent: seed a fresh draft conversation
      with the task text. Absent in map mode. */
  onTaskDraft?: (task: BoardTask) => void;
  /** Reveal a task linked from a compact pipeline rail. */
  onOpenTask?: (task: BoardTask) => void;
  /** Fold a full card back into its status stack (drops the durable expand
      pin). Absent in map mode and while status stacks are unavailable. */
  onTaskCollapse?: (task: BoardTask) => void;
  /** Place-on-map: an unplaced task armed by the panel. The next canvas click
      pins it where clicked; `onTaskPlaced` fires to disarm the caller. */
  placeTaskId?: string | null;
  onTaskPlaced?: () => void;
  /** Desktop `+ Task`: bumping this drops the inline sticky composer in a free
      slot near the button's world anchor (bottom-left quadrant), avoiding cards
      and panes via `findFreeSlot`. */
  newTaskNonce?: number;
  /** The canvas pipeline builder (#136): a draft pipeline whose group panel should
      open as soon as it renders, so `+ Пайплайн` lands the operator in the builder.
      `onBuilderOpened` fires once consumed so the caller can clear it. */
  builderPipelineId?: string | null;
  onBuilderOpened?: () => void;
}

function ToolButton({
  active,
  title,
  onClick,
  children,
}: {
  active?: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`inline-flex h-7 w-7 items-center justify-center rounded-[8px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        active ? "bg-accent/10 text-accent" : "text-muted hover:bg-canvas hover:text-primary"
      }`}
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * The scheme canvas — the only presentation of a project: conversations as
 * positioned cards on a pannable, zoomable world. Subagents sit below their
 * parent with bezier arrows, quiet branches hang as mini-card stacks, quiet
 * history lies under each card as a deck. Navigation: hand/select modes,
 * wheel pan, ctrl+wheel and pinch zoom, double-click to fit or focus, and a
 * minimap. The camera never re-renders panes: node/edge layers are memoized
 * and far-zoom labels scale through CSS vars. The viewport interaction engine
 * lives in useSchemeCamera; the node shells live in nodes.tsx.
 */
export function SchemeBoard({
  project,
  groups,
  manual,
  files,
  flows,
  reviewGroups = [],
  pipelines = [],
  tasks,
  allTasks = tasks,
  workerStacks = [],
  surfacePipelines = [],
  drafts,
  favorites,
  isolatedManualPaths = EMPTY_PATHS,
  focus,
  ring,
  attentionPaths,
  trayApi,
  onSelect,
  onNodePick,
  mapFrame,
  onClose,
  onDraftClose,
  onDraftSpawned,
  onHandoff,
  onSpawnRetry,
  onTaskDraft,
  onOpenTask,
  onTaskCollapse,
  placeTaskId,
  onTaskPlaced,
  newTaskNonce,
  builderPipelineId,
  onBuilderOpened,
}: Props) {
  const { t } = useLocale();
  const mapMode = Boolean(onNodePick);
  const [selected, setSelected] = useState<string | null>(null);
  const [badgeAnchorRevision, setBadgeAnchorRevision] = useState(0);
  const badgeAnchors = useMemo(
    () => createSubagentBadgeAnchorRegistry(() => setBadgeAnchorRevision((revision) => revision + 1)),
    [],
  );
  const [localBuilderPipelineId, setLocalBuilderPipelineId] = useState<string | null>(null);
  const activeBuilderPipelineId = builderPipelineId ?? localBuilderPipelineId;
  const handleBuilderOpened = useCallback(() => {
    setLocalBuilderPipelineId(null);
    onBuilderOpened?.();
  }, [onBuilderOpened]);
  const handlePipelineCreated = useCallback((created: Pipeline) => {
    setLocalBuilderPipelineId(created.id);
  }, []);
  /* The ephemeral selection session: a set of node paths plus an "armed"
     latch for the toolbar button. Session ⇔ armed or non-empty — a plain
     single-click ring never enters it. */
  const [multi, setMulti] = useState<ReadonlySet<string>>(EMPTY_PATHS);
  const [armed, setArmed] = useState(false);

  /* A focus jump also selects its node (D9): the selection ring stays after
     the 1.8 s highlight expires, marking where the camera landed. */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (focus) setSelected(focus);
  }, [focus]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /* Direct review groups join the layout's flow list so their decks place
     beside the reviewed conversation exactly like managed loops (issue #325);
     flowsByImpl and every strip/hub below keep reading the real `flows`. */
  const deckFlows = useMemo(() => (reviewGroups.length ? [...flows, ...reviewGroups] : flows), [flows, reviewGroups]);
  const layoutFlows = useMemo(() => compactPipelineLayoutFlows(pipelines, deckFlows), [pipelines, deckFlows]);
  /* Tasks created this session but not yet echoed by the poll: overlaid so a
     fresh card never blinks out between the POST and the refetch. Entries
     leave the cache the moment the server echoes them (or on local delete),
     so a later server-side removal can never be shadowed by a stale copy;
     the project filter keeps a card created here off other projects' boards. */
  const [localTasks, setLocalTasks] = useState<BoardTask[]>([]);
  const [pendingTask, setPendingTask] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const have = new Set(tasks.map((task) => task.id));
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- prune-only:
       returns the same reference unless an entry was echoed or reprojected */
    setLocalTasks((prev) => {
      const next = prev.filter((task) => !have.has(task.id) && task.project === project);
      return next.length === prev.length ? prev : next;
    });
  }, [tasks, project]);
  const mergedTasks = useMemo(() => {
    const have = new Set(tasks.map((task) => task.id));
    const fresh = localTasks.filter((task) => !have.has(task.id) && task.project === project);
    return fresh.length ? [...tasks, ...fresh] : tasks;
  }, [tasks, localTasks, project]);
  /* Session-only full-text state. Every geometry consumer reads this set, while
     durable task records and pinned positions stay unchanged. */
  const [textExpandedIds, setTextExpandedIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const present = new Set(mergedTasks.map((task) => task.id));
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- prune-only state synchronization */
    setTextExpandedIds((previous) => {
      if (![...previous].some((id) => !present.has(id))) return previous;
      return new Set([...previous].filter((id) => present.has(id)));
    });
  }, [mergedTasks]);
  /* Only placed tasks have a board position; unplaced ones (panel/mobile creation)
     live in the list until place-on-map pins them. */
  const boardTasks = useMemo(() => mergedTasks.filter(isPlacedTask), [mergedTasks]);
  /* Desktop pipeline ownership is the colored SchemeGroup halo (#353): the board
     layout places every materialized stage conversation and derives one halo that
     encloses them plus the planned-stage placeholders — and the pipeline's linked
     task cards (#531), so the pipeline reads as a single region — never a
     detached control card with a duplicate stage graph. */
  const layout = useMemo(
    () => buildSchemeLayout(groups, manual, files, layoutFlows, drafts, pipelines, surfacePipelines, favorites, isolatedManualPaths, boardTasks, textExpandedIds),
    [groups, manual, files, layoutFlows, drafts, pipelines, surfacePipelines, favorites, isolatedManualPaths, boardTasks, textExpandedIds],
  );

  /* Selection keys are transcript paths, so the 10s poll relayout keeps the
     set for free; nodes that left the board are pruned out of the state
     itself — a path returning later must not resurrect an old selection.
     pruneSelection returns the same reference when nothing changed, so the
     write below bails out instead of cascading. */
  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setMulti((prev) => pruneSelection(prev, layout.nodes));
  }, [layout]);
  const session = !mapMode && (armed || multi.size > 0);

  const clearSession = useCallback(() => {
    setMulti(EMPTY_PATHS);
    setArmed(false);
  }, []);
  const toggleMember = useCallback((path: string) => {
    setMulti((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  /* Camera-facing selection setter: null clears everything (Esc, background),
     additive is a Shift+click that lifts the click into the session. */
  const setSelectedFromCamera = useCallback(
    (value: string | null, additive?: boolean) => {
      if (value === null) {
        setSelected(null);
        clearSession();
        return;
      }
      if (additive && layout.byPath.has(value) && layout.nodes.some((node) => node.file.path === value)) {
        setSelected(null);
        setMulti((prev) => {
          const next = new Set(prev);
          const ringed = selectedRef.current;
          if (ringed && ringed !== value && layout.nodes.some((node) => node.file.path === ringed)) next.add(ringed);
          if (next.has(value)) next.delete(value);
          else next.add(value);
          return next;
        });
        return;
      }
      setSelected(value);
    },
    [layout, clearSession],
  );
  const flowsByImpl = useMemo(() => flowByImplementer(flows), [flows]);
  /* Which node hosts each pipeline's compact strip (§2.2): the current run
     stage's node. Review-loop current stages resolve to null here — their
     FlowStrip owns that slot — so the two controls never stack. */
  const pipelineStrips = useMemo(() => pipelineStripByPath(pipelines), [pipelines]);

  /* One conversation expanded full-window at a time. React state only — never
     persisted, gone on reload; the board underneath stays mounted, so camera,
     selection and column prefs survive the round trip untouched. */
  const [expanded, setExpanded] = useState<string | null>(null);
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setExpanded(null);
  }, [project]);
  /* eslint-enable react-hooks/set-state-in-effect */
  /* The overlay pane re-derives from the layout each poll, so its feed stays
     live; a node that left the layout (closed, deleted) drops the overlay. A
     succession is not a close: the predecessor entry is replaced by a successor
     under a new path (same conversation), matched via `predecessorPath` so the
     overlay — and its rename draft — survives. */
  const expandedNode = resolveExpandedNode(layout.nodes, expanded);
  const overlayOpen = expandedNode !== null;
  /* Track the successor's current path so the overlay stays open across a
     succession (and further successions chain from the new path). */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (expandedNode && expandedNode.file.path !== expanded) setExpanded(expandedNode.file.path);
  }, [expandedNode, expanded]);
  /* eslint-enable react-hooks/set-state-in-effect */
  /* Esc collapses the overlay. Capture phase, so the camera's own Escape
     handler never sees the press and the board selection stays. Presses
     inside text fields keep their meaning for the field. */
  useEffect(() => {
    if (!overlayOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const el = event.target as HTMLElement | null;
      if (el && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable)) return;
      event.preventDefault();
      event.stopPropagation();
      setExpanded(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [overlayOpen]);
  /* F2 renames the selected node: expand it and open exactly that overlay pane's
     editor via a token (a broadcast would also open the node's still-mounted
     board pane, whose blur would persist an unintended rename). Ignored inside
     text fields. */
  const [renameRequest, setRenameRequest] = useState<RenameRequest>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "F2") return;
      const el = event.target as HTMLElement | null;
      if (el && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable)) return;
      const path = selectedRef.current;
      if (!path) return;
      const node = layout.nodes.find((candidate) => candidate.file.path === path);
      if (!node?.file.renamable) return;
      event.preventDefault();
      setExpanded(path);
      setRenameRequest((prev) => requestRename(prev, path));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [layout]);
  /* Drop a consumed request once its overlay closes (or the expanded node
     changes), so an ordinary re-expand of the same node does not replay the
     stale token and reopen the editor (whose Collapse blur would persist an
     unintended override). */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setRenameRequest((prev) => clearStaleRename(prev, expanded));
  }, [expanded]);
  /* eslint-enable react-hooks/set-state-in-effect */
  const [deckFocus, setDeckFocus] = useState<DeckFocus | null>(null);
  const focusRound = useCallback((flowId: string, round: number) => {
    setDeckFocus((prev) => ({ flowId, round, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  const visualFocus = ring ?? focus;

  /* Handlers passed into the memoized nodes layer must stay identity-stable,
     otherwise every camera frame re-renders every pane. */
  const selectRef = useRef(onSelect);
  const nodePickRef = useRef(onNodePick);
  const closeRef = useRef(onClose);
  const draftCloseRef = useRef(onDraftClose);
  const draftSpawnedRef = useRef(onDraftSpawned);
  const handoffRef = useRef(onHandoff);
  const spawnRetryRef = useRef(onSpawnRetry);
  const taskDraftRef = useRef(onTaskDraft);
  const openTaskRef = useRef(onOpenTask);
  const taskCollapseRef = useRef(onTaskCollapse);
  useEffect(() => {
    selectRef.current = onSelect;
    nodePickRef.current = onNodePick;
    closeRef.current = onClose;
    draftCloseRef.current = onDraftClose;
    draftSpawnedRef.current = onDraftSpawned;
    handoffRef.current = onHandoff;
    spawnRetryRef.current = onSpawnRetry;
    taskDraftRef.current = onTaskDraft;
    openTaskRef.current = onOpenTask;
    taskCollapseRef.current = onTaskCollapse;
  });
  const stableSelect = useCallback((file: FileEntry) => {
    const nodePick = nodePickRef.current;
    if (nodePick) {
      nodePick(file.path);
      return;
    }
    selectRef.current(file);
  }, []);
  const stableClose = useCallback((path: string) => closeRef.current(path), []);
  const stableDraftClose = useCallback((id: string) => draftCloseRef.current(id), []);
  const stableDraftSpawned = useCallback((id: string, file: FileEntry) => draftSpawnedRef.current(id, file), []);
  const stableHandoff = useCallback((file: FileEntry) => handoffRef.current?.(file), []);
  const stableSpawnRetry = useCallback((file: FileEntry) => spawnRetryRef.current?.(file), []);
  const stableOpenTask = useCallback((task: BoardTask) => openTaskRef.current?.(task), []);
  /* The handle renders only when the opener wired a handler (not in map mode). */
  const handoffForNodes = onHandoff ? stableHandoff : undefined;
  const stableExpand = useCallback((path: string) => setExpanded(path), []);

  /* Compact node strips keep their path/flow navigation below. The group graph
     resolves every materialized stage by conversation id through stableSelect. */
  const openPipelinePath = useCallback((path: string) => {
    const file = files.find((entry) => entry.path === path);
    if (file) stableSelect(file);
  }, [files, stableSelect]);
  /* A stage-graph node hands back the attempt's conversation id AND its recorded
     transcript path. Resolution opens the CURRENT non-archived generation for the
     conversation id first, then falls back to the path — so a path-only attempt
     (no adopted id yet) still navigates and a migrated attempt never opens the
     folded predecessor. */
  const openPipelineFlow = useCallback((flowId: string) => {
    const flow = flows.find((candidate) => candidate.id === flowId);
    if (flow) focusRound(flow.id, flow.rounds.at(-1)?.n ?? 1);
  }, [flows, focusRound]);
  const renderablePipelinePaths = useMemo(() => new Set(files.map((entry) => entry.path)), [files]);
  const placedNodePaths = useMemo(() => new Set(layout.nodes.map((node) => node.file.path)), [layout]);
  const renderableGroupFlows = useMemo(() => renderableFlowIds(layoutFlows, placedNodePaths), [layoutFlows, placedNodePaths]);
  const linkedTasksByPipeline = useMemo(
    () => new Map(pipelines.map((pipeline) => [pipeline.id, pipelineLinkedTasks(pipeline, allTasks, flows, files)] as const)),
    [pipelines, allTasks, flows, files],
  );
  const completedPipelinesByTask = useMemo(() => {
    const byTask = new Map<string, Pipeline[]>();
    for (const pipeline of pipelines) {
      if (pipeline.state !== "completed" && pipeline.state !== "closed") continue;
      if (!compactPipelineOpenTarget(pipeline, flows, renderableGroupFlows, renderablePipelinePaths, files)) continue;
      for (const task of linkedTasksByPipeline.get(pipeline.id) ?? []) {
        const rows = byTask.get(task.id) ?? [];
        rows.push(pipeline);
        byTask.set(task.id, rows);
      }
    }
    return byTask;
  }, [pipelines, linkedTasksByPipeline, flows, renderableGroupFlows, renderablePipelinePaths, files]);
  const openPipelineHistory = useCallback((pipeline: Pipeline) => {
    const target = compactPipelineOpenTarget(pipeline, flows, renderableGroupFlows, renderablePipelinePaths, files);
    if (target?.kind === "path") openPipelinePath(target.path);
    else if (target?.kind === "flow") openPipelineFlow(target.flowId);
  }, [flows, renderableGroupFlows, renderablePipelinePaths, files, openPipelinePath, openPipelineFlow]);
  /* One minimap dot per collapsed worker-stack origin (issue #136): orchestration
     origins (flow/pipeline) in accent, spawner/worktree origins in gray. */
  const stackDots = useMemo<StackDot[]>(() => stackDotsFor(workerStacks), [workerStacks]);

  /* A stationary background tap: inside the session it toggles the node under
     the cursor (panes are click-through, so the DOM can't answer) or exits on
     empty ground; outside it, it drops the single ring — the job the press
     itself did before the marquee claimed background presses. */
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  /* The click that lands right after a marquee commit must be swallowed: the
     marquee arms from 4px of travel while the camera's tap threshold is 9px,
     so a short drag would otherwise commit AND then toggle/clear through
     onWorldTap. Armed at commit, disarmed on the very next press. */
  const marqueeClickGuard = useRef(false);
  const onWorldTap = useCallback(
    (wx: number, wy: number) => {
      if (marqueeClickGuard.current) {
        marqueeClickGuard.current = false;
        return true;
      }
      if (!sessionRef.current) {
        setSelected(null);
        return true;
      }
      const hit = nodesInRect(layout.nodes, { x: wx, y: wy, w: 0, h: 0 });
      if (hit.length) toggleMember(hit[0]!);
      else clearSession();
      return true;
    },
    [layout, toggleMember, clearSession],
  );

  /* The camera consults the lasso on every background press; the ref breaks
     the camera↔lasso creation cycle (the lasso needs the camera's viewport). */
  const lassoDownRef = useRef<(event: React.PointerEvent<HTMLDivElement>) => boolean>(() => false);

  /* Panes, decks, stacks, drafts and pipeline-owned task cards the free cards
     must not bury (issue #17): the placement pass spreads any pileup into their
     gaps. Group halos are derived from these same rects, so nudging cards never
     disturbs a flow/pipeline overlay. */
  const taskObstacles = useMemo<SchemeRect[]>(
    () => [...layout.nodes, ...layout.decks, ...layout.stacks, ...layout.drafts, ...layout.slots, ...layout.regionTasks].map(({ x, y, w, h }) => ({ x, y, w, h })),
    [layout],
  );
  /* Card rects the pipeline rails route around (issue #136). Unlike taskObstacles
     these stay the SAME objects byPath holds, so a rail can exclude its own two
     endpoints by identity before routing around the rest. */
  const railObstacles = useMemo<SchemeRect[]>(
    () => [...layout.nodes, ...layout.decks, ...layout.stacks, ...layout.drafts, ...layout.slots],
    [layout],
  );
  /* Task cards owned by a pipeline region (#531) sit at the layout's coordinates
     inside the colored halo; only the remaining free cards run through the
     collision solver below. */
  const regionTaskPos = useMemo(
    () => new Map(layout.regionTasks.map((rect) => [rect.taskId, { x: rect.x, y: rect.y }] as const)),
    [layout],
  );
  /* Collision-aware display positions: cards keep their stored spot unless they
     overlap another card or pane, so hand-arranged boards pass through untouched
     while the curator/inbox lattice pileup gets spread out and stays readable. */
  const placement = useMemo(
    () => resolveTaskPlacements(boardTasks.filter((task) => !regionTaskPos.has(task.id)), taskObstacles, textExpandedIds),
    [boardTasks, regionTaskPos, taskObstacles, textExpandedIds],
  );
  const placedTasks = useMemo(
    () =>
      boardTasks.map((task) => {
        const spot = regionTaskPos.get(task.id) ?? placement.get(task.id);
        return spot && (spot.x !== task.pos.x || spot.y !== task.pos.y) ? { ...task, pos: spot } : task;
      }),
    [boardTasks, regionTaskPos, placement],
  );
  /* Camera-facing rects: focus glides and map taps resolve task keys. */
  const taskRects = useMemo(
    () => new Map(placedTasks.map((task) => ["task::" + task.id, taskRect(task, textExpandedIds.has(task.id))] as const)),
    [placedTasks, textExpandedIds],
  );
  const taskNavLabels = useMemo(
    () => new Map(placedTasks.map((task) => [`task::${task.id}`, taskTitle(task.text) || t("tasks.untitled")] as const)),
    [placedTasks, t],
  );
  const taskTargetIndex = useMemo(() => buildTaskTargetIndex(layout, flows, files), [layout, flows, files]);
  const taskEdges = useMemo(
    () => buildTaskEdges(placedTasks, taskTargetIndex, textExpandedIds, files),
    [placedTasks, taskTargetIndex, textExpandedIds, files],
  );
  /* Card rects the edge router steers around, each tagged with its task so an
     edge is never counted as crossing the card it leaves from (issue #17). */
  const taskCardObstacles = useMemo(
    () => placedTasks.map((task) => ({ id: task.id, ...taskRect(task, textExpandedIds.has(task.id)) })),
    [placedTasks, textExpandedIds],
  );
  /* Route all task edges here — the layer only renders them — so the world box below can grow
     to include the routed geometry. Cached on a rounded geometry signature: the
     10s poll hands fresh arrays every tick, so an unchanged board reuses cached
     routes and the pass re-runs on the render thread only for a real move (issue #17). */
  const taskRoutesSig = useMemo(
    () => taskEdgesSignature(taskEdges, taskCardObstacles, taskObstacles),
    [taskEdges, taskCardObstacles, taskObstacles],
  );
  const taskRoutes = useMemo(
    () => routeTaskEdges(taskEdges, taskCardObstacles, taskObstacles),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the geometry signature; each poll gives the arrays a new identity while their content is unchanged
    [taskRoutesSig],
  );
  /* World bounds the camera, minimap and task-edge SVG all read: the node-derived
     layout box grown to swallow any card the placement pass (or a hand drag) put
     beyond or left/above it — AND every routed path/marker, since an obstacle
     detour can swing a connector or its retry badge past the card extent, so both
     stay reachable and on the map, never clipping out (issue #17). */
  const world = useMemo(() => {
    const rects = [...taskRects.values()];
    const routeBox = routePathsBounds(taskRoutes.values());
    if (routeBox) rects.push(routeBox);
    return taskWorldBounds(layout.width, layout.height, rects);
  }, [layout.width, layout.height, taskRects, taskRoutes]);
  const currentWork = useMemo(() => {
    const base = currentWorkRect(layout, placedTasks, favorites ?? EMPTY_PATHS, textExpandedIds);
    return rectUnion([...(base ? [base] : [])]);
  }, [layout, placedTasks, favorites, textExpandedIds]);
  const currentWorkCount = useMemo(
    () => currentWorkRects(layout, placedTasks, favorites ?? EMPTY_PATHS, textExpandedIds).length,
    [layout, placedTasks, favorites, textExpandedIds],
  );
  const clusters = useMemo(() => boardClusters(layout, favorites ?? EMPTY_PATHS), [layout, favorites]);
  /* Conversation-side relation controls (issue #292): each pane reserves a
     strip naming its assigned/captured tasks, mirroring the cards' own open
     controls, so the task↔agent relation navigates in both directions without
     any chip ever floating over conversation content. */
  const relatedTasksByPath = useMemo(() => taskRelationsByPath(files, allTasks), [files, allTasks]);
  const [frameAnnouncement, setFrameAnnouncement] = useState("");
  const announceFit = useCallback(
    (kind: "current" | "all") => {
      const count = kind === "current"
        ? currentWorkCount
        : layout.nodes.length + layout.drafts.length + layout.groups.length + layout.stacks.length + layout.decks.length + placedTasks.length;
      setFrameAnnouncement(t(kind === "current" ? "scheme.framedCurrent" : "scheme.framedAll", { count }));
    },
    [currentWorkCount, layout.nodes.length, layout.drafts.length, layout.groups.length, layout.stacks.length, layout.decks.length, placedTasks.length, t],
  );

  /* Place-on-map arms this ref with the id of an existing unplaced task; the
     next canvas click pins it instead of dropping a fresh sticky. */
  const placingRef = useRef<string | null>(placeTaskId ?? null);
  useEffect(() => {
    placingRef.current = placeTaskId ?? null;
  }, [placeTaskId]);

  const onPlaceTask = useCallback(
    (wx: number, wy: number) => {
      const pos = { x: Math.round(wx - TASK_W / 2), y: Math.round(wy - 14) };
      const placing = placingRef.current;
      if (placing) {
        placingRef.current = null;
        /* A concurrent DELETE resolves to a 404 → treated as gone (no resurrect),
           the refetch drops the row; success pins the card exactly where clicked. */
        void updateTask(placing, { placement: "pinned", pos }).then((error) => {
          if (error) pushTaskToast("err", error);
        });
        onTaskPlaced?.();
        return;
      }
      setPendingTask(pos);
    },
    [onTaskPlaced],
  );

  /* Spatial-nav handlers behind refs: the camera's keydown listener reads these
     while useSpatialNav (created below) needs the camera's own outputs — the
     ref breaks that creation cycle, same as lassoDownRef. */
  const navArrowRef = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const navZoomRef = useRef<(dir: 1 | -1) => boolean>(() => false);

  const {
    cam,
    vp,
    viewportRef,
    handLike,
    taskTool,
    setTaskTool,
    centerOn,
    panning,
    glide,
    setMode,
    onPointerDown,
    onPointerMove,
    onDoubleClick,
    onClick,
    zoomCenter,
    zoomTo,
    fit,
    fitCurrent,
    fitRect,
    jump,
    manualNonce,
    glideBy,
    glideFrame,
  } = useSchemeCamera({
    project,
    layout,
    world,
    currentWork,
    mapMode,
    focus,
    onNodePick,
    setSelected: setSelectedFromCamera,
    onBackgroundDown: mapMode
      ? undefined
      : (event) => {
          marqueeClickGuard.current = false;
          return lassoDownRef.current(event);
        },
    onWorldTap: mapMode ? undefined : onWorldTap,
    taskRects,
    onPlaceTask: mapMode ? undefined : onPlaceTask,
    onArrowNav: navArrowRef,
    onZoomKey: navZoomRef,
    onFit: announceFit,
  });

  /* Screen-space boxes of fixed board chrome an edge chip must never paint over
     — the subagent avatar/round stack and the composer/input, tagged
     `data-chip-keepout` — measured in the chip layer's local space. An
     off-screen card's avatar column pokes into the viewport at an edge where a
     chip would otherwise reveal over it (operator overlap report, issue #474);
     reserving these folds the chip into «+N» instead. Re-measured whenever the
     camera, viewport, or board content changes, and on any DOM mutation that
     adds/moves that chrome (badges appearing, the composer opening). */
  const [keepoutObstacles, setKeepoutObstacles] = useState<SchemeRect[]>([]);
  const measureKeepouts = useCallback(() => {
    const host = viewportRef.current;
    if (!host) return;
    const base = host.getBoundingClientRect();
    const rects = Array.from(document.querySelectorAll<HTMLElement>("[data-chip-keepout]"), (el) => el.getBoundingClientRect());
    const next = screenKeepoutObstacles(base, rects, { w: base.width, h: base.height });
    setKeepoutObstacles((prev) =>
      prev.length === next.length && prev.every((box, i) => box.x === next[i]!.x && box.y === next[i]!.y && box.w === next[i]!.w && box.h === next[i]!.h)
        ? prev
        : next,
    );
  }, [viewportRef]);
  /* Re-measure after any commit that repositions the camera, viewport, or board
     content (subagent columns move with the pan, the composer docks in a fresh
     slot). */
  useEffect(() => { measureKeepouts(); }, [measureKeepouts, cam, vp, layout]);
  /* Stable observers (set up once) catch the chrome appearing/resizing between
     those commits — a badge stack rendering in, the composer opening, a hover
     expanding an avatar — coalesced to one measurement per frame. */
  useEffect(() => {
    if (typeof window === "undefined") return;
    let frame = 0;
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 16) as unknown as number;
    const caf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : (id: number) => window.clearTimeout(id);
    const schedule = () => {
      if (frame) return;
      frame = raf(() => { frame = 0; measureKeepouts(); });
    };
    const observer = typeof MutationObserver === "function" ? new MutationObserver(schedule) : null;
    observer?.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class", "data-chip-keepout"] });
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    if (resize && viewportRef.current) resize.observe(viewportRef.current);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) caf(frame);
      observer?.disconnect();
      resize?.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [measureKeepouts, viewportRef]);

  /* Screen-space boxes of every rendered conversation surface — live panes,
     review decks, AND draft conversation panes (each draft rect spans its whole
     shell, its composer included) — plus the fixed keep-out chrome above: an
     edge-navigation chip that would paint over one folds into the «+N»
     disclosure instead of covering chat content (issue #292 rejection), the
     agent stack / composer, or an open draft's composer (#474). */
  const chipObstacles = useMemo(
    () => chipObstacleRects(layout.nodes, layout.decks, layout.drafts, cam, keepoutObstacles),
    [layout, cam, keepoutObstacles],
  );

  /* The fit functions change identity on every poll-driven relayout (useFiles
     hands a fresh `files` array ~10s, re-memoizing the layout), so the framing
     effect reads them through a ref and re-applies only on a real mapFrame
     transition — an open mobile map must hold a pinched/panned camera across
     polls. The applied frame resets while the board is still empty so the
     initial framing lands once content arrives. */
  const mapFitRef = useRef({ fit, fitCurrent });
  useEffect(() => {
    mapFitRef.current = { fit, fitCurrent };
  });
  const appliedMapFrame = useRef<"all" | "current" | null>(null);
  const hasMapContent =
    layout.nodes.length > 0
    || layout.drafts.length > 0
    || layout.groups.length > 0
    || layout.slots.length > 0
    || taskRects.size > 0;
  useEffect(() => {
    if (!mapMode || !mapFrame || !hasMapContent) {
      appliedMapFrame.current = null;
      return;
    }
    if (appliedMapFrame.current === mapFrame) return;
    appliedMapFrame.current = mapFrame;
    if (mapFrame === "current") mapFitRef.current.fitCurrent();
    else mapFitRef.current.fit();
  }, [mapMode, mapFrame, hasMapContent]);

  /* Place-on-map requested from the panel: arm the crosshair so the next click
     pins the task (the camera reverts to select once it lands). */
  useEffect(() => {
    if (placeTaskId && !mapMode) setTaskTool(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only when a new placement is requested
  }, [placeTaskId]);

  /* Desktop `+ Task`: drop the sticky composer in a free slot near the button's
     world anchor (the viewport's bottom-left quadrant), stepping clear of every
     card and pane through findFreeSlot. */
  useEffect(() => {
    if (!newTaskNonce || mapMode) return;
    const anchorX = (vp.w * 0.25 - cam.x) / cam.z;
    const anchorY = (vp.h * 0.7 - cam.y) / cam.z;
    const obstacles = [...taskRects.values(), ...layout.nodes];
    const slot = findFreeSlot({ x: Math.round(anchorX - TASK_W / 2), y: Math.round(anchorY) }, { w: TASK_W, h: 140 }, obstacles);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot drop on a `+ Task` press
    setPendingTask(slot);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on a new `+ Task` press
  }, [newTaskNonce]);

  /* A fresh draft glides to its compact colored halo and keeps the tall draft
     editor closed (#353 review). Configuration opens through the halo header's
     explicit disclosure, so a new draft lands the operator on the region. The halo
     materializes from the draft's placeholder members once the POST → refetch →
     relayout round-trip lands, so the reveal waits for that group to appear, then
     consumes the request. */
  const builderRevealed = useRef<string | null>(null);
  useEffect(() => {
    if (!activeBuilderPipelineId || mapMode) return;
    if (builderRevealed.current === activeBuilderPipelineId) return;
    const group = layout.groups.find((candidate) => candidate.kind === "pipeline" && candidate.id === activeBuilderPipelineId);
    if (!group) return;
    builderRevealed.current = activeBuilderPipelineId;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot reveal syncing camera + selection to a new draft
    clearSession();
    setMode("select");
    centerOn(group, 0.75);
    handleBuilderOpened();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires when the new draft's halo first renders
  }, [activeBuilderPipelineId, layout.groups]);

  /* Spatial keyboard navigation: live only on the desktop board — a selection
     session, an expanded overlay, or map mode all suspend it. */
  const navEnabled = !mapMode && !session && !overlayOpen;
  const { onArrow, onZoomKey, announcement } = useSpatialNav({
    enabled: navEnabled,
    layout,
    taskRects,
    taskLabels: taskNavLabels,
    cam,
    vp,
    selected,
    setSelected,
    centerOn,
    glideBy,
    glideFrame,
    manualNonce,
  });
  useEffect(() => {
    navArrowRef.current = onArrow;
    navZoomRef.current = onZoomKey;
  }, [onArrow, onZoomKey]);

  /* Pipeline transitions (a stage advancing, parking, pausing, completing) are
     otherwise silent to screen readers — the spatial-nav live region only speaks
     on arrow moves. Track each pipeline's state+cursor signature and, when one
     changes, write the new position straight into its own live region. Writing
     the DOM node in an effect is the sanctioned way to push the latest state into
     an external system without a cascading render. */
  const pipelineLiveRef = useRef<HTMLDivElement>(null);
  const pipelineSigs = useRef(new Map<string, string>());
  useEffect(() => {
    const next = new Map<string, string>();
    const changed: string[] = [];
    for (const pipeline of pipelines) {
      const sig = `${pipeline.state}:${pipeline.cursor?.stageId ?? ""}:${pipeline.cursor?.state ?? ""}`;
      next.set(pipeline.id, sig);
      const before = pipelineSigs.current.get(pipeline.id);
      if (before !== undefined && before !== sig) changed.push(pipelineAnnouncement(t, pipeline));
    }
    pipelineSigs.current = next;
    if (changed.length && pipelineLiveRef.current) pipelineLiveRef.current.textContent = changed.join(". ");
  }, [pipelines, t]);

  const commitMarquee = useCallback((paths: string[], additive: boolean) => {
    marqueeClickGuard.current = true;
    setSelected(null);
    setMulti((prev) => {
      if (!additive) return paths.length ? new Set(paths) : EMPTY_PATHS;
      if (!paths.length) return prev;
      const next = new Set(prev);
      for (const path of paths) next.add(path);
      return next;
    });
  }, []);
  const { marquee, onBackgroundDown } = useLasso({
    viewportRef,
    cam,
    layout,
    enabled: !mapMode,
    session,
    onCommit: commitMarquee,
  });
  useEffect(() => {
    lassoDownRef.current = onBackgroundDown;
  }, [onBackgroundDown]);

  const selectedNodes = useMemo(() => layout.nodes.filter((node) => multi.has(node.file.path)), [layout, multi]);
  const bbox = useMemo(() => selectionBBox(layout.nodes, multi), [layout, multi]);
  /* Stable fit handler: the memoized bar must not re-render on bbox moves. */
  const bboxRef = useRef(bbox);
  useEffect(() => {
    bboxRef.current = bbox;
  }, [bbox]);
  const fitSelection = useCallback(() => {
    if (bboxRef.current) fitRect(bboxRef.current);
  }, [fitRect]);

  /* Latest camera behind a stable ref: card drags divide pointer deltas by
     cam.z without subscribing the memoized task layer to camera frames. */
  const camRef = useRef(cam);
  useEffect(() => {
    camRef.current = cam;
  }, [cam]);

  /* Presence: the desktop scheme reports its view slice for observation. The
     assembler reads current state each commit through this ref, so publishing a
     camera frame never re-renders the memoized pane layers. The mobile map
     (mapMode) reports through MobileFocusView, so this instance stays quiet. */
  const reportView = useRef<() => void>(() => {});
  useEffect(() => {
    reportView.current = () => {
      if (mapMode) return;
      /* A full-window expanded pane is the sole visible transcript; otherwise
         the nodes whose rect the camera frames, in layout order. */
      const visiblePaths = expanded ? [expanded] : schemeVisiblePaths(layout, cam, vp, MAX_VISIBLE_PATHS);
      /* The ring can sit on a virtual layout key (a deck, draft or quiet-branch
         stack) while spatial nav walks the board; only real transcript nodes
         are valid focus targets, so anything else publishes as no focus. */
      const transcriptPaths = new Set(layout.nodes.map((node) => node.file.path));
      viewBus.reportSlice({
        mode: "scheme",
        focusedPath: schemeFocusedPath(expanded, selected, transcriptPaths),
        selectedPaths: orderedSelection(layout, multi),
        visiblePaths,
        camera: cameraToPresence(cam, vp),
        viewport: { width: vp.w, height: vp.h, dpr: typeof window === "undefined" ? 1 : window.devicePixelRatio || 1 },
      });
    };
  });
  /* Focus, selection, overlay and layout changes publish promptly. */
  useEffect(() => {
    if (!mapMode) reportView.current();
  }, [mapMode, layout, multi, selected, expanded]);
  /* Camera and viewport settles are debounced, mirroring the 300 ms llvCam
     persist — a pan produces one publish after it stops, never per frame. */
  useEffect(() => {
    if (mapMode) return;
    const timer = window.setTimeout(() => reportView.current(), 300);
    return () => window.clearTimeout(timer);
  }, [mapMode, cam, vp]);

  /* A wrong-target legacy edge (a failed delivery from an older build) is
     cleaned up by a click — nothing is ever re-delivered from the board. */
  const retryEdge = useCallback((taskId: string, path: string) => void unassignTask(taskId, path), []);

  const taskTargetIndexRef = useRef(taskTargetIndex);
  useEffect(() => {
    taskTargetIndexRef.current = taskTargetIndex;
  }, [taskTargetIndex]);

  const taskHandlers = useMemo<TaskCardHandlers>(
    () => ({
      patch: async (id, patch) => {
        const error = await updateTask(id, patch);
        if (error) pushTaskToast("err", error);
        return error;
      },
      remove: (id) => {
        /* Drop the optimistic copy too, or a delete before the first poll
           echo would leave the card resurrected from the local cache. */
        setLocalTasks((prev) => (prev.some((task) => task.id === id) ? prev.filter((task) => task.id !== id) : prev));
        void deleteTask(id).then((error) => {
          if (error) pushTaskToast("err", error);
        });
      },
      /* Handoff into a running agent: the task text lands in that pane's
         composer (never auto-sent) and a removable link is recorded so the
         card shows where it was routed. */
      handoff: async (task, file) => {
        /* Persist any pending text edit and record the link first; only then
           seed the composer, and with the canonical saved text — appending
           before the save could inject stale text or leave text behind on a
           failed handoff. */
        const res = await handoffTask(task.id, file.path);
        if ("error" in res) {
          pushTaskToast("err", res.error);
          return res.error;
        }
        appendComposerDraft(conversationIdentity(file), taskDeliveryText(res.task.id, res.task.text));
        return null;
      },
      /* No aimed agent: seed a fresh draft conversation with the task text —
         launches nothing until the user picks an engine and hits send. */
      draft: (task) => taskDraftRef.current?.(task),
      /* Fold-back rides the same ref pattern: the button renders only where a
         collapse target exists (the dashboard always wires one on desktop). */
      collapse: (task) => taskCollapseRef.current?.(task),
      unassign: async (task, ref) => {
        const error = await unassignTask(task.id, ref);
        if (error) pushTaskToast("err", error);
      },
      center: (rect: SchemeRect) => centerOn(rect, 0.75),
      toggleExpand: (id) => {
        setTextExpandedIds((previous) => {
          const next = new Set(previous);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      },
      openAgent: (file) => {
        const target = taskTargetIndexRef.current.get(file.path);
        if (target) centerOn(target, 0.75);
        stableSelect(file);
      },
    }),
    [centerOn, stableSelect],
  );

  /* The sticky composer owns the create (text, voice, images, deadline); the
     board just adopts the fresh card optimistically and drops the sticky. */
  const handleStickyCreated = useCallback((task: BoardTask) => {
    setLocalTasks((prev) => [...prev, task]);
    setPendingTask(null);
  }, []);
  const cancelCreate = useCallback(() => setPendingTask(null), []);

  /* Far-zoom feed sleep: behind the identity labels the pane content is
     unreadable, so the live feeds stop polling until zoom comes back. One
     boolean flip re-renders the memoized nodes layer once per crossing —
     never per camera frame. */
  const [dormant, setDormant] = useState(false);
  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- hysteresis
       over a per-frame camera value; same-value writes bail out in React */
    setDormant((prev) => (prev ? cam.z < DORMANT_EXIT_Z : cam.z < DORMANT_ENTER_Z));
  }, [cam.z]);

  const tile = 24 * cam.z;

  return (
    <>
    <div
      ref={viewportRef}
      className={`relative min-h-0 flex-1 overflow-clip ${
        panning ? "cursor-grabbing select-none" : taskTool ? "cursor-crosshair" : handLike ? "cursor-grab" : ""
      } ${handLike ? "touch-none" : ""}`}
      tabIndex={mapMode ? undefined : 0}
      aria-label={mapMode ? undefined : t("scheme.boardAria")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onDoubleClick={onDoubleClick}
      onClick={onClick}
      /* Focusable controls live inside world-space panes. Browser focus can
         scroll a clipped ancestor to reveal one, which would offset every
         camera coordinate and carry the minimap away from its corner. */
      onScroll={(event) => {
        event.currentTarget.scrollLeft = 0;
        event.currentTarget.scrollTop = 0;
      }}
    >
      {/* Announces the window the arrow keys just landed on, for screen readers. */}
      <div className="sr-only" aria-live="polite" role="status">
        {announcement}
      </div>
      <div className="sr-only" aria-live="polite" role="status">
        {frameAnnouncement}
      </div>
      {/* Separate region so a pipeline transition never races the nav message;
          its text is written imperatively by the effect above. */}
      <div ref={pipelineLiveRef} className="sr-only" aria-live="polite" role="status" />
      {/* Dot grid on its own composited layer: panning moves it with a
          transform (modulo one tile) instead of repainting the viewport
          background every frame. */}
      <div
        aria-hidden
        className="pointer-events-none absolute"
        style={{
          inset: -tile,
          backgroundImage: "radial-gradient(color-mix(in srgb, var(--color-primary) 9%, transparent) 1px, transparent 1px)",
          backgroundSize: `${tile}px ${tile}px`,
          transform: `translate(${((cam.x % tile) + tile) % tile}px, ${((cam.y % tile) + tile) % tile}px)`,
          willChange: "transform",
        }}
      />
      <div
        key={project}
        className={`absolute left-0 top-0 ${panning ? "scheme-panning" : ""}`}
        style={
          {
            width: layout.width,
            height: layout.height,
            transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`,
            transformOrigin: "0 0",
            transition: glide ? `transform .45s ${MOVE_EASE}` : undefined,
            willChange: "transform",
            "--inv-z": String(1 / cam.z),
            "--label-o": cam.z < LABEL_Z ? "1" : "0",
          } as React.CSSProperties
        }
      >
        {/* Group halos sit behind every edge and card so a running flow/pipeline
            reads as one framed region; the label chip stays live off the map. */}
        <GroupsLayer groups={layout.groups} interactive={!mapMode && !handLike && !session} />
        <EdgesLayer edges={layout.edges} badgeAnchors={badgeAnchors} badgeAnchorRevision={badgeAnchorRevision} width={layout.width} height={layout.height} />
        <LoopsLayer loops={layout.loops} width={layout.width} height={layout.height} />
        {/* Rails/badges stay passive on the map, but the pipeline hub keeps its
            tap target there — the mobile lite map reaches pipeline controls only
            through it (#93 §2.3). */}
        <AgentLinksLayer links={layout.links} byPath={layout.byPath} obstacles={railObstacles} interactive={!mapMode && !handLike && !session} hubInteractive={!handLike && !session} width={layout.width} height={layout.height} />
        <NodesLayer
          layout={layout}
          project={project}
          files={files}
          interactive={!handLike && !session}
          lite={mapMode}
          dormant={dormant}
          selected={selected}
          multi={multi}
          session={session}
          focus={visualFocus}
          attentionPaths={attentionPaths ?? null}
          flowsByImpl={flowsByImpl}
          flows={flows}
          pipelines={pipelines}
          pipelineStrips={mapMode ? pipelineStrips : EMPTY_PIPELINE_STRIPS}
          linkedTasksByPipeline={linkedTasksByPipeline}
          relatedTasksByPath={relatedTasksByPath}
          deckFocus={deckFocus}
          badgeAnchors={badgeAnchors}
          trayApi={mapMode ? undefined : trayApi}
          onSelect={stableSelect}
          onClose={stableClose}
          onFocusRound={focusRound}
          onDraftClose={stableDraftClose}
          onDraftSpawned={stableDraftSpawned}
          onHandoff={handoffForNodes}
          onSpawnRetry={onSpawnRetry ? stableSpawnRetry : undefined}
          onOpenTask={onOpenTask ? stableOpenTask : undefined}
          onExpand={stableExpand}
          onPipelineCreated={handlePipelineCreated}
        />
        <TaskEdgesLayer edges={taskEdges} world={world} routes={taskRoutes} onRetry={retryEdge} />
        <TasksLayer
          tasks={placedTasks}
          files={files}
          project={project}
          interactive={!handLike && !session}
          lite={mapMode}
          camRef={camRef}
          handlers={taskHandlers}
          selectedTaskId={selected?.startsWith("task::") ? selected.slice("task::".length) : null}
          textExpandedIds={textExpandedIds}
          pending={pendingTask}
          onStickyCreated={handleStickyCreated}
          onCreateCancel={cancelCreate}
          completedPipelinesByTask={completedPipelinesByTask}
          onOpenPipelineHistory={openPipelineHistory}
        />
        {/* Desktop pipelines are owned by their colored SchemeGroup halo above
            (GroupsLayer): the real stage conversations and planned-stage
            placeholders live inside that region, so there is no detached control
            card or duplicate stage graph here (#353). */}
        {/* Session bbox lives inside the transformed world div: the camera
            moves it through the container transform, never a re-render. */}
        {session && bbox ? (
          <div
            aria-hidden
            className="pointer-events-none absolute z-[6] rounded-[14px] border-2 border-dashed border-accent/60"
            style={{ left: bbox.x - 14, top: bbox.y - 14, width: bbox.w + 28, height: bbox.h + 28 }}
          >
            <span
              className="absolute -top-3 left-4 rounded-full border border-accent/50 bg-card px-2 py-0.5 font-bold text-accent"
              style={{ fontSize: "calc(11px * min(var(--inv-z, 1), 2.6))" }}
            >
              {t("bulk.selectedCount", { count: multi.size })}
            </span>
          </div>
        ) : null}
      </div>

      {/* Screen-space marquee: only this small subtree changes per drag frame. */}
      {marquee ? (
        <div aria-hidden className="pointer-events-none absolute inset-0 z-30">
          <div
            className="absolute rounded-[4px] border border-accent/70 bg-accent/10"
            style={{ left: marquee.rect.x, top: marquee.rect.y, width: marquee.rect.w, height: marquee.rect.h }}
          />
          {marquee.candidates.map((path) => {
            const node = layout.byPath.get(path);
            if (!node) return null;
            return (
              <div
                key={path}
                className="absolute rounded-[10px] border-2 border-accent/70"
                style={{
                  left: node.x * cam.z + cam.x,
                  top: node.y * cam.z + cam.y,
                  width: node.w * cam.z,
                  height: node.h * cam.z,
                }}
              />
            );
          })}
        </div>
      ) : null}

      <EdgeChips
        clusters={clusters}
        cam={cam}
        vp={vp}
        hidden={mapMode || Boolean(marquee) || panning}
        obstacles={chipObstacles}
        onFit={fitRect}
      />

      <div data-scheme-ui className="absolute left-3 top-3 z-40 flex items-center gap-1 rounded-[10px] border border-border bg-card/95 p-1 shadow-1">
        {mapMode ? null : (
          <>
            <ToolButton active={handLike && !taskTool} title={t("scheme.handTool")} onClick={() => setMode("hand")}>
              <Hand className="h-4 w-4" aria-hidden />
            </ToolButton>
            <ToolButton
              active={!handLike && !session && !taskTool}
              title={t("scheme.selectTool")}
              onClick={() => setMode("select")}
            >
              <MousePointer2 className="h-4 w-4" aria-hidden />
            </ToolButton>
            <ToolButton
              active={session}
              title={t("scheme.lassoTool")}
              onClick={() => {
                if (session) {
                  clearSession();
                } else {
                  setMode("select");
                  setArmed(true);
                }
              }}
            >
              <BoxSelect className="h-4 w-4" aria-hidden />
            </ToolButton>
            <ToolButton active={taskTool} title={t("tasks.tool")} onClick={() => setTaskTool(!taskTool)}>
              <StickyNote className="h-4 w-4" aria-hidden />
            </ToolButton>
            <div className="mx-0.5 h-5 w-px bg-border" aria-hidden />
          </>
        )}
        <ToolButton title={t("scheme.zoomOut")} onClick={() => zoomCenter(0.8)}>
          <Minus className="h-4 w-4" aria-hidden />
        </ToolButton>
        <button
          className="min-w-[46px] rounded-[8px] px-1 text-center text-[11px] font-semibold text-muted hover:bg-canvas hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          title={t("scheme.zoom100")}
          onClick={() => zoomTo(1)}
        >
          {Math.round(cam.z * 100)}%
        </button>
        <ToolButton title={t("scheme.zoomIn")} onClick={() => zoomCenter(1.25)}>
          <Plus className="h-4 w-4" aria-hidden />
        </ToolButton>
        <ToolButton title={t("scheme.fitCurrent")} onClick={fitCurrent}>
          <Focus className="h-4 w-4" aria-hidden />
        </ToolButton>
        <ToolButton title={t("scheme.fit")} onClick={fit}>
          <Maximize2 className="h-4 w-4" aria-hidden />
        </ToolButton>
      </div>

      {session ? (
        <BulkActionBar
          project={project}
          nodes={selectedNodes}
          flowsByImpl={flowsByImpl}
          onRemove={stableClose}
          onFit={fitSelection}
          onExit={clearSession}
        />
      ) : null}

      <Minimap
        layout={layout}
        world={world}
        tasks={placedTasks}
        textExpandedIds={textExpandedIds}
        currentWork={currentWork}
        stackDots={stackDots}
        cam={cam}
        vp={vp}
        onJump={jump}
      />
    </div>
    {/* The full-window conversation: the same pane component over the whole
        viewport, with the live feed and the composer of exactly this
        conversation. Sibling of the viewport, so its clicks never reach the
        canvas pan/select handlers. */}
    {expandedNode ? (
      <div
        className="fixed inset-0 z-40 flex flex-col bg-canvas p-3"
        role="dialog"
        aria-modal="true"
        aria-label={cleanTitle(expandedNode.file.title, 90)}
      >
        <BranchPane
          /* Not keyed by identity: SessionTitle resets its own edit state on a
             real A→B switch (and preserves it across conversation-id enrichment
             or succession), so a key here would only cause spurious remounts —
             and replay a retained F2 token — when a poll fills in identity. */
          file={expandedNode.file}
          tasks={expandedNode.tasks}
          isRoot={expandedNode.isRoot}
          expanded
          showFavorite
          onToggleExpand={() => setExpanded(null)}
          autoEditToken={autoEditTokenFor(renameRequest, expandedNode.file.path)}
          onSpawnRetry={onSpawnRetry ? stableSpawnRetry : undefined}
          relatedTasks={relatedTasksByPath.get(expandedNode.file.path)}
          /* Opening a task from the full-window conversation returns to the
             board first — the card the camera centers must be visible. */
          onOpenTask={onOpenTask ? (task) => { setExpanded(null); stableOpenTask(task); } : undefined}
        />
      </div>
    ) : null}
    </>
  );
}
