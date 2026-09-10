"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Camera } from "./Minimap";
import { stackItemAt, type SchemeLayout, type SchemeRect } from "./layout";

const MIN_Z = 0.07;
const MAX_Z = 1.6;
/* At least this much of the world stays inside the viewport when panning. */
const EDGE_KEEP = 120;
/* How long the board must hold a framing that shows nothing before it is
   re-framed — long enough that a measuring layout is never judged. */
const OFF_WORLD_SETTLE_MS = 300;

const MODE_KEY = "llvSchemeMode";
/* Band board framings (#1586): the band stack is a document taller than any
   viewport, so "fit" frames it from the top at a chosen scale rather than
   shrinking it in. Fit All frames the task overview at chip scale; Fit Current
   frames the top (working) bands at tile scale. */
export const BAND_FIT_ALL_Z = 0.2;
export const BAND_FIT_CURRENT_Z = 0.58;

export type Mode = "hand" | "select";

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/* Reduced-motion: camera glides become instant jumps (matches useFlip.ts:7). */
const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

interface CameraOptions {
  project: string;
  layout: SchemeLayout;
  /** World box the camera clamps and fits to — the layout box grown to include
      every placed task card (issue #17), origin possibly negative. Panning,
      fit and edge-keep all read this grown box, so a relocated card past the raw
      layout dimensions is always reachable. */
  world: SchemeRect;
  /** Current operator work; null falls back to the full world. */
  currentWork?: SchemeRect | null;
  /** Map mode (phone full-screen overlay): always opens fitted, never persists. */
  mapMode: boolean;
  /** Path to glide the camera to once its node exists in the layout. */
  focus: string | null;
  /** Map-mode node pick handler; a stationary tap resolves to a node key. */
  onNodePick?: (key: string) => void;
  /** Selection setter owned by SchemeBoard, driven by pointer/keyboard here.
      `additive` marks a Shift+click on a node — add/toggle instead of replace. */
  setSelected: (value: string | null, additive?: boolean) => void;
  /** First claim on a select-mode background press. Returning true means the
      caller owns the gesture (marquee on mouse); for touch a true only skips
      the press-time selection clear — panning and the stationary tap remain. */
  onBackgroundDown?: (event: React.PointerEvent<HTMLDivElement>) => boolean;
  /** Stationary background tap in world coords (the selection session's
      toggle/exit). Runs before the map-mode pick; true consumes the tap. */
  onWorldTap?: (wx: number, wy: number) => boolean;
  /** Task-card rects keyed `task::<id>`: focus glides and map taps resolve
      through them exactly like layout.byPath entries. */
  taskRects?: ReadonlyMap<string, SchemeRect>;
  /** PipelineGroup rects participate in content gating even when the board has
      no conversation nodes, drafts, flow groups, or task cards. */
  pipelineRects?: ReadonlyMap<string, SchemeRect>;
  /** One-shot «task» tool sink: the next canvas click lands here in world
      coordinates, then the tool reverts to select. Absent in map mode. */
  onPlaceTask?: (wx: number, wy: number) => void;
  /** Spatial keyboard navigation (issue #27), held behind a ref to break the
      camera↔nav creation cycle. `onArrowNav` handles an Arrow press and returns
      true when it consumed it (the old fixed 160px pan is gone — an unconsumed
      press does nothing). `onZoomKey` gets first refusal on +/−: true means it
      snapped the anchor to a ladder framing, false falls back to continuous
      zoom around the viewport centre. */
  onArrowNav?: React.RefObject<(event: KeyboardEvent) => boolean>;
  onZoomKey?: React.RefObject<(dir: 1 | -1) => boolean>;
  /** Announces explicit framing actions to the board live region. */
  onFit?: (kind: "current" | "all") => void;
  /** Selected projection whose header top-left must keep its screen position
      through zoom and relayout (#1586): key identifies the projection, rect is
      its current world box. Null when nothing is selected. */
  anchor?: SchemeAnchor | null;
  /** Band layouts read as a document (#1641): the band stack is exactly one
      viewport wide in world pixels, so whenever it fits the viewport (zoom at
      or below 1) the camera keeps its left edge on the viewport's — no dead
      canvas beside the bands, from any zoom, framing, anchor hold, resize or
      pan; when the stack is wider than the viewport the camera may show any
      part of it but never past its edges. Every camera the hook settles on the
      band board goes through this rule, the selection anchor included. */
  lockX?: boolean;
  /** Zoom an opened conversation is framed at (#1641). On the physical-scaling
      band board a reader's size follows the camera, so an open reaches for a
      fuller zoom than the bare readable floor; defaults to `READABLE_Z`. */
  focusZoom?: number;
}

export interface SchemeAnchor {
  key: string;
  rect: SchemeRect;
}

/** Pure anchor equation: the camera translation that puts `rect`'s top-left at
    the captured screen point under the new zoom. */
export function anchoredCamera(captured: { sx: number; sy: number }, rect: SchemeRect, z: number): Camera {
  return { z, x: captured.sx - rect.x * z, y: captured.sy - rect.y * z };
}

