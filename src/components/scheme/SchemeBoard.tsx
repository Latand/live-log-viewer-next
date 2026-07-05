"use client";

import { Hand, Maximize2, Minus, MousePointer2, Plus, StickyNote } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Flow } from "@/lib/flows/types";
import { getLocale, translate, useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { flowByImplementer } from "@/components/flows/flowModel";
import type { BranchGroup } from "@/components/projectModel";
import { SelectionComposer } from "@/components/tasks/SelectionComposer";
import { createTask, deleteTask, sendTask, spawnTaskAgent, updateTask } from "@/components/tasks/taskApi";
import { pushTaskToast, sendSummary } from "@/components/tasks/taskToast";

import { buildSchemeLayout } from "./layout";
import { Minimap } from "./Minimap";
import { EdgesLayer, LoopsLayer, MOVE_EASE, NodesLayer, type DeckFocus } from "./nodes";
import type { TaskCardHandlers } from "./TaskCard";
import { TaskEdgesLayer } from "./TaskEdgesLayer";
import { TasksLayer } from "./TasksLayer";
import { buildTaskEdges, buildTaskTargetIndex, TASK_W, taskRect, type SchemeRect } from "./taskGeometry";
import { useSchemeCamera } from "./useSchemeCamera";

/* Below this zoom the big node labels fade in over the unreadable panes. */
const LABEL_Z = 0.45;

interface Props {
  project: string;
  groups: BranchGroup[];
  manual: FileEntry[];
  files: FileEntry[];
  flows: Flow[];
  /** This project's board tasks — sticky cards over the panes. */
  tasks: BoardTask[];
  /** Ids of not-yet-spawned conversation drafts drawn as full panes. */
  drafts: string[];
  /** Path to glide the camera to and ring briefly (set by openers). */
  focus: string | null;
  /** Path to ring without moving the camera, used by the mobile full-map overlay. */
  ring?: string | null;
  onSelect: (file: FileEntry) => void;
  /** Optional map-mode node pick handler; receives the selected node key. */
  onNodePick?: (key: string) => void;
  onClose: (path: string) => void;
  onDraftClose: (id: string) => void;
  /** A draft's agent booted and its transcript arrived: open it as a real node. */
  onDraftSpawned: (id: string, file: FileEntry) => void;
  /** The handoff handle under a pane: drop a draft that continues this
      conversation. Absent in map mode — the handle stays hidden there. */
  onHandoff?: (file: FileEntry) => void;
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
        active ? "bg-accent/10 text-accent" : "text-dim hover:bg-bg hover:text-ink"
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
  tasks,
  drafts,
  focus,
  ring,
  onSelect,
  onNodePick,
  onClose,
  onDraftClose,
  onDraftSpawned,
  onHandoff,
}: Props) {
  const { t } = useLocale();
  const mapMode = Boolean(onNodePick);
  /* Multi-select: plain click replaces, Shift/Ctrl+click toggles, Esc clears. */
  const [selected, setSelectedState] = useState<ReadonlySet<string>>(() => new Set<string>());
  const setSelected = useCallback((key: string | null, toggle = false) => {
    setSelectedState((prev) => {
      if (key === null) return prev.size ? new Set<string>() : prev;
      if (toggle) {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }
      if (prev.size === 1 && prev.has(key)) return prev;
      return new Set([key]);
    });
  }, []);

  const layout = useMemo(() => buildSchemeLayout(groups, manual, files, flows, drafts), [groups, manual, files, flows, drafts]);
  const flowsByImpl = useMemo(() => flowByImplementer(flows), [flows]);
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
  useEffect(() => {
    selectRef.current = onSelect;
    nodePickRef.current = onNodePick;
    closeRef.current = onClose;
    draftCloseRef.current = onDraftClose;
    draftSpawnedRef.current = onDraftSpawned;
    handoffRef.current = onHandoff;
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
  /* The handle renders only when the opener wired a handler (not in map mode). */
  const handoffForNodes = onHandoff ? stableHandoff : undefined;

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
  /* Camera-facing rects: focus glides and map taps resolve task keys. */
  const taskRects = useMemo(
    () => new Map(mergedTasks.map((task) => ["task::" + task.id, taskRect(task)] as const)),
    [mergedTasks],
  );
  const taskEdges = useMemo(() => buildTaskEdges(mergedTasks, buildTaskTargetIndex(layout)), [mergedTasks, layout]);

  const onPlaceTask = useCallback((wx: number, wy: number) => {
    setPendingTask({ x: Math.round(wx - TASK_W / 2), y: Math.round(wy - 14) });
  }, []);

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
    jump,
  } = useSchemeCamera({
    project,
    layout,
    mapMode,
    focus,
    onNodePick,
    setSelected,
    taskRects,
    onPlaceTask: mapMode ? undefined : onPlaceTask,
  });

  /* Latest camera behind a stable ref: card drags divide pointer deltas by
     cam.z without subscribing the memoized task layer to camera frames. */
  const camRef = useRef(cam);
  useEffect(() => {
    camRef.current = cam;
  }, [cam]);
  const filesRef = useRef(files);
  const selectedRef = useRef(selected);
  const layoutRef = useRef(layout);
  useEffect(() => {
    filesRef.current = files;
    selectedRef.current = selected;
    layoutRef.current = layout;
  });

  const handleSendById = useCallback(async (taskId: string, paths: string[]) => {
    const res = await sendTask(taskId, paths);
    if ("error" in res) {
      pushTaskToast("err", res.error);
      return;
    }
    const summary = sendSummary(res, filesRef.current);
    pushTaskToast(summary.kind, summary.text);
  }, []);
  const retryEdge = useCallback((taskId: string, path: string) => void handleSendById(taskId, [path]), [handleSendById]);

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
      send: (task, paths) => void handleSendById(task.id, paths),
      spawn: async (task, engine, cwd) => {
        const res = await spawnTaskAgent(task.id, { engine, cwd });
        if ("error" in res) return res.error;
        pushTaskToast("ok", translate(getLocale(), "tasks.spawnOk", { target: res.target }));
        return null;
      },
      center: (rect: SchemeRect) => centerOn(rect, 0.75),
      /* Conversation nodes only: stacks, decks and drafts in the selection
         are not send targets. */
      selectionPaths: () => {
        const nodePaths = new Set(layoutRef.current.nodes.map((node) => node.file.path));
        return [...selectedRef.current].filter((key) => nodePaths.has(key));
      },
    }),
    [handleSendById, centerOn],
  );

  const handleCreate = useCallback(
    (text: string) => {
      const pos = pendingTask;
      if (!pos) return;
      void createTask({ project, text, pos }).then((res) => {
        if ("error" in res) {
          pushTaskToast("err", res.error);
          return;
        }
        setLocalTasks((prev) => [...prev, res.task]);
        setPendingTask(null);
      });
    },
    [project, pendingTask],
  );
  const cancelCreate = useCallback(() => setPendingTask(null), []);

  /* The docked selection composer targets the selected conversation nodes;
     a new task card lands near their centroid. */
  const selectedNodes = useMemo(() => layout.nodes.filter((node) => selected.has(node.file.path)), [layout, selected]);
  const selectionFiles = useMemo(() => selectedNodes.map((node) => node.file), [selectedNodes]);
  const selectionCentroid = useMemo(() => {
    if (!selectedNodes.length) return { x: 0, y: 0 };
    let cx = 0;
    let cy = 0;
    for (const node of selectedNodes) {
      cx += node.x + node.w / 2;
      cy += node.y + node.h / 2;
    }
    return { x: cx / selectedNodes.length - TASK_W / 2, y: cy / selectedNodes.length - 60 };
  }, [selectedNodes]);

  const tile = 24 * cam.z;

  return (
    <div
      ref={viewportRef}
      className={`relative min-h-0 flex-1 overflow-hidden ${
        panning ? "cursor-grabbing select-none" : taskTool ? "cursor-crosshair" : handLike ? "cursor-grab" : ""
      } ${handLike ? "touch-none" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onDoubleClick={onDoubleClick}
      onClick={onClick}
    >
      {/* Dot grid on its own composited layer: panning moves it with a
          transform (modulo one tile) instead of repainting the viewport
          background every frame. */}
      <div
        aria-hidden
        className="pointer-events-none absolute"
        style={{
          inset: -tile,
          backgroundImage: "radial-gradient(rgba(28,28,34,0.09) 1px, transparent 1px)",
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
        <EdgesLayer edges={layout.edges} width={layout.width} height={layout.height} />
        <LoopsLayer loops={layout.loops} width={layout.width} height={layout.height} />
        <NodesLayer
          layout={layout}
          project={project}
          files={files}
          interactive={!handLike}
          lite={mapMode}
          selected={selected}
          focus={visualFocus}
          flowsByImpl={flowsByImpl}
          deckFocus={deckFocus}
          onSelect={stableSelect}
          onClose={stableClose}
          onFocusRound={focusRound}
          onDraftClose={stableDraftClose}
          onDraftSpawned={stableDraftSpawned}
          onHandoff={handoffForNodes}
        />
        <TaskEdgesLayer edges={taskEdges} width={layout.width} height={layout.height} onRetry={retryEdge} />
        <TasksLayer
          tasks={mergedTasks}
          files={files}
          interactive={!handLike}
          lite={mapMode}
          camRef={camRef}
          handlers={taskHandlers}
          pending={pendingTask}
          onCreate={handleCreate}
          onCreateCancel={cancelCreate}
        />
      </div>

      <div data-scheme-ui className="absolute left-3 top-3 z-40 flex items-center gap-1 rounded-[10px] border border-line bg-panel/95 p-1 shadow-card">
        {mapMode ? null : (
          <>
            <ToolButton active={handLike && !taskTool} title={t("scheme.handTool")} onClick={() => setMode("hand")}>
              <Hand className="h-4 w-4" aria-hidden />
            </ToolButton>
            <ToolButton active={!handLike && !taskTool} title={t("scheme.selectTool")} onClick={() => setMode("select")}>
              <MousePointer2 className="h-4 w-4" aria-hidden />
            </ToolButton>
            <ToolButton active={taskTool} title={t("tasks.tool")} onClick={() => setTaskTool(!taskTool)}>
              <StickyNote className="h-4 w-4" aria-hidden />
            </ToolButton>
            <div className="mx-0.5 h-5 w-px bg-line" aria-hidden />
          </>
        )}
        <ToolButton title={t("scheme.zoomOut")} onClick={() => zoomCenter(0.8)}>
          <Minus className="h-4 w-4" aria-hidden />
        </ToolButton>
        <button
          className="min-w-[46px] rounded-[8px] px-1 text-center text-[11px] font-semibold text-dim hover:bg-bg hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          title={t("scheme.zoom100")}
          onClick={() => zoomTo(1)}
        >
          {Math.round(cam.z * 100)}%
        </button>
        <ToolButton title={t("scheme.zoomIn")} onClick={() => zoomCenter(1.25)}>
          <Plus className="h-4 w-4" aria-hidden />
        </ToolButton>
        <ToolButton title={t("scheme.fit")} onClick={fit}>
          <Maximize2 className="h-4 w-4" aria-hidden />
        </ToolButton>
      </div>

      <Minimap layout={layout} tasks={mergedTasks} cam={cam} vp={vp} onJump={jump} />

      {!mapMode && selectionFiles.length ? (
        <SelectionComposer project={project} selection={selectionFiles} centroid={selectionCentroid} />
      ) : null}
    </div>
  );
}
