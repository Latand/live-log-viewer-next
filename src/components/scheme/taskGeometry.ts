import { reviewerBindingTargetsForRound } from "@/components/flows/flowModel";
import type { Flow, Round } from "@/lib/flows/types";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import type { SchemeRect } from "./layout";

export type { SchemeRect } from "./layout";

/** A task that owns a board position — `unplaced` tasks are filtered out before
    any geometry runs, so every card the board draws is a `PlacedTask`. */
export type PlacedTask = BoardTask & { pos: { x: number; y: number } };

/** True for tasks the board should render (pinned with a usable position). */
export function isPlacedTask(task: BoardTask): task is PlacedTask {
  return task.placement !== "unplaced" && task.pos !== undefined;
}

/* Task card geometry in world pixels (docs/design/sticky-notes.md). */
export const TASK_W = 260;
/** Collapsed text rows rendered by TaskCard's literal Tailwind clamp classes. */
export const TASK_TITLE_CLAMP = 2;
export const TASK_PREVIEW_CLAMP = 3;
/** Disclosure control: h-6 plus the card's 8px bottom padding. */
export const TASK_DISCLOSURE_H = 32;
/** Reserved footprint for the hover/edit action row below the visual card. */
export const TASK_ACTION_ROW_H = 36;
const TASK_MIN_H = 64;
/* Card body geometry: 12.5px text on 17px lines inside 12px (px-3) horizontal
   padding, so the wrap width is TASK_W − 24 = 236px. This estimate must be an
   *upper* bound on the rendered height — underestimating lets a tall card render
   past its computed box and overlap its neighbour (issue #17) — so line count is
   figured against the widest glyphs a proportional bold font produces (W/M run
   ~13px). Real text of the same length wraps to fewer lines, so the estimate is
   conservative for compact clamps and full-text expansion. */
const STRIP_H = 6;
const PAD_Y = 20;
const LINE_H = 17;
const BODY_CONTENT_W = TASK_W - 24;
/* Upper-bound advances at 12.5px bold: the widest glyph (W/M ≈ 11.8, rounded up
   to 13) and a space (≈ 3.4, rounded up to 5). Using widths ≥ the real ones
   makes the wrap simulation a provable upper bound — real narrower glyphs only
   pack more per line, never fewer, so the estimated row count never falls short
   of what Chromium renders. */
const MAX_GLYPH_W = 13;
const MAX_SPACE_W = 5;
/* `whitespace-pre-wrap` preserves tabs and the browser expands each to the next
   tab stop. With no CSS override the default `tab-size` is 8, so one tab advances
   at most 8 space-widths — model it at that ceiling (upper bound, since a tab from
   mid-stop advances less) or a `W\t…` run undercounts its rendered rows. */
const TAB_STOP = 8;
const MAX_TAB_W = TAB_STOP * MAX_SPACE_W;
/* Characters that fit on one full row at the widest glyph — the break-words wrap
   width for an over-long single word. */
const CHARS_PER_LINE = Math.max(1, Math.floor(BODY_CONTENT_W / MAX_GLYPH_W));
/* Rendered chip block is 28m + 4 (each chip h-6 = 24, gap-1 = 4 between rows,
   pb-2 = 8 under the last), so the per-row budget must be the full 24 + 4 gap =
   28; a smaller figure undercounts a tall multi-target stack and eats the
   placement gutter. Paired with CHIP_PAD below (≥ the 8px pb) to stay an upper
   bound for any row count. */
const CHIP_ROW_H = 28;
const CHIP_PAD = 8;

/**
 * Worst-case rendered row count for one hard line under `whitespace-pre-wrap` +
 * `break-words`. Greedy word wrap using the upper-bound advances above: a word
 * that would overflow the current row starts a new one, and a word wider than a
 * whole row breaks at character boundaries. Because the widths are upper bounds,
 * real text packs at least this tightly, so the result never undercounts the
 * rendered rows — closing the word-boundary gap a plain length÷chars estimate
 * misses (twenty wide words wrap to twenty rows, above the char-packed count).
 */
function hardLineRows(line: string): number {
  let rows = 1;
  let used = 0; // px consumed on the current row
  for (const token of line.match(/\s+|\S+/g) ?? []) {
    if (/\s/.test(token)) {
      /* A tab consumes a whole tab stop (up to eight space widths) — count each
         at its upper-bound advance so a tab-laden line keeps its full height. */
      for (const ch of token) used += ch === "\t" ? MAX_TAB_W : MAX_SPACE_W;
      while (used > BODY_CONTENT_W) {
        rows++;
        used -= BODY_CONTENT_W;
      }
      continue;
    }
    const width = token.length * MAX_GLYPH_W;
    if (width <= BODY_CONTENT_W) {
      if (used > 0 && used + width > BODY_CONTENT_W) {
        rows++;
        used = width;
      } else {
        used += width;
      }
    } else {
      /* break-words splits an over-long word across full rows. */
      if (used > 0) rows++;
      const full = Math.ceil(token.length / CHARS_PER_LINE);
      rows += full - 1;
      used = (token.length - (full - 1) * CHARS_PER_LINE) * MAX_GLYPH_W;
    }
  }
  return rows;
}

