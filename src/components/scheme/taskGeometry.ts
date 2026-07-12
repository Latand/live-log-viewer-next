import type { BoardTask, TaskStatus } from "@/lib/tasks/types";

import type { SchemeRect } from "./layout";

export type { SchemeRect } from "./layout";

/* Task card geometry in world pixels (docs/design/sticky-notes.md). */
export const TASK_W = 260;
/** Body height cap; past it the card body scrolls internally. */
export const TASK_BODY_MAX = 340;
const TASK_MIN_H = 64;
/* Card body geometry: 12.5px text on 17px lines inside 12px (px-3) horizontal
   padding, so the wrap width is TASK_W − 24 = 236px. This estimate must be an
   *upper* bound on the rendered height — underestimating lets a tall card render
   past its computed box and overlap its neighbour (issue #17) — so line count is
   figured against the widest glyphs a proportional bold font produces (W/M run
   ~13px), never an average. Real text of the same length wraps to fewer lines,
   so the estimate is conservative, and the body is capped either way. */
const STRIP_H = 6;
const PAD_Y = 20;
const LINE_H = 17;
const BODY_CONTENT_W = TASK_W - 24;
/* Widest bold glyph advance at 12.5px; the fewest characters a full line can
   hold, so the most lines a given length can wrap to. */
const MAX_GLYPH_W = 13;
const CHARS_PER_LINE = Math.max(1, Math.floor(BODY_CONTENT_W / MAX_GLYPH_W));
/* Rendered chip block is 28m + 4 (each chip h-6 = 24, gap-1 = 4 between rows,
   pb-2 = 8 under the last), so the per-row budget must be the full 24 + 4 gap =
   28; a smaller figure undercounts a tall multi-target stack and eats the
   placement gutter. Paired with CHIP_PAD below (≥ the 8px pb) to stay an upper
   bound for any row count. */
const CHIP_ROW_H = 28;
const CHIP_PAD = 8;

/**
 * Estimated on-board height of a task card: status strip + wrapped text
 * (capped at the internal-scroll threshold) + one chip row per assignment.
 * Deliberately conservative — see the wrap-width note above — so the returned
 * box always contains the rendered card and the collision pass never lets two
 * cards overlap on screen.
 */
export function taskCardHeight(task: Pick<BoardTask, "text" | "assignments" | "source">): number {
  let lines = 0;
  /* Split on every hard break `whitespace-pre-wrap` renders — CRLF, a lone CR,
     or a lone LF — so a string of standalone `\r`s can't hide extra rendered
     rows inside one counted line and undercount the height. */
  for (const raw of task.text.split(/\r\n?|\n/)) {
    lines += Math.max(1, Math.ceil(raw.length / CHARS_PER_LINE));
  }
  const bodyH = Math.min(lines * LINE_H, TASK_BODY_MAX) + PAD_Y;
  const chipRows = task.assignments.length + (task.source ? 1 : 0);
  const chipsH = chipRows ? chipRows * CHIP_ROW_H + CHIP_PAD : 0;
  return Math.max(TASK_MIN_H, STRIP_H + bodyH + chipsH);
}

/** World-space box of a task card, derived from its owned position. */
export function taskRect(task: Pick<BoardTask, "pos" | "text" | "assignments" | "source">): SchemeRect {
  return { x: task.pos.x, y: task.pos.y, w: TASK_W, h: taskCardHeight(task) };
}

