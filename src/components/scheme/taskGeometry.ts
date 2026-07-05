import type { BoardTask, TaskStatus } from "@/lib/tasks/types";

import type { SchemeRect } from "./layout";

export type { SchemeRect } from "./layout";

/* Task card geometry in world pixels (docs/design/sticky-notes.md). */
export const TASK_W = 260;
/** Body height cap; past it the card body scrolls internally. */
export const TASK_BODY_MAX = 340;
const TASK_MIN_H = 64;
/* Estimation metrics for the card body: 12.5px text on 17px lines inside
   12px horizontal padding. The estimate feeds edge anchors and camera
   glides, so a small drift against the DOM height is fine. */
const STRIP_H = 6;
const PAD_Y = 20;
const LINE_H = 17;
const CHARS_PER_LINE = 34;
const CHIP_ROW_H = 26;

/**
 * Estimated on-board height of a task card: status strip + wrapped text
 * (capped at the internal-scroll threshold) + one chip row per assignment.
 */
export function taskCardHeight(task: Pick<BoardTask, "text" | "assignments">): number {
  let lines = 0;
  for (const raw of task.text.split(/\r?\n/)) {
    lines += Math.max(1, Math.ceil(raw.length / CHARS_PER_LINE));
  }
  const bodyH = Math.min(lines * LINE_H, TASK_BODY_MAX) + PAD_Y;
  const chipsH = task.assignments.length ? task.assignments.length * CHIP_ROW_H + 6 : 0;
  return Math.max(TASK_MIN_H, STRIP_H + bodyH + chipsH);
}

/** World-space box of a task card, derived from its owned position. */
export function taskRect(task: Pick<BoardTask, "pos" | "text" | "assignments">): SchemeRect {
  return { x: task.pos.x, y: task.pos.y, w: TASK_W, h: taskCardHeight(task) };
}

export function rectCenter(rect: SchemeRect): { x: number; y: number } {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
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
  /** Assignment transcript path — the retry handle for failed edges. */
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
    for (const assignment of task.assignments) {
      if (!assignment.path) continue;
      const target = index.get(assignment.path);
      if (!target) continue;
      const from = rectAnchor(card, rectCenter(target));
      const to = rectAnchor(target, cardCenter);
      edges.push({
        key: task.id + "::" + assignment.path,
        taskId: task.id,
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
