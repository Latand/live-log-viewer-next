"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { useLocale } from "@/lib/i18n";
import type { SchemeLayout } from "@/components/scheme/layout";
import type { WorkerStack } from "@/components/scheme/workerCollapse";
import { activityDot, engineBadge } from "@/components/utils";
import type { BoardTask } from "@/lib/tasks/types";

import { buildMobileMapModel, type MapMarker, type MapRect, type MobileMapModel, type MobilePipelineOutline } from "./mobileMapModel";

const Z_MIN = 0.15;
const Z_MAX = 1.6;
const FIT_PAD = 28;
const MARKER_MIN_SIZE = 40;
const DEFAULT_VIEWPORT = { w: 390, h: 620 };
const EMPTY_PIPELINE_OUTLINES: readonly MobilePipelineOutline[] = [];

interface Camera {
  tx: number;
  ty: number;
  z: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Center a world rect in the viewport at zoom `z` (screen = world·z + t). */
function frameRect(rect: { x: number; y: number; w: number; h: number }, viewport: { w: number; h: number }, z: number): Camera {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return { z, tx: viewport.w / 2 - cx * z, ty: viewport.h / 2 - cy * z };
}

function fitAll(world: MapRect, viewport: { w: number; h: number }): Camera {
  /* Anchored marker buttons retain a 40px footprint at distant zoom levels.
     Reserve that footprint and allow All below the regular interaction floor. */
  const availableW = Math.max(viewport.w - FIT_PAD * 2 - MARKER_MIN_SIZE, 1);
  const availableH = Math.max(viewport.h - FIT_PAD * 2 - MARKER_MIN_SIZE, 1);
  const z = Math.min(availableW / world.w, availableH / world.h, Z_MAX);
  const renderedW = world.w * z + MARKER_MIN_SIZE;
  const renderedH = world.h * z + MARKER_MIN_SIZE;
  return {
    z,
    tx: FIT_PAD + (viewport.w - FIT_PAD * 2 - renderedW) / 2 - world.x * z,
    ty: FIT_PAD + (viewport.h - FIT_PAD * 2 - renderedH) / 2 - world.y * z,
  };
}

/**
 * Bounded, lightweight phone projection of the scheme (issue #418). Renders the
 * already-computed layout as a capped marker set with camera math done in JS —
 * there is no world-sized composited layer, no `will-change`, no per-node enter
 * transition, and no second `buildSchemeLayout`. It mounts no transcript feed or
 * pane and fetches nothing on open, so it survives the largest board on a slow
 * link. Pick keys reuse the exact `pickFromMap` contract, so a tapped marker
 * opens the same conversation/deck/task the full scheme would.
 */
export function MobileMapLite({
  layout,
  tasks,
  workerStacks,
  pipelineOutlines = EMPTY_PIPELINE_OUTLINES,
  frame,
  ringKey,
  onPick,
}: {
  layout: SchemeLayout;
  tasks: readonly BoardTask[];
  workerStacks: readonly WorkerStack[];
  pipelineOutlines?: readonly MobilePipelineOutline[];
  frame: "all" | "current";
  ringKey: string | null;
  onPick: (key: string) => void;
}) {
  const { t } = useLocale();
  /* The ring key rides into the model so the focused marker is never folded
     into a cluster past the cap (PR #431) — `ringRect` below must resolve. */
  const model = useMemo<MobileMapModel>(
    () => buildMobileMapModel(layout, tasks, workerStacks, ringKey, pipelineOutlines),
    [layout, tasks, workerStacks, ringKey, pipelineOutlines],
  );
  const currentRect = frame === "current" ? model.current : null;

  const surfaceRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT);
  /* Skeleton-first: the overlay chrome + a skeleton commit synchronously on tap;
     the markers land in a follow-up transition chunk so the open feels instant
     even on the largest board. */
  const [ready, setReady] = useState(false);
  const [camera, setCamera] = useState<Camera>(() => fitAll(model.world, DEFAULT_VIEWPORT));
  const { x: worldX, y: worldY, w: worldW, h: worldH } = model.world;
  const { w: viewportW, h: viewportH } = viewport;
  const currentX = currentRect?.x ?? null;
  const currentY = currentRect?.y ?? null;
  const currentW = currentRect?.w ?? null;
  const currentH = currentRect?.h ?? null;
  const allCamera = useMemo(
    () => fitAll({ x: worldX, y: worldY, w: worldW, h: worldH }, { w: viewportW, h: viewportH }),
    [worldX, worldY, worldW, worldH, viewportW, viewportH],
  );
  const currentCamera = useMemo(
    () => currentX === null || currentY === null || currentW === null || currentH === null
      ? null
      : frameRect({ x: currentX, y: currentY, w: currentW, h: currentH }, { w: viewportW, h: viewportH }, clamp(1, Z_MIN, Z_MAX)),
    [currentX, currentY, currentW, currentH, viewportW, viewportH],
  );
  const targetCamera = currentCamera ?? allCamera;
  const gestureMinZoom = currentRect ? Z_MIN : Math.min(Z_MIN, allCamera.z);

