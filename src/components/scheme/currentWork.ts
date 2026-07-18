import { conversationIdentity, isSupersededRound } from "@/lib/accounts/identity";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { isPlacedTask, taskRect } from "./taskGeometry";
import type { SchemeGroup, SchemeLayout, SchemeRect } from "./layout";

const EMPTY_TEXT_EXPANDED_IDS: ReadonlySet<string> = new Set();

/** Activity signals that deserve the operator's next framing. A terminally
    superseded round (issue #383) short-circuits: even a stale attention
    signal surviving on its transcript tail must not re-frame retired work. */
export function isCurrentWorkFile(file: FileEntry): boolean {
  if (isSupersededRound(file)) return false;
  return (
    file.activity === "live" ||
    file.activity === "stalled" ||
    file.proc === "running" ||
    Boolean(file.pendingQuestion) ||
    Boolean(file.waitingInput)
  );
}

/** Open/restored orchestration containers stay part of current work. */
export function isCurrentWorkGroup(group: SchemeGroup): boolean {
  if (group.pipeline) return group.pipeline.state !== "closed" || Boolean(group.pipeline.restored);
  if (group.flow) return group.flow.state !== "closed" || Boolean(group.flow.restored);
  return false;
}

export function rectUnion(rects: readonly SchemeRect[]): SchemeRect | null {
  if (!rects.length) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.w);
    bottom = Math.max(bottom, rect.y + rect.h);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * Pure geometry for the operator's working set. `tasks` is the full-size board
 * partition, so compact history remains reachable through TaskStacksStrip and
 * does not inflate this frame. No persisted board/task state is changed.
 */
export function currentWorkRect(
  layout: SchemeLayout,
  tasks: readonly BoardTask[],
  favorites: ReadonlySet<string>,
  textExpandedIds: ReadonlySet<string> = EMPTY_TEXT_EXPANDED_IDS,
): SchemeRect | null {
  return rectUnion(currentWorkRects(layout, tasks, favorites, textExpandedIds));
}

/** Individual members, also used for spoken counts and minimap/chip geometry. */
export function currentWorkRects(
  layout: SchemeLayout,
  tasks: readonly BoardTask[],
  favorites: ReadonlySet<string>,
  textExpandedIds: ReadonlySet<string> = EMPTY_TEXT_EXPANDED_IDS,
): SchemeRect[] {
  const rects: SchemeRect[] = [];
  for (const node of layout.nodes) {
    if (isCurrentWorkFile(node.file) || (node.isRoot && favorites.has(conversationIdentity(node.file)))) rects.push(node);
  }
  for (const group of layout.groups) if (isCurrentWorkGroup(group)) rects.push(group);
  rects.push(...layout.drafts);
  for (const task of tasks) {
    if (task.status !== "done" && isPlacedTask(task)) rects.push(taskRect(task, textExpandedIds.has(task.id)));
  }
  return rects;
}
