import { describe, expect, test } from "bun:test";

import type { BoardTask, TaskAssignment } from "@/lib/tasks/types";

import {
  buildTaskEdges,
  buildTaskTargetIndex,
  rectAnchor,
  TASK_BODY_MAX,
  TASK_W,
  taskCardHeight,
  taskRect,
  type TaskTargetSource,
} from "./taskGeometry";

function assignment(overrides: Partial<TaskAssignment>): TaskAssignment {
  return { path: "/a", panePid: null, state: "delivered", error: null, at: "2026-07-05T00:00:00Z", ...overrides };
}

function task(overrides: Partial<BoardTask> & { id: string }): BoardTask & { pos: { x: number; y: number } } {
  return {
    project: "demo",
    status: "assigned",
    text: "title\nbody",
    placement: "pinned",
    pos: { x: 0, y: 0 },
    assignments: [],
    createdAt: "2026-07-05T00:00:00Z",
    updatedAt: "2026-07-05T00:00:00Z",
    ...overrides,
  };
}

const LAYOUT: TaskTargetSource = {
  nodes: [
    { x: 1000, y: 100, w: 600, h: 680, file: { path: "/node" }, under: [{ path: "/under-item" }] },
  ],
  stacks: [{ x: 1700, y: 900, w: 360, h: 120, items: [{ file: { path: "/quiet" } }] }],
  decks: [
    {
      x: 1770,
      y: 100,
      w: 600,
      h: 680,
      rounds: [
        { file: { path: "/reviewer-1" }, round: { reviewerPath: "/reviewer-1" } },
        { file: null, round: { reviewerPath: "/reviewer-2" } },
      ],
    },
  ],
};

describe("buildTaskTargetIndex — the resolution ladder", () => {
  const index = buildTaskTargetIndex(LAYOUT);

  test("full node rect wins", () => {
    expect(index.get("/node")).toEqual({ x: 1000, y: 100, w: 600, h: 680 });
  });

  test("quiet-stack mini-card resolves to the stack rect", () => {
    expect(index.get("/quiet")).toEqual({ x: 1700, y: 900, w: 360, h: 120 });
  });

  test("under-deck item resolves to its host node rect", () => {
    expect(index.get("/under-item")).toEqual({ x: 1000, y: 100, w: 600, h: 680 });
  });

  test("review-deck round resolves to the deck rect, with or without a file", () => {
    expect(index.get("/reviewer-1")).toEqual({ x: 1770, y: 100, w: 600, h: 680 });
    expect(index.get("/reviewer-2")).toEqual({ x: 1770, y: 100, w: 600, h: 680 });
  });

  test("unknown path is absent — no edge, dead chip only", () => {
    expect(index.has("/gone")).toBe(false);
  });

  test("a path drawn both as a node and inside a container resolves to the node", () => {
    const overlapping: TaskTargetSource = {
      nodes: [{ x: 5, y: 5, w: 10, h: 10, file: { path: "/dup" }, under: [] }],
      stacks: [{ x: 900, y: 900, w: 10, h: 10, items: [{ file: { path: "/dup" } }] }],
      decks: [],
    };
    expect(buildTaskTargetIndex(overlapping).get("/dup")).toEqual({ x: 5, y: 5, w: 10, h: 10 });
  });
});

describe("taskRect / taskCardHeight", () => {
  test("card is 260 wide at its owned position", () => {
    const rect = taskRect(task({ id: "t", pos: { x: 40, y: 60 } }));
    expect(rect).toMatchObject({ x: 40, y: 60, w: TASK_W });
  });

  test("height grows with text but the body caps at the scroll threshold", () => {
    const short = taskCardHeight(task({ id: "t", text: "x" }));
    const long = taskCardHeight(task({ id: "t", text: "x".repeat(6000) }));
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThanOrEqual(TASK_BODY_MAX + 40);
  });

  test("assignments add chip rows", () => {
    const bare = taskCardHeight(task({ id: "t" }));
    const chipped = taskCardHeight(task({ id: "t", assignments: [assignment({}), assignment({ path: "/b" })] }));
    expect(chipped).toBeGreaterThan(bare);
  });

  test("source adds one chip row", () => {
    const bare = taskCardHeight(task({ id: "t" }));
    const sourced = taskCardHeight(
      task({ id: "t", source: { path: "/node", ts: null, text: "Fix it", fingerprint: "fp", engine: "codex" } }),
    );
    expect(sourced).toBeGreaterThan(bare);
  });
});

describe("rectAnchor", () => {
  const rect = { x: 0, y: 0, w: 100, h: 50 };

  test("anchors on the facing side", () => {
    expect(rectAnchor(rect, { x: 200, y: 25 })).toEqual({ x: 100, y: 25 });
    expect(rectAnchor(rect, { x: 50, y: -100 })).toEqual({ x: 50, y: 0 });
  });

  test("degenerate target inside the rect falls back toward the center", () => {
    const anchor = rectAnchor(rect, { x: 50, y: 25 });
    expect(anchor).toEqual({ x: 50, y: 25 });
  });
});

describe("buildTaskEdges", () => {
  const index = buildTaskTargetIndex(LAYOUT);

  test("draws an edge per resolvable assignment and skips spawning/dead ones", () => {
    const edges = buildTaskEdges(
      [
        task({
          id: "t1",
          pos: { x: 0, y: 300 },
          assignments: [
            assignment({ path: "/node" }),
            assignment({ path: null, state: "spawning" }),
            assignment({ path: "/gone" }),
          ],
        }),
      ],
      index,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]!.key).toBe("t1::/node");
    expect(edges[0]!.relation).toBe("assignment");
    /* Card sits left of the node: the edge leaves the card's right side and
       enters the node's left side. */
    expect(edges[0]!.x1).toBe(TASK_W);
    expect(edges[0]!.x2).toBe(1000);
  });

  test("failed assignment marks its edge with the error", () => {
    const edges = buildTaskEdges(
      [task({ id: "t2", assignments: [assignment({ path: "/quiet", state: "failed", error: "no pane" })] })],
      index,
    );
    expect(edges[0]!.failed).toBe(true);
    expect(edges[0]!.error).toBe("no pane");
  });

  test("status rides on the edge for coloring", () => {
    const edges = buildTaskEdges([task({ id: "t3", status: "blocked", assignments: [assignment({ path: "/node" })] })], index);
    expect(edges[0]!.status).toBe("blocked");
  });

  test("draws a source edge without assignment state", () => {
    const edges = buildTaskEdges(
      [task({ id: "t4", source: { path: "/node", ts: null, text: "Fix it", fingerprint: "fp", engine: "codex" } })],
      index,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]!.key).toBe("t4::source::/node");
    expect(edges[0]!.relation).toBe("source");
    expect(edges[0]!.failed).toBe(false);
  });
});
