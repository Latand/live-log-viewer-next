"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Camera } from "./Minimap";
import type { SchemeLayout, SchemeRect } from "./layout";
import {
  collectNavTargets,
  keyToDir,
  navTargetLabel,
  nearestToViewportCenter,
  type NavDir,
  nextZoomStep,
  pickDirectional,
  planReflow,
  zoomLadderSteps,
} from "./spatialNav";
import { useLocale } from "@/lib/i18n";

interface SpatialNavOptions {
  /** Nav is live only on the desktop board with no session/overlay/map mode. */
  enabled: boolean;
  layout: SchemeLayout;
  /** Placed task cards join the same geometric target field. */
  taskRects?: ReadonlyMap<string, SchemeRect>;
  taskLabels?: ReadonlyMap<string, string>;
  cam: Camera;
  vp: { w: number; h: number };
  /** The single-selection ring path, owned by SchemeBoard. */
  selected: string | null;
  setSelected: (value: string | null) => void;
  /** Glide the anchor to view keeping zoom (arrows never change zoom). */
  centerOn: (rect: SchemeRect, zMin: number) => void;
  /** Translate-glide so a moved anchor keeps its screen spot (reflow follow). */
  glideBy: (worldDx: number, worldDy: number) => void;
  /** Glide the anchor to an explicit zoom (the keyboard ladder). */
  glideFrame: (rect: SchemeRect, z: number) => void;
  /** Bumps on any manual camera gesture — drops follow and re-baselines. */
  manualNonce: number;
}

export interface SpatialNav {
  /** Handle an Arrow keydown; true when nav consumed it (camera preventDefaults). */
  onArrow: (event: KeyboardEvent) => boolean;
  /** Handle a +/− keydown; true when the ladder framed the anchor. */
  onZoomKey: (dir: 1 | -1) => boolean;
  /** Screen-reader text for the last keyboard move (aria-live region). */
  announcement: string;
}

/* Native-key surfaces that must keep their own arrows (§5 guards). */
const GUARD_SELECTOR = '[role="dialog"], [role="menu"], [role="listbox"], [data-scheme-ui]';

function isTypingTarget(el: HTMLElement): boolean {
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/* A focused feed consumes its own ↑/↓ until it hits the end; mirrors the wheel
   handler's scrollable-ancestor walk in useSchemeCamera. */
function scrollConsumes(start: HTMLElement | null, dir: NavDir): boolean {
  if (dir !== "up" && dir !== "down") return false;
  for (let node: HTMLElement | null = start; node; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight + 1) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") {
        const atTop = node.scrollTop <= 0;
        const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
        if (dir === "up" && !atTop) return true;
        if (dir === "down" && !atBottom) return true;
      }
    }
  }
  return false;
}

/**
 * Spatial keyboard navigation for the scheme board (issue #27). Arrow keys move
 * the selection ring between agent windows by geometry (never DOM/freshness
 * order) and centre the pick; the selected window becomes the camera anchor and
 * the camera translates with it through reflow so it never slides off screen. A
 * manual gesture drops follow; +/− snap to whole-window framings around the
 * anchor. The pure geometry lives in spatialNav.ts; this hook owns the follow
 * lifecycle and the DOM key guards. onArrow/onZoomKey are identity-stable and
 * read live state through refs so the camera's keydown listener never re-binds.
 */