/** Upper-bound row counts for the title and remaining body text. */
function taskTextRows(text: string): { title: number; rest: number } {
  const lines = text.split(/\r\n?|\n/);
  const title = hardLineRows(lines[0] ?? "");
  let rest = 0;
  for (let index = 1; index < lines.length; index += 1) rest += hardLineRows(lines[index]!);
  return { title, rest };
}

/** Whether compact presentation hides at least one estimated text row. */
export function taskCardExpandable(task: Pick<BoardTask, "text">): boolean {
  const rows = taskTextRows(task.text);
  return rows.title > TASK_TITLE_CLAMP || rows.rest > TASK_PREVIEW_CLAMP;
}

/**
 * Estimated visual height of a task card. Compact cards count the same title
 * and preview rows as TaskCard's line clamps. Expanded cards count the complete
 * durable text and contain no internal scrolling. The wrap model remains a
 * conservative upper bound for placement and camera geometry.
 */
export function taskCardHeight(task: Pick<BoardTask, "text" | "assignments" | "source">, expanded = false): number {
  const rows = taskTextRows(task.text);
  const expandable = rows.title > TASK_TITLE_CLAMP || rows.rest > TASK_PREVIEW_CLAMP;
  const lines = expanded && expandable
    ? rows.title + rows.rest
    : Math.min(rows.title, TASK_TITLE_CLAMP) + Math.min(rows.rest, TASK_PREVIEW_CLAMP);
  const bodyH = lines * LINE_H + PAD_Y;
  const chipRows = task.assignments.length + (task.source ? 1 : 0);
  const chipsH = chipRows ? chipRows * CHIP_ROW_H + CHIP_PAD : 0;
  return Math.max(TASK_MIN_H, STRIP_H + bodyH + chipsH + (expandable ? TASK_DISCLOSURE_H : 0));
}

/** Full DOM footprint used by collision, edges, navigation, and world bounds. */
export function taskBoxHeight(task: Pick<BoardTask, "text" | "assignments" | "source">, expanded = false): number {
  return taskCardHeight(task, expanded) + TASK_ACTION_ROW_H;
}

/** World-space box of a task card, including its action-row reservation. */
export function taskRect(task: Pick<PlacedTask, "pos" | "text" | "assignments" | "source">, expanded = false): SchemeRect {
  return { x: task.pos.x, y: task.pos.y, w: TASK_W, h: taskBoxHeight(task, expanded) };
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
  groups?: ReadonlyArray<SchemeRect & {
    pipeline?: {
      srcPath?: string | null;
      runs: ReadonlyArray<{ stageId: string; attempts: ReadonlyArray<{ agentPath: string | null; flowId?: string | null }> }>;
    } | null;
  }>;
  nodes: ReadonlyArray<SchemeRect & { file: { path: string }; under: ReadonlyArray<{ path: string }> }>;
  stacks: ReadonlyArray<SchemeRect & { items: ReadonlyArray<{ file: { path: string } }> }>;
  decks: ReadonlyArray<SchemeRect & { rounds: ReadonlyArray<{ file: { path: string } | null; round: { reviewerPath: string | null } }> }>;
}

/**
 * Where an assignment path is drawn on the board — the edge-endpoint
 * resolution ladder: a full node rect wins; compact pipeline evidence and a
 * path shown inside a quiet stack, under-deck item, or review-deck round resolve
 * to their container rect. Unknown paths are absent (dead chip, no edge).
 * Containers are inserted first so the later node entries override them.
 */
