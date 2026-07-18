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

/* The rendered pill's outer bounds (max-w-[240px], min-h-11) resolved from the
   per-edge CSS transform in EdgeChips, in screen space. Conservative: a shorter
   label yields a narrower pill inside this box. */
const CHIP_W = 240;
const CHIP_H = 44;
function chipBox(chip: Omit<ClusterChip, "cluster">): SchemeRect {
  if (chip.edge === "left") return { x: chip.x, y: chip.y - CHIP_H / 2, w: CHIP_W, h: CHIP_H };
  if (chip.edge === "right") return { x: chip.x - CHIP_W, y: chip.y - CHIP_H / 2, w: CHIP_W, h: CHIP_H };
  if (chip.edge === "top") return { x: chip.x - CHIP_W / 2, y: chip.y, w: CHIP_W, h: CHIP_H };
  return { x: chip.x - CHIP_W / 2, y: chip.y - CHIP_H, w: CHIP_W, h: CHIP_H };
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
  const pad = 22;
  if (tx <= ty) {
    const edge: ChipEdge = dx >= 0 ? "right" : "left";
    return { edge, x: edge === "right" ? vp.w - pad : pad, y: Math.max(pad, Math.min(vp.h - pad, vy + dy * tx)) };
  }
  const edge: ChipEdge = dy >= 0 ? "bottom" : "top";
  return { edge, x: Math.max(pad, Math.min(vp.w - pad, vx + dx * ty)), y: edge === "bottom" ? vp.h - pad : pad };
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
    const box = chipBox(chip);
    if (count < perEdgeCap && !obstacles.some((obstacle) => intersects(box, obstacle))) {
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
      label: cleanTitle(node.file.title, 48),
      rect: node,
      priority: isCurrentWorkFile(node.file) ? 4 : 2,
      color: node.file.engine === "codex" ? "var(--color-codex)" : "var(--color-claude)",
    });
  }
  return clusters;
}
