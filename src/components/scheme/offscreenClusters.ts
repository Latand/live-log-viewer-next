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
  /** The viewport-clamped outer width this chip's pill may paint at its anchor —
      the *measured* full label+control width (see {@link chipRevealWidth}),
      already clamped to the room at `edge`/`x`. An admitted chip's reveal caps
      here so a full unfurl can never spill past a viewport edge. */
  revealWidth: number;
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

/** The widest a chip can actually paint at this anchor: the *measured*
    fully-revealed width `fullWidth` (label + reserved control + padding, as the
    caller measured it), clamped to the room left before the opposite viewport
    edge so a revealed/focused label can never spill past it. Used both to
    reserve collision space (so a chip that *could* unfurl over a conversation —
    or whose measured wide-glyph label simply cannot fit — folds into «+N»
    before it ever reveals) and to cap the live reveal in {@link EdgeChips}.
    Left/right chips grow one way from their edge; top/bottom chips are centered,
    so they grow both ways. `fullWidth` defaults to {@link CHIP_MAX_W}, the widest
    a latin 48–60 char label needs, for callers without a measurement. */
export function chipRevealWidth(
  edge: ChipEdge,
  x: number,
  vp: { w: number; h: number },
  fullWidth: number = CHIP_MAX_W,
): number {
  const room =
    edge === "right" ? x - CHIP_EDGE_PAD
    : edge === "left" ? vp.w - CHIP_EDGE_PAD - x
    : 2 * Math.min(x - CHIP_EDGE_PAD, vp.w - CHIP_EDGE_PAD - x);
  return Math.max(0, Math.min(Math.max(0, fullWidth), room));
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

function chipAnchor(rect: SchemeRect, cam: Camera, vp: { w: number; h: number }): { edge: ChipEdge; x: number; y: number } {
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
    paint over a conversation pane or the avatar/round/composer keep-out, so it
    slides along its edge from the midpoint to the nearest slot whose trigger box
    clears every obstacle. Returns `null` when the whole edge is blocked — every
    candidate slot overlaps an obstacle — so the caller can re-home the aggregate
    to a clear edge or suppress it rather than dock it over content (issue #474
    collision-safe aggregate placement). The returned `{x,y}` is the same
    edge-anchor the disclosure's per-edge transform expects. */
export function overflowAnchor(
  edge: ChipEdge,
  vp: { w: number; h: number },
  obstacles: readonly SchemeRect[] = [],
): { x: number; y: number } | null {
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
  return null;
}

/** The four viewport borders in a stable clockwise order, used to re-home a
    blocked aggregate deterministically. */
const EDGE_ORDER: readonly ChipEdge[] = ["top", "right", "bottom", "left"];

/** Where an edge's «+N» aggregate actually docks. Prefers its own `edge`; when
    that edge is fully blocked ({@link overflowAnchor} returns null) it re-homes
    to the nearest clear border in a deterministic clockwise sweep, so the
    aggregate — and the keyboard-reachable disclosure it opens — always lands on a
    slot clear of every pane/avatar/round/composer keep-out. Returns `null` only
    when the entire viewport border is blocked, in which case the caller
    suppresses the trigger (no non-overlapping slot exists anywhere). Issue #474
    nullable / re-homed aggregate placement. */
export interface OverflowPlacement {
  edge: ChipEdge;
  x: number;
  y: number;
}
export function resolveOverflowPlacement(
  edge: ChipEdge,
  vp: { w: number; h: number },
  obstacles: readonly SchemeRect[] = [],
): OverflowPlacement | null {
  const order = [edge, ...EDGE_ORDER.filter((candidate) => candidate !== edge)];
  for (const candidate of order) {
    const anchor = overflowAnchor(candidate, vp, obstacles);
    if (anchor) return { edge: candidate, x: anchor.x, y: anchor.y };
  }
  return null;
}

/** Gap between the «+N» trigger and its opened disclosure list, and the padding
    the list keeps off every viewport border so keyboard-focused rows never sit
    against (or past) an edge. */
const LIST_GAP = 8;
const LIST_PAD = 8;
/** Comfortable resting widths for the opened list: a narrower column for the
    vertical (left/right) edges, a touch wider for the horizontal (top/bottom)
    ones. Each is clamped down to the room actually left at the anchor. */
const LIST_W_VERTICAL = 220;
const LIST_W_HORIZONTAL = 260;
/** Tallest the scrollable list grows before it pages internally. */
const LIST_MAX_H = 256;

/** Inline geometry for an «+N» disclosure's opened list, expressed as CSS
    offsets relative to a zero-size container anchored at the trigger's
    `{x,y}` (nav/viewport space). The list always opens *inward* from its
    resolved edge — right off a left edge, left off a right edge, down off the
    top, up off the bottom — is width-constrained to the room actually left
    toward the opposite border, and is clamped along its cross axis so that,
    however tall it renders (up to {@link maxHeight}), it stays fully inside the
    viewport. That keeps every keyboard-focused row visible for all four edges
    and for a re-homed aggregate anchored anywhere along its border (issue #474
    viewport-safe disclosures). */
export interface OverflowListStyle {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
}
export function overflowListStyle(
  edge: ChipEdge,
  anchor: { x: number; y: number },
  vp: { w: number; h: number },
): OverflowListStyle {
  const { x, y } = anchor;
  const off = OVERFLOW_TRIGGER + LIST_GAP;
  const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(value, Math.max(lo, hi)));
  if (edge === "left" || edge === "right") {
    /* Vertical list: opens horizontally inward, its height clamped so the whole
       column sits inside [LIST_PAD, vp.h - LIST_PAD] regardless of where along
       the edge the trigger docked. */
    const listH = Math.min(LIST_MAX_H, Math.max(0, vp.h - 2 * LIST_PAD));
    const topNav = clamp(y - listH / 2, LIST_PAD, vp.h - LIST_PAD - listH);
    const vertical = { top: topNav - y, maxHeight: listH };
    if (edge === "left") {
      const width = Math.max(0, Math.min(LIST_W_VERTICAL, vp.w - LIST_PAD - (x + off)));
      return { left: off, width, ...vertical };
    }
    const width = Math.max(0, Math.min(LIST_W_VERTICAL, x - off - LIST_PAD));
    return { right: off, width, ...vertical };
  }
  /* Horizontal list: opens vertically inward, centered on the trigger and
     clamped so it never spills past a left/right corner. */
  const width = Math.max(0, Math.min(LIST_W_HORIZONTAL, vp.w - 2 * LIST_PAD));
  const leftNav = clamp(x - width / 2, LIST_PAD, vp.w - LIST_PAD - width);
  const horizontal = { left: leftNav - x, width };
  if (edge === "top") {
    return { top: off, maxHeight: Math.max(0, vp.h - LIST_PAD - (y + off)), ...horizontal };
  }
  return { bottom: off, maxHeight: Math.max(0, y - off - LIST_PAD), ...horizontal };
}

/** Project every rendered conversation surface — live panes, review decks, and
    draft conversation panes — from world space into the chip layer's screen
    space with the existing camera projection, then append the fixed keep-out
    chrome (subagent avatar/round stack, composers). A draft pane's rect spans
    its whole shell, its composer included, so an edge chip whose revealed band
    would paint over an open draft or its composer folds into the «+N»
    disclosure exactly as it does for a live pane (issue #292 / #474 draft-pane
    obstacles). */
export function chipObstacleRects(
  panes: readonly SchemeRect[],
  decks: readonly SchemeRect[],
  drafts: readonly SchemeRect[],
  cam: Camera,
  keepouts: readonly SchemeRect[] = [],
): SchemeRect[] {
  const projected = [...panes, ...decks, ...drafts].map((surface) => ({
    x: surface.x * cam.z + cam.x,
    y: surface.y * cam.z + cam.y,
    w: surface.w * cam.z,
    h: surface.h * cam.z,
  }));
  return [...projected, ...keepouts];
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
  /** Measures the *rendered* outer width a chip needs to fully paint `label`
      plus its reserved control box and padding. Defaults to {@link CHIP_MAX_W}
      (the widest a latin 48–60 char label needs) for callers without a live
      measurement; {@link EdgeChips} supplies a real canvas measurement so an
      exact 48/60-character *wide-glyph* title — whose true width exceeds the
      latin band — is admitted only when it genuinely fits, and otherwise folds
      instead of truncating forever (issue #474 measured admission). */
  measure: (label: string) => number = () => CHIP_MAX_W,
): ClusterChipPartition {
  const viewport: SchemeRect = { x: -cam.x / cam.z, y: -cam.y / cam.z, w: vp.w / cam.z, h: vp.h / cam.z };
  const sorted = clusters
    .filter((cluster) => !intersects(cluster.rect, viewport))
    .sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key));
  const visible: ClusterChip[] = [];
  const overflow: ClusterChip[] = [];
  const counts = new Map<ChipEdge, number>();
  for (const cluster of sorted) {
    const anchor = chipAnchor(cluster.rect, cam, vp);
    /* Reserve the chip's *measured* full width: an admitted chip must be able to
       unfurl its complete rendered label, so we never admit one whose full
       reveal would spill past a viewport edge (a top/bottom chip centered near a
       corner), simply not fit at all (a wide-glyph 48–60 char title wider than
       the room), or paint over a conversation surface / keep-out. `fullWidth` is
       the measured outer width; `revealWidth` clamps it to the room at this
       anchor. The chip is admitted only when its edge still has a slot, that
       clamped width still holds the whole measured band (revealWidth ==
       fullWidth), and the band clears every obstacle. Otherwise it folds into
       «+N» — so a chip either fully fits or folds, never renders a
       permanently-truncated sliver (issue #474 measured full-title admission). */
    const fullWidth = Math.max(0, measure(cluster.label));
    const revealWidth = chipRevealWidth(anchor.edge, anchor.x, vp, fullWidth);
    const chip: ClusterChip = { cluster, ...anchor, revealWidth };
    const count = counts.get(chip.edge) ?? 0;
    const fitsViewport = revealWidth >= fullWidth;
    const box = chipBox(chip, fullWidth);
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