export interface SchemeCamera {
  cam: Camera;
  vp: { w: number; h: number };
  viewportRef: React.RefObject<HTMLDivElement | null>;
  mode: Mode;
  setMode: (next: Mode) => void;
  /** Hand-like: map mode, hand tool, or Space held — panes go click-through. */
  handLike: boolean;
  /** One-shot «task» tool: armed until the placing click or Esc. */
  taskTool: boolean;
  setTaskTool: (next: boolean) => void;
  /** Glide a world rect into view (task panel rows, far-zoom inline edit). */
  centerOn: (rect: SchemeRect, zMin: number) => void;
  panning: boolean;
  glide: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onDoubleClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  zoomCenter: (factor: number) => void;
  zoomTo: (targetZ: number) => void;
  fit: () => void;
  /** Frame current work, falling back to Fit All when the set is empty. */
  fitCurrent: () => void;
  /** Glide to fit a world rect (the "show selection" bulk action). */
  fitRect: (rect: SchemeRect) => void;
  jump: (wx: number, wy: number) => void;
  /** Bumps whenever the user drives the camera by hand (pan >9px, pinch end,
      wheel settle) — spatial nav watches it to drop follow and re-baseline. */
  manualNonce: number;
  /** Glide-translate so a point that moved by (worldDx, worldDy) keeps its
      screen position: the follow anchor holds still through a reflow. */
  glideBy: (worldDx: number, worldDy: number) => void;
  /** Glide the anchor to the `centerOn` placement at an explicit zoom — the
      keyboard zoom ladder, which unlike `centerOn` may zoom out below `c.z`. */
  glideFrame: (rect: SchemeRect, z: number) => void;
  /** Put the camera back at an exact position (#688's return point). */
  glideToCamera: (camera: { x: number; y: number; zoom: number }) => void;
  /** Seed the selection anchor with a destination projection before the layout
      moves the surface there (#1586): the next commit holds that projection's
      screen point, so a reader opened from a reference tile lands where the
      tile was even though the bands around it reflow. */
  primeAnchor: (key: string, rect: SchemeRect) => void;
}

/**
 * The scheme canvas camera engine: pannable/zoomable viewport state plus every
 * gesture that moves it — wheel pan/zoom, pinch, drag, keyboard shortcuts,
 * double-click fit/focus, and map-mode taps. High-rate gestures coalesce into
 * one rAF-batched camera update so React renders at most once per frame, and
 * the camera clamps so a strip of the world always stays on screen and
 * persists per project in sessionStorage. Selection lives in the caller; this
 * hook drives it through `setSelected` from the pointer and keyboard handlers.
 */
/** Whether the board has anything to frame: nodes, drafts, or task cards. Task
    cards count (issue #17) — a project with only cards must still init and fit
    the camera, so both the fit guard and the one-time init effect read this. */
export function hasBoardContent(
  layout: Pick<SchemeLayout, "nodes" | "drafts"> & Partial<Pick<SchemeLayout, "groups">>,
  taskRects?: ReadonlyMap<string, SchemeRect>,
  pipelineRects?: ReadonlyMap<string, SchemeRect>,
): boolean {
  return layout.nodes.length > 0
    || layout.drafts.length > 0
    || (layout.groups?.length ?? 0) > 0
    || (taskRects?.size ?? 0) > 0
    || (pipelineRects?.size ?? 0) > 0;
}

/** Pure camera framing shared by Fit All, Fit Current, tests, and map toggles. */
export function fitCameraToRect(rect: SchemeRect, vp: { w: number; h: number }): Camera {
  const z = Math.min(MAX_Z, Math.max(MIN_Z, Math.min((vp.w - 48) / rect.w, (vp.h - 48) / rect.h, 1)));
  return { z, x: (vp.w - rect.w * z) / 2 - rect.x * z, y: (vp.h - rect.h * z) / 2 - rect.y * z };
}

/**
 * Whether a camera still shows the world it is pointed at (#1614).
 *
 * The saved camera is per project and survives a reload, but the world it was
 * saved against does not have to: hiding the empty task bands of a 390-task
 * board shortens the band stack from tens of thousands of pixels to a few
 * thousand, and a camera parked far down the old stack then frames nothing at
 * all — an empty canvas the operator has no way to read as "scrolled off the
 * board". This is the same visibility rule `clampCam` maintains during a pan,
 * asked as a question instead of enforced: at least `EDGE_KEEP` of the world
 * (or all of it, when it is smaller than that) overlaps the viewport on both
 * axes. An unmeasured viewport cannot answer it and does not veto.
 */
export function cameraShowsWorld(camera: Camera, world: SchemeRect, vp: { w: number; h: number }): boolean {
  /* An unmeasured viewport, or a world with no extent yet (the first commit of
     a board whose layout has not been measured), cannot answer the question —
     and must not answer it "no", or a camera would be thrown away over a
     transient. */
  if (!(vp.w > 1) || !(vp.h > 1) || !(world.w > 0) || !(world.h > 0)) return true;
  const overlap = (origin: number, extent: number, offset: number, size: number) => {
    const start = origin * camera.z + offset;
    return Math.min(start + extent * camera.z, size) - Math.max(start, 0);
  };
  return overlap(world.x, world.w, camera.x, vp.w) >= Math.min(EDGE_KEEP, world.w * camera.z)
    && overlap(world.y, world.h, camera.y, vp.h) >= Math.min(EDGE_KEEP, world.h * camera.z);
}

/** Where the camera must sit for `node` to be framed: centred horizontally,
    its head near the top so a tall pane starts readable instead of split. */
export function centredCamera(node: SchemeRect, z: number, vp: { w: number; h: number }): Camera {
  return {
    z,
    x: vp.w / 2 - (node.x + node.w / 2) * z,
    y: Math.min(vp.h / 2 - node.y * z, vp.h * 0.08 - (node.y - 40) * z),
  };
}

/** How much of a node's head must be on screen before an opened conversation
    counts as shown: its title row and the first lines under it. */
const FRAMED_HEAD = 120;
/** The scale below which a conversation is drawn as a chip rather than as
    content. `centerOn` has always raised the camera to it for a focus, which is
    what makes an opened conversation readable rather than merely located. */
export const READABLE_Z = 0.55;

/**
 * Whether `node` is on screen and readable at this camera — the question a
 * focus request actually asks, as opposed to "did a camera move happen".
 *
 * Readable is the operative word, and it rules out two things that "the
 * rectangle overlaps the viewport" would accept: a board zoomed out far enough
 * that the node is a chip, and a node hanging off an edge with a sliver of
 * itself showing. The head is what is judged, so a pane taller than the
 * viewport is framed when its top is inside it and one pushed past an edge is
 * not.
 */
