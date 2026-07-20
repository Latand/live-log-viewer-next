import { conversationIdentity } from "@/lib/accounts/identity";

import { cleanTitle } from "@/components/utils";

import { isCurrentWorkFile, isCurrentWorkGroup } from "./currentWork";
import type { SchemeLayout, SchemeRect } from "./layout";
import type { Camera } from "./Minimap";

export type ChipEdge = "top" | "right" | "bottom" | "left";

export interface BoardCluster {
  key: string;
  label: string;
  rect: SchemeRect;
  priority: number;
  color: string;
}

export interface ClusterChip {
  cluster: BoardCluster;
  edge: ChipEdge;
  /** Screen-space anchor on the chosen viewport edge. */
  x: number;
  y: number;
}

export interface ClusterChipPartition {
  visible: ClusterChip[];
  overflow: ClusterChip[];
}

const intersects = (a: SchemeRect, b: SchemeRect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** A viewport-space rectangle as a browser {@link DOMRect} reports it. */
export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Translate fixed board chrome — the subagent avatar/round stack and the
    composer/input area — from viewport space into the chip layer's local space
    (origin `base`, the board container's screen top-left) and keep only the
    parts that actually fall inside the chip viewport. Feeding these to
    {@link offscreenClusterChips} as obstacles makes an edge chip whose revealed
    band would paint over one fold into its «+N» disclosure instead of covering
    the avatars or the composer (operator overlap report, issue #474). */
export function screenKeepoutObstacles(
  base: { left: number; top: number },
  rects: readonly ScreenRect[],
  vp: { w: number; h: number },
): SchemeRect[] {
  const out: SchemeRect[] = [];
  for (const rect of rects) {
    if (rect.width < 1 || rect.height < 1) continue;
    const box: SchemeRect = { x: rect.left - base.left, y: rect.top - base.top, w: rect.width, h: rect.height };
    if (box.x + box.w <= 0 || box.y + box.h <= 0 || box.x >= vp.w || box.y >= vp.h) continue;
    out.push(box);
  }
  return out;
}

/** Screen-space padding between a chip's anchored edge and the viewport border;
    mirrors the ray-cast anchor pad below so the reveal budget matches placement. */
export const CHIP_EDGE_PAD = 22;
/** Fully-revealed / focused outer width of a chip pill: wide enough for a
    completely unfurled 48–60 character label (the longest current-work titles)
    plus the reserved control box and padding. The label never grows past this,
    so collision geometry can reserve it up front. */
export const CHIP_MAX_W = 520;
const CHIP_H = 44;

/** The widest a chip can ever paint at this anchor: the fully-revealed width,
    clamped so a revealed/focused label can never spill past a viewport edge.
    Used both to reserve collision space (so a chip that *could* unfurl over a
    conversation folds into «+N» before it ever reveals) and to cap the live
    reveal in {@link EdgeChips}. Left/right chips grow one way from their edge;
    top/bottom chips are centered, so they grow both ways. */
export function chipRevealWidth(edge: ChipEdge, x: number, vp: { w: number; h: number }): number {
  const room =
    edge === "right" ? x - CHIP_EDGE_PAD
    : edge === "left" ? vp.w - CHIP_EDGE_PAD - x
    : 2 * Math.min(x - CHIP_EDGE_PAD, vp.w - CHIP_EDGE_PAD - x);
  return Math.max(0, Math.min(CHIP_MAX_W, room));
}

/* The rendered pill's outer bounds resolved from the per-edge CSS transform in
   EdgeChips, in screen space. Reserves the *fully-revealed* width (not the
   resting pill) so a chip whose unfurled label would paint over a conversation
   surface folds into the edge disclosure before it can reveal (issue #474). */
function chipBox(chip: Omit<ClusterChip, "cluster">, w: number): SchemeRect {
  if (chip.edge === "left") return { x: chip.x, y: chip.y - CHIP_H / 2, w, h: CHIP_H };
  if (chip.edge === "right") return { x: chip.x - w, y: chip.y - CHIP_H / 2, w, h: CHIP_H };
  if (chip.edge === "top") return { x: chip.x - w / 2, y: chip.y, w, h: CHIP_H };
  return { x: chip.x - w / 2, y: chip.y - CHIP_H, w, h: CHIP_H };
}

function chipAnchor(rect: SchemeRect, cam: Camera, vp: { w: number; h: number }): Omit<ClusterChip, "cluster"> {
  const cx = (rect.x + rect.w / 2) * cam.z + cam.x;
  const cy = (rect.y + rect.h / 2) * cam.z + cam.y;
  const vx = vp.w / 2;
  const vy = vp.h / 2;
  const dx = cx - vx;
  const dy = cy - vy;
  const tx = dx === 0 ? Infinity : (vp.w / 2) / Math.abs(dx);
  const ty = dy === 0 ? Infinity : (vp.h / 2) / Math.abs(dy);
  const pad = CHIP_EDGE_PAD;
  if (tx <= ty) {
    const edge: ChipEdge = dx >= 0 ? "right" : "left";
    return { edge, x: edge === "right" ? vp.w - pad : pad, y: Math.max(pad, Math.min(vp.h - pad, vy + dy * tx)) };
  }
  const edge: ChipEdge = dy >= 0 ? "bottom" : "top";
  return { edge, x: Math.max(pad, Math.min(vp.w - pad, vx + dx * ty)), y: edge === "bottom" ? vp.h - pad : pad };
}

/** Fixed outer size of an edge's «+N» overflow trigger (Tailwind min-h-11 /
    min-w-11). Reserved as a collision box so the aggregate control, like the
    reveal chips, never docks over a conversation pane or the keep-out chrome. */
export const OVERFLOW_TRIGGER = 44;
/** Distance the aggregate trigger stays off its viewport border — mirrors the
    inline offset {@link EdgeChips} anchors it at. */
const OVERFLOW_PAD = 10;

/** Where an edge's «+N» overflow disclosure trigger anchors. The trigger is a
    fixed-size control docked against `edge`; like the reveal chips it must never
    paint over a conversation pane or the avatar/composer keep-out, so it slides
    along its edge from the midpoint to the nearest slot whose trigger box clears
    every obstacle, falling back to the midpoint only when the whole edge is
    blocked (issue #474 obstacle-aware aggregate placement). The returned `{x,y}`
    is the same edge-anchor the disclosure's per-edge transform expects. */
export function overflowAnchor(
  edge: ChipEdge,
  vp: { w: number; h: number },
  obstacles: readonly SchemeRect[] = [],
): { x: number; y: number } {
  const vertical = edge === "left" || edge === "right";
  const fixedX = edge === "left" ? OVERFLOW_PAD : edge === "right" ? vp.w - OVERFLOW_PAD : vp.w / 2;
  const fixedY = edge === "top" ? OVERFLOW_PAD : edge === "bottom" ? vp.h - OVERFLOW_PAD : vp.h / 2;
  const half = OVERFLOW_TRIGGER / 2;
  const boxAt = (v: number): SchemeRect => {
    if (edge === "left") return { x: OVERFLOW_PAD, y: v - half, w: OVERFLOW_TRIGGER, h: OVERFLOW_TRIGGER };
    if (edge === "right") return { x: vp.w - OVERFLOW_PAD - OVERFLOW_TRIGGER, y: v - half, w: OVERFLOW_TRIGGER, h: OVERFLOW_TRIGGER };
    if (edge === "top") return { x: v - half, y: OVERFLOW_PAD, w: OVERFLOW_TRIGGER, h: OVERFLOW_TRIGGER };
    return { x: v - half, y: vp.h - OVERFLOW_PAD - OVERFLOW_TRIGGER, w: OVERFLOW_TRIGGER, h: OVERFLOW_TRIGGER };
  };
  const at = (v: number): { x: number; y: number } => (vertical ? { x: fixedX, y: v } : { x: v, y: fixedY });
  const clear = (v: number): boolean => !obstacles.some((obstacle) => intersects(boxAt(v), obstacle));
  const span = vertical ? vp.h : vp.w;
  const center = span / 2;
  const min = half + OVERFLOW_PAD;
  const max = span - half - OVERFLOW_PAD;
  if (clear(center)) return at(center);
  for (let offset = 24; offset <= span; offset += 24) {
    for (const v of [center - offset, center + offset]) {
      if (v >= min && v <= max && clear(v)) return at(v);
    }
  }
  return at(center);
}

/** Pure off-screen filtering, ray/edge placement, priority, and per-edge cap.
 * `obstacles` are screen-space boxes of rendered conversation surfaces (panes,
 * decks): a chip whose pill would paint over one folds into that edge's compact
 * «+N» disclosure instead — relation/navigation chips must never overlay chat
 * content (issue #292 production rejection). */
export function offscreenClusterChips(
  clusters: readonly BoardCluster[],
  cam: Camera,
  vp: { w: number; h: number },
  perEdgeCap = 4,
  obstacles: readonly SchemeRect[] = [],
): ClusterChipPartition {
  const viewport: SchemeRect = { x: -cam.x / cam.z, y: -cam.y / cam.z, w: vp.w / cam.z, h: vp.h / cam.z };
  const sorted = clusters
    .filter((cluster) => !intersects(cluster.rect, viewport))
    .sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key));
  const visible: ClusterChip[] = [];
  const overflow: ClusterChip[] = [];
  const counts = new Map<ChipEdge, number>();
  for (const cluster of sorted) {
    const chip = { cluster, ...chipAnchor(cluster.rect, cam, vp) };
    const count = counts.get(chip.edge) ?? 0;
    /* Reserve the *whole* title band (CHIP_MAX_W): an admitted chip must be able
       to unfurl its complete 48–60 character label, so we never admit one whose
       full reveal would spill past a viewport edge (a top/bottom chip centered
       near a corner) or paint over a conversation surface / keep-out. A chip is
       admitted only when its edge still has a slot, that full band fits the
       viewport at this anchor (chipRevealWidth reaches CHIP_MAX_W), and the band
       clears every obstacle. Otherwise it folds into «+N» — so a near-corner
       title either fully fits or folds, never renders a permanently-truncated
       sliver (issue #474 collision-safe full-title admission). */
    const fitsViewport = chipRevealWidth(chip.edge, chip.x, vp) >= CHIP_MAX_W;
    const box = chipBox(chip, CHIP_MAX_W);
    if (count < perEdgeCap && fitsViewport && !obstacles.some((obstacle) => intersects(box, obstacle))) {
      visible.push(chip);
      counts.set(chip.edge, count + 1);
    } else {
      overflow.push(chip);
    }
  }
  return { visible, overflow };
}

/** Labeled board clusters eligible for edge navigation: current-work groups and
    panes plus crowned favorites. Task cards deliberately stay out (issue #292):
    their navigation lives in the reserved relation controls on panes and cards
    (plus the minimap), so a floating wayfinding chip never covers an open
    conversation's content the way the old task chips did. */
export function boardClusters(
  layout: SchemeLayout,
  favorites: ReadonlySet<string>,
): BoardCluster[] {
  const clusters: BoardCluster[] = [];
  for (const group of layout.groups) {
    if (!isCurrentWorkGroup(group)) continue;
    const attention = group.pipeline
      ? group.pipeline.state === "needs_decision" || group.pipeline.state === "paused"
      : group.flow?.state === "needs_decision" || group.flow?.state === "paused";
    clusters.push({
      key: group.key,
      label: group.label,
      rect: group,
      priority: attention ? 5 : 3,
      color: `hsl(${group.hue} 62% 42%)`,
    });
  }
  for (const node of layout.nodes) {
    const favorite = node.isRoot && favorites.has(conversationIdentity(node.file));
    if (!favorite && !isCurrentWorkFile(node.file)) continue;
    clusters.push({
      key: node.file.path,
      label: cleanTitle(node.file.title),
      rect: node,
      priority: isCurrentWorkFile(node.file) ? 4 : 2,
      color: node.file.engine === "codex" ? "var(--color-codex)" : "var(--color-claude)",
    });
  }
  return clusters;
}
