import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";

import { findFreeSlot, OB_GUTTER, RING_MAX, SLOT_Q } from "./findFreeSlot";
import type { SchemeRect } from "./layout";
import { TASK_W } from "./taskGeometry";

export const PIPELINE_GROUP_GAP = 32;
export const PIPELINE_GROUP_W = 360;
export const PIPELINE_GROUP_COLLAPSED_H = 76;
/** Expanded groups reserve a bounded world-space surface; their body scrolls within it. */
export const PIPELINE_GROUP_EXPANDED_H = 520;
export const PIPELINE_GROUP_STACK_GAP = 24;
export const PIPELINE_GROUP_BODY_H = PIPELINE_GROUP_EXPANDED_H - PIPELINE_GROUP_COLLAPSED_H;

const FREE_GRID_COLUMNS = 4;
const FREE_GRID_X_GAP = 24;
const FREE_GRID_Y_GAP = 24;

function stableHash(value: string): number {
  let hash = 2166136261;
  for (const ch of value) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export interface PipelinePane {
  x: number;
  y: number;
  w: number;
  h: number;
  path: string;
  conversationId?: string | null;
}

export type PipelineGroupDirection = "collapsed" | "down" | "up" | "right" | "left" | "free";

export interface PipelineGroupPlacement extends SchemeRect {
  /** Durable or automatic collapsed-header coordinates. */
  header: SchemeRect;
  /** Session-only expanded surface. */
  body: SchemeRect | null;
  /** Camera, minimap, and descendant-context extent. */
  bounds: SchemeRect;
  direction: PipelineGroupDirection;
}

type PipelineWithTaskIds = Pipeline & { taskIds?: readonly string[] };
type PositionedPipeline = Pipeline & { pos?: { x: number; y: number } };

function pipelineLineage(pipeline: Pipeline): { paths: Set<string>; conversationIds: Set<string> } {
  const paths = new Set<string>();
  const conversationIds = new Set<string>();
  if (pipeline.srcPath) paths.add(pipeline.srcPath);
  if (pipeline.srcConversationId) conversationIds.add(pipeline.srcConversationId);
  for (const run of pipeline.runs) {
    for (const attempt of run.attempts) {
      if (attempt.agentPath) paths.add(attempt.agentPath);
      if (attempt.conversationId) conversationIds.add(attempt.conversationId);
    }
  }
  return { paths, conversationIds };
}

/**
 * Every board task linked to a pipeline (#531): the explicit `taskIds` links
 * first, then tasks whose source or assignments point into the pipeline's
 * lineage (src conversation or any stage attempt). One shared definition, so
 * the region layout and the legacy anchor heuristic can never disagree about
 * which sticky notes belong to a pipeline.
 */
export function linkedPipelineTasks(pipeline: Pipeline, tasks: readonly BoardTask[]): BoardTask[] {
  const explicit = new Set((pipeline as PipelineWithTaskIds).taskIds ?? []);
  const lineage = pipelineLineage(pipeline);
  return tasks.filter((task) =>
    explicit.has(task.id) ||
    Boolean(
      (task.source && lineage.paths.has(task.source.path)) ||
      task.assignments.some((assignment) =>
        Boolean(
          (assignment.path && lineage.paths.has(assignment.path)) ||
          (assignment.conversationId && lineage.conversationIds.has(assignment.conversationId)),
        ),
      ),
    ),
  );
}

function manuallyLinkedTask(pipeline: Pipeline, tasks: readonly BoardTask[]): BoardTask | null {
  const lineage = pipelineLineage(pipeline);
  return tasks.find((task) =>
    Boolean(
      (task.source && lineage.paths.has(task.source.path)) ||
      task.assignments.some((assignment) =>
        Boolean(
          (assignment.path && lineage.paths.has(assignment.path)) ||
          (assignment.conversationId && lineage.conversationIds.has(assignment.conversationId)),
        ),
      ),
    ),
  ) ?? null;
}

function rectUnion(rects: readonly SchemeRect[]): SchemeRect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.w));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function clashes(rect: SchemeRect, obstacles: readonly SchemeRect[]): boolean {
  return obstacles.some((obstacle) =>
    rect.x < obstacle.x + obstacle.w + OB_GUTTER
    && rect.x + rect.w + OB_GUTTER > obstacle.x
    && rect.y < obstacle.y + obstacle.h + OB_GUTTER
    && rect.y + rect.h + OB_GUTTER > obstacle.y,
  );
}

function placeExpandedBody(
  header: SchemeRect,
  obstacles: readonly SchemeRect[],
): { body: SchemeRect; direction: Exclude<PipelineGroupDirection, "collapsed"> } {
  const bodySize = { w: PIPELINE_GROUP_W, h: PIPELINE_GROUP_BODY_H };
  const candidate = (direction: Exclude<PipelineGroupDirection, "collapsed" | "free">, distance: number): SchemeRect => {
    if (direction === "down") return { x: header.x, y: header.y + header.h + distance, ...bodySize };
    if (direction === "up") return { x: header.x, y: header.y - bodySize.h - distance, ...bodySize };
    if (direction === "right") return { x: header.x + header.w + distance, y: header.y, ...bodySize };
    return { x: header.x - bodySize.w - distance, y: header.y, ...bodySize };
  };
  const directions = ["down", "up", "right", "left"] as const;
  for (let step = 0; step <= RING_MAX; step += 1) {
    for (const direction of directions) {
      const body = candidate(direction, step * SLOT_Q);
      if (!clashes(body, obstacles)) return { body, direction };
    }
  }
  const anchor = candidate("right", (RING_MAX + 1) * SLOT_Q);
  const free = findFreeSlot(anchor, bodySize, obstacles);
  return { body: { ...free, ...bodySize }, direction: "free" };
}