export function buildTaskTargetIndex(
  layout: TaskTargetSource,
  flows: ReadonlyArray<{
    id: string;
    implementerPath: string;
    rounds: ReadonlyArray<{
      n?: number;
      reviewerPath: string | null;
      reviewerConversationId?: string | null;
    }>;
  }> = [],
  files: readonly FileEntry[] = [],
): Map<string, SchemeRect> {
  const index = new Map<string, SchemeRect>();
  const flowsById = new Map(flows.map((flow) => [flow.id, flow] as const));
  const rectOf = ({ x, y, w, h }: SchemeRect): SchemeRect => ({ x, y, w, h });
  for (const group of layout.groups ?? []) {
    if (!group.pipeline) continue;
    if (group.pipeline.srcPath) index.set(group.pipeline.srcPath, rectOf(group));
    for (const run of group.pipeline.runs) {
      for (const attempt of run.attempts) {
        if (attempt.agentPath) index.set(attempt.agentPath, rectOf(group));
        const flow = attempt.flowId ? flowsById.get(attempt.flowId) : null;
        if (!flow) continue;
        index.set(flow.implementerPath, rectOf(group));
        for (const round of flow.rounds) {
          for (const { path } of reviewerBindingTargetsForRound(flow as Flow, round as Round, files)) {
            index.set(path, rectOf(group));
          }
        }
      }
    }
  }
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
export function buildTaskEdges(
  tasks: readonly PlacedTask[],
  index: ReadonlyMap<string, SchemeRect>,
  expandedIds?: ReadonlySet<string>,
): TaskEdgeGeom[] {
  const edges: TaskEdgeGeom[] = [];
  for (const task of tasks) {
    const card = taskRect(task, expandedIds?.has(task.id) ?? false);
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
/** The straight run of an orthogonal detour (its middle segment): the part that
    superimposes when several detours land on the same track. `axis: "h"` is a
    horizontal corridor at y=`pos` spanning x∈[lo,hi]; `"v"` is vertical at
    x=`pos` spanning y∈[lo,hi]. */
export interface RouteCorridor {
  axis: "h" | "v";
  pos: number;
  lo: number;
  hi: number;
}

export interface TaskEdgeRoute {
  d: string;
  mid: { x: number; y: number };
  /** True when no bow could clear every obstacle — the layer fades the edge so
      an unavoidable crossing at least reads as passing *behind* the card. */
  crosses: boolean;
  /** Present only for a detour: its corridor, for routed-corridor deconfliction. */
  corridor?: RouteCorridor;
}

/* How far a routing bow may push the control handles before giving up, and the
   step it grows by. Symmetric: each magnitude is tried to both sides. */
const ROUTE_MAX_BOW = 260;
const ROUTE_BOW_STEP = 40;
/* Max pixel gap between adjacent samples along a routed curve. Kept well under
   the shortest card side (a card is ≥ TASK_MIN_H = 64 tall, TASK_W = 260 wide)
   so no card can hide entirely between two samples, and each pair of samples is
   tested as a segment to close the gap completely. */
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
   caught even when no sample point lands inside it. */
export function segHitsRect(ax: number, ay: number, bx: number, by: number, rect: SchemeRect, pad: number): boolean {
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
  /* Broad phase: a cubic never leaves the convex hull of its four control points,
     so its bounds are the min/max of those points (plus the clearance pad). An
     obstacle outside that box can't be hit — cull it with cheap number compares
     before the per-segment Liang–Barsky test, so routing one edge scans only the
     handful of cards actually near its path and skips the rest of the board
     (issue #17). */
  const hullMinX = Math.min(x1, c1x, c2x, x2) - ROUTE_CLEARANCE;
  const hullMaxX = Math.max(x1, c1x, c2x, x2) + ROUTE_CLEARANCE;
  const hullMinY = Math.min(y1, c1y, c2y, y2) - ROUTE_CLEARANCE;
  const hullMaxY = Math.max(y1, c1y, c2y, y2) + ROUTE_CLEARANCE;
  const near: SchemeRect[] = [];
  for (const rect of obstacles) {
    if (rect.x <= hullMaxX && rect.x + rect.w >= hullMinX && rect.y <= hullMaxY && rect.y + rect.h >= hullMinY) near.push(rect);
  }
  if (!near.length) return false;
  const polyLen = Math.hypot(c1x - x1, c1y - y1) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(x2 - c2x, y2 - c2y);
  const segments = Math.max(ROUTE_MIN_SEGMENTS, Math.min(ROUTE_MAX_SEGMENTS, Math.ceil(polyLen / ROUTE_STEP)));
  let px = x1;
  let py = y1;
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const nx = cubicAt(t, x1, c1x, c2x, x2);
    const ny = cubicAt(t, y1, c1y, c2y, y2);
    for (const rect of near) {
      if (segHitsRect(px, py, nx, ny, rect, ROUTE_CLEARANCE)) return true;
    }
    px = nx;
    py = ny;
  }
  return false;
}

/* Perpendicular spacing between coincident edges fanned into parallel lanes. */
const LANE_BOW = 26;

/* A single cubic bow escapes a card (≤ TASK_W); a 600×680 pane is far too large
   for any bow, so an orthogonal detour routes around the obstacle's side. The corridor
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
  /* laneOff always stacks *outward* from the box (away from side), so successive
     corridor lanes separate monotonically; the obstacle never pushes a lane back
     and corrects it onto a colliding track. */
  const X = side < 0 ? box.x - off - laneOff : box.x + box.w + off + laneOff;
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
  /* Outward-stacking laneOff — see {@link verticalDetour}. */
  const Y = side < 0 ? box.y - off - laneOff : box.y + box.h + off + laneOff;
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
      if (!segsHitAny(segs, obstacles)) {
        const run = segs[1]!; // middle segment is the corridor
        const corridor: RouteCorridor = vertical
          ? { axis: "v", pos: run.x1, lo: Math.min(run.y1, run.y2), hi: Math.max(run.y1, run.y2) }
          : { axis: "h", pos: run.y1, lo: Math.min(run.x1, run.x2), hi: Math.max(run.x1, run.x2) };
        return { d: segsToD(segs), mid: segsMid(segs), crosses: false, corridor };
      }
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

/* Collinearity tolerances: endpoints within LINE_EPS (px) of the shared line
   count as on it, unit-direction cross within DIR_EPS counts as parallel, and
   the projections must overlap beyond CORRIDOR_MIN (px) so a mere shared
   endpoint (fan-in/out) stays off the shared-corridor list. */
const LINE_EPS = 1.5;
const DIR_EPS = 0.02;
const CORRIDOR_MIN = 8;

/* Perpendicular distance of point (px,py) from the line through (ox,oy) with
   unit direction (ux,uy). */
function perpDist(px: number, py: number, ox: number, oy: number, ux: number, uy: number): number {
  return Math.abs((px - ox) * uy - (py - oy) * ux);
}

/**
 * Do two edges share a collinear corridor — lie on the same line and overlap
 * along it by a visible run? Symmetric in a and b: parallelism is the unit-vector
 * cross against a fixed, length-independent tolerance, collinearity checks each edge's
 * endpoints against *both* lines, and the projection overlap is a 1-D interval
 * length, invariant to which edge or direction is the reference. Direction-
 * agnostic, so a segment and its reverse count; coincident edges are the
 * fully-overlapping case.
 */
function shareCorridor(a: TaskEdgeGeom, b: TaskEdgeGeom): boolean {
  const adx = a.x2 - a.x1;
  const ady = a.y2 - a.y1;
  const alen = Math.hypot(adx, ady);
  const bdx = b.x2 - b.x1;
  const bdy = b.y2 - b.y1;
  const blen = Math.hypot(bdx, bdy);
  if (alen === 0 || blen === 0) return false;
  const aux = adx / alen;
  const auy = ady / alen;
  const bux = bdx / blen;
  const buy = bdy / blen;
  if (Math.abs(aux * buy - auy * bux) > DIR_EPS) return false; // not parallel (symmetric)
  /* Every endpoint near both lines — a symmetric collinearity test. */
  if (perpDist(b.x1, b.y1, a.x1, a.y1, aux, auy) > LINE_EPS) return false;
  if (perpDist(b.x2, b.y2, a.x1, a.y1, aux, auy) > LINE_EPS) return false;
  if (perpDist(a.x1, a.y1, b.x1, b.y1, bux, buy) > LINE_EPS) return false;
  if (perpDist(a.x2, a.y2, b.x1, b.y1, bux, buy) > LINE_EPS) return false;
  /* Overlap of the two 1-D projections onto a's axis (length is orientation- and
     origin-invariant for collinear segments). */
  const proj = (px: number, py: number) => (px - a.x1) * aux + (py - a.y1) * auy;
  const pa0 = Math.min(0, alen);
  const pa1 = Math.max(0, alen);
  const b0 = Math.min(proj(b.x1, b.y1), proj(b.x2, b.y2));
  const b1 = Math.max(proj(b.x1, b.y1), proj(b.x2, b.y2));
  return Math.min(pa1, b1) - Math.max(pa0, b0) > CORRIDOR_MIN;
}

/**
 * Groups of edges that would overdraw one another — each maximal set sharing a
 * collinear corridor (issue #17), coincident edges being the fully-overlapping
 * special case. Union-find over {@link shareCorridor} pairs, so a chain of
 * overlaps lands in one group. Order-independent; every group is key-sorted.
 */
export function corridorGroups(edges: readonly TaskEdgeGeom[]): TaskEdgeGeom[][] {
  const parent = edges.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      if (shareCorridor(edges[i]!, edges[j]!)) parent[find(i)] = find(j);
    }
  }
  const byRoot = new Map<number, TaskEdgeGeom[]>();
  edges.forEach((edge, i) => {
    const root = find(i);
    const list = byRoot.get(root);
    if (list) list.push(edge);
    else byRoot.set(root, [edge]);
  });
  return [...byRoot.values()].map((group) => group.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)));
}

