import { describe, expect, test } from "bun:test";

import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";

import { TASK_W } from "./taskGeometry";
import {
  PIPELINE_GROUP_COLLAPSED_H,
  PIPELINE_GROUP_EXPANDED_H,
  PIPELINE_GROUP_GAP,
  PIPELINE_GROUP_STACK_GAP,
  PIPELINE_GROUP_W,
  anchorFor,
  layoutPipelineGroups,
} from "./pipelineAnchor";

function pipeline(overrides: Record<string, unknown> = {}): Pipeline {
  return {
    id: "pipeline-a",
    task: "Ship the board groups",
    project: "viewer",
    repoDir: "/repo",
    worktreeDir: "/repo-pipeline-a",
    branch: "pipeline/a",
    baseBranch: "main",
    baseRef: "abc",
    lastPassedCommit: "abc",
    stages: [],
    runs: [],
    cursor: null,
    state: "draft",
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    closedAt: null,
    ...overrides,
  } as Pipeline;
}

function task(id: string, pos?: { x: number; y: number }): BoardTask {
  return {
    id,
    project: "viewer",
    status: "assigned",
    text: id,
    placement: pos ? "pinned" : "unplaced",
    ...(pos ? { pos } : {}),
    assignments: [],
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
}

describe("anchorFor", () => {
  test("anchors beside the first placed task named by taskIds", () => {
    const linked = task("task-2", { x: 420, y: 180 });
    const result = anchorFor(
      pipeline({ taskIds: ["task-2", "task-1"] }),
      [task("task-1", { x: 20, y: 40 }), linked],
      [],
    );

    expect(result).toEqual({ x: linked.pos!.x + TASK_W + PIPELINE_GROUP_GAP, y: linked.pos!.y });
  });

  test("uses the first placed task whose assignment belongs to pipeline lineage", () => {
    const linked = {
      ...task("manual-link", { x: 760, y: 240 }),
      assignments: [{ path: "/stage.jsonl", panePid: 12, state: "handoff" as const, error: null, at: "2026-07-19T00:00:00.000Z" }],
    };
    const result = anchorFor(
      pipeline({
        stages: [{ id: "build", kind: "run", prompt: "", next: null }],
        runs: [{ stageId: "build", attempts: [{ n: 1, state: "running", agentPath: "/stage.jsonl", conversationId: "conversation-stage" }] }],
      }),
      [linked],
      [],
    );

    expect(result).toEqual({ x: linked.pos!.x + TASK_W + PIPELINE_GROUP_GAP, y: linked.pos!.y });
  });

  test("falls back to the centroid of placed stage conversation panes", () => {
    const result = anchorFor(
      pipeline({
        stages: [{ id: "build", kind: "run", prompt: "", next: null }],
        runs: [{ stageId: "build", attempts: [{ n: 1, state: "running", agentPath: "/stage.jsonl", conversationId: "conversation-stage" }] }],
      }),
      [task("unplaced-link")],
      [
        { x: 100, y: 120, w: 600, h: 420, path: "/stage.jsonl", conversationId: "conversation-stage" },
        { x: 900, y: 120, w: 600, h: 420, path: "/unrelated.jsonl", conversationId: "other" },
      ],
    );

    expect(result).toEqual({ x: 400, y: 330 });
  });

  test("an unplaced first taskId falls through to the conversation centroid", () => {
    const result = anchorFor(
      pipeline({
        taskIds: ["unplaced", "placed"],
        runs: [{ stageId: "build", attempts: [{ agentPath: "/stage.jsonl" }] }],
      }),
      [task("unplaced"), task("placed", { x: 900, y: 100 })],
      [{ x: 100, y: 120, w: 600, h: 420, path: "/stage.jsonl" }],
    );

    expect(result).toEqual({ x: 400, y: 330 });
  });

  test("uses a deterministic grid to the right of occupied board space", () => {
    const panes = [{ x: 100, y: 120, w: 600, h: 420, path: "/other.jsonl" }];
    const tasks = [task("placed", { x: 840, y: 90 })];

    const first = anchorFor(pipeline({ id: "grid-pipeline" }), tasks, panes);
    const repeated = anchorFor(pipeline({ id: "grid-pipeline" }), [...tasks].reverse(), [...panes].reverse());

    expect(first).toEqual(repeated);
    expect(first.x).toBeGreaterThan(840 + TASK_W);
    expect(first.y).toBeGreaterThanOrEqual(120);
  });
});

describe("layoutPipelineGroups", () => {
  test("stacks pipelines linked to one task with obstacle clearance", () => {
    const linked = task("task-1", { x: 420, y: 180 });
    const rows = [
      pipeline({ id: "pipeline-a", taskIds: [linked.id] }),
      pipeline({ id: "pipeline-b", taskIds: [linked.id], createdAt: "2026-07-19T00:01:00.000Z" }),
    ];
    const taskRect = { x: linked.pos!.x, y: linked.pos!.y, w: TASK_W, h: 180 };

    const layout = layoutPipelineGroups(rows, [linked], [], [taskRect]);
    const a = layout.get("pipeline-a")!;
    const b = layout.get("pipeline-b")!;

    expect(a.x).toBeGreaterThanOrEqual(taskRect.x + taskRect.w + PIPELINE_GROUP_GAP);
    expect(b.x).toBe(a.x);
    expect(b.y).toBeGreaterThan(a.y);
    expect(a.x + PIPELINE_GROUP_W <= b.x || b.x + PIPELINE_GROUP_W <= a.x || a.y + PIPELINE_GROUP_COLLAPSED_H <= b.y || b.y + PIPELINE_GROUP_COLLAPSED_H <= a.y).toBe(true);
  });

  test("keeps a durable pipeline position exact across obstacle changes", () => {
    const pinned = pipeline({ id: "pinned", pos: { x: 1337, y: 512 } });
    const first = layoutPipelineGroups([pinned], [], [], []).get(pinned.id);
    const crowded = layoutPipelineGroups([pinned], [], [], [{ x: 1300, y: 480, w: 500, h: 300 }]).get(pinned.id);

    expect(first).toMatchObject({ x: 1337, y: 512 });
    expect(crowded).toMatchObject({ x: 1337, y: 512 });
  });

  test("an expanded group reserves its full height before the next linked group", () => {
    const linked = task("task-expanded", { x: 420, y: 180 });
    const rows = [
      pipeline({ id: "expanded", taskIds: [linked.id] }),
      pipeline({ id: "next", taskIds: [linked.id], createdAt: "2026-07-19T00:01:00.000Z" }),
    ];
    const layout = layoutPipelineGroups(
      rows,
      [linked],
      [],
      [{ x: linked.pos!.x, y: linked.pos!.y, w: TASK_W, h: 180 }],
      new Map([["expanded", PIPELINE_GROUP_EXPANDED_H]]),
    );
    const expanded = layout.get("expanded")!;
    const next = layout.get("next")!;

    expect(expanded.h).toBe(PIPELINE_GROUP_EXPANDED_H);
    expect(next.y).toBeGreaterThanOrEqual(expanded.y + expanded.h + PIPELINE_GROUP_STACK_GAP);
  });
});
