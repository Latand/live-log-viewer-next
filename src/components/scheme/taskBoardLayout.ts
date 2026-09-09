import type { TaskWorkflowProjection } from "@/components/tasks/taskWorkflowModel";
import { taskTitle } from "@/components/tasks/taskModel";
import { hueFromId } from "./agentLinks";
import type { SchemeGroup, SchemeLayout, SchemeRect } from "./layout";
import { routeTaskEdge, taskRect, type PlacedTask } from "./taskGeometry";

export function overlaps(a: SchemeRect, b: SchemeRect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

/** Preview and commit share the same collision decision. Existing pins are
 * obstacles; automatic neighbours can be placed around the accepted drop. */
export function legalTaskDrop(task: PlacedTask, point: { x: number; y: number }, groups: readonly SchemeGroup[], pinnedIds: ReadonlySet<string>): { x: number; y: number } {
  const own = groups.find(group => group.taskId === task.id);
  if (!own) return point;
  const moving = { ...own, x: own.x + point.x - task.pos.x, y: own.y + point.y - task.pos.y };
  const obstacles = groups.filter(group => group.taskId !== task.id && group.taskId && pinnedIds.has(group.taskId));
  if (!obstacles.some(rect => overlaps(moving, rect, 32))) return point;
  const candidates = obstacles.flatMap(rect => [
    { ...moving, x: rect.x - moving.w - 32 }, { ...moving, x: rect.x + rect.w + 32 },
    { ...moving, y: rect.y - moving.h - 32 }, { ...moving, y: rect.y + rect.h + 32 },
  ]).filter(candidate => !obstacles.some(rect => overlaps(candidate, rect, 31.99)));
  candidates.sort((a, b) => Math.hypot(a.x - moving.x, a.y - moving.y) - Math.hypot(b.x - moving.x, b.y - moving.y));
  const accepted = candidates[0];
  return accepted ? { x: Math.round(point.x + accepted.x - moving.x), y: Math.round(point.y + accepted.y - moving.y) } : task.pos;
}
function union(rects: readonly SchemeRect[], pad: number, heading: number): SchemeRect {
  const x = Math.min(...rects.map(r => r.x)) - pad, y = Math.min(...rects.map(r => r.y)) - heading;
  return { x, y, w: Math.max(...rects.map(r => r.x + r.w)) + pad - x, h: Math.max(...rects.map(r => r.y + r.h)) + pad - y };
}

/** Project recorded task membership onto displayed rectangles. All source
 * records remain in the history projection. Shared workers have one canonical
 * surface, chosen in stable task-id order; other tasks keep their references. */
export interface TaskBoardScene {
  layout: SchemeLayout;
  tasks: PlacedTask[];
  shown: ReadonlySet<string>;
  conflicts: string[][];
  aggregate: boolean;
  fallbackReader?: string;
}
export function layoutTaskBoard(base: SchemeLayout, tasks: readonly PlacedTask[], projection: TaskWorkflowProjection, zoom: number, reader: string | null, expanded: ReadonlySet<string>, options: { allowNative?: boolean; viewportWidth?: number } = {}): TaskBoardScene {
  const { allowNative = true, viewportWidth = 1400 } = options;
  const z = Math.max(.07, zoom), aggregate = z < .22;
  const taskScale = Math.max(1, 1 / z);
  const nodes = base.nodes.map(node => {
    const native = allowNative && !aggregate && (z >= .82 || node.file.path === reader);
    return {
      ...node, presentation: native ? "native" as const : "summary" as const,
      readerScale: 1 / z, w: (native ? 600 : 320) / z, h: (native ? 680 : 160) / z
    };
  });
  const cards = tasks.map(task => ({ ...task, displayScale: taskScale, pos: { ...task.pos } }));
  const byPath = new Map<string, SchemeRect>(nodes.map(node => [node.file.path, node]));
  for (const collection of [base.stacks, base.decks, base.drafts, base.slots]) for (const rect of collection) byPath.set(rect.key, { ...rect });
  for (const task of cards) byPath.set(`task::${task.id}`, taskRect(task, expanded.has(task.id)));
  const claimed = new Set<string>();
  const groups: SchemeGroup[] = [];
  const shown = new Set<string>();
  const taskById = new Map(cards.map(task => [task.id, task]));
  for (const workflow of [...projection.tasks].sort((a, b) => a.task.id.localeCompare(b.task.id))) {
    const task = taskById.get(workflow.task.id);
    if (!task) continue;
    const members = [`task::${task.id}`, ...workflow.workers.map(file => file.path).filter(key => byPath.has(key) && !claimed.has(key))];
    for (const execution of workflow.executions) for (const slot of base.slots) if (slot.pipeline.id === execution.pipeline.id && !claimed.has(slot.key)) members.push(slot.key);
    const unique = [...new Set(members)];
    for (const key of unique) claimed.add(key);
    groups.push({ key: `group::task::${task.id}`, kind: "task", id: task.id, taskId: task.id, hue: hueFromId(task.id), members: unique, label: taskTitle(task.text), x: 0, y: 0, w: 0, h: 0 });
  }
  for (const group of base.groups) {
    const members = group.members.filter(key => byPath.has(key) && !claimed.has(key));
    if (!members.length) continue;
    members.forEach(key => claimed.add(key));
    groups.push({ ...group, members });
  }
  const units: { group: SchemeGroup | null; keys: string[]; locked: boolean }[] = groups.map(group => ({ group, keys: group.members, locked: Boolean(group.taskId && taskById.get(group.taskId)?.placement === "pinned") }));
  for (const key of byPath.keys()) if (!claimed.has(key)) units.push({ group: null, keys: [key], locked: key.startsWith("task::") && taskById.get(key.slice(6))?.placement === "pinned" });
  const occupied: SchemeRect[] = [], conflicts: string[][] = [];
  const positions = new Map<string, SchemeRect>();
  const pad = 32 / z;
  const ordered = units.sort((a, b) => Number(b.locked) - Number(a.locked));
  for (let index = 0; index < ordered.length; index++) {
    const unit = ordered[index], taskKey = unit.keys.find(key => key.startsWith("task::"));
    const pipeline = unit.group?.kind === "pipeline";
    const heading = (pipeline ? 48 : 112) / z;
    const gap = (pipeline ? 144 : 48) / z;
    const keys = aggregate && taskKey ? [taskKey] : unit.keys;
    const outerColumns = aggregate ? Math.max(1, Math.floor(viewportWidth / 508)) : 1;
    const origin = unit.locked && taskKey ? byPath.get(taskKey)! : { x: (index % outerColumns) * 508 / z, y: Math.floor(index / outerColumns) * (aggregate ? 350 : 200) / z };
    const widest = Math.max(...keys.filter(key => key !== taskKey).map(key => byPath.get(key)!.w * z), 320);
    const columns = Math.max(1, Math.min(3, Math.floor((viewportWidth - 64) / (widest + gap * z))));
    let x = origin.x, y = origin.y, rowH = 0, column = 0;
    for (const key of keys) {
      const rect = byPath.get(key)!;
      if (key === taskKey) { rect.x = x; rect.y = y; y += rect.h + heading; continue; }
      if (column === columns) { column = 0; x = origin.x; y += rowH + heading; rowH = 0; }
      rect.x = x; rect.y = y; x += rect.w + gap; rowH = Math.max(rowH, rect.h); column++;
    }
    const envelope = union(keys.map(key => byPath.get(key)!), pad, heading);
    envelope.w = Math.max(envelope.w, 460 / z);
    const initial = { ...envelope };
    if (!unit.locked) {
      for (let pass = 0; pass <= occupied.length; pass++) {
        const collision = occupied.find(rect => overlaps(envelope, rect, 48 / z));
        if (!collision) break;
        envelope.y = collision.y + collision.h + 48 / z;
      }
    } else {
      for (const [key, rect] of positions) if (overlaps(envelope, rect)) conflicts.push([key, unit.group?.key ?? unit.keys[0]]);
    }
    const dx = envelope.x - initial.x, dy = envelope.y - initial.y;
    for (const key of keys) { const rect = byPath.get(key)!; rect.x += dx; rect.y += dy; shown.add(key); }
    if (unit.group) Object.assign(unit.group, envelope);
    occupied.push(envelope); positions.set(unit.group?.key ?? unit.keys[0], envelope);
  }
  for (const card of cards) { const rect = byPath.get(`task::${card.id}`)!; card.pos = { x: rect.x, y: rect.y }; }
  const owner = new Map<string, string>();
  for (const group of groups) for (const key of group.members) owner.set(key, aggregate && group.taskId ? `task::${group.taskId}` : key);
  const anchor = (key: string) => byPath.get(owner.get(key) ?? key);
  const edgeKeys = new Set<string>();
  const edges = base.edges.flatMap(edge => {
    const from = edge.from && anchor(edge.from), to = anchor(edge.to);
    if (!from || !to || from === to) return [];
    const fromKey = owner.get(edge.from!) ?? edge.from!, toKey = owner.get(edge.to) ?? edge.to, key = fromKey + ":" + toKey;
    if (edgeKeys.has(key)) return []; edgeKeys.add(key);
    const ports = { x1: from.x + from.w / 2, y1: from.y + from.h, x2: to.x + to.w / 2, y2: to.y };
    const route = routeTaskEdge(ports, [...shown].filter(key => key !== fromKey && key !== toKey).map(key => byPath.get(key)!));
    return [{ ...edge, from: fromKey, to: toKey, sourceConversationId: undefined, targetConversationId: undefined, ...ports, route: route.d, routeCrosses: route.crosses }];
  });
  const bounds = occupied.length ? union(occupied, 100, 100) : { x: 0, y: 0, w: 1000, h: 800 };
  const layout: SchemeLayout = {
    ...base, nodes, edges, groups, byPath,
    links: base.links.map(link => ({ ...link, from: owner.get(link.from) ?? link.from, to: owner.get(link.to) ?? link.to })).filter(link => link.from !== link.to),
    loops: base.loops.flatMap(loop => { const impl = byPath.get(loop.flow.implementerPath), deck = base.decks.find(deck => deck.flow.id === loop.flow.id); const target = deck ? byPath.get(deck.key) : null; return impl && target && shown.has(loop.flow.implementerPath) && shown.has(deck!.key) ? [{ ...loop, x1: impl.x + impl.w, x2: target.x, y: impl.y }] : []; }),
    stacks: base.stacks.map(rect => ({ ...rect, ...byPath.get(rect.key)! })),
    decks: base.decks.map(rect => ({ ...rect, ...byPath.get(rect.key)! })),
    drafts: base.drafts.map(rect => ({ ...rect, ...byPath.get(rect.key)! })),
    slots: base.slots.map(rect => ({ ...rect, ...byPath.get(rect.key)! })),
    regionTasks: cards.map(card => ({ key: `task::${card.id}`, taskId: card.id, pipelineId: "", ...byPath.get(`task::${card.id}`)! })),
    width: bounds.x + bounds.w, height: bounds.y + bounds.h
};
  if (allowNative && reader && conflicts.length) {
    const readerGroup = groups.find(group => group.members.includes(reader));
    if (readerGroup && conflicts.some(pair => pair.includes(readerGroup.key))) {
      return { ...layoutTaskBoard(base, tasks, projection, zoom, reader, expanded, { ...options, allowNative: false }), fallbackReader: reader };
    }
  }
  return { layout, tasks: cards, shown, conflicts, aggregate };
}