export function rectCenter(rect: SchemeRect): { x: number; y: number } {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

/* Breathing room between the outermost card and the world edge, so a card's
   dashed edge and status dot never sit flush against the clip / minimap frame. */
export const TASK_WORLD_MARGIN = 140;

/**
 * World box that encloses both the node-derived layout region ([0,0] →
 * width×height) and every placed task card (issue #17). A card relocated by the
 * collision pass — or dragged by hand — can land beyond the layout's right/bottom
 * edge, or left/above its origin, so the camera clamp, fit, minimap and task-edge
 * SVG must grow to reach it; otherwise it clips out, drops from the minimap, or
 * becomes unreachable by panning. The origin may go negative when a card sits
 * left of or above (0,0).
 */
export function taskWorldBounds(width: number, height: number, taskRects: readonly SchemeRect[]): SchemeRect {
  let minX = 0;
  let minY = 0;
  let maxX = width;
  let maxY = height;
  for (const rect of taskRects) {
    minX = Math.min(minX, rect.x - TASK_WORLD_MARGIN);
    minY = Math.min(minY, rect.y - TASK_WORLD_MARGIN);
    maxX = Math.max(maxX, rect.x + rect.w + TASK_WORLD_MARGIN);
    maxY = Math.max(maxY, rect.y + rect.h + TASK_WORLD_MARGIN);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Point where the line from the rect's center toward `toward` crosses the
 * rect boundary — the edge anchor. Falls back to the center for degenerate
 * (overlapping) geometry.
 */
export function rectAnchor(rect: SchemeRect, toward: { x: number; y: number }): { x: number; y: number } {
  const { x: cx, y: cy } = rectCenter(rect);
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const sx = dx ? rect.w / 2 / Math.abs(dx) : Infinity;
  const sy = dy ? rect.h / 2 / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy, 1);
  return { x: cx + dx * s, y: cy + dy * s };
}

/* Structural slice of SchemeLayout the target index needs — keeps the module
   testable with plain literals instead of full FileEntry/Flow fixtures. */
export interface TaskTargetSource {
  nodes: ReadonlyArray<SchemeRect & { file: { path: string }; under: ReadonlyArray<{ path: string }> }>;
  stacks: ReadonlyArray<SchemeRect & { items: ReadonlyArray<{ file: { path: string } }> }>;
  decks: ReadonlyArray<SchemeRect & { rounds: ReadonlyArray<{ file: { path: string } | null; round: { reviewerPath: string | null } }> }>;
}

/**
 * Where an assignment path is drawn on the board — the edge-endpoint
 * resolution ladder: a full node rect wins; a path shown only as a mini-card
 * in a quiet stack, an under-deck item, or a review-deck round resolves to
 * that container's rect; anything else is absent (dead chip, no edge).
 * Containers are inserted first so the later node entries override them.
 */
export function buildTaskTargetIndex(layout: TaskTargetSource): Map<string, SchemeRect> {
  const index = new Map<string, SchemeRect>();
  const rectOf = ({ x, y, w, h }: SchemeRect): SchemeRect => ({ x, y, w, h });
  for (const stack of layout.stacks) {
    for (const item of stack.items) index.set(item.file.path, rectOf(stack));
  }
  for (const deck of layout.decks) {
    for (const round of deck.rounds) {
      const path = round.file?.path ?? round.round.reviewerPath;
      if (path) index.set(path, rectOf(deck));
    }
  }
  for (const node of layout.nodes) {
    for (const item of node.under) index.set(item.path, rectOf(node));
  }
  for (const node of layout.nodes) index.set(node.file.path, rectOf(node));
  return index;
}

export interface TaskEdgeGeom {
  key: string;
  taskId: string;
  relation: "assignment" | "source";
  /** Transcript path — the retry handle for failed assignment edges. */
  path: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  status: TaskStatus;
  failed: boolean;
  error: string | null;
}

/**
 * Edge geometry from every task card to each resolvable assignment target.
 * Spawning assignments without a transcript and dead assignments (path
 * absent from the index) draw no edge — they stay chips on the card.
 */
export function buildTaskEdges(tasks: readonly BoardTask[], index: ReadonlyMap<string, SchemeRect>): TaskEdgeGeom[] {
  const edges: TaskEdgeGeom[] = [];
  for (const task of tasks) {
    const card = taskRect(task);
    const cardCenter = rectCenter(card);
    if (task.source) {
      const target = index.get(task.source.path);
      if (target) {
        const from = rectAnchor(card, rectCenter(target));
        const to = rectAnchor(target, cardCenter);
        edges.push({
          key: task.id + "::source::" + task.source.path,
          taskId: task.id,
          relation: "source",
          path: task.source.path,
          x1: from.x,
          y1: from.y,
          x2: to.x,
          y2: to.y,
          status: task.status,
          failed: false,
          error: null,
        });
      }
    }
    for (const assignment of task.assignments) {
      if (!assignment.path) continue;
      const target = index.get(assignment.path);
      if (!target) continue;
      const from = rectAnchor(card, rectCenter(target));
      const to = rectAnchor(target, cardCenter);
      edges.push({
        key: task.id + "::" + assignment.path,
        taskId: task.id,
        relation: "assignment",
        path: assignment.path,
        x1: from.x,
        y1: from.y,
        x2: to.x,
        y2: to.y,
        status: task.status,
        failed: assignment.state === "failed",
        error: assignment.error,
      });
    }
  }
  return edges;
}

/** A routed task edge: the cubic `d`, its on-curve midpoint (where the failed
    ⚠ badge lands), and whether it still grazes an unrelated card after routing. */
export interface TaskEdgeRoute {
  d: string;
  mid: { x: number; y: number };
  /** True when no bow could clear every obstacle — the layer fades the edge so
      an unavoidable crossing at least reads as passing *behind* the card. */
  crosses: boolean;
}

/* How far a routing bow may push the control handles before giving up, and the
   step it grows by. Symmetric: each magnitude is tried to both sides. */
const ROUTE_MAX_BOW = 260;
const ROUTE_BOW_STEP = 40;
/* Max pixel gap between adjacent samples along a routed curve. Kept well under
   the shortest card side (a card is ≥ TASK_MIN_H = 64 tall, TASK_W = 260 wide)
   so no card can hide entirely between two samples, and each pair of samples is
   tested as a segment (not two points) to close the gap completely. */
const ROUTE_STEP = 24;
const ROUTE_MIN_SEGMENTS = 8;
/* Cap the sample count so a very long edge stays cheap; the segment test keeps
   accuracy even when the cap makes the step coarser than ROUTE_STEP. */
const ROUTE_MAX_SEGMENTS = 128;
/* A little slack around each card so a curve routes with visible clearance,
   not flush against the edge. */
const ROUTE_CLEARANCE = 10;

function cubicAt(t: number, p0: number, c1: number, c2: number, p3: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * p3;
}

/* Does segment a→b touch `rect` inflated by `pad`? Liang–Barsky clipping —
   exact for a straight segment, so a card lying between two curve samples is
   caught, not just one that happens to contain a sample point. */
function segHitsRect(ax: number, ay: number, bx: number, by: number, rect: SchemeRect, pad: number): boolean {
  const minX = rect.x - pad;
  const minY = rect.y - pad;
  const maxX = rect.x + rect.w + pad;
  const maxY = rect.y + rect.h + pad;
  const dx = bx - ax;
  const dy = by - ay;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - minX, maxX - ax, ay - minY, maxY - ay];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i]! < 0) return false; // parallel and outside this slab
    } else {
      const r = q[i]! / p[i]!;
      if (p[i]! < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return t0 <= t1;
}

/**
 * Does the cubic cross any obstacle? The sample count scales with the curve's
 * control-polygon length, so a long edge is walked as finely as a short one —
 * a fixed set of parameter samples skips right past a card sitting near a long
 * edge's endpoint (issue #17). Adjacent samples are tested as a segment, so a
 * card thinner than the step is still caught.
 */
function cubicHitsAny(
  x1: number,
  y1: number,
  c1x: number,
  c1y: number,
  c2x: number,
  c2y: number,
  x2: number,
  y2: number,
  obstacles: readonly SchemeRect[],
): boolean {
  if (!obstacles.length) return false;
  const polyLen = Math.hypot(c1x - x1, c1y - y1) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(x2 - c2x, y2 - c2y);
  const segments = Math.max(ROUTE_MIN_SEGMENTS, Math.min(ROUTE_MAX_SEGMENTS, Math.ceil(polyLen / ROUTE_STEP)));
  let px = x1;
  let py = y1;
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const nx = cubicAt(t, x1, c1x, c2x, x2);
    const ny = cubicAt(t, y1, c1y, c2y, y2);
    for (const rect of obstacles) {
      if (segHitsRect(px, py, nx, ny, rect, ROUTE_CLEARANCE)) return true;
    }
    px = nx;
    py = ny;
  }
  return false;
}