/** Symmetric spread of the i-th group member: first holds track 0, the rest
    alternate to either side (+1, −1, +2, …). */
function laneAt(index: number): number {
  return index === 0 ? 0 : index % 2 === 1 ? (index + 1) / 2 : -(index / 2);
}

/* A corridor's canonical unit direction, independent of any member's stored
   orientation: the dominant axis is forced positive so an edge and its reverse
   yield the same reference. */
function canonicalCorridorDir(edge: TaskEdgeGeom): { x: number; y: number } {
  let dx = edge.x2 - edge.x1;
  let dy = edge.y2 - edge.y1;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const flip = Math.abs(dx) >= Math.abs(dy) ? dx < 0 : dy < 0;
  return flip ? { x: -dx, y: -dy } : { x: dx, y: dy };
}

/* Lane index that renders on a consistent *physical* side of the corridor. The
   bow in routeTaskEdge is perpendicular to the edge's own direction, which flips
   for a reversed edge — so a lane is signed by whether the edge runs with or
   against the canonical direction, cancelling that flip. Without this, a forward
   +1 and a reverse −1 bow to the very same curve (issue #17). */
function corridorLane(edge: TaskEdgeGeom, index: number, canon: { x: number; y: number }): number {
  const dot = (edge.x2 - edge.x1) * canon.x + (edge.y2 - edge.y1) * canon.y;
  return laneAt(index) * (dot >= 0 ? 1 : -1);
}