  /* Measure the surface (default viewport keeps SSR/tests stable) and reframe. */
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth || DEFAULT_VIEWPORT.w;
      const h = el.clientHeight || DEFAULT_VIEWPORT.h;
      setViewport((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (!RO) return;
    const observer = new RO(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    /* One frame after the synchronous skeleton commit, swap in the markers. A
       plain state flip (not a transition) so the whole capped set lands in one
       commit — bounded work, no time-slicing to starve. */
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  /* Semantic frame or geometry changes reframe the camera. Equivalent poll
     objects preserve a manually adjusted view because their scalar geometry
     retains the memoized target identity. */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setCamera(targetCamera);
  }, [frame, targetCamera]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /* Pointer pan + pinch/wheel zoom, all clamped. Pointer math only — no camera
     glide animation, so nothing composites a world-sized layer. */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; z: number } | null>(null);

  const onPointerDown = (event: React.PointerEvent) => {
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const prev = pointers.current.get(event.pointerId);
    if (!prev) return;
    const next = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, next);
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (!pinch.current) pinch.current = { dist, z: camera.z };
      else if (pinch.current.dist > 0) {
        const z = clamp(pinch.current.z * (dist / pinch.current.dist), gestureMinZoom, Z_MAX);
        setCamera((cam) => ({ ...cam, z }));
      }
      return;
    }
    setCamera((cam) => ({ ...cam, tx: cam.tx + (next.x - prev.x), ty: cam.ty + (next.y - prev.y) }));
  };
  const endPointer = (event: React.PointerEvent) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };
  const onWheel = (event: React.WheelEvent) => {
    const factor = Math.exp(-event.deltaY * 0.0015);
    setCamera((cam) => {
      const z = clamp(cam.z * factor, gestureMinZoom, Z_MAX);
      /* Zoom about the pointer so the point under the cursor stays put. */
      const rect = surfaceRef.current?.getBoundingClientRect();
      const px = rect ? event.clientX - rect.left : viewport.w / 2;
      const py = rect ? event.clientY - rect.top : viewport.h / 2;
      const worldX = (px - cam.tx) / cam.z;
      const worldY = (py - cam.ty) / cam.z;
      return { z, tx: px - worldX * z, ty: py - worldY * z };
    });
  };

  return (
    <div
      ref={surfaceRef}
      data-testid="mobile-map"
      className="relative min-h-0 flex-1 touch-none overflow-hidden bg-canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onWheel={onWheel}
      role="application"
      aria-label={t("mobile.map")}
    >
      {!ready ? (
        <div data-testid="mobile-map-skeleton" className="absolute inset-0 flex flex-col gap-2 p-4" aria-label={t("mobile.mapLoading")}>
          {Array.from({ length: 5 }).map((_, index) => (
            <span key={index} className="h-8 w-2/3 animate-pulse rounded-[8px] bg-sunken" style={{ opacity: 1 - index * 0.15 }} aria-hidden />
          ))}
        </div>
      ) : (
        <>
          {/* Lineage: one SVG the size of the surface, camera applied on a single
              group — bounded, no world-sized element. */}
          <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
            <g transform={`translate(${camera.tx} ${camera.ty}) scale(${camera.z})`}>
              {model.edges.map((edge, index) => (
                <line key={index} x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} className="stroke-border" strokeWidth={2 / camera.z} />
              ))}
            </g>
          </svg>
          {model.markers.map((marker) => (
            <Marker key={marker.key} marker={marker} camera={camera} active={marker.key === ringKey} onPick={onPick} />
          ))}
          {model.clusters.map((cluster) => {
            const left = cluster.rect.x * camera.z + camera.tx;
            const top = cluster.rect.y * camera.z + camera.ty;
            return (
              <span
                key={cluster.key}
                data-testid="mobile-map-cluster"
                className="pointer-events-none absolute flex h-6 min-w-6 items-center justify-center rounded-full border border-border bg-sunken px-1.5 text-[10px] font-bold text-muted"
                style={{ left, top }}
              >
                +{cluster.count}
              </span>
            );
          })}
        </>
      )}
    </div>
  );
}

function Marker({ marker, camera, active, onPick }: { marker: MapMarker; camera: Camera; active: boolean; onPick: (key: string) => void }) {
  const { t } = useLocale();
  const left = marker.rect.x * camera.z + camera.tx;
  const top = marker.rect.y * camera.z + camera.ty;
  const width = Math.max(marker.rect.w * camera.z, MARKER_MIN_SIZE);
  const height = Math.max(marker.rect.h * camera.z, MARKER_MIN_SIZE);
  const badge = marker.file ? engineBadge(marker.file) : null;
  const label = marker.title || t(`mobile.marker.${marker.kind}`);
  const disabled = marker.pickKey === null;
  return (
    <button
      type="button"
      data-testid="mobile-map-marker"
      data-map-key={marker.pickKey ?? ""}
      data-map-kind={marker.kind}
      disabled={disabled}
      onClick={() => marker.pickKey && onPick(marker.pickKey)}
      aria-label={t("mobile.marker.open", { title: label })}
      className={`absolute flex flex-col justify-center gap-0.5 overflow-hidden rounded-[8px] border px-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        active ? "border-accent bg-accent/10" : marker.kind === "draft" ? "border-dashed border-border bg-canvas" : "border-border bg-card"
      } ${disabled ? "opacity-60" : ""}`}
      style={{ left, top, width, height, minWidth: MARKER_MIN_SIZE, minHeight: MARKER_MIN_SIZE }}
    >
      <span className="flex items-center gap-1">
        {marker.file ? <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityDot(marker.file.activity)}`} aria-hidden /> : null}
        {badge ? <span className="shrink-0 rounded px-1 text-[8px] font-bold" style={badge.style}>{badge.label}</span> : null}
        {marker.count ? <span className="shrink-0 rounded-full bg-sunken px-1 text-[8px] font-bold text-muted">{marker.count}</span> : null}
      </span>
      <span className="truncate text-[9px] font-semibold text-primary">{label}</span>
    </button>
  );
}