/* Perpendicular spacing between coincident edges fanned into parallel lanes. */
const LANE_BOW = 26;

/* A single cubic bow escapes cards (≤ TASK_W) but not a 600×680 pane; when it
   can't, an orthogonal detour routes around the obstacle's side. The corridor
   sits `DETOUR_MARGIN` past the obstacle edge (> ROUTE_CLEARANCE, so the router
   reads it as clear), and may be pushed a further `DETOUR_MAX_EXTRA` out in
   steps when a second obstacle blocks the first corridor. */
const DETOUR_MARGIN = ROUTE_CLEARANCE + 6;
const DETOUR_MAX_EXTRA = 240;
const DETOUR_EXTRA_STEP = 40;

/* One cubic of a routed path, carrying its own start so a detour can be a chain
   of them. */
interface RouteSeg {
  x1: number;
  y1: number;
  c1x: number;
  c1y: number;
  c2x: number;
  c2y: number;
  x2: number;
  y2: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function segsToD(segs: readonly RouteSeg[]): string {
  const first = segs[0]!;
  let d = `M ${first.x1} ${first.y1}`;
  for (const s of segs) d += ` C ${s.c1x} ${s.c1y}, ${s.c2x} ${s.c2y}, ${s.x2} ${s.y2}`;
  return d;
}

function segsHitAny(segs: readonly RouteSeg[], obstacles: readonly SchemeRect[]): boolean {
  for (const s of segs) {
    if (cubicHitsAny(s.x1, s.y1, s.c1x, s.c1y, s.c2x, s.c2y, s.x2, s.y2, obstacles)) return true;
  }
  return false;
}

/* Badge/mid point: the middle of the centre segment (the corridor run), which is
   the clear, readable part of a detour. */
function segsMid(segs: readonly RouteSeg[]): { x: number; y: number } {
  const s = segs[Math.floor(segs.length / 2)]!;
  return { x: cubicAt(0.5, s.x1, s.c1x, s.c2x, s.x2), y: cubicAt(0.5, s.y1, s.c1y, s.c2y, s.y2) };
}

/* Out to a corridor at x = `X`, down/up it past the box, then in to the target —
   the whole path staying to one side of a box that spans the edge vertically. */
function verticalDetour(edge: { x1: number; y1: number; x2: number; y2: number }, box: SchemeRect, side: number, off: number, laneOff: number): RouteSeg[] {
  const { x1, y1, x2, y2 } = edge;
  const X = (side < 0 ? box.x - off : box.x + box.w + off) + laneOff;
  const ya = box.y - off;
  const yb = box.y + box.h + off;
  const yStart = y1 <= y2 ? ya : yb;
  const yEnd = y1 <= y2 ? yb : ya;
  return [
    { x1, y1, c1x: X, c1y: y1, c2x: X, c2y: yStart, x2: X, y2: yStart },
    { x1: X, y1: yStart, c1x: X, c1y: lerp(yStart, yEnd, 1 / 3), c2x: X, c2y: lerp(yStart, yEnd, 2 / 3), x2: X, y2: yEnd },
    { x1: X, y1: yEnd, c1x: X, c1y: y2, c2x: x2, c2y: y2, x2, y2 },
  ];
}

/* Mirror of {@link verticalDetour} for a box that spans the edge horizontally. */
function horizontalDetour(edge: { x1: number; y1: number; x2: number; y2: number }, box: SchemeRect, side: number, off: number, laneOff: number): RouteSeg[] {
  const { x1, y1, x2, y2 } = edge;
  const Y = (side < 0 ? box.y - off : box.y + box.h + off) + laneOff;
  const xa = box.x - off;
  const xb = box.x + box.w + off;
  const xStart = x1 <= x2 ? xa : xb;
  const xEnd = x1 <= x2 ? xb : xa;
  return [
    { x1, y1, c1x: x1, c1y: Y, c2x: xStart, c2y: Y, x2: xStart, y2: Y },
    { x1: xStart, y1: Y, c1x: lerp(xStart, xEnd, 1 / 3), c1y: Y, c2x: lerp(xStart, xEnd, 2 / 3), c2y: Y, x2: xEnd, y2: Y },
    { x1: xEnd, y1: Y, c1x: x2, c1y: Y, c2x: x2, c2y: y2, x2, y2 },
  ];
}

/**
 * When bowing a single cubic can't clear the obstacles — a production pane is
 * 600×680, far larger than any bow escapes — route an orthogonal detour around
 * the union of the obstacles the straight path crosses. The nearer side is tried
 * first, then the far side, pushing the corridor out in steps; the first path
 * clear of *every* obstacle wins, or null if genuinely boxed in.
 */
function detourRoute(
  edge: { x1: number; y1: number; x2: number; y2: number },
  obstacles: readonly SchemeRect[],
  lane: number,
): TaskEdgeRoute | null {
  const { x1, y1, x2, y2 } = edge;
  const hit = obstacles.filter((r) => segHitsRect(x1, y1, x2, y2, r, ROUTE_CLEARANCE));
  if (!hit.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of hit) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  const box: SchemeRect = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  const vertical = Math.abs(y2 - y1) >= Math.abs(x2 - x1);
  const laneOff = lane * LANE_BOW;
  /* Go around whichever side the endpoints already lean toward — the shorter way. */
  const endMid = vertical ? (x1 + x2) / 2 : (y1 + y2) / 2;
  const boxMid = vertical ? box.x + box.w / 2 : box.y + box.h / 2;
  const sides = endMid <= boxMid ? [-1, 1] : [1, -1];
  for (const side of sides) {
    for (let off = DETOUR_MARGIN; off <= DETOUR_MARGIN + DETOUR_MAX_EXTRA; off += DETOUR_EXTRA_STEP) {
      const segs = vertical ? verticalDetour(edge, box, side, off, laneOff) : horizontalDetour(edge, box, side, off, laneOff);
      if (!segsHitAny(segs, obstacles)) return { d: segsToD(segs), mid: segsMid(segs), crosses: false };
    }
  }
  return null;
}

/**
 * Routes one task edge around unrelated cards and panes (issue #17). The base
 * curve is the same axis-following cubic the layer drew before — vertical
 * handles for a mostly-vertical hop, horizontal for a mostly-horizontal one.
 *
 * `lane` fans coincident edges apart: edges that share endpoints (a task's
 * source and assignment landing on the same session) would otherwise draw as a
 * single overdrawn stroke, so a non-zero lane bows this one's handles onto its
 * own parallel track before any obstacle routing.
 *
 * When the (lane-adjusted) base would run through an obstacle the edge neither
 * starts nor ends on, the handles are bowed perpendicular to the endpoint line
 * in growing steps (both sides) until a clear path is found. If no bow within
 * `ROUTE_MAX_BOW` clears it — a full-size pane is far too big to bow around — an
 * orthogonal detour routes around the obstacle's side instead. Only if even that
 * is boxed in is the base kept with `crosses` set, so the layer can fade it.
 *
 * Pure and deterministic — depends only on the endpoints, the lane, and the
 * obstacle rects.
 */
export function routeTaskEdge(
  edge: { x1: number; y1: number; x2: number; y2: number },
  obstacles: readonly SchemeRect[],
  lane = 0,
): TaskEdgeRoute {
  const { x1, y1, x2, y2 } = edge;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const vertical = Math.abs(dy) > Math.abs(dx);
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  /* Perpendicular to the endpoint line, normalized; a degenerate zero-length
     edge falls back to a horizontal push. */
  const len = Math.hypot(dx, dy) || 1;
  const perpX = -dy / len;
  const perpY = dx / len;
  /* Base handles, matching the original axis-following curve, offset onto this
     edge's lane so coincident edges never coincide. Endpoints stay pinned to
     their card/target, so only the mid of the curve fans out. */
  const laneOff = lane * LANE_BOW;
  const base = vertical
    ? { c1x: x1 + perpX * laneOff, c1y: midY + perpY * laneOff, c2x: x2 + perpX * laneOff, c2y: midY + perpY * laneOff }
    : { c1x: midX + perpX * laneOff, c1y: y1 + perpY * laneOff, c2x: midX + perpX * laneOff, c2y: y2 + perpY * laneOff };

  const build = (h: { c1x: number; c1y: number; c2x: number; c2y: number }): TaskEdgeRoute => ({
    d: `M ${x1} ${y1} C ${h.c1x} ${h.c1y}, ${h.c2x} ${h.c2y}, ${x2} ${y2}`,
    mid: { x: cubicAt(0.5, x1, h.c1x, h.c2x, x2), y: cubicAt(0.5, y1, h.c1y, h.c2y, y2) },
    crosses: false,
  });

  if (!obstacles.length || !cubicHitsAny(x1, y1, base.c1x, base.c1y, base.c2x, base.c2y, x2, y2, obstacles)) {
    return build(base);
  }

  for (let bow = ROUTE_BOW_STEP; bow <= ROUTE_MAX_BOW; bow += ROUTE_BOW_STEP) {
    for (const sign of [1, -1]) {
      const off = bow * sign;
      const handles = {
        c1x: base.c1x + perpX * off,
        c1y: base.c1y + perpY * off,
        c2x: base.c2x + perpX * off,
        c2y: base.c2y + perpY * off,
      };
      if (!cubicHitsAny(x1, y1, handles.c1x, handles.c1y, handles.c2x, handles.c2y, x2, y2, obstacles)) {
        return build(handles);
      }
    }
  }

  /* No bow cleared it — a pane is too large to escape with a single cubic. Route
     an orthogonal detour around it; only if that is boxed in do we admit the
     crossing and let the layer fade the base curve. */
  const detour = detourRoute(edge, obstacles, lane);
  if (detour) return detour;

  return { ...build(base), crosses: true };
}

/** A task card the edges must not run through, tagged with its owning task so an
    edge is never treated as crossing the very card it starts from. */
export interface TaskEdgeObstacle extends SchemeRect {
  id: string;
}

function rectOwnsEndpoint(rect: SchemeRect, edge: Pick<TaskEdgeGeom, "x1" | "y1" | "x2" | "y2">): boolean {
  const inside = (x: number, y: number) => x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
  return inside(edge.x1, edge.y1) || inside(edge.x2, edge.y2);
}

/**
 * The obstacle set one task edge must route around (issue #17): every other task
 * card plus every visible container (panes, decks, quiet stacks, drafts), minus
 * whichever container or card owns an endpoint — the card the edge leaves and
 * the pane/deck/node it arrives on can never be "crossed", and an obstacle the
 * source card sits inside can't be routed around at the start either. Pure, so
 * the router's inputs are unit-testable without a DOM.
 */
export function edgeObstacles(
  edge: Pick<TaskEdgeGeom, "taskId" | "x1" | "y1" | "x2" | "y2">,
  cards: readonly TaskEdgeObstacle[],
  containers: readonly SchemeRect[],
): SchemeRect[] {
  const out: SchemeRect[] = [];
  for (const card of cards) {
    if (card.id !== edge.taskId && !rectOwnsEndpoint(card, edge)) out.push({ x: card.x, y: card.y, w: card.w, h: card.h });
  }
  for (const rect of containers) {
    if (!rectOwnsEndpoint(rect, edge)) out.push({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });
  }
  return out;
}

/**
 * Deterministic lane index per edge so coincident edges never overdraw (issue
 * #17). A task's source and an assignment resolving to the same session produce
 * byte-identical endpoints; grouped by their (rounded) endpoints, the group's
 * first edge by key keeps lane 0 and the rest alternate to either side (+1, −1,
 * +2, …), which {@link routeTaskEdge} turns into parallel bowed tracks. A lone
 * edge is lane 0. Order-independent — grouping and ordering read only edge data.
 */
export function assignEdgeLanes(edges: readonly TaskEdgeGeom[]): Map<string, number> {
  const groups = new Map<string, TaskEdgeGeom[]>();
  for (const edge of edges) {
    const sig = `${Math.round(edge.x1)}:${Math.round(edge.y1)}:${Math.round(edge.x2)}:${Math.round(edge.y2)}`;
    const list = groups.get(sig);
    if (list) list.push(edge);
    else groups.set(sig, [edge]);
  }
  const lanes = new Map<string, number>();
  for (const list of groups.values()) {
    const ordered = [...list].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    ordered.forEach((edge, i) => {
      lanes.set(edge.key, i === 0 ? 0 : i % 2 === 1 ? (i + 1) / 2 : -(i / 2));
    });
  }
  return lanes;
}

function endpointSig(edge: TaskEdgeGeom): string {
  return `${Math.round(edge.x1)}:${Math.round(edge.y1)}:${Math.round(edge.x2)}:${Math.round(edge.y2)}`;
}

type RoutePoint = { x: number; y: number };

/* Sample a routed path (one or several cubics) into a polyline for edge-vs-edge
   crossing tests. */
function sampleRoutePoints(d: string, per = 12): RoutePoint[] {
  const n = d.replace(/[MC,]/g, " ").trim().split(/\s+/).map(Number);
  const pts: RoutePoint[] = [{ x: n[0]!, y: n[1]! }];
  let x0 = n[0]!;
  let y0 = n[1]!;
  for (let i = 2; i + 6 <= n.length; i += 6) {
    const c1x = n[i]!;
    const c1y = n[i + 1]!;
    const c2x = n[i + 2]!;
    const c2y = n[i + 3]!;
    const x2 = n[i + 4]!;
    const y2 = n[i + 5]!;
    for (let k = 1; k <= per; k++) {
      const t = k / per;
      pts.push({ x: cubicAt(t, x0, c1x, c2x, x2), y: cubicAt(t, y0, c1y, c2y, y2) });
    }
    x0 = x2;
    y0 = y2;
  }
  return pts;
}

/* Parametric intersection of segments a–b and c–d, or null when they miss or are
   parallel. Inclusive of the segment ends, so a crossing that lands exactly on a
   shared sample vertex (two box diagonals meeting dead-centre) is still found —
   the degenerate case a strict orientation test silently drops. */
function segIntersection(a: RoutePoint, b: RoutePoint, c: RoutePoint, d: RoutePoint): RoutePoint | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (den === 0) return null; // parallel or collinear — never a transversal cross
  const qx = c.x - a.x;
  const qy = c.y - a.y;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a.x + t * rx, y: a.y + t * ry };
}