export function nodeIsFramed(node: SchemeRect, camera: Camera, vp: { w: number; h: number }): boolean {
  if (!(vp.w > 1) || !(vp.h > 1)) return false;
  if (camera.z < READABLE_Z) return false;
  const sx = camera.x + node.x * camera.z;
  const sy = camera.y + node.y * camera.z;
  const head = Math.min(node.h * camera.z, FRAMED_HEAD);
  const across = Math.min(sx + node.w * camera.z, vp.w) - Math.max(sx, 0);
  return sy >= 0 && sy + head <= vp.h && across >= Math.min(node.w * camera.z, FRAMED_HEAD);
}

const sameRect = (a: SchemeRect, b: SchemeRect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/** A focus request the camera still owes the operator: the node it names, the
    rectangle the last aim was taken against, and the camera that aim asked for.
    Cleared when the node is framed, when the operator moves the camera, or when
    a new request replaces it. */
interface FocusAim {
  path: string;
  project: string;
  at: SchemeRect | null;
  cam: Camera | null;
}

/** The deadband used by repeated 0 to escalate from current work to all. */
export function cameraMatchesFraming(camera: Camera, target: Camera): boolean {
  return Math.abs(camera.z - target.z) <= target.z * 0.01 && Math.abs(camera.x - target.x) <= 4 && Math.abs(camera.y - target.y) <= 4;
}

export function useSchemeCamera({
  project,
  layout,
  world,
  currentWork = null,
  mapMode,
  focus,
  onNodePick,
  setSelected,
  onBackgroundDown,
  onWorldTap,
  taskRects,
  pipelineRects,
  onPlaceTask,
  onArrowNav,
  onZoomKey,
  onFit,
  anchor = null,
  lockX = false,
  focusZoom = READABLE_Z,
}: CameraOptions): SchemeCamera {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const tapRef = useRef<{ x: number; y: number } | null>(null);
  const [cam, setCam] = useState<Camera>({ x: 0, y: 0, z: 0.5 });
  const [mode, setModeState] = useState<Mode>("select");
  const [taskTool, setTaskTool] = useState(false);
  const [spacePan, setSpacePan] = useState(false);
  const [panning, setPanning] = useState(false);
  const [glide, setGlide] = useState(false);
  const [vp, setVp] = useState({ w: 1, h: 1 });
  const [manualNonce, setManualNonce] = useState(0);
  const panRef = useRef<{ sx: number; sy: number; cx: number; cy: number } | null>(null);
  /* A pan that actually travelled >9px, and an active two-finger pinch — both
     bump manualNonce when they end so a settled hand gesture re-baselines nav. */
  const panMovedRef = useRef(false);
  const pinchActiveRef = useRef(false);
  const wheelSettle = useRef<number | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ d: number; cx: number; cy: number } | null>(null);
  const modeRef = useRef<Mode>(mode);
  const spaceRef = useRef(spacePan);
  const taskToolRef = useRef(taskTool);
  const placeTaskRef = useRef(onPlaceTask);
  const glideTimer = useRef<number | null>(null);
  const initedFor = useRef<string | null>(null);
  const latestCam = useRef(cam);
  /* An explicit framing change (fit, focus glide, jump, Return) re-baselines
     the selection anchor instead of being undone by it. */
  const framingRef = useRef(false);
  /* The standing focus obligation, and the flag that tells the framings below
     that the move they are being asked for IS that obligation's own aim. */
  const focusAim = useRef<FocusAim | null>(null);
  const aiming = useRef(false);
  const dropFocusAim = useCallback(() => {
    if (!aiming.current) focusAim.current = null;
  }, []);

  useEffect(() => {
    latestCam.current = cam;
  }, [cam]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    spaceRef.current = spacePan;
  }, [spacePan]);
  useEffect(() => {
    taskToolRef.current = taskTool;
  }, [taskTool]);
  useEffect(() => {
    placeTaskRef.current = onPlaceTask;
  });

  /* Saved tool wins; a touch-first device without a saved tool starts on the
     hand — panes are still fully usable after an explicit switch to select. */
  useEffect(() => {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === "hand" || saved === "select") {
      /* eslint-disable-next-line react-hooks/set-state-in-effect */
      setModeState(saved);
      return;
    }
    if (window.matchMedia("(pointer: coarse)").matches) {

      setModeState("hand");
    }
  }, []);
  const setMode = useCallback((next: Mode) => {
    /* Picking hand/select always disarms the one-shot task tool. */
    setTaskTool(false);
    setModeState(next);
    localStorage.setItem(MODE_KEY, next);
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      setVp({ w: Math.max(1, rect.width), h: Math.max(1, rect.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* The world can never be thrown fully off-screen: a strip of it always
     stays visible, so there is no "lost the canvas" state to recover from. */
  const clampCam = useCallback(
    (c: Camera): Camera => {
      /* Keep a strip of the world on screen from either edge, measured against
         the world box (origin world.x/world.y, which may be negative) rather
         than a fixed (0,0) so a card left of/above the layout stays reachable. */
      const x = Math.min(Math.max(c.x, EDGE_KEEP - (world.x + world.w) * c.z), vp.w - EDGE_KEEP - world.x * c.z);
      const y = Math.min(Math.max(c.y, EDGE_KEEP - (world.y + world.h) * c.z), vp.h - EDGE_KEEP - world.y * c.z);
      return x === c.x && y === c.y ? c : { ...c, x, y };
    },
    [world, vp],
  );
  /* The document rule of the band board (see `lockX`): a world that fits the
     viewport horizontally sits on its left edge; a wider one is clamped so
     neither of its edges leaves a gap. Identity on the free map. */
  const alignX = useCallback((c: Camera): Camera => {
    if (!lockX) return c;
    const left = -world.x * c.z;
    if (world.w * c.z <= vp.w) return c.x === left ? c : { ...c, x: left };
    const x = Math.min(left, Math.max(vp.w - (world.x + world.w) * c.z, c.x));
    return x === c.x ? c : { ...c, x };
  }, [lockX, world.x, world.w, vp.w]);
  /* Every gesture and framing settles through both rules. */
  const settle = useCallback((c: Camera): Camera => alignX(clampCam(c)), [alignX, clampCam]);

  /* Selection anchor (#1586). Every commit records where the selected
     projection's top-left sits on screen. When the next commit finds the same
     projection at a different world position or under a different zoom — a
     wheel/pinch/button/keyboard zoom, a viewport resize, a band reflow — the
     camera is translated synchronously, before paint, so that point holds. A
     pure pan (same zoom, same world rect) records the new position instead, and
     an explicit framing (fit, focus glide, jump) re-baselines. Clamping is
     skipped on purpose: content-bound clamping must not drag a retained
     selection away. */
  const anchorRef = useRef<{ key: string; sx: number; sy: number; wx: number; wy: number; z: number } | null>(null);
  const primeAnchor = useCallback((key: string, rect: SchemeRect) => {
    const c = latestCam.current;
    anchorRef.current = { key, sx: c.x + rect.x * c.z, sy: c.y + rect.y * c.z, wx: rect.x, wy: rect.y, z: c.z };
  }, []);
  useLayoutEffect(() => {
    if (!anchor) {
      anchorRef.current = null;
      framingRef.current = false;
      return;
    }
    const explicit = framingRef.current;
    framingRef.current = false;
    const prev = anchorRef.current;
    const { rect } = anchor;
    const sx = cam.x + rect.x * cam.z;
    const sy = cam.y + rect.y * cam.z;
    if (prev && prev.key === anchor.key && !explicit && (prev.z !== cam.z || prev.wx !== rect.x || prev.wy !== rect.y)) {
      /* The hold is exact on the free map. On the band board the document
         rule outranks it horizontally (#1641): a reader that wrapped to
         another row keeps its vertical screen position, and the band stack
         stays on the viewport's left edge instead of following the tile. */
      const next = alignX(anchoredCamera(prev, rect, cam.z));
      if (Math.abs(next.x - cam.x) > 0.01 || Math.abs(next.y - cam.y) > 0.01) {
        anchorRef.current = { key: anchor.key, sx: next.x + rect.x * cam.z, sy: next.y + rect.y * cam.z, wx: rect.x, wy: rect.y, z: cam.z };
        latestCam.current = next;
        setCam(next);
        return;
      }
    }
    anchorRef.current = { key: anchor.key, sx, sy, wx: rect.x, wy: rect.y, z: cam.z };
  }, [anchor, cam, alignX]);

  /* High-rate gestures (wheel, pointermove, pinch) coalesce into one camera
     update per frame: updater functions queue up and compose inside a single
     rAF, so deltas are never lost but React renders at most once per frame. */
  const camQueue = useRef<((c: Camera) => Camera)[]>([]);
  const camRaf = useRef<number | null>(null);
  const queueCam = useCallback((fn: (c: Camera) => Camera) => {
    /* Pan, wheel and pinch: the operator has taken the camera, so a focus
       request still owed is dropped rather than pulling them back. */
    dropFocusAim();
    camQueue.current.push(fn);
    if (camRaf.current != null) return;
    camRaf.current = requestAnimationFrame(() => {
      camRaf.current = null;
      const fns = camQueue.current;
      camQueue.current = [];
      setCam((c) => fns.reduce((acc, apply) => apply(acc), c));
    });
  }, [dropFocusAim]);
  useEffect(
    () => () => {
      if (camRaf.current != null) cancelAnimationFrame(camRaf.current);
    },
    [],
  );

  const applyZoom = useCallback(
    (cx: number, cy: number, factor: number) => {
      queueCam((c) => {
        const z = Math.min(MAX_Z, Math.max(MIN_Z, c.z * factor));
        if (z === c.z) return c;
        const k = z / c.z;
        return settle({ z, x: cx - (cx - c.x) * k, y: cy - (cy - c.y) * k });
      });
    },
    [settle, queueCam],
  );

  const zoomCenter = useCallback(
    (factor: number) => {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (rect) applyZoom(rect.width / 2, rect.height / 2, factor);
    },
    [applyZoom],
  );

  /* Absolute zoom around the viewport center (the % button, the "1" key). */
  const zoomTo = useCallback(
    (targetZ: number) => {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      setCam((c) => {
        const z = Math.min(MAX_Z, Math.max(MIN_Z, targetZ));
        if (z === c.z) return c;
        const k = z / c.z;
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        return settle({ z, x: cx - (cx - c.x) * k, y: cy - (cy - c.y) * k });
      });
    },
    [settle],
  );

  const fitCam = useCallback((): Camera | null => {
    const rect = viewportRef.current?.getBoundingClientRect();
    /* Task cards are board content too (issue #17): a project with only task
       cards and no nodes/drafts must still fit, or Fit sits inert and a
       relocated card can stay off-screen. `world` already spans the cards. */
    if (!rect || !hasBoardContent(layout, taskRects, pipelineRects)) return null;
    if (lockX) return { z: BAND_FIT_ALL_Z, x: -world.x * BAND_FIT_ALL_Z, y: -world.y * BAND_FIT_ALL_Z };
    return alignX(fitCameraToRect(world, { w: rect.width, h: rect.height }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hasBoardContent reads the listed layout lengths and rect maps; subscribing to all of `layout` would re-fit on every unrelated relayout
  }, [layout.nodes.length, layout.drafts.length, layout.groups.length, taskRects, pipelineRects, world, alignX, lockX]);

  const glideTo = useCallback((next: Camera | ((c: Camera) => Camera)) => {
    /* Every explicit framing but the focus aim itself — fit, jump, Return, a
       task-panel row — is the operator deciding where to look, and ends any
       focus request still owed. */
    dropFocusAim();
    /* Reduced motion: skip the CSS transition — the move lands instantly. */
    if (!reducedMotion()) setGlide(true);
    framingRef.current = true;
    setCam(next);
    if (glideTimer.current) window.clearTimeout(glideTimer.current);
    glideTimer.current = window.setTimeout(() => setGlide(false), 500);
  }, [dropFocusAim]);
  useEffect(
    () => () => {
      if (glideTimer.current) window.clearTimeout(glideTimer.current);
    },
    [],
  );

  const fit = useCallback(() => {
    const c = fitCam();
    if (c) {
      glideTo(settle(c));
      onFit?.("all");
    }
  }, [fitCam, glideTo, settle, onFit]);

  const currentFitCam = useCallback((): Camera | null => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect || !hasBoardContent(layout, taskRects, pipelineRects)) return null;
    if (lockX) return { z: BAND_FIT_CURRENT_Z, x: -world.x * BAND_FIT_CURRENT_Z, y: -world.y * BAND_FIT_CURRENT_Z };
    return alignX(fitCameraToRect(currentWork ?? world, { w: rect.width, h: rect.height }));
  }, [currentWork, world, layout, taskRects, pipelineRects, alignX, lockX]);

  const fitCurrent = useCallback(() => {
    const c = currentFitCam();
    if (!c) return;
    glideTo(settle(c));
    onFit?.(currentWork ? "current" : "all");
  }, [currentFitCam, glideTo, settle, onFit, currentWork]);

  const fitCurrentOrAll = useCallback(() => {
    const current = currentFitCam();
    if (!current) return;
    const target = settle(current);
    if (currentWork && cameraMatchesFraming(latestCam.current, target)) {
      fit();
      return;
    }
    latestCam.current = target;
    glideTo(target);
    onFit?.(currentWork ? "current" : "all");
  }, [currentFitCam, currentWork, settle, fit, glideTo, onFit]);

  const fitRect = useCallback(
    (r: SchemeRect) => {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect || r.w <= 0 || r.h <= 0) return;
      glideTo(settle(fitCameraToRect(r, { w: rect.width, h: rect.height })));
    },
    [glideTo, settle],
  );

  /* Glide a node into view: centered horizontally, its head near the top so
     a tall pane starts readable instead of vertically split. */
  const centerOn = useCallback(
    (node: SchemeRect, zMin: number) => {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      glideTo((c) => alignX(centredCamera(node, Math.min(MAX_Z, Math.max(c.z, zMin)), { w: rect.width, h: rect.height })));
    },
    [glideTo, alignX],
  );

  /* Follow-anchor reflow: the anchor's world position shifted by (wdx, wdy);
     translate the camera the opposite way (× z) so it holds its screen spot. */
  const glideBy = useCallback(
    (wdx: number, wdy: number) => {
      glideTo((c) => settle({ ...c, x: c.x - wdx * c.z, y: c.y - wdy * c.z }));
    },
    [glideTo, settle],
  );

  /* Restore an exact camera — #688's return point, which puts back a framing
     rather than framing a thing, so unlike every other move here it takes the
     position verbatim (still clamped, since the world may have shrunk). */
  const glideToCamera = useCallback(
    (next: { x: number; y: number; zoom: number }) => {
      glideTo(settle({ x: next.x, y: next.y, z: next.zoom }));
    },
    [glideTo, settle],
  );

  /* The keyboard zoom ladder: same centered/head-near-top placement as
     `centerOn`, but at an explicit zoom (it may zoom out below the current z). */
  const glideFrame = useCallback(
    (node: SchemeRect, z: number) => {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      const zz = Math.min(MAX_Z, Math.max(MIN_Z, z));
      glideTo(
        settle({
          z: zz,
          x: rect.width / 2 - (node.x + node.w / 2) * zz,
          y: Math.min(rect.height / 2 - node.y * zz, rect.height * 0.08 - (node.y - 40) * zz),
        }),
      );
    },
    [glideTo, settle],
  );

  /* First layout of a project: restore the saved camera or fit everything.
     The map always opens fitted — its job is the whole picture. */
  useEffect(() => {
    if (initedFor.current === project || !hasBoardContent(layout, taskRects, pipelineRects)) return;
    initedFor.current = project;
    if (!mapMode) {
      try {
        const raw = sessionStorage.getItem("llvCam:" + project);
        if (raw) {
          const saved = JSON.parse(raw) as Camera;
          const rect = viewportRef.current?.getBoundingClientRect();
          const measured = rect && rect.width > 1 && rect.height > 1 ? { w: rect.width, h: rect.height } : vp;
          /* A camera the world grew out from under is not restored: it framed
             a part of the board that no longer exists, so the operator would
             open an empty canvas. Every camera that still shows the world is
             restored exactly as it was saved — scroll position is state, and
             re-fitting an in-bounds camera would throw it away. */
          if (Number.isFinite(saved.x) && Number.isFinite(saved.y) && Number.isFinite(saved.z) && saved.z >= MIN_Z && saved.z <= MAX_Z
            && cameraShowsWorld(saved, world, measured)) {
            framingRef.current = true;
            /* eslint-disable-next-line react-hooks/set-state-in-effect */
            setCam(saved);
            return;
          }
        }
      } catch {
        /* corrupt saved camera — fall through to fit */
      }
    }
    const c = mapMode ? fitCam() : currentFitCam();
    if (c) {
      framingRef.current = true;
      /* Not clamped: this can run before the viewport is measured, and the
         framings above are already aligned to the world. */
      setCam(c);
    }
  }, [project, layout, taskRects, pipelineRects, fitCam, currentFitCam, mapMode, world, vp]);

  /* The standing rule behind the restore check above: a camera that framed the
     board when it was set can be left framing nothing when the WORLD moves
     instead — the board's own content decides its bounds, and hiding 384 empty
     task bands shortens the stack from tens of thousands of pixels to a few
     thousand under a camera parked at the bottom of the old one. The world
     arrives a commit or two after the camera does, so checking only at restore
     time reads the world before it has shrunk and lets exactly that camera
     through; this runs on every world the board reports.
     It cannot fight a gesture: `clampCam` already keeps a strip of the world on
     screen through every pan and zoom, so a camera that frames none of it is
     one no gesture could have produced. */
  const reframedTo = useRef<Camera | null>(null);
  useEffect(() => {
    if (mapMode || initedFor.current !== project) return;
    if (!hasBoardContent(layout, taskRects, pipelineRects)) return;
    if (cameraShowsWorld(cam, world, vp)) return;
    /* One verdict per framing: if the board is already sitting on the framing
       this rule chose and still reports nothing on screen, the disagreement is
       between the fit and the world box, and re-fitting on a timer forever
       would only render the board unusable in a new way. */
    if (reframedTo.current && cameraMatchesFraming(cam, reframedTo.current)) return;
    /* Only a settled board is judged. Bands span the viewport, so between the
       viewport being measured and the layout being recomputed for it the board
       reports a world about one pixel wide — which no camera "shows", and which
       is nobody's lost canvas. Any camera, world or viewport change re-arms
       this, so what runs is one verdict on a board that stopped moving. */
    const timer = window.setTimeout(() => {
      const c = currentFitCam();
      if (!c) return;
      framingRef.current = true;
      reframedTo.current = c;
      setCam(c);
    }, OFF_WORLD_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [world, vp, cam, mapMode, project, layout, taskRects, pipelineRects, currentFitCam]);

  /* Debounced: a pan produces hundreds of camera frames, storage needs only
     the resting position. The map never writes — the desktop camera survives. */
  useEffect(() => {
    if (mapMode || initedFor.current !== project) return;
    const t = window.setTimeout(() => sessionStorage.setItem("llvCam:" + project, JSON.stringify(cam)), 300);
    return () => window.clearTimeout(t);
  }, [cam, project, mapMode]);

  /*
   * An opened conversation is brought into view — and STAYS the camera's
   * obligation until it actually is (#1625).
   *
   * The band projection is built for a camera it is built BEFORE: SchemeBoard
   * must hand `layoutTaskBands` a zoom and a viewport width, and — the layout
   * is an input to this hook, not an output of it — those can only be copies of
   * this camera's own values, applied one commit late. A board that mounts with
   * a focus already standing (the catalog open: the list unmounts, the board
   * mounts, the request arrives with it) therefore offers the requested node a
   * PROVISIONAL rectangle, projected at the initial 0.5 zoom and 1400px width,
   * and on a tall stack of task bands that rectangle is thousands of world
   * pixels away from where the node settles. Aiming at it once and calling the
   * request handled left the operator's own conversation far outside the
   * viewport, with nothing left to correct it: the saved-camera restore and the
   * off-world re-fit both ran afterwards and framed something else entirely.
   *
   * So the request is an obligation rather than an event. It is discharged the
   * moment the node is framed — after that a reflow moves the node freely and
   * the camera stays where the operator left it — and it re-aims only while the
   * node is NOT framed and either its rectangle or the camera has moved since
   * the aim, so it answers the settling board without ever chasing a settled
   * one. `glideTo` drops it, which is every explicit framing the operator can
   * ask for; so does `queueCam`, which is every pan, wheel and pinch. Neither
   * the highlight expiring nor a scanner poll can re-arm it — only a new focus
   * VALUE can, and upstream only a new focus nonce produces one, which is what
   * keeps this from being the standing follow `focusRequestEdge` removed.
   */
  const focusHandled = useRef<string | null>(null);
  useEffect(() => {
    if (focus && focusHandled.current !== focus) {
      focusHandled.current = focus;
      focusAim.current = { path: focus, project, at: null, cam: null };
    }
    /* A repeated open of the same conversation must move the view again, so
       the handled marker — not the obligation — clears when the request ends. */
    if (!focus) focusHandled.current = null;
    const aim = focusAim.current;
    if (!aim) return;
    /* Another project is another board: a request made against the one the
       operator left is not owed by the one they arrived at, and must not be
       waiting for them when they come back. */
    if (aim.project !== project) {
      focusAim.current = null;
      return;
    }
    const node = layout.byPath.get(aim.path) ?? taskRects?.get(aim.path);
    /* Not placed yet is not a failure: the request is still owed. */
    if (!node) return;
    /* The FIRST aim is unconditional. An open asks for a readable framing of
       that conversation, not merely for its rectangle to be somewhere in the
       viewport, so returning to one from the overview scale still zooms in to
       it — the guarantee `centerOn(node, 0.55)` has always carried. Only once
       an aim has been taken AGAINST THE RECTANGLE THE NODE STILL HAS does
       "already shown" complete the request: the aim promised the framing
       `centredCamera` computes for that rectangle, and a rectangle that moved
       since (the tile it was taken against became the reader and wrapped to
       the next row, the bands re-measured for a mode change) has not been
       given that framing — its head may be on screen, its composer below the
       fold, with the space it was promised sitting empty above it (#1641).
       Such a node is aimed at again; a node whose rectangle is stable and
       framed discharges the request, and a stable one that the aim could not
       frame is left alone rather than fought over. */
    if (aim.at && sameRect(aim.at, node)) {
      if (nodeIsFramed(node, cam, vp)) {
        focusAim.current = null;
        return;
      }
      /* Our own aim is already standing and the node is still not framed:
         there is nothing further this rule can do, and repeating the move
         would only fight whatever is holding the camera. */
      if (aim.cam && cameraMatchesFraming(cam, aim.cam)) return;
    }
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect || !(rect.width > 1) || !(rect.height > 1)) return;
    /* The zoom an open reaches for. On the physical-scaling band board a card's
       size follows the camera, so opening a conversation at the bare readable
       floor would leave its reader shrunk; the band asks for a fuller zoom so
       the opened conversation reads prominently. Never below the readable floor,
       and never past the current zoom downward. */
    const openZoom = Math.max(focusZoom, READABLE_Z);
    const z = Math.min(MAX_Z, Math.max(cam.z, openZoom));
    aim.at = { x: node.x, y: node.y, w: node.w, h: node.h };
    aim.cam = alignX(centredCamera(node, z, { w: rect.width, h: rect.height }));
    aiming.current = true;
    try {
      centerOn(node, openZoom);
    } finally {
      aiming.current = false;
    }
  }, [focus, project, layout, taskRects, cam, vp, centerOn, alignX, focusZoom]);

  /* Wheel: plain — pan (shift turns it horizontal); ctrl/cmd (and trackpad
     pinch) — zoom at the cursor. The only surface that keeps the wheel for
     itself is a scroll container under the pointer with content to scroll —
     the open conversation reader's feed, or a scrollable panel floating over
     the board. Everything else pans, so a wheel over the task background, a
     band's header controls, «+ Agent», a mirror tile or a collapsed agent card
     moves the board instead of being swallowed by a control that cannot use it
     (#1641). */
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    /* A camera-moving wheel re-baselines nav once it stops: bump manualNonce
       250ms after the last such event (a wheel that scrolls a feed does not). */
    const armSettle = () => {
      if (wheelSettle.current) window.clearTimeout(wheelSettle.current);
      wheelSettle.current = window.setTimeout(() => setManualNonce((n) => n + 1), 250);
    };
    /* The nearest ancestor between the target and the viewport that can consume
       vertical wheel: overflowing content in an auto/scroll box. Interactive
       chrome that does not scroll (a button, a status pill, a card that is not
       an open reader) returns nothing, so the board pans over it. */
    const scrollableAncestor = (target: HTMLElement | null): HTMLElement | null => {
      for (let node = target; node && node !== el; node = node.parentElement) {
        if (node.scrollHeight > node.clientHeight + 1) {
          const overflowY = getComputedStyle(node).overflowY;
          if (overflowY === "auto" || overflowY === "scroll") return node;
        }
      }
      return null;
    };
    const onWheel = (event: WheelEvent) => {
      const rect = el.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        applyZoom(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * 0.0022));
        armSettle();
        return;
      }
      /* A held Space is an explicit hand-pan and overrides even a feed. */
      if (!spaceRef.current && scrollableAncestor(event.target as HTMLElement | null)) return;
      event.preventDefault();
      const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
      const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
      queueCam((c) => settle({ ...c, x: c.x - dx, y: c.y - dy }));
      armSettle();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (wheelSettle.current) window.clearTimeout(wheelSettle.current);
    };
  }, [applyZoom, settle, queueCam]);

  /* Keyboard: H/V tools, Space-hold temporary hand, +/−/1 zoom, 0 fit,
     arrows pan, Esc drops the selection. */
  useEffect(() => {
    const typing = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el || !el.tagName) return false;
      return ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(el.tagName) || el.isContentEditable;
    };
    const onDown = (event: KeyboardEvent) => {
      /* Arrows go to spatial nav before the typing() guard: they must still
         work when a pane's button holds focus after a click. Nav runs its own
         richer guards (inputs, dialogs, scroll-consuming feeds) and only
         preventDefaults when it actually consumed the key. Modifier variants
         are left to the browser (no MVP bindings). */
      if (event.key.startsWith("Arrow")) {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (onArrowNav?.current?.(event)) event.preventDefault();
        return;
      }
      if (typing(event.target)) return;
      if (event.key === " ") {
        event.preventDefault();
        if (!event.repeat) setSpacePan(true);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "h" || event.key === "H") setMode("hand");
      else if (event.key === "v" || event.key === "V") setMode("select");
      else if (event.key === "t" || event.key === "T") {
        /* T arms the one-shot «task» tool; N belongs to the global
           attention-queue cycle in Viewer. */
        if (placeTaskRef.current) setTaskTool(true);
      } else if (event.key === "Escape") {
        if (taskToolRef.current) setTaskTool(false);
        else setSelected(null);
      }
      else if (event.key === "0") {
        if (event.shiftKey) fit();
        else fitCurrentOrAll();
      }
      else if (event.key === "1") zoomTo(1);
      /* +/− first offer the anchor-preserving zoom ladder; without a followed
         anchor it falls back to continuous zoom around the viewport centre. */
      else if (event.key === "+" || event.key === "=") {
        if (!onZoomKey?.current?.(1)) zoomCenter(1.25);
      } else if (event.key === "-") {
        if (!onZoomKey?.current?.(-1)) zoomCenter(0.8);
      }
    };
    const onUp = (event: KeyboardEvent) => {
      if (event.key === " ") setSpacePan(false);
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, [fit, fitCurrentOrAll, zoomCenter, zoomTo, setMode, setSelected, onArrowNav, onZoomKey]);

  const localPoint = (event: { clientX: number; clientY: number }) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: event.clientX, y: event.clientY };
  };

  const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
    panRef.current = { sx: event.clientX, sy: event.clientY, cx: cam.x, cy: cam.y };
    panMovedRef.current = false;
    setPanning(true);
    try {
      viewportRef.current?.setPointerCapture(event.pointerId);
    } catch {
      /* pointer already gone — pan still tracks via move events */
    }
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-scheme-ui]")) return;
    /* Map mode: remember where the press started, the click handler turns a
       stationary press into a node pick. */
    if (mapMode && event.isPrimary) tapRef.current = { x: event.clientX, y: event.clientY };
    /* Second finger anywhere turns the gesture into a pinch. */
    if (event.pointerType === "touch") {
      pointersRef.current.set(event.pointerId, localPoint(event));
      if (pointersRef.current.size === 2) {
        const [a, b] = [...pointersRef.current.values()];
        pinchRef.current = { d: dist(a!, b!), cx: (a!.x + b!.x) / 2, cy: (a!.y + b!.y) / 2 };
        pinchActiveRef.current = true;
        panRef.current = null;
        setPanning(false);
        return;
      }
    }
    if (event.button === 1) {
      event.preventDefault();
      startPan(event);
      return;
    }
    if (event.button !== 0) return;
    /* Armed «task» tool: this click places the card and the tool reverts
       to select — no pan, no selection change. preventDefault suppresses the
       compatibility mousedown: its focus fixup would land on the background
       and blur the draft's just-focused textarea, whose empty-blur handler
       cancels the card before it is ever seen. */
    if (taskTool && !mapMode && placeTaskRef.current) {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (rect) {
        event.preventDefault();
        placeTaskRef.current((event.clientX - rect.left - cam.x) / cam.z, (event.clientY - rect.top - cam.y) / cam.z);
        setTaskTool(false);
        setMode("select");
        return;
      }
    }
    const handLike = mapMode || mode === "hand" || spacePan;
    if (!handLike) {
      /* Task cards own their pointer interactions (drag, inline edit) the
         way buttons and inputs do — the camera never starts a pan on them. */
      if (target.closest("[data-scheme-task]")) return;
      const nodeEl = target.closest("[data-scheme-node]");
      if (nodeEl) {
        setSelected(nodeEl.getAttribute("data-scheme-node"), event.shiftKey || event.ctrlKey || event.metaKey);
        return;
      }
      /* Background press: the stationary tap resolves through onClick below,
         so the session's toggle/exit and the map pick share one path. */
      if (onWorldTap && event.isPrimary) tapRef.current = { x: event.clientX, y: event.clientY };
      const claimed = onBackgroundDown?.(event) ?? false;
      /* Mouse/pen claim hands the whole gesture to the marquee; a touch claim
         only spares the selection from the press-time clear — the finger keeps
         panning and a stationary tap still lands in onWorldTap. */
      if (claimed && event.pointerType !== "touch") return;
      if (!claimed) {
        setSelected(null);
        if (target.closest("button, a, input, textarea, select")) return;
      }
    }
    startPan(event);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch" && pointersRef.current.has(event.pointerId)) {
      pointersRef.current.set(event.pointerId, localPoint(event));
      const pinch = pinchRef.current;
      if (pinch && pointersRef.current.size >= 2) {
        const [a, b] = [...pointersRef.current.values()];
        const d = dist(a!, b!);
        const cx = (a!.x + b!.x) / 2;
        const cy = (a!.y + b!.y) / 2;
        const factor = pinch.d > 0 ? d / pinch.d : 1;
        queueCam((c) => {
          const z = Math.min(MAX_Z, Math.max(MIN_Z, c.z * factor));
          const k = z / c.z;
          return settle({ z, x: cx - (pinch.cx - c.x) * k, y: cy - (pinch.cy - c.y) * k });
        });
        pinchRef.current = { d, cx, cy };
        return;
      }
    }
    const pan = panRef.current;
    if (!pan) return;
    const dx = event.clientX - pan.sx;
    const dy = event.clientY - pan.sy;
    /* Past the 9px tap threshold this is a real drag, not a click — mark it so
       its end re-baselines nav. */
    if (Math.hypot(dx, dy) > 9) panMovedRef.current = true;
    queueCam((c) => settle({ ...c, x: pan.cx + dx, y: pan.cy + dy }));
  };

  /* Gestures end on window-level listeners: a pointerup outside the viewport
     (or one React's delegation misses) must never leave the camera glued to
     the cursor. Implicit capture release handles the capture itself. */
  useEffect(() => {
    const end = (event: PointerEvent) => {
      pointersRef.current.delete(event.pointerId);
      if (pointersRef.current.size < 2) {
        pinchRef.current = null;
        if (pinchActiveRef.current) {
          pinchActiveRef.current = false;
          setManualNonce((n) => n + 1);
        }
      }
      /* A drag that actually moved is a manual camera gesture — re-baseline. */
      if (panRef.current && panMovedRef.current) setManualNonce((n) => n + 1);
      panMovedRef.current = false;
      panRef.current = null;
      setPanning(false);
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, []);

  /* Double-click: empty canvas drops an inline task composer at the click point
     (fit() stays on the toolbar button and the «0» key); a node in hand mode
     zooms in on that conversation (in select mode double-click keeps selecting
     text). Map mode and a running selection session keep the old no-op. */
  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-scheme-ui]") || target.closest("[data-scheme-task]")) return;
    const nodeEl = target.closest("[data-scheme-node]");
    if (!nodeEl) {
      if (mapMode || !placeTaskRef.current) {
        fit();
        return;
      }
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      placeTaskRef.current((event.clientX - rect.left - cam.x) / cam.z, (event.clientY - rect.top - cam.y) / cam.z);
      return;
    }
    if (mode !== "hand" && !spacePan) return;
    const node = layout.byPath.get(nodeEl.getAttribute("data-scheme-node") ?? "");
    if (node) centerOn(node, 0.9);
  };

  const handLike = mapMode || mode === "hand" || spacePan;

  /* World-coordinate hit test: with panes non-interactive on the map, a tap
     resolves against the layout geometry instead of the DOM. */
  const pickAt = (wx: number, wy: number): string | null => {
    const hit = (r: SchemeRect) => wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h;
    /* Task cards draw above panes, so they win the tap. */
    if (taskRects) {
      for (const [key, rect] of taskRects) if (hit(rect)) return key;
    }
    for (const node of layout.nodes) if (hit(node)) return node.file.path;
    for (const draft of layout.drafts) if (hit(draft)) return draft.key;
    for (const stack of layout.stacks) {
      if (hit(stack)) return stackItemAt(stack, wy)?.path ?? null;
    }
    for (const deck of layout.decks) {
      if (!hit(deck)) continue;
      return deck.key;
    }
    return null;
  };

  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onNodePick && !onWorldTap) return;
    const start = tapRef.current;
    tapRef.current = null;
    if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 9) return;
    if ((event.target as HTMLElement).closest("[data-scheme-ui]")) return;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const wx = (event.clientX - rect.left - cam.x) / cam.z;
    const wy = (event.clientY - rect.top - cam.y) / cam.z;
    if (onWorldTap?.(wx, wy)) return;
    if (!onNodePick) return;
    const key = pickAt(wx, wy);
    if (key) onNodePick(key);
  };

  const jump = useCallback(
    (wx: number, wy: number) => {
      framingRef.current = true;
      setCam((c) => settle({ ...c, x: vp.w / 2 - wx * c.z, y: vp.h / 2 - wy * c.z }));
    },
    [vp, settle],
  );

  return {
    cam,
    vp,
    viewportRef,
    mode,
    setMode,
    handLike,
    taskTool,
    setTaskTool,
    centerOn,
    panning,
    glide,
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
    glideToCamera,
    primeAnchor,
  };
}