/** Base world anchor for one pipeline group before obstacle clearance. */
export function anchorFor(
  pipeline: Pipeline,
  tasks: readonly BoardTask[],
  panes: readonly PipelinePane[],
): { x: number; y: number } {
  const taskIds = (pipeline as PipelineWithTaskIds).taskIds ?? [];
  const byId = new Map(tasks.map((task) => [task.id, task] as const));
  const explicitTask = taskIds.map((id) => byId.get(id)).find((task) => task !== undefined) ?? null;
  if (explicitTask?.pos) return { x: explicitTask.pos.x + TASK_W + PIPELINE_GROUP_GAP, y: explicitTask.pos.y };
  const linked = explicitTask ? null : manuallyLinkedTask(pipeline, tasks);
  if (linked?.pos) return { x: linked.pos.x + TASK_W + PIPELINE_GROUP_GAP, y: linked.pos.y };

  const lineage = pipelineLineage(pipeline);
  const stagePanes = panes.filter((pane) =>
    lineage.paths.has(pane.path) || Boolean(pane.conversationId && lineage.conversationIds.has(pane.conversationId)),
  );
  if (stagePanes.length) {
    const sum = stagePanes.reduce(
      (center, pane) => ({ x: center.x + pane.x + pane.w / 2, y: center.y + pane.y + pane.h / 2 }),
      { x: 0, y: 0 },
    );
    return { x: Math.round(sum.x / stagePanes.length), y: Math.round(sum.y / stagePanes.length) };
  }
  const maxRight = Math.max(
    0,
    ...tasks.flatMap((task) => task.pos ? [task.pos.x + TASK_W] : []),
    ...panes.map((pane) => pane.x + pane.w),
  );
  const slot = stableHash(pipeline.id);
  const column = slot % FREE_GRID_COLUMNS;
  const row = Math.floor(slot / FREE_GRID_COLUMNS) % 12;
  return {
    x: Math.ceil((maxRight + 144) / 24) * 24 + column * (PIPELINE_GROUP_W + FREE_GRID_X_GAP),
    y: 120 + row * (PIPELINE_GROUP_COLLAPSED_H + FREE_GRID_Y_GAP),
  };
}

/** Collision-cleared world rects. Durable positions remain exact drag pins. */
export function layoutPipelineGroups(
  pipelines: readonly Pipeline[],
  tasks: readonly BoardTask[],
  panes: readonly PipelinePane[],
  obstacles: readonly SchemeRect[],
  groupHeights: ReadonlyMap<string, number> = new Map(),
): Map<string, PipelineGroupPlacement> {
  const byAge = [...pipelines].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id.localeCompare(b.id),
  );
  const result = new Map<string, PipelineGroupPlacement>();
  const headers = new Map<string, SchemeRect>();
  const occupied: SchemeRect[] = [...obstacles];
  const stackOffset = new Map<string, number>();

  for (const pipeline of byAge) {
    const pinned = (pipeline as PositionedPipeline).pos;
    if (!pinned) continue;
    const header = { ...pinned, w: PIPELINE_GROUP_W, h: PIPELINE_GROUP_COLLAPSED_H };
    headers.set(pipeline.id, header);
    occupied.push(header);
  }
  for (const pipeline of byAge) {
    if ((pipeline as PositionedPipeline).pos) continue;
    const anchor = anchorFor(pipeline, tasks, panes);
    const key = `${anchor.x}:${anchor.y}`;
    const offset = stackOffset.get(key) ?? 0;
    stackOffset.set(key, offset + PIPELINE_GROUP_COLLAPSED_H + PIPELINE_GROUP_STACK_GAP);
    const stackedAnchor = { x: anchor.x, y: anchor.y + offset };
    const spot = findFreeSlot(stackedAnchor, { w: PIPELINE_GROUP_W, h: PIPELINE_GROUP_COLLAPSED_H }, occupied);
    const header = { ...spot, w: PIPELINE_GROUP_W, h: PIPELINE_GROUP_COLLAPSED_H };
    headers.set(pipeline.id, header);
    occupied.push(header);
  }

  const surfaces = [...occupied];
  for (const pipeline of byAge) {
    const header = headers.get(pipeline.id)!;
    const expanded = (groupHeights.get(pipeline.id) ?? PIPELINE_GROUP_COLLAPSED_H) > PIPELINE_GROUP_COLLAPSED_H;
    if (!expanded) {
      result.set(pipeline.id, { ...header, header, body: null, bounds: header, direction: "collapsed" });
      continue;
    }
    const otherSurfaces = surfaces.filter((surface) => surface !== header);
    const { body, direction } = placeExpandedBody(header, otherSurfaces);
    surfaces.push(body);
    const bounds = rectUnion([header, body]);
    result.set(pipeline.id, { ...bounds, header, body, bounds, direction });
  }
  return result;
}
