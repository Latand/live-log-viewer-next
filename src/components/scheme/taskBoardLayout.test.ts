import { expect, test } from "bun:test";
import { projectTaskWorkflows } from "@/components/tasks/taskWorkflowModel";
import type { FileEntry } from "@/lib/types";
import { layoutTaskBoard, legalTaskDrop, overlaps } from "./taskBoardLayout";
import type { SchemeLayout } from "./layout";
import { displayedTaskHeight, edgeObstacles, type PlacedTask } from "./taskGeometry";
import { createVisibilityIndex } from "./visibilityIndex";

function fixture(count: number) {
  const files = Array.from({ length: count }, (_, i) => ({ path: `/fixture/worker-${i}`, conversationId: `conversation_fixture_${i}`, title: `Worker ${i}`, project: "fixture", root: "codex-sessions", kind: "session", fmt: "codex", engine: "codex", mtime: 1, size: 100, activity: "live", proc: "running", pid: null, parent: null, model: null, pendingQuestion: null, waitingInput: null, name: `worker-${i}` } as FileEntry));
  const tasks: PlacedTask[] = Array.from({ length: Math.ceil(count / 4) }, (_, i) => ({ id: `task-${i}`, project: "fixture", text: `Task ${i}`, status: "assigned", placement: "auto", pos: { x: i * 300, y: 100 }, assignments: files.slice(i * 4, i * 4 + 4).map(file => ({ path: file.path, conversationId: file.conversationId!, panePid: null, state: "delivered", error: null, at: "2026-01-01T00:00:00Z" })), createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }));
  const nodes = files.map((file, i) => ({ file, x: i * 648, y: 100, w: 600, h: 680, isRoot: true, tasks: [], under: [] }));
  const base: SchemeLayout = { nodes, groups: [], stacks: [], decks: [], drafts: [], slots: [], regionTasks: [], edges: [], links: [], loops: [], byPath: new Map(nodes.map(n => [n.file.path, n])), width: count * 648, height: 880 };
  return { base, tasks, projection: projectTaskWorkflows(tasks, [], [], files) };
}
test("displayed task groups contain children and separate at every semantic boundary", () => {
  const { base, tasks, projection } = fixture(24);
  for (const zoom of [.07, .219, .22, .221, .4, .52, .58, .719, .72, .721, .819, .82, .821, 1]) for (const reader of base.nodes) {
    const scene = layoutTaskBoard(base, tasks, projection, zoom, reader.file.path, new Set());
    for (const group of scene.layout.groups) {
      for (const key of group.members.filter(key => scene.shown.has(key))) {
        const child = scene.layout.byPath.get(key)!;
        expect(child.x).toBeGreaterThanOrEqual(group.x);
        expect(child.y).toBeGreaterThanOrEqual(group.y);
        expect(child.x + child.w).toBeLessThanOrEqual(group.x + group.w + .001);
        expect(child.y + child.h).toBeLessThanOrEqual(group.y + group.h + .001);
      }
    }
    const rectangles = [...scene.shown].map(key => scene.layout.byPath.get(key)!);
    for (let i = 0; i < rectangles.length; i++) for (let j = i + 1; j < rectangles.length; j++) expect(overlaps(rectangles[i], rectangles[j])).toBe(false);
    for (let i = 0; i < scene.layout.groups.length; i++)for (let j = i + 1; j < scene.layout.groups.length; j++)expect(overlaps(scene.layout.groups[i], scene.layout.groups[j])).toBe(false);
  }
});
test("aggregate pins retain their accepted coordinates and expose conflicting legacy pins", () => {
  const { base, tasks, projection } = fixture(24);
  tasks[0] = { ...tasks[0], placement: "pinned", pos: { x: 1720, y: -400 } };
  for (const z of [.07, .22, .58, 1]) {
    const scene = layoutTaskBoard(base, tasks, projection, z, null, new Set());
    expect(scene.tasks[0].pos).toEqual(tasks[0].pos);
  }
  tasks[1] = { ...tasks[1], placement: "pinned", pos: { ...tasks[0].pos } };
  const conflict = layoutTaskBoard(base, tasks, projection, .07, null, new Set());
  expect(conflict.conflicts.length).toBeGreaterThan(0);
  expect(conflict.tasks[0].pos).toEqual(conflict.tasks[1].pos);
});
test("1000 workers across 250 tasks retain all identities; the spatial query reads geometry", () => {
  for (const count of [24, 100, 1000]) {
    const { base, tasks, projection } = fixture(count);
    const scene = layoutTaskBoard(base, tasks, projection, .07, null, new Set());
    expect(projection.tasks.flatMap(task => task.workers).length).toBe(count);
    expect(scene.layout.nodes.length).toBe(count);
    expect(scene.shown.size).toBe(tasks.length);
    const query = createVisibilityIndex([...scene.shown].map(id => ({ id, ...scene.layout.byPath.get(id)! })));
    const first = scene.layout.byPath.get(`task::${tasks[0].id}`)!;
    expect(query(first).has(`task::${tasks[0].id}`)).toBe(true);
    expect(query({ x: -1e6, y: -1e6, w: 100, h: 100 }).size).toBe(0);
  }
});

test("inverse-zoom rounding keeps the target boundary out of its own obstacle set", () => {
  const target={x:790.2439024390244,y:463,w:731,h:829};
  expect(edgeObstacles({taskId:"fixture",x1:317,y1:264,x2:790.2439024390243,y2:598},[],[target])).toEqual([]);
});

test("infeasible native expansion offers the existing full-window reader without shifting pins", () => {
  const {base,tasks,projection}=fixture(8);
  tasks[0]={...tasks[0],placement:"pinned",pos:{x:0,y:0}};
  tasks[1]={...tasks[1],placement:"pinned",pos:{x:1200,y:0}};
  const scene=layoutTaskBoard(base,tasks,projection,1,base.nodes[0].file.path,new Set());
  expect(scene.fallbackReader).toBe(base.nodes[0].file.path);
  expect(scene.tasks.map(task=>task.pos)).toEqual(tasks.map(task=>task.pos));
  expect(scene.conflicts).toEqual([]);
  const requested=scene.tasks[1].pos;
  const accepted=legalTaskDrop(scene.tasks[0],requested,scene.layout.groups,new Set(tasks.map(task=>task.id)));
  expect(accepted).not.toEqual(requested);
  const moved={...scene.layout.groups[0],x:scene.layout.groups[0].x+accepted.x-scene.tasks[0].pos.x,y:scene.layout.groups[0].y+accepted.y-scene.tasks[0].pos.y};
  expect(overlaps(moved,scene.layout.groups[1])).toBe(false);
});

test("one task's thousand assignments retain a bounded summary footprint", () => {
  const {tasks}=fixture(1000);
  const task={...tasks[0],displayScale:1,assignments:tasks.flatMap(task=>task.assignments)};
  expect(task.assignments.length).toBe(1000);
  expect(displayedTaskHeight(task)).toBeLessThan(500);
});