function assignCorridorLanes(group: readonly TaskEdgeGeom[], lanes: Map<string, number>): void {
  const canon = canonicalCorridorDir(group[0]!);
  group.forEach((edge, i) => lanes.set(edge.key, corridorLane(edge, i, canon)));
}

/**
 * Deterministic lane index per edge so overlapping edges never overdraw (issue
 * #17). Edges sharing a collinear corridor — coincident source/assignment pairs,
 * or partially-overlapping connectors on the same line — are grouped and fanned
 * onto parallel bowed tracks by {@link routeTaskEdge}, each lane oriented against
 * the corridor's canonical direction so mixed-direction edges never collapse onto
 * one curve. A lone edge is lane 0. Order-independent — grouping, canonical
 * direction and lane signs read only edge data.
 */
export function assignEdgeLanes(edges: readonly TaskEdgeGeom[]): Map<string, number> {
  const lanes = new Map<string, number>();
  for (const group of corridorGroups(edges)) assignCorridorLanes(group, lanes);
  return lanes;
}

type RoutePoint = { x: number; y: number };
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

/* Parse a routed path ("M x y (C c1 c2 end)+") into its cubic segments — the
   exact geometry the crossing test recurses on, so accuracy never depends on a
   sampling density (issue #17: a fixed chord budget stepped over crossings on
   very long edges). */
function parseCubics(d: string): RouteSeg[] {
  const n = d.replace(/[MC,]/g, " ").trim().split(/\s+/).map(Number);
  const out: RouteSeg[] = [];
  let x0 = n[0]!;
  let y0 = n[1]!;
  for (let i = 2; i + 6 <= n.length; i += 6) {
    out.push({ x1: x0, y1: y0, c1x: n[i]!, c1y: n[i + 1]!, c2x: n[i + 2]!, c2y: n[i + 3]!, x2: n[i + 4]!, y2: n[i + 5]! });
    x0 = n[i + 4]!;
    y0 = n[i + 5]!;
  }
  return out;
}

/* A cubic stays inside the convex hull of its four control points, so their
   bounding box bounds the curve — the broad phase for both culling and recursion. */
function segBounds(s: RouteSeg): Bounds {
  return {
    minX: Math.min(s.x1, s.c1x, s.c2x, s.x2),
    maxX: Math.max(s.x1, s.c1x, s.c2x, s.x2),
    minY: Math.min(s.y1, s.c1y, s.c2y, s.y2),
    maxY: Math.max(s.y1, s.c1y, s.c2y, s.y2),
  };
}

