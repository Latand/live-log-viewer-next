"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Camera } from "./Minimap";
import { stackItemAt, type SchemeLayout, type SchemeRect } from "./layout";

const MIN_Z = 0.12;
const MAX_Z = 1.6;
/* At least this much of the world stays inside the viewport when panning. */
const EDGE_KEEP = 120;

const MODE_KEY = "llvSchemeMode";

export type Mode = "hand" | "select";

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/* Reduced-motion: camera glides become instant jumps (matches useFlip.ts:7). */
const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

interface CameraOptions {
  project: string;
  layout: SchemeLayout;
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
export function useSchemeCamera({
  project,
  layout,
  mapMode,
  focus,
  onNodePick,
  setSelected,
  onBackgroundDown,
  onWorldTap,
  taskRects,
  onPlaceTask,
  onArrowNav,
  onZoomKey,
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
      const x = Math.min(Math.max(c.x, EDGE_KEEP - layout.width * c.z), vp.w - EDGE_KEEP);
      const y = Math.min(Math.max(c.y, EDGE_KEEP - layout.height * c.z), vp.h - EDGE_KEEP);
      return x === c.x && y === c.y ? c : { ...c, x, y };
    },
    [layout.width, layout.height, vp],
  );

  /* High-rate gestures (wheel, pointermove, pinch) coalesce into one camera
     update per frame: updater functions queue up and compose inside a single
     rAF, so deltas are never lost but React renders at most once per frame. */
  const camQueue = useRef<((c: Camera) => Camera)[]>([]);
  const camRaf = useRef<number | null>(null);
  const queueCam = useCallback((fn: (c: Camera) => Camera) => {
    camQueue.current.push(fn);
    if (camRaf.current != null) return;
    camRaf.current = requestAnimationFrame(() => {
      camRaf.current = null;
      const fns = camQueue.current;
      camQueue.current = [];
      setCam((c) => fns.reduce((acc, apply) => apply(acc), c));
    });
  }, []);
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
        return clampCam({ z, x: cx - (cx - c.x) * k, y: cy - (cy - c.y) * k });
      });
    },
    [clampCam, queueCam],
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
        return clampCam({ z, x: cx - (cx - c.x) * k, y: cy - (cy - c.y) * k });
      });
    },
    [clampCam],
  );

  const fitCam = useCallback((): Camera | null => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect || (!layout.nodes.length && !layout.drafts.length)) return null;
    const z = Math.min(MAX_Z, Math.max(MIN_Z, Math.min((rect.width - 48) / layout.width, (rect.height - 48) / layout.height, 1)));
    return { z, x: (rect.width - layout.width * z) / 2, y: (rect.height - layout.height * z) / 2 };
  }, [layout]);

  const glideTo = useCallback((next: Camera | ((c: Camera) => Camera)) => {
    /* Reduced motion: skip the CSS transition — the move lands instantly. */
    if (!reducedMotion()) setGlide(true);
    setCam(next);
    if (glideTimer.current) window.clearTimeout(glideTimer.current);
    glideTimer.current = window.setTimeout(() => setGlide(false), 500);
  }, []);
  useEffect(
    () => () => {
      if (glideTimer.current) window.clearTimeout(glideTimer.current);
    },
    [],
  );

  const fit = useCallback(() => {
    const c = fitCam();
    if (c) glideTo(c);
  }, [fitCam, glideTo]);

  const fitRect = useCallback(
    (r: SchemeRect) => {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect || r.w <= 0 || r.h <= 0) return;
      const z = Math.min(MAX_Z, Math.max(MIN_Z, Math.min((rect.width - 48) / r.w, (rect.height - 48) / r.h, 1)));
      glideTo(clampCam({ z, x: (rect.width - r.w * z) / 2 - r.x * z, y: (rect.height - r.h * z) / 2 - r.y * z }));
    },
    [glideTo, clampCam],
  );

  /* Glide a node into view: centered horizontally, its head near the top so
     a tall pane starts readable instead of vertically split. */
  const centerOn = useCallback(
    (node: SchemeRect, zMin: number) => {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      glideTo((c) => {
        const z = Math.min(MAX_Z, Math.max(c.z, zMin));
        return {
          z,
          x: rect.width / 2 - (node.x + node.w / 2) * z,
          y: Math.min(rect.height / 2 - node.y * z, rect.height * 0.08 - (node.y - 40) * z),
        };
      });
    },
    [glideTo],
  );

  /* Follow-anchor reflow: the anchor's world position shifted by (wdx, wdy);
     translate the camera the opposite way (× z) so it holds its screen spot. */
  const glideBy = useCallback(
    (wdx: number, wdy: number) => {
      glideTo((c) => clampCam({ ...c, x: c.x - wdx * c.z, y: c.y - wdy * c.z }));
    },
    [glideTo, clampCam],
  );

  /* The keyboard zoom ladder: same centered/head-near-top placement as
     `centerOn`, but at an explicit zoom (it may zoom out below the current z). */
  const glideFrame = useCallback(
    (node: SchemeRect, z: number) => {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      const zz = Math.min(MAX_Z, Math.max(MIN_Z, z));
      glideTo(
        clampCam({
          z: zz,
          x: rect.width / 2 - (node.x + node.w / 2) * zz,
          y: Math.min(rect.height / 2 - node.y * zz, rect.height * 0.08 - (node.y - 40) * zz),
        }),
      );
    },
    [glideTo, clampCam],
  );

  /* First layout of a project: restore the saved camera or fit everything.
     The map always opens fitted — its job is the whole picture. */
  useEffect(() => {
    if (initedFor.current === project || (!layout.nodes.length && !layout.drafts.length)) return;
    initedFor.current = project;
    if (!mapMode) {
      try {
        const raw = sessionStorage.getItem("llvCam:" + project);
        if (raw) {
          const saved = JSON.parse(raw) as Camera;
          if (Number.isFinite(saved.x) && Number.isFinite(saved.y) && Number.isFinite(saved.z) && saved.z >= MIN_Z && saved.z <= MAX_Z) {
            /* eslint-disable-next-line react-hooks/set-state-in-effect */
            setCam(saved);
            return;
          }
        }
      } catch {
        /* corrupt saved camera — fall through to fit */
      }
    }
    const c = fitCam();
    if (c) {

      setCam(c);
    }
  }, [project, layout, fitCam, mapMode]);

  /* Debounced: a pan produces hundreds of camera frames, storage needs only
     the resting position. The map never writes — the desktop camera survives. */
  useEffect(() => {
    if (mapMode || initedFor.current !== project) return;
    const t = window.setTimeout(() => sessionStorage.setItem("llvCam:" + project, JSON.stringify(cam)), 300);
    return () => window.clearTimeout(t);
  }, [cam, project, mapMode]);

  /* An opened conversation glides into view once its node exists in the layout. */
  const focusHandled = useRef<string | null>(null);
  useEffect(() => {
    if (!focus) {
      focusHandled.current = null;
      return;
    }
    if (focusHandled.current === focus) return;
    const node = layout.byPath.get(focus) ?? taskRects?.get(focus);
    if (!node) return;
    focusHandled.current = focus;
    centerOn(node, 0.55);
  }, [focus, layout, taskRects, centerOn]);

  /* Wheel: plain — pan (shift turns it horizontal); ctrl/cmd (and trackpad
     pinch) — zoom at the cursor. In select mode a wheel over a scrollable
     feed keeps native scrolling. */
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    /* A camera-moving wheel re-baselines nav once it stops: bump manualNonce
       250ms after the last such event (a wheel that scrolls a feed does not). */
    const armSettle = () => {
      if (wheelSettle.current) window.clearTimeout(wheelSettle.current);
      wheelSettle.current = window.setTimeout(() => setManualNonce((n) => n + 1), 250);
    };
    const onWheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest("[data-scheme-ui]")) return;
      const rect = el.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        applyZoom(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * 0.0022));
        armSettle();
        return;
      }
      if (modeRef.current === "select" && !spaceRef.current) {
        for (let node = event.target as HTMLElement | null; node && node !== el; node = node.parentElement) {
          if (node.scrollHeight > node.clientHeight + 1) {
            const overflowY = getComputedStyle(node).overflowY;
            if (overflowY === "auto" || overflowY === "scroll") return;
          }
        }
      }
      event.preventDefault();
      const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
      const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
      queueCam((c) => clampCam({ ...c, x: c.x - dx, y: c.y - dy }));
      armSettle();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (wheelSettle.current) window.clearTimeout(wheelSettle.current);
    };
  }, [applyZoom, clampCam, queueCam]);

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
      else if (event.key === "0") fit();
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
  }, [fit, zoomCenter, zoomTo, setMode, setSelected, onArrowNav, onZoomKey]);

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
          return clampCam({ z, x: cx - (pinch.cx - c.x) * k, y: cy - (pinch.cy - c.y) * k });
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
    queueCam((c) => clampCam({ ...c, x: pan.cx + dx, y: pan.cy + dy }));
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

  /* Double-click: empty canvas fits everything; a node in hand mode zooms in
     on that conversation (in select mode double-click keeps selecting text). */
  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-scheme-ui]")) return;
    const nodeEl = target.closest("[data-scheme-node]");
    if (!nodeEl) {
      fit();
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
    (wx: number, wy: number) => setCam((c) => clampCam({ ...c, x: vp.w / 2 - wx * c.z, y: vp.h / 2 - wy * c.z })),
    [vp, clampCam],
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
    fitRect,
    jump,
    manualNonce,
    glideBy,
    glideFrame,
  };
}
