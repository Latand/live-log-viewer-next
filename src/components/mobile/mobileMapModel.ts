import { cleanTitle } from "@/components/utils";
import type { SchemeLayout } from "@/components/scheme/layout";
import type { WorkerStack } from "@/components/scheme/workerCollapse";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

/** Hard ceiling on individually rendered markers. Everything past it folds into
    spatial cluster chips, so the phone overlay's DOM stays bounded no matter how
    large the board grows (issue #418) — the map survives the largest board over
    a slow Tailscale link because its element count never scales with the board. */
export const MAP_MARKER_CAP = 400;

/** Asserted DOM ceiling for the whole open-map overlay subtree on the #418
    regression fixture (measured baseline was ~7,146 elements with the full
    SchemeBoard). ~6 elements/marker × 400 + chrome + edges stays well under. */
export const MOBILE_MAP_DOM_BUDGET = 2500;

/* Bands appended below the placed graph for occupants the layout does not
   position: collapsed worker stacks (map-only per-origin dots) and board tasks
   without a pinned position. */
const BAND_ITEM_W = 132;
const BAND_ITEM_H = 60;
const BAND_GAP = 16;
const BAND_PAD = 48;

export interface MapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type MapMarkerKind = "node" | "deck" | "draft" | "stack" | "worker" | "task";

export interface MapMarker {
  key: string;
  kind: MapMarkerKind;
  rect: MapRect;
  title: string;
  /** What `onNodePick` receives on tap; null when the marker has no openable
      target (e.g. an empty collapsed worker stack). */
  pickKey: string | null;
  isRoot: boolean;
  /** Node markers carry their file so the overlay can paint engine/activity. */
  file?: FileEntry;
  /** Aggregate size for stack/worker markers. */
  count?: number;
}

export interface MapEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface MapCluster {
  key: string;
  count: number;
  rect: MapRect;
}

export interface MobileMapModel {
  markers: MapMarker[];
  edges: MapEdge[];
  clusters: MapCluster[];
  world: MapRect;
  /** Marker candidates before the cap — diagnostics and tests. */
  total: number;
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return cleanTitle(line, 60);
}

/**
 * Project an already-computed {@link SchemeLayout} (plus board tasks and
 * collapsed worker stacks) into a bounded marker set for the phone map overlay.
 *
 * Pure and cheap: it reuses the layout the focus view already memoized — no
 * second `buildSchemeLayout`, no camera/lasso/task-routing machinery — and caps
 * the marker count, folding the overflow into spatial clusters. The result has
 * no world-sized element and no per-node transition, which is what makes the
 * overlay survive the largest board (issue #418).
 */
export function buildMobileMapModel(
  layout: SchemeLayout,
  tasks: readonly BoardTask[],
  workerStacks: readonly WorkerStack[],
  /** The focused (ring) marker's key: always kept as an individual marker even
      past the cap, so the ring and the "current" frame never lose their rect to
      a cluster chip (PR #431). */
  focusKey: string | null = null,
): MobileMapModel {
  const candidates: MapMarker[] = [];

  for (const node of layout.nodes) {
    candidates.push({
      key: node.file.path,
      kind: "node",
      rect: { x: node.x, y: node.y, w: node.w, h: node.h },
      title: cleanTitle(node.file.title, 60),
      pickKey: node.file.path,
      isRoot: node.isRoot,
      file: node.file,
    });
  }
  for (const deck of layout.decks) {
    candidates.push({
      key: deck.key,
      kind: "deck",
      rect: { x: deck.x, y: deck.y, w: deck.w, h: deck.h },
      title: firstLine(deck.flow.id),
      pickKey: deck.key,
      isRoot: false,
      count: deck.rounds.length,
    });
  }
  for (const draft of layout.drafts) {
    candidates.push({
      key: draft.key,
      kind: "draft",
      rect: { x: draft.x, y: draft.y, w: draft.w, h: draft.h },
      title: draft.id,
      pickKey: draft.key,
      isRoot: true,
    });
  }
  for (const stack of layout.stacks) {
    const top = stack.items[0]?.file ?? null;
    candidates.push({
      key: stack.key,
      kind: "stack",
      rect: { x: stack.x, y: stack.y, w: stack.w, h: stack.h },
      title: top ? cleanTitle(top.title, 40) : "",
      pickKey: top ? top.path : null,
      isRoot: false,
      count: stack.items.length,
    });
  }

  /* Collapsed worker stacks are map-only (issue #136) — their per-origin dots
     appear nowhere else — so they must ride the map even though the layout does
     not place them; a band below the graph keeps them bounded. */
  const worldW = Math.max(layout.width, 1);
  let bandY = Math.max(layout.height, 0) + BAND_PAD;
  workerStacks.forEach((stack, index) => {
    const top = stack.items[0] ?? null;
    candidates.push({
      key: "worker::" + stack.key,
      kind: "worker",
      rect: bandRect(index, bandY, worldW),
      title: stack.id,
      pickKey: top ? top.path : null,
      isRoot: false,
      count: stack.items.length,
    });
  });
  if (workerStacks.length) bandY += bandRow(workerStacks.length, worldW) + BAND_GAP;

  /* Board tasks: pinned ones sit at their own board position; unplaced ones
     trail in a band so a status-stacked card is still reachable from the map. */
  const unplaced: BoardTask[] = [];
  for (const task of tasks) {
    if (task.pos) {
      candidates.push({
        key: "task::" + task.id,
        kind: "task",
        rect: { x: task.pos.x, y: task.pos.y, w: BAND_ITEM_W, h: BAND_ITEM_H },
        title: firstLine(task.text),
        pickKey: "task::" + task.id,
        isRoot: false,
      });
    } else {
      unplaced.push(task);
    }
  }
  unplaced.forEach((task, index) => {
    candidates.push({
      key: "task::" + task.id,
      kind: "task",
      rect: bandRect(index, bandY, worldW),
      title: firstLine(task.text),
      pickKey: "task::" + task.id,
      isRoot: false,
    });
  });

  const markers = candidates.slice(0, MAP_MARKER_CAP);
  const overflow = candidates.slice(MAP_MARKER_CAP);
  /* The focused marker must survive the cap: swap it with the last kept marker
     so the ceiling holds and the demoted marker joins the clustered overflow. */
  if (focusKey) {
    const focusedIndex = overflow.findIndex((marker) => marker.key === focusKey);
    if (focusedIndex >= 0) {
      const focused = overflow.splice(focusedIndex, 1)[0]!;
      const demoted = markers.pop();
      markers.push(focused);
      if (demoted) overflow.unshift(demoted);
    }
  }
  const clusters = clusterOverflow(overflow);

  /* Parent lineage only, one path each. Clustering either endpoint removes the
     connector, so every retained edge terminates at two visible markers. */
  const kept = new Set(markers.map((marker) => marker.key));
  const visibleSources = markers.filter((marker) => marker.kind === "node").map((marker) => marker.rect);
  const edges: MapEdge[] = [];
  for (const edge of layout.edges) {
    if (!kept.has(edge.to)) continue;
    if (!visibleSources.some((rect) => pointInRect(rect, edge.x1, edge.y1))) continue;
    edges.push({ x1: edge.x1, y1: edge.y1, x2: edge.x2, y2: edge.y2 });
    if (edges.length >= MAP_MARKER_CAP) break;
  }

  const contentRects = [
    { x: 0, y: 0, w: Math.max(layout.width, 1), h: Math.max(layout.height, bandY, 1) },
    ...markers.map((marker) => marker.rect),
    ...clusters.map((cluster) => cluster.rect),
  ];
  const left = Math.min(...contentRects.map((rect) => rect.x));
  const top = Math.min(...contentRects.map((rect) => rect.y));
  const right = Math.max(...contentRects.map((rect) => rect.x + rect.w));
  const bottom = Math.max(...contentRects.map((rect) => rect.y + rect.h));

  return {
    markers,
    edges,
    clusters,
    world: { x: left, y: top, w: Math.max(right - left, 1), h: Math.max(bottom - top, 1) },
    total: candidates.length,
  };
}