function cubicsBounds(segs: readonly RouteSeg[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of segs) {
    const b = segBounds(s);
    if (b.minX < minX) minX = b.minX;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  return { minX, minY, maxX, maxY };
}

function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/* A crossing within this many px of a point the two edges legitimately share
   (a fan-in/out endpoint) counts as a designed touch — ignore it. */
const SHARED_ENDPOINT_EPS = 2;

/* The endpoints two edges have in common: fan-in edges meeting at one target, or
   fan-out edges leaving one card, touch there by design and must stay off the
   crossing list. */
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

/* Below this control-point deviation from its chord (px) a cubic is treated as a
   straight segment, ending recursion. Tight so recursion isolates a shallow
   near-endpoint crossing deeply enough that its tiny sub-chords truly intersect,
   which a coarse chord (or a fixed sampling cap) steps over (issue #17). */
const CUBIC_FLAT_EPS = 0.1;
const CUBIC_MAX_DEPTH = 26;

/* De Casteljau split of a cubic at t = 0.5 into its two halves. */
function splitCubic(s: RouteSeg): [RouteSeg, RouteSeg] {
  const abx = (s.x1 + s.c1x) / 2;
  const aby = (s.y1 + s.c1y) / 2;
  const bcx = (s.c1x + s.c2x) / 2;
  const bcy = (s.c1y + s.c2y) / 2;
  const cdx = (s.c2x + s.x2) / 2;
  const cdy = (s.c2y + s.y2) / 2;
  const abcx = (abx + bcx) / 2;
  const abcy = (aby + bcy) / 2;
  const bcdx = (bcx + cdx) / 2;
  const bcdy = (bcy + cdy) / 2;
  const mx = (abcx + bcdx) / 2;
  const my = (abcy + bcdy) / 2;
  return [
    { x1: s.x1, y1: s.y1, c1x: abx, c1y: aby, c2x: abcx, c2y: abcy, x2: mx, y2: my },
    { x1: mx, y1: my, c1x: bcdx, c1y: bcdy, c2x: cdx, c2y: cdy, x2: s.x2, y2: s.y2 },
  ];
}

function segFlat(s: RouteSeg): boolean {
  const ux = s.x2 - s.x1;
  const uy = s.y2 - s.y1;
  const len = Math.hypot(ux, uy);
  if (len === 0) return true;
  const d1 = Math.abs((s.c1x - s.x1) * uy - (s.c1y - s.y1) * ux) / len;
  const d2 = Math.abs((s.c2x - s.x1) * uy - (s.c2y - s.y1) * ux) / len;
  return d1 <= CUBIC_FLAT_EPS && d2 <= CUBIC_FLAT_EPS;
}

/* Proper intersection of segments a1–a2 and b1–b2 (t and u both in [0,1]), or
   null. Inclusive of the ends so a crossing on a shared vertex is still found. */
function segIntersection(a1: RoutePoint, a2: RoutePoint, b1: RoutePoint, b2: RoutePoint): RoutePoint | null {
  const rx = a2.x - a1.x;
  const ry = a2.y - a1.y;
  const sx = b2.x - b1.x;
  const sy = b2.y - b1.y;
  const den = rx * sy - ry * sx;
  if (den === 0) return null; // parallel or collinear — never a transversal cross
  const qx = b1.x - a1.x;
  const qy = b1.y - a1.y;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a1.x + t * rx, y: a1.y + t * ry };
}

/* Recursive cubic–cubic crossing: cull by control-hull bounds, split the curvy
   side(s) until both are flat, then a chord intersection test. Exact regardless
   of length — no sampling cap to step over a crossing — and cheap because a
   far-apart pair is rejected at its first disjoint hull and a gentle curve
   flattens within a few splits. Collinear overlap (a shared corridor) gives a
   parallel chord test and no false crossing. A crossing within `SHARED_ENDPOINT_EPS`
   of a point the edges legitimately share (a fan-in/out endpoint) is ignored. */
function cubicPairCross(a: RouteSeg, b: RouteSeg, shared: readonly RoutePoint[], depth: number): boolean {
  if (!boundsOverlap(segBounds(a), segBounds(b))) return false;
  const flatA = segFlat(a);
  const flatB = segFlat(b);
  if ((flatA && flatB) || depth <= 0) {
    const p = segIntersection({ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }, { x: b.x1, y: b.y1 }, { x: b.x2, y: b.y2 });
    if (!p) return false;
    return !shared.some((s) => Math.abs(s.x - p.x) <= SHARED_ENDPOINT_EPS && Math.abs(s.y - p.y) <= SHARED_ENDPOINT_EPS);
  }
  const as = flatA ? [a] : splitCubic(a);
  const bs = flatB ? [b] : splitCubic(b);
  for (const sa of as) {
    for (const sb of bs) {
      if (cubicPairCross(sa, sb, shared, depth - 1)) return true;
    }
  }
  return false;
}

/* Do two routed paths cross anywhere other than a point they legitimately share? */
function routesCross(a: readonly RouteSeg[], b: readonly RouteSeg[], shared: readonly RoutePoint[]): boolean {
  for (const sa of a) {
    for (const sb of b) {
      if (cubicPairCross(sa, sb, shared, CUBIC_MAX_DEPTH)) return true;
    }
  }
  return false;
}

/* Lane steps a routed-corridor mate tries — growing outward from the box (the
   detour stacks laneOff away from the obstacle) — until its corridor clears the
   ones already placed. Bounded so placement always terminates; a member that
   can't clear keeps its last try. */
/* Corridor-lane search bound. A step is one LANE_BOW further out, so with N
   corridors already placed a free lane exists within N+1 steps (pigeonhole);
   the search runs up to this many, enough for any realistic fan-out while
   keeping the pass bounded on a pathological all-through-one-pane board. */
const CORRIDOR_LANE_MAX = 48;

/* Extra perpendicular bows a crossing edge may try, on top of its lane, to slip
   past another edge. Bounded so the pass is cheap and always terminates. */