/* A crossing within this many px of a point the two edges legitimately share
   (a fan-in/out endpoint) is not a tangle — ignore it. */
const SHARED_ENDPOINT_EPS = 2;

/* The endpoints two edges have in common: fan-in edges meeting at one target, or
   fan-out edges leaving one card, touch there by design and must not be read as
   crossing. */
function sharedEndpoints(a: TaskEdgeGeom, b: TaskEdgeGeom): RoutePoint[] {
  const ends = (e: TaskEdgeGeom): RoutePoint[] => [
    { x: e.x1, y: e.y1 },
    { x: e.x2, y: e.y2 },
  ];
  const out: RoutePoint[] = [];
  for (const p of ends(a)) {
    for (const q of ends(b)) {
      if (Math.round(p.x) === Math.round(q.x) && Math.round(p.y) === Math.round(q.y)) out.push(p);
    }
  }
  return out;
}

/* Do two routed polylines cross anywhere other than a point they legitimately
   share? Robust to the crossing landing exactly on a sample vertex. */
function routesCross(a: readonly RoutePoint[], b: readonly RoutePoint[], shared: readonly RoutePoint[]): boolean {
  for (let i = 0; i + 1 < a.length; i++) {
    for (let j = 0; j + 1 < b.length; j++) {
      const p = segIntersection(a[i]!, a[i + 1]!, b[j]!, b[j + 1]!);
      if (!p) continue;
      if (shared.some((s) => Math.abs(s.x - p.x) <= SHARED_ENDPOINT_EPS && Math.abs(s.y - p.y) <= SHARED_ENDPOINT_EPS)) continue;
      return true;
    }
  }
  return false;
}

