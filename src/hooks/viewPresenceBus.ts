"use client";

import type { SchemeLayout, SchemeRect } from "@/components/scheme/layout";
import { MAX_SELECTED_PATHS, type PresencePayloadV1 } from "@/lib/view/types";

/* The client-assembled view the presence publisher ships to the server: every
   non-identity field of the wire DTO, so the hook only has to stamp identity,
   sequence and visibility on top. Reusing PresencePayloadV1 keeps this in lock
   step with Terra's validator — a field renamed there breaks the build here. */
export type RenderedViewState = Pick<
  PresencePayloadV1,
  "project" | "mode" | "focusedPath" | "selectedPaths" | "visiblePaths" | "camera" | "viewport" | "board"
>;

export type PresenceCamera = PresencePayloadV1["camera"];
export type PresenceBoard = PresencePayloadV1["board"];
export type PresenceViewport = PresencePayloadV1["viewport"];
export type ViewMode = PresencePayloadV1["mode"];

/** Minimal camera shape the scheme camera engine exposes (`{x,y,z}`). */
export interface CameraLike {
  x: number;
  y: number;
  z: number;
}

/* The board arrangement lives outside a project view (overview) or before the
   store answers: presence still publishes, marked unavailable. */
export const UNAVAILABLE_BOARD: PresenceBoard = { renderedRevision: null, durableRevision: null, sync: "unavailable" };

/** Cross-cutting fields owned by the shell: which project is open and how its
    durable board arrangement is syncing. Merged under every leaf's slice. */
export interface ViewContext {
  project: string | null;
  board: PresenceBoard;
}

/** The active leaf's view: what is focused, selected and visible right now, plus
    the camera/viewport for spatial modes. `viewport` is optional — only the
    scheme board reports its own canvas size; every other mode inherits the
    window viewport the publisher supplies. */
export interface ViewSlice {
  mode: ViewMode;
  focusedPath: string | null;
  selectedPaths: string[];
  visiblePaths: string[];
  camera: PresenceCamera;
  viewport?: PresenceViewport;
}

export const OVERVIEW_CONTEXT: ViewContext = { project: null, board: UNAVAILABLE_BOARD };
export const OVERVIEW_SLICE: ViewSlice = {
  mode: "overview",
  focusedPath: null,
  selectedPaths: [],
  visiblePaths: [],
  camera: null,
};

export type WorldRect = NonNullable<PresenceCamera>["worldRect"];

/** Visible world box: solving `screen = world * zoom + {x,y}` for the two screen
    corners `(0,0)` and `(vp.w, vp.h)`. */
export function worldRectFor(cam: CameraLike, vp: { w: number; h: number }): WorldRect {
  const zoom = cam.z || 1;
  return { x: -cam.x / zoom, y: -cam.y / zoom, width: vp.w / zoom, height: vp.h / zoom };
}

/** Camera published for observation: the device's own frame, never used to
    drive another device's rendering (per-device camera stays authoritative). */
export function cameraToPresence(cam: CameraLike, vp: { w: number; h: number }): PresenceCamera {
  return { x: cam.x, y: cam.y, zoom: cam.z, worldRect: worldRectFor(cam, vp) };
}

function intersects(rect: SchemeRect, world: { x: number; y: number; width: number; height: number }): boolean {
  return rect.x < world.x + world.width && rect.x + rect.w > world.x && rect.y < world.y + world.height && rect.y + rect.h > world.y;
}

/**
 * The scheme's visible transcripts, in layout order (groups left→right
 * freshest-first, depth-first within a group). A node counts as visible when
 * its world rect intersects the camera's world rect. Capped so an extreme
 * zoom-out never publishes more than the wire limit; the cap drops the
 * furthest-right (freshest-last) nodes, matching what falls off screen last.
 */