const CROSS_BOWS = [1, -1, 2, -2, 3, -3];
const CROSS_PASSES = 2;
/* The crossing-reduction pass re-routes candidate bows per edge — the pass's real
   cost — so it is skipped above this many edges. Broad-phase culling keeps the
   remaining (cheaper) fade near-linear on a spread board, so even at the 300-task
   ceiling the global routing stays off the render thread's critical path. Below
   the cap, dense boards get full untangling. */
const CROSS_REDUCE_MAX = 48;
/* An edge whose crossing count exceeds this sits in a dense tangle no single
   perpendicular bow can meaningfully untangle, so re-routing it is wasted work —
   the fade handles it. Also caps the per-edge cost in a pathological
   all-overlapping cluster. */
const CROSS_BUSY = 4;

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
 * bounded planar route separates them — is surfaced: of each still-crossing pair
 * the higher-key edge is marked `crosses`, so the layer fades it and it reads
 * as passing *behind* the other, clear of the tangle.
 *
 * Pure and order-independent: the crossing test is symmetric, the pass walks
 * edges in key order, and the fade always picks the higher key, so the result is
 * identical for any input ordering.
 */
/**
 * Stable content key for a {@link routeTaskEdges} call: every input that can move
 * a route — edge keys and (rounded) endpoints, plus each obstacle's box. Polling
 * hands the layer fresh arrays every tick, so the layer memoizes the expensive
 * global routing on this signature and skips the recompute when nothing actually
 * moved (issue #17). Rounded to whole px because the router itself rounds, so a
 * sub-pixel jitter never busts the cache.
 */
export function taskEdgesSignature(
  edges: readonly TaskEdgeGeom[],
  cards: readonly TaskEdgeObstacle[],
  containers: readonly SchemeRect[],
): string {
  const r = Math.round;
  const e = edges.map((x) => `${x.key}:${r(x.x1)},${r(x.y1)},${r(x.x2)},${r(x.y2)}`).join(";");
  const c = cards.map((x) => `${x.id}:${r(x.x)},${r(x.y)},${r(x.w)},${r(x.h)}`).join(";");
  const k = containers.map((x) => `${r(x.x)},${r(x.y)},${r(x.w)},${r(x.h)}`).join(";");
  return `${e}|${c}|${k}`;
}