/* Extra perpendicular bows a crossing edge may try, on top of its lane, to slip
   past another edge. Bounded so the pass is cheap and always terminates. */
const CROSS_BOWS = [1, -1, 2, -2, 3, -3];
const CROSS_PASSES = 2;

/**
 * Routes every task edge together (issue #17): lanes fan coincident edges apart
 * (see {@link assignEdgeLanes}), each edge routes around cards and panes (see
 * {@link edgeObstacles} / {@link routeTaskEdge}), and a bounded, deterministic
 * pass then reduces edge-to-edge crossings. For each lone edge still crossing
 * another, it tries a few extra perpendicular bows and keeps whichever crosses
 * the *fewest* other edges without re-entering an obstacle. Coincident edges are
 * left on their assigned lanes so the pass never collapses a fanned pair.
 *
 * Any crossing that survives the pass — the diagonals of a box interleave, so no
 * bounded planar route separates them — is not left silent: of each still-crossing
 * pair the higher-key edge is marked `crosses`, so the layer fades it and it reads
 * as passing *behind* the other rather than tangling with it.
 *
 * Pure and order-independent: the crossing test is symmetric, the pass walks
 * edges in key order, and the fade always picks the higher key, so the result is
 * identical for any input ordering.
 */
export function routeTaskEdges(
  edges: readonly TaskEdgeGeom[],
  cards: readonly TaskEdgeObstacle[],
  containers: readonly SchemeRect[],
): Map<string, TaskEdgeRoute> {
  const lanes = assignEdgeLanes(edges);
  const sigCount = new Map<string, number>();
  for (const edge of edges) sigCount.set(endpointSig(edge), (sigCount.get(endpointSig(edge)) ?? 0) + 1);

  const byKey = new Map<string, TaskEdgeGeom>(edges.map((edge) => [edge.key, edge]));
  const state = new Map<string, { route: TaskEdgeRoute; pts: RoutePoint[] }>();
  for (const edge of edges) {
    const route = routeTaskEdge(edge, edgeObstacles(edge, cards, containers), lanes.get(edge.key) ?? 0);
    state.set(edge.key, { route, pts: sampleRoutePoints(route.d) });
  }

  /* How many *other* edges this route tangles with — a boolean per pair, robust
     to the exact crossing point, so a symmetric dead-centre crossing counts. */
  const crossingsAgainstOthers = (key: string, pts: readonly RoutePoint[]): number => {
    const edge = byKey.get(key)!;
    let total = 0;
    for (const [otherKey, other] of state) {
      if (otherKey === key) continue;
      if (routesCross(pts, other.pts, sharedEndpoints(edge, byKey.get(otherKey)!))) total++;
    }
    return total;
  };

  const order = [...edges].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (let pass = 0; pass < CROSS_PASSES; pass++) {
    let improved = false;
    for (const edge of order) {
      /* Never perturb a coincident edge — its lane is what keeps a fanned pair
         from overdrawing, and parallel tracks never register as crossing. */
      if ((sigCount.get(endpointSig(edge)) ?? 0) > 1) continue;
      const current = state.get(edge.key)!;
      let bestCrossings = crossingsAgainstOthers(edge.key, current.pts);
      if (bestCrossings === 0) continue;
      const obstacles = edgeObstacles(edge, cards, containers);
      const laneBase = lanes.get(edge.key) ?? 0;
      let best = current;
      /* Obstacle clearance outranks edge-crossing count: a route that clears
         every card and pane (`crosses === false`) is never traded for one that
         re-enters a container just to untangle edges. Selection is lexicographic
         on (obstacle-crossing?, edge-crossings). */
      let bestObstacle = current.route.crosses ? 1 : 0;
      for (const bow of CROSS_BOWS) {
        const route = routeTaskEdge(edge, obstacles, laneBase + bow);
        const candObstacle = route.crosses ? 1 : 0;
        if (candObstacle > bestObstacle) continue; // would re-enter an obstacle — reject
        const pts = sampleRoutePoints(route.d);
        const crossings = crossingsAgainstOthers(edge.key, pts);
        if (candObstacle < bestObstacle || crossings < bestCrossings) {
          best = { route, pts };
          bestObstacle = candObstacle;
          bestCrossings = crossings;
        }
      }
      if (best !== current) {
        state.set(edge.key, best);
        improved = true;
      }
    }
    if (!improved) break;
  }

  /* Fade the residual: for every pair still crossing after the pass, mark the
     higher-key edge so it reads as passing behind — a crossing is never left
     silently solid (issue #17). Deterministic: the pair is symmetric and the
     higher key is a stable choice. */
  const faded = new Set<string>();
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const a = order[i]!;
      const b = order[j]!;
      if (!routesCross(state.get(a.key)!.pts, state.get(b.key)!.pts, sharedEndpoints(a, b))) continue;
      faded.add(a.key < b.key ? b.key : a.key);
    }
  }

  const out = new Map<string, TaskEdgeRoute>();
  for (const [key, value] of state) {
    out.set(key, faded.has(key) && !value.route.crosses ? { ...value.route, crosses: true } : value.route);
  }
  return out;
}
