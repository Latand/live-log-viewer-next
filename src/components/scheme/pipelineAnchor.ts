import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";

import { findFreeSlot } from "./findFreeSlot";
import type { SchemeRect } from "./layout";
import { TASK_W } from "./taskGeometry";

export const PIPELINE_GROUP_GAP = 32;
export const PIPELINE_GROUP_W = 360;
export const PIPELINE_GROUP_COLLAPSED_H = 76;
export const PIPELINE_GROUP_STACK_GAP = 24;

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
): Map<string, SchemeRect> {
  const byAge = [...pipelines].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id.localeCompare(b.id),
  );
  const result = new Map<string, SchemeRect>();
  const occupied: SchemeRect[] = [...obstacles];
  const stackDepth = new Map<string, number>();

  for (const pipeline of byAge) {
    const pinned = (pipeline as PositionedPipeline).pos;
    if (!pinned) continue;
    const rect = { ...pinned, w: PIPELINE_GROUP_W, h: PIPELINE_GROUP_COLLAPSED_H };
    result.set(pipeline.id, rect);
    occupied.push(rect);
  }
  for (const pipeline of byAge) {
    if ((pipeline as PositionedPipeline).pos) continue;
    const anchor = anchorFor(pipeline, tasks, panes);
    const key = `${anchor.x}:${anchor.y}`;
    const depth = stackDepth.get(key) ?? 0;
    stackDepth.set(key, depth + 1);
    const stackedAnchor = { x: anchor.x, y: anchor.y + depth * (PIPELINE_GROUP_COLLAPSED_H + PIPELINE_GROUP_STACK_GAP) };
    const spot = findFreeSlot(stackedAnchor, { w: PIPELINE_GROUP_W, h: PIPELINE_GROUP_COLLAPSED_H }, occupied);
    const rect = { ...spot, w: PIPELINE_GROUP_W, h: PIPELINE_GROUP_COLLAPSED_H };
    result.set(pipeline.id, rect);
    occupied.push(rect);
  }
  return result;
}