export function schemeVisiblePaths(layout: SchemeLayout, cam: CameraLike, vp: { w: number; h: number }, cap: number): string[] {
  const world = worldRectFor(cam, vp);
  const out: string[] = [];
  for (const node of layout.nodes) {
    if (intersects(node, world)) out.push(node.file.path);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * THE `selectedPaths` ORDERING CONTRACT (#771), one rule for all three
 * publishers: `selectedPaths` is the canonical selection PROJECTED ONTO THE
 * CURRENT VIEW'S RENDER ORDER. The set is the same in every view — it lives at
 * project scope and outlives any of them — and only the ORDER differs: the
 * scheme walks its layout nodes, the list walks its rows, the phone walks its
 * own board order. Publishing never reorders the stored set.
 *
 * `includeUnordered` decides what happens to a member this view's order does not
 * mention, and the two answers are both deliberate:
 *
 * - The SCHEME passes false. Its order IS the board, so a path the board does not
 *   place has no board presence to report, and this keeps `orderedSelection`
 *   byte-identical to what it always published.
 * - The LIST and the PHONE pass true. Their orders are not the authority on
 *   membership — the list only lists ROOT conversations, so a selected subagent
 *   leaf appears in no row at all. Dropping it there would make a mode switch
 *   indistinguishable from the operator deselecting everything, which is exactly
 *   the regression this issue is about. Those members are appended after the
 *   view-ordered ones, in the set's own order.
 *
 * Capped at MAX_SELECTED_PATHS in that same order — the server rejects a larger
 * selection outright (400), so a marquee over 65+ panes must not kill every
 * presence POST; the tail of the order is dropped, matching the visible cap.
 */
export function selectionInOrder(
  order: readonly string[],
  selected: ReadonlySet<string>,
  options: { includeUnordered?: boolean } = {},
): string[] {
  if (selected.size === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of order) {
    if (!selected.has(path) || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= MAX_SELECTED_PATHS) return out;
  }
  if (!options.includeUnordered) return out;
  for (const path of selected) {
    if (seen.has(path)) continue;
    out.push(path);
    if (out.length >= MAX_SELECTED_PATHS) return out;
  }
  return out;
}

/** The scheme's projection: its layout node order, members off the board omitted. */
export function orderedSelection(layout: SchemeLayout, selected: ReadonlySet<string>): string[] {
  return selectionInOrder(layout.nodes.map((node) => node.file.path), selected);
}

/** Desktop focus precedence: the full-window expanded pane wins over the single
    selection ring. Both must be real transcript paths. The ring can land on a
    virtual layout key while spatial navigation walks the board — a review-round
    deck (`deck::<flow>`), a not-yet-spawned draft (`draft::<id>`), or a
    quiet-branch stack (`<path>::stack`) — none of which is a scanner transcript.
    Publishing such a key as `focusedPath` makes the server reject the entire
    snapshot with PATH_OUTSIDE_CURRENT_VIEW, so a ring on a virtual key focuses
    nothing. `transcriptPaths` is the set of real conversation node paths in the
    current layout. */
export function schemeFocusedPath(expanded: string | null, ringed: string | null, transcriptPaths: ReadonlySet<string>): string | null {
  if (expanded !== null) return expanded;
  if (ringed !== null && transcriptPaths.has(ringed)) return ringed;
  return null;
}

/** Stable structural compare for the small view objects — avoids notifying the
    publisher (and re-POSTing) when a report reproduces the current value, which
    is what keeps per-frame camera settles from spamming the network. */
function sameShape(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Merge the shell context and the active leaf slice into the full view. The
    leaf's viewport wins (the scheme canvas size); otherwise the window viewport
    the publisher passes is used, so camera-less modes still report a viewport. */
export function mergeView(context: ViewContext, slice: ViewSlice, windowViewport: PresenceViewport): RenderedViewState {
  return {
    project: context.project,
    board: context.board,
    mode: slice.mode,
    focusedPath: slice.focusedPath,
    selectedPaths: slice.selectedPaths,
    visiblePaths: slice.visiblePaths,
    camera: slice.camera,
    viewport: slice.viewport ?? windowViewport,
  };
}

export interface ViewBus {
  reportContext(next: ViewContext): void;
  reportSlice(next: ViewSlice): void;
  getContext(): ViewContext;
  getSlice(): ViewSlice;
  subscribe(listener: () => void): () => void;
}

/**
 * The module-level merger every view component reports into: the shell reports
 * context (project + board sync), the active leaf reports its slice, and the
 * single publisher mounted in Viewer subscribes once. No prop-drilling and no
 * render coupling — a report that reproduces the current value is dropped, so
 * publishing a camera frame never cascades a React render through the tree.
 */
export function createViewBus(): ViewBus {
  let context: ViewContext = OVERVIEW_CONTEXT;
  let slice: ViewSlice = OVERVIEW_SLICE;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    reportContext(next) {
      if (sameShape(context, next)) return;
      context = next;
      notify();
    },
    reportSlice(next) {
      if (sameShape(slice, next)) return;
      slice = next;
      notify();
    },
    getContext: () => context,
    getSlice: () => slice,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The app-wide singleton. Components import this; tests build isolated buses. */
export const viewBus: ViewBus = createViewBus();