function pointInRect(rect: MapRect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

function bandRow(count: number, worldW: number): number {
  const perRow = Math.max(1, Math.floor((worldW + BAND_GAP) / (BAND_ITEM_W + BAND_GAP)));
  const rows = Math.ceil(count / perRow);
  return rows * (BAND_ITEM_H + BAND_GAP);
}

function bandRect(index: number, top: number, worldW: number): MapRect {
  const perRow = Math.max(1, Math.floor((worldW + BAND_GAP) / (BAND_ITEM_W + BAND_GAP)));
  const col = index % perRow;
  const row = Math.floor(index / perRow);
  return {
    x: col * (BAND_ITEM_W + BAND_GAP),
    y: top + row * (BAND_ITEM_H + BAND_GAP),
    w: BAND_ITEM_W,
    h: BAND_ITEM_H,
  };
}

/** Fold overflow markers into a coarse spatial grid (≤ 36 cells) so the map
    still shows where the uncounted work lives without unbounded DOM. */
function clusterOverflow(overflow: readonly MapMarker[]): MapCluster[] {
  if (!overflow.length) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const marker of overflow) {
    minX = Math.min(minX, marker.rect.x);
    minY = Math.min(minY, marker.rect.y);
    maxX = Math.max(maxX, marker.rect.x + marker.rect.w);
    maxY = Math.max(maxY, marker.rect.y + marker.rect.h);
  }
  const cols = 6;
  const rows = 6;
  const cellW = Math.max((maxX - minX) / cols, 1);
  const cellH = Math.max((maxY - minY) / rows, 1);
  const byCell = new Map<string, { count: number; x: number; y: number }>();
  for (const marker of overflow) {
    const col = Math.min(cols - 1, Math.floor((marker.rect.x - minX) / cellW));
    const row = Math.min(rows - 1, Math.floor((marker.rect.y - minY) / cellH));
    const key = col + ":" + row;
    const cell = byCell.get(key) ?? { count: 0, x: minX + col * cellW, y: minY + row * cellH };
    cell.count += 1;
    byCell.set(key, cell);
  }
  return [...byCell.entries()].map(([key, cell]) => ({
    key: "cluster::" + key,
    count: cell.count,
    rect: { x: cell.x, y: cell.y, w: cellW, h: cellH },
  }));
}

/** Every pickable marker key the overlay can emit — the pick-key contract the
    focus view's `pickFromMap` must resolve (nodes/decks/drafts by key, tasks by
    `task::` prefix, transcripts by path). Used by the model test to guarantee
    parity so a tapped marker never dead-ends. */
export function markerPickKeys(model: MobileMapModel): string[] {
  return model.markers.map((marker) => marker.pickKey).filter((key): key is string => key !== null);
}
