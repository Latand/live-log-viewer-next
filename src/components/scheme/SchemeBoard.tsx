"use client";

import { BoxSelect, Hand, Maximize2, Minus, MousePointer2, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Flow } from "@/lib/flows/types";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { BranchPane } from "@/components/BranchPane";
import { flowByImplementer } from "@/components/flows/flowModel";
import type { BranchGroup } from "@/components/projectModel";
import { cleanTitle } from "@/components/utils";

import { BulkActionBar } from "./BulkActionBar";
import { nodesInRect, pruneSelection, selectionBBox } from "./lasso";
import { buildSchemeLayout } from "./layout";
import { Minimap } from "./Minimap";
import { EdgesLayer, LoopsLayer, MOVE_EASE, NodesLayer, type DeckFocus } from "./nodes";
import { useLasso } from "./useLasso";
import { useSchemeCamera } from "./useSchemeCamera";

/* Below this zoom the big node labels fade in over the unreadable panes. */
const LABEL_Z = 0.45;

const EMPTY_PATHS: ReadonlySet<string> = new Set();

interface Props {
  project: string;
  groups: BranchGroup[];
  manual: FileEntry[];
  files: FileEntry[];
  flows: Flow[];
  /** Ids of not-yet-spawned conversation drafts drawn as full panes. */
  drafts: string[];
  /** Path to glide the camera to and ring briefly (set by openers). */
  focus: string | null;
  /** Path to ring without moving the camera, used by the mobile full-map overlay. */
  ring?: string | null;
  /** «Show only needs me» filter: non-null dims every shell without a queue member. */
  attentionPaths?: ReadonlySet<string> | null;
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
  drafts,
  focus,
  ring,
  attentionPaths,
  onSelect,
  onNodePick,
  onClose,
  onDraftClose,
  onDraftSpawned,
  onHandoff,
}: Props) {
  const { t } = useLocale();
  const mapMode = Boolean(onNodePick);
  const [selected, setSelected] = useState<string | null>(null);
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

  const layout = useMemo(() => buildSchemeLayout(groups, manual, files, flows, drafts), [groups, manual, files, flows, drafts]);

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
     live; a node that left the layout (closed, deleted) drops the overlay. */
  const expandedNode = expanded ? (layout.nodes.find((node) => node.file.path === expanded) ?? null) : null;
  const overlayOpen = expandedNode !== null;
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
  const stableExpand = useCallback((path: string) => setExpanded(path), []);
  /* Opening another conversation from inside the overlay (agent links,
     subagent chips) collapses it first, so the board jump stays visible. */
  const overlaySelect = useCallback((file: FileEntry) => {
    setExpanded(null);
    selectRef.current(file);
  }, []);

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

  const {
    cam,
    vp,
    viewportRef,
    handLike,
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
    fitRect,
    jump,
  } = useSchemeCamera({
    project,
    layout,
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
  });

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

  const tile = 24 * cam.z;

  return (
    <>
    <div
      ref={viewportRef}
      className={`relative min-h-0 flex-1 overflow-hidden ${
        panning ? "cursor-grabbing select-none" : handLike ? "cursor-grab" : ""
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
          interactive={!handLike && !session}
          lite={mapMode}
          selected={selected}
          multi={multi}
          session={session}
          focus={visualFocus}
          attentionPaths={attentionPaths ?? null}
          flowsByImpl={flowsByImpl}
          deckFocus={deckFocus}
          onSelect={stableSelect}
          onClose={stableClose}
          onFocusRound={focusRound}
          onDraftClose={stableDraftClose}
          onDraftSpawned={stableDraftSpawned}
          onHandoff={handoffForNodes}
          onExpand={stableExpand}
        />
        {/* Session bbox lives inside the transformed world div: the camera
            moves it through the container transform, never a re-render. */}
        {session && bbox ? (
          <div
            aria-hidden
            className="pointer-events-none absolute z-[6] rounded-[14px] border-2 border-dashed border-accent/60"
            style={{ left: bbox.x - 14, top: bbox.y - 14, width: bbox.w + 28, height: bbox.h + 28 }}
          >
            <span
              className="absolute -top-3 left-4 rounded-full border border-accent/50 bg-panel px-2 py-0.5 font-bold text-accent"
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

      <div data-scheme-ui className="absolute left-3 top-3 z-40 flex items-center gap-1 rounded-[10px] border border-line bg-panel/95 p-1 shadow-card">
        {mapMode ? null : (
          <>
            <ToolButton active={handLike} title={t("scheme.handTool")} onClick={() => setMode("hand")}>
              <Hand className="h-4 w-4" aria-hidden />
            </ToolButton>
            <ToolButton active={!handLike && !session} title={t("scheme.selectTool")} onClick={() => setMode("select")}>
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

      {session ? (
        <BulkActionBar
          nodes={selectedNodes}
          flowsByImpl={flowsByImpl}
          onRemove={stableClose}
          onFit={fitSelection}
          onExit={clearSession}
        />
      ) : null}

      <Minimap layout={layout} cam={cam} vp={vp} onJump={jump} />
    </div>
    {/* The full-window conversation: the same pane component over the whole
        viewport, with the live feed and the composer of exactly this
        conversation. Sibling of the viewport, so its clicks never reach the
        canvas pan/select handlers. */}
    {expandedNode ? (
      <div
        className="fixed inset-0 z-40 flex flex-col bg-bg p-3"
        role="dialog"
        aria-modal="true"
        aria-label={cleanTitle(expandedNode.file.title, 90)}
      >
        <BranchPane
          file={expandedNode.file}
          files={files}
          tasks={expandedNode.tasks}
          onSelect={overlaySelect}
          isRoot={expandedNode.isRoot}
          expanded
          onToggleExpand={() => setExpanded(null)}
        />
      </div>
    ) : null}
    </>
  );
}