export function useSpatialNav({
  enabled,
  layout,
  taskRects,
  taskLabels,
  cam,
  vp,
  selected,
  setSelected,
  centerOn,
  glideBy,
  glideFrame,
  manualNonce,
}: SpatialNavOptions): SpatialNav {
  const { t } = useLocale();
  const followRef = useRef(false);
  /* The anchor's rect at its last known layout, tagged with its key, so a
     relayout yields a delta only when it is still the same anchor (a selection
     that changed in the same render as a poll must not translate by a bogus
     cross-anchor delta). */
  const prevRectRef = useRef<{ key: string } & SchemeRect | null>(null);
  const [announcement, setAnnouncement] = useState("");

  /* Live inputs behind refs: the handlers below fire from a window keydown
     listener and must stay identity-stable across camera frames. */
  const enabledRef = useRef(enabled);
  const layoutRef = useRef(layout);
  const taskRectsRef = useRef(taskRects);
  const taskLabelsRef = useRef(taskLabels);
  const camRef = useRef(cam);
  const vpRef = useRef(vp);
  const selectedRef = useRef(selected);
  const centerRef = useRef(centerOn);
  const glideByRef = useRef(glideBy);
  const glideFrameRef = useRef(glideFrame);
  const setSelectedRef = useRef(setSelected);
  const tRef = useRef(t);
  useEffect(() => {
    enabledRef.current = enabled;
    layoutRef.current = layout;
    taskRectsRef.current = taskRects;
    taskLabelsRef.current = taskLabels;
    camRef.current = cam;
    vpRef.current = vp;
    selectedRef.current = selected;
    centerRef.current = centerOn;
    glideByRef.current = glideBy;
    glideFrameRef.current = glideFrame;
    setSelectedRef.current = setSelected;
    tRef.current = t;
  });

  const rectFor = useCallback((key: string): SchemeRect | undefined => layoutRef.current.byPath.get(key) ?? taskRectsRef.current?.get(key), []);
  const labelFor = useCallback((key: string): string => navTargetLabel(layoutRef.current, key, tRef.current, taskLabelsRef.current), []);

  /* Land on a target: anchor it, centre it (zoom unchanged), seed the reflow
     baseline, ring it, and announce it. */
  const land = useCallback(
    (key: string) => {
      const rect = rectFor(key);
      followRef.current = true;
      if (rect) {
        prevRectRef.current = { key, x: rect.x, y: rect.y, w: rect.w, h: rect.h };
        centerRef.current(rect, 0);
      }
      setSelectedRef.current(key);
      setAnnouncement(labelFor(key));
    },
    [labelFor, rectFor],
  );

  const onArrow = useCallback((event: KeyboardEvent): boolean => {
    const dir = keyToDir(event.key);
    if (!dir || !enabledRef.current) return false;
    const target = event.target as HTMLElement | null;
    const active = (typeof document !== "undefined" ? document.activeElement : null) as HTMLElement | null;
    for (const el of [target, active]) {
      if (!el) continue;
      if (isTypingTarget(el)) return false;
      if (el.closest?.(GUARD_SELECTOR)) return false;
    }
    if (scrollConsumes(target ?? active, dir)) return false;

    const targets = collectNavTargets(layoutRef.current, taskRectsRef.current);
    if (!targets.length) return false;
    const sel = selectedRef.current;
    const hasSel = followRef.current && sel != null && targets.some((t) => t.key === sel);
    if (!hasSel) {
      /* First press after a re-baseline: pick the on-screen-centre window and
         centre it — no directional step, so nothing jumps unexpectedly. */
      const start = nearestToViewportCenter(targets, camRef.current, vpRef.current, sel);
      if (start) land(start);
      return true;
    }
    const pick = pickDirectional(targets, sel, dir);
    /* Silent edge (no candidate that way): consume anyway so the page never
       scrolls out from under the board. */
    if (pick) land(pick);
    return true;
  }, [land]);

  const onZoomKey = useCallback((dir: 1 | -1): boolean => {
    if (!enabledRef.current || !followRef.current) return false;
    const sel = selectedRef.current;
    if (sel == null) return false;
    const rect = rectFor(sel);
    if (!rect) return false;
    const steps = zoomLadderSteps(rect, vpRef.current);
    const next = nextZoomStep(steps, camRef.current.z, dir);
    /* At the ceiling/floor of the readable ladder: consume, no-op. */
    if (next == null) return true;
    glideFrameRef.current(rect, next);
    prevRectRef.current = { key: sel, x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    return true;
  }, [rectFor]);

  /* Reflow follow: when the layout changes under a followed anchor, translate
     the camera by the anchor's world delta so it holds its screen position;
     if the anchor left the board, drop follow and the ring. */
  useEffect(() => {
    if (!followRef.current) return;
    const sel = selectedRef.current;
    if (sel == null) {
      prevRectRef.current = null;
      return;
    }
    const rect = layout.byPath.get(sel) ?? taskRects?.get(sel) ?? null;
    const prev = prevRectRef.current;
    const plan = planReflow(prev && prev.key === sel ? prev : null, rect);
    if (plan.kind === "drop") {
      followRef.current = false;
      prevRectRef.current = null;
      setSelectedRef.current(null);
      return;
    }
    if (rect) prevRectRef.current = { key: sel, x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    if (plan.kind === "translate") glideByRef.current(plan.dx, plan.dy);
  }, [layout, taskRects]);

  /* Any new anchor arms follow so it stays framed through reflow — an Arrow
     land, a pane click, or a focus jump after a send (the original issue's
     ask). No camera motion here: arrows/focus move it through their own paths,
     a click deliberately stays put. Clearing the ring disarms follow. Reads the
     layout through a ref so a poll relayout never re-seeds the baseline (which
     would zero out every reflow delta). */
  useEffect(() => {
    if (selected == null) {
      followRef.current = false;
      prevRectRef.current = null;
      return;
    }
    if (!enabledRef.current) return;
    const rect = rectFor(selected) ?? null;
    followRef.current = true;
    prevRectRef.current = rect ? { key: selected, x: rect.x, y: rect.y, w: rect.w, h: rect.h } : null;
  }, [selected, rectFor]);

  /* Any manual camera gesture re-baselines: drop follow but keep the ring. */
  const firstNonce = useRef(true);
  useEffect(() => {
    if (firstNonce.current) {
      firstNonce.current = false;
      return;
    }
    followRef.current = false;
    prevRectRef.current = null;
  }, [manualNonce]);

  /* Leaving the desktop board (session/overlay/map) disarms follow. */
  useEffect(() => {
    if (!enabled) {
      followRef.current = false;
      prevRectRef.current = null;
    }
  }, [enabled]);

  return { onArrow, onZoomKey, announcement };
}