export function routeTaskEdges(
  edges: readonly TaskEdgeGeom[],
  cards: readonly TaskEdgeObstacle[],
  containers: readonly SchemeRect[],
): Map<string, TaskEdgeRoute> {
  /* Corridor groups drive both the lanes (fan overlapping edges apart) and the
     set of edges the reduction must not perturb — moving a fanned edge off its
     lane would let it overdraw its corridor-mate again. */
  const lanes = new Map<string, number>();
  const corridorMate = new Set<string>();
  for (const group of corridorGroups(edges)) {
    assignCorridorLanes(group, lanes);
    if (group.length > 1) for (const edge of group) corridorMate.add(edge.key);
  }

  const byKey = new Map<string, TaskEdgeGeom>(edges.map((edge) => [edge.key, edge]));
  const state = new Map<string, { route: TaskEdgeRoute; cubics: RouteSeg[]; box: Bounds }>();
  const routeInto = (edge: TaskEdgeGeom, lane: number) => {
    const route = routeTaskEdge(edge, edgeObstacles(edge, cards, containers), lane);
    const cubics = parseCubics(route.d);
    state.set(edge.key, { route, cubics, box: cubicsBounds(cubics) });
  };
  for (const edge of edges) routeInto(edge, lanes.get(edge.key) ?? 0);

  const order = [...edges].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  /* How many *other* edges this route tangles with — a boolean per pair, robust
     to the exact crossing point, so a symmetric dead-centre crossing counts. The
     bounding-box broad phase skips the recursive test for every far-apart edge,
     so the pass stays near-linear on a spread board (issue #17). */
  const crossingsAgainstOthers = (key: string, cubics: readonly RouteSeg[], box: Bounds): number => {
    const edge = byKey.get(key)!;
    let total = 0;
    for (const [otherKey, other] of state) {
      if (otherKey === key || !boundsOverlap(box, other.box)) continue;
      if (routesCross(cubics, other.cubics, sharedEndpoints(edge, byKey.get(otherKey)!))) total++;
    }
    return total;
  };

  /* The reduction re-routes candidate bows per crossing edge — the pass's real
     cost. Bound it: above the cap, only the cheaper broad-phased fade runs. */
  if (edges.length <= CROSS_REDUCE_MAX) {
    for (let pass = 0; pass < CROSS_PASSES; pass++) {
      let improved = false;
      for (const edge of order) {
        /* Never perturb a corridor-mate — its lane is what keeps a fanned pair
           from overdrawing, and parallel tracks never register as crossing. */
        if (corridorMate.has(edge.key)) continue;
        const current = state.get(edge.key)!;
        let bestCrossings = crossingsAgainstOthers(edge.key, current.cubics, current.box);
        if (bestCrossings === 0 || bestCrossings > CROSS_BUSY) continue;
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
          const cubics = parseCubics(route.d);
          const box = cubicsBounds(cubics);
          const crossings = crossingsAgainstOthers(edge.key, cubics, box);
          if (candObstacle < bestObstacle || crossings < bestCrossings) {
            best = { route, cubics, box };
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
  }

  /* Detours superimpose even when the source edges don't share a corridor:
     several fan-out edges forced around one pane land on the *same* routed
     corridor and compound into an opaque rail (issue #17). Run last, after the
     reduction has settled, so it has the final say: walk edges in key order on
     their exact corridors (the detour's straight middle run), and when one sits
     within a lane of an already-placed corridor on the same axis and overlaps its
     extent, step its lane out until it clears. It runs on every board — a busy
     board is exactly where fan-out rails form — and stays cheap because only the
     (usually few) detoured edges are compared, and only a clashing one re-routes.
     Deterministic and bounded. */
  {
    const placed: RouteCorridor[] = [];
    const clashes = (c: RouteCorridor): boolean =>
      placed.some((p) => p.axis === c.axis && Math.abs(p.pos - c.pos) < LANE_BOW - 1 && Math.min(p.hi, c.hi) > Math.max(p.lo, c.lo));
    for (const edge of order) {
      let corridor = state.get(edge.key)!.route.corridor;
      if (corridor && clashes(corridor)) {
        const laneBase = lanes.get(edge.key) ?? 0;
        const obstacles = edgeObstacles(edge, cards, containers);
        /* Keep stepping the lane outward until the route clears the corridors
           already placed — the fixed ten-lane list left a dense fan-out reusing
           occupied rails (issue #17). Accept the first obstacle-clear route that
           either lands on a free corridor or has bowed far enough to leave the
           corridor entirely (no rail to share); the outward stack guarantees one
           within a lane per placed corridor. Bounded by CORRIDOR_LANE_MAX. */
        for (let step = 1; step <= CORRIDOR_LANE_MAX; step++) {
          const route = routeTaskEdge(edge, obstacles, laneBase + step);
          if (!route.crosses && (!route.corridor || !clashes(route.corridor))) {
            const cubics = parseCubics(route.d);
            state.set(edge.key, { route, cubics, box: cubicsBounds(cubics) });
            corridor = route.corridor;
            break;
          }
        }
      }
      if (corridor) placed.push(corridor);
    }
  }

  /* Fade the residual: for every pair still crossing after the pass, mark the
     higher-key edge so it reads as passing behind — a crossing is never left
     silently solid (issue #17). Broad-phased, and deterministic: the pair is
     symmetric and the higher key is a stable choice. */
  const faded = new Set<string>();
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const a = order[i]!;
      const b = order[j]!;
      const sa = state.get(a.key)!;
      const sb = state.get(b.key)!;
      if (!boundsOverlap(sa.box, sb.box)) continue;
      if (!routesCross(sa.cubics, sb.cubics, sharedEndpoints(a, b))) continue;
      faded.add(a.key < b.key ? b.key : a.key);
    }
  }

  const out = new Map<string, TaskEdgeRoute>();
  for (const [key, value] of state) {
    out.set(key, faded.has(key) && !value.route.crosses ? { ...value.route, crosses: true } : value.route);
  }
  return out;
}

/* Pad around a route's control-point hull covering the endpoint dot and the
   retry-badge disc so neither is clipped at the world edge. */
const ROUTE_MARKER_PAD = 14;

/**
 * Union bounding box of every routed edge path and its markers (issue #17). The
 * world box must include this: a valid obstacle detour can swing a connector — or
 * its retry badge — past the card/layout extent, and the task-edge SVG, camera
 * clamp and minimap all read the world box, so anything outside it is clipped and
 * unreachable. The cubic control points bound the curve (convex-hull property),
 * and `mid` is where the badge sits. Null when there are no edges.
 */
export function routePathsBounds(routes: Iterable<TaskEdgeRoute>): SchemeRect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  const grow = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const route of routes) {
    any = true;
    const n = route.d.replace(/[MC,]/g, " ").trim().split(/\s+/).map(Number);
    for (let i = 0; i + 1 < n.length; i += 2) grow(n[i]!, n[i + 1]!);
    grow(route.mid.x, route.mid.y);
  }
  if (!any) return null;
  return { x: minX - ROUTE_MARKER_PAD, y: minY - ROUTE_MARKER_PAD, w: maxX - minX + 2 * ROUTE_MARKER_PAD, h: maxY - minY + 2 * ROUTE_MARKER_PAD };
}
