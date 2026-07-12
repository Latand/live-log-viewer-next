import { describe, expect, test } from "bun:test";

import type { BoardTask, TaskAssignment } from "@/lib/tasks/types";

import {
  assignEdgeLanes,
  buildTaskEdges,
  buildTaskTargetIndex,
  edgeObstacles,
  rectAnchor,
  routeTaskEdge,
  TASK_BODY_MAX,
  TASK_W,
  TASK_WORLD_MARGIN,
  taskCardHeight,
  taskRect,
  taskWorldBounds,
  type TaskEdgeGeom,
  type TaskTargetSource,
} from "./taskGeometry";
import type { SchemeRect } from "./layout";

function assignment(overrides: Partial<TaskAssignment>): TaskAssignment {
  return { path: "/a", panePid: null, state: "delivered", error: null, at: "2026-07-05T00:00:00Z", ...overrides };
}

function task(overrides: Partial<BoardTask> & { id: string }): BoardTask {
  return {
    project: "demo",
    status: "assigned",
    text: "title\nbody",
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

describe("taskWorldBounds", () => {
  test("no cards leaves the layout box untouched", () => {
    expect(taskWorldBounds(2000, 1500, [])).toEqual({ x: 0, y: 0, w: 2000, h: 1500 });
  });

  test("a card inside the layout box does not shrink or move it", () => {
    expect(taskWorldBounds(2000, 1500, [{ x: 500, y: 500, w: TASK_W, h: 100 }])).toEqual({ x: 0, y: 0, w: 2000, h: 1500 });
  });

  test("a card past the right/bottom edge grows width and height with a margin", () => {
    const bounds = taskWorldBounds(1000, 800, [{ x: 1200, y: 900, w: TASK_W, h: 100 }]);
    expect(bounds.x).toBe(0);
    expect(bounds.y).toBe(0);
    expect(bounds.w).toBe(1200 + TASK_W + TASK_WORLD_MARGIN);
    expect(bounds.h).toBe(900 + 100 + TASK_WORLD_MARGIN);
  });

  test("a card left of/above the origin pushes the origin negative and keeps the far edge", () => {
    const bounds = taskWorldBounds(1000, 800, [{ x: -276, y: -50, w: TASK_W, h: 120 }]);
    expect(bounds.x).toBe(-276 - TASK_WORLD_MARGIN);
    expect(bounds.y).toBe(-50 - TASK_WORLD_MARGIN);
    /* Far edges stay at least the layout box: width spans from the new negative
       origin to the old right edge. */
    expect(bounds.x + bounds.w).toBe(1000);
    expect(bounds.y + bounds.h).toBe(800);
  });
});

describe("routeTaskEdge", () => {
  /* Parse `M x1 y1 C c1x c1y, c2x c2y, x2 y2` back into its eight numbers. */
  function parse(d: string): number[] {
    return d
      .replace(/[MC,]/g, " ")
      .trim()
      .split(/\s+/)
      .map(Number);
  }
  function cubic(t: number, p0: number, c1: number, c2: number, p3: number): number {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * p3;
  }
  function inRect(x: number, y: number, r: SchemeRect): boolean {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }
  /* Enters any segment of a routed path — handles multi-segment detours, not
     just a single cubic. */
  function pathEntersRect(d: string, r: SchemeRect): boolean {
    const n = parse(d);
    let x0 = n[0]!;
    let y0 = n[1]!;
    for (let i = 2; i + 6 <= n.length; i += 6) {
      const [c1x, c1y, c2x, c2y, x2, y2] = n.slice(i, i + 6);
      for (let k = 0; k <= 40; k++) {
        const t = k / 40;
        if (inRect(cubic(t, x0, c1x!, c2x!, x2!), cubic(t, y0, c1y!, c2y!, y2!), r)) return true;
      }
      x0 = x2!;
      y0 = y2!;
    }
    return false;
  }
  const curveEntersRect = pathEntersRect;

  test("with no obstacles the base axis-following curve is kept", () => {
    const route = routeTaskEdge({ x1: 0, y1: 0, x2: 0, y2: 400 }, []);
    expect(route.crosses).toBe(false);
    /* Vertical hop → vertical control handles at the endpoints' x. */
    expect(parse(route.d)).toEqual([0, 0, 0, 200, 0, 200, 0, 400]);
    expect(route.mid).toEqual({ x: 0, y: 200 });
  });

  test("a card straddling the straight path is routed around", () => {
    /* A vertical edge whose base curve would run straight down through a card
       parked on the midline. */
    const blocker: SchemeRect = { x: -130, y: 150, w: 260, h: 100 };
    const straight = routeTaskEdge({ x1: 0, y1: 0, x2: 0, y2: 400 }, []);
    expect(curveEntersRect(straight.d, blocker)).toBe(true); // base really is blocked
    const route = routeTaskEdge({ x1: 0, y1: 0, x2: 0, y2: 400 }, [blocker]);
    expect(route.crosses).toBe(false);
    expect(curveEntersRect(route.d, blocker)).toBe(false);
  });

  test("a wide wall no bow can clear is routed around its end by a detour", () => {
    /* Too wide for any bow, but the detour goes around its side. */
    const wall: SchemeRect = { x: -5000, y: 150, w: 10000, h: 100 };
    const route = routeTaskEdge({ x1: 0, y1: 0, x2: 0, y2: 400 }, [wall]);
    expect(route.crosses).toBe(false);
    expect(pathEntersRect(route.d, wall)).toBe(false);
  });

  test("obstacles blocking both detour sides are flagged as an unavoidable crossing", () => {
    /* Centre wall blocks the straight path; flanking walls sit exactly where
       either detour corridor would run, so nothing clears — the honest outcome
       is an admitted, faded crossing. */
    const centre: SchemeRect = { x: -300, y: 150, w: 600, h: 100 };
    const leftWall: SchemeRect = { x: -700, y: 110, w: 400, h: 180 };
    const rightWall: SchemeRect = { x: 300, y: 110, w: 400, h: 180 };
    const route = routeTaskEdge({ x1: 0, y1: 0, x2: 0, y2: 400 }, [centre, leftWall, rightWall]);
    expect(route.crosses).toBe(true);
  });

  test("an obstacle nowhere near the path leaves the base curve and does not fade", () => {
    const far: SchemeRect = { x: 2000, y: 2000, w: 100, h: 100 };
    const route = routeTaskEdge({ x1: 0, y1: 0, x2: 0, y2: 400 }, [far]);
    expect(route.crosses).toBe(false);
    expect(parse(route.d)).toEqual([0, 0, 0, 200, 0, 200, 0, 400]);
  });

  test("a card near a long edge's start is not silently missed", () => {
    /* On a 2000px edge, a card just past the start falls between fixed parameter
       samples, so the old sampler returned a clear (crosses:false) curve that ran
       straight through it. Adaptive segment sampling walks the whole curve and a
       detour routes around the card: the returned path is clear and never claims
       a clear edge whose curve still enters the card. */
    const nearStart: SchemeRect = { x: -130, y: 16, w: 260, h: 64 };
    const straight = routeTaskEdge({ x1: 0, y1: 0, x2: 0, y2: 2000 }, []);
    expect(curveEntersRect(straight.d, nearStart)).toBe(true); // a real crossing exists
    const route = routeTaskEdge({ x1: 0, y1: 0, x2: 0, y2: 2000 }, [nearStart]);
    expect(route.crosses).toBe(false);
    expect(pathEntersRect(route.d, nearStart)).toBe(false);
  });

  test("a mid-span card on a long edge is detected and routed clear", () => {
    /* Further from the endpoints the crossing is avoidable — the denser sampler
       still finds it (fixed samples straddled it) and a bow clears it. */
    const midSpan: SchemeRect = { x: -130, y: 900, w: 260, h: 120 };
    const straight = routeTaskEdge({ x1: 0, y1: 0, x2: 0, y2: 2000 }, []);
    expect(curveEntersRect(straight.d, midSpan)).toBe(true);
    const route = routeTaskEdge({ x1: 0, y1: 0, x2: 0, y2: 2000 }, [midSpan]);
    expect(route.crosses).toBe(false);
    expect(curveEntersRect(route.d, midSpan)).toBe(false);
  });

  test("routes around a production-sized pane on a vertical edge (Finding 2)", () => {
    /* A real agent pane is 600×680 — far more clearance than any single-cubic
       bow can produce, so the old router faded a centreline straight through it.
       The detour goes around the pane's side and comes out clear. */
    const pane: SchemeRect = { x: -300, y: 100, w: 600, h: 680 };
    const edge = { x1: 0, y1: 0, x2: 0, y2: 900 };
    expect(curveEntersRect(routeTaskEdge(edge, []).d, pane)).toBe(true);
    const route = routeTaskEdge(edge, [pane]);
    expect(route.crosses).toBe(false);
    expect(pathEntersRect(route.d, pane)).toBe(false);
  });

  test("routes around a production-sized pane on a horizontal edge (Finding 2)", () => {
    const pane: SchemeRect = { x: 100, y: -340, w: 680, h: 600 };
    const edge = { x1: 0, y1: 0, x2: 900, y2: 0 };
    expect(curveEntersRect(routeTaskEdge(edge, []).d, pane)).toBe(true);
    const route = routeTaskEdge(edge, [pane]);
    expect(route.crosses).toBe(false);
    expect(pathEntersRect(route.d, pane)).toBe(false);
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

function edgeGeom(key: string, x1: number, y1: number, x2: number, y2: number, over: Partial<TaskEdgeGeom> = {}): TaskEdgeGeom {
  return { key, taskId: "t", relation: "assignment", path: "/p", x1, y1, x2, y2, status: "assigned", failed: false, error: null, ...over };
}

describe("assignEdgeLanes", () => {
  test("coincident source + assignment edges land on distinct lanes", () => {
    /* The Finding-2 case: a task whose source and assignment resolve to the same
       session give byte-identical endpoints — they must not share a lane. */
    const src = edgeGeom("t::source::/p", 0, 0, 100, 100, { relation: "source" });
    const asn = edgeGeom("t::/p", 0, 0, 100, 100);
    const lanes = assignEdgeLanes([src, asn]);
    expect(new Set(lanes.values()).size).toBe(2);
    expect([...lanes.values()]).toContain(0);
  });

  test("three coincident edges spread symmetrically to 0, +1, −1", () => {
    const es = [edgeGeom("k3", 0, 0, 10, 10), edgeGeom("k1", 0, 0, 10, 10), edgeGeom("k2", 0, 0, 10, 10)];
    expect([...assignEdgeLanes(es).values()].sort((a, b) => a - b)).toEqual([-1, 0, 1]);
  });

  test("edges with distinct endpoints all stay on lane 0", () => {
    const lanes = assignEdgeLanes([edgeGeom("a", 0, 0, 10, 10), edgeGeom("b", 0, 0, 10, 20)]);
    expect([...lanes.values()]).toEqual([0, 0]);
  });

  test("deterministic under input permutation", () => {
    const es = [edgeGeom("k1", 0, 0, 5, 5), edgeGeom("k2", 0, 0, 5, 5), edgeGeom("k3", 0, 0, 5, 5)];
    const forward = assignEdgeLanes(es);
    const reversed = assignEdgeLanes([...es].reverse());
    for (const e of es) expect(reversed.get(e.key)).toBe(forward.get(e.key));
  });
});

describe("routeTaskEdge lanes", () => {
  test("a non-zero lane fans the curve off the straight track but keeps endpoints", () => {
    const e = { x1: 0, y1: 0, x2: 0, y2: 400 };
    const straight = routeTaskEdge(e, []);
    const laned = routeTaskEdge(e, [], 1);
    expect(laned.d).not.toBe(straight.d);
    expect(laned.d.startsWith("M 0 0 ")).toBe(true);
    expect(laned.d.endsWith("0 400")).toBe(true);
    expect(Math.abs(laned.mid.x)).toBeGreaterThan(10); // pushed off the x=0 line
  });

  test("coincident edges on opposite lanes never overdraw", () => {
    const e = { x1: 0, y1: 0, x2: 200, y2: 0 };
    const up = routeTaskEdge(e, [], 1);
    const down = routeTaskEdge(e, [], -1);
    expect(up.d).not.toBe(down.d);
    expect(up.mid.y).not.toBe(down.mid.y);
  });
});

describe("edgeObstacles", () => {
  const edge = { taskId: "t1", x1: 0, y1: 0, x2: 0, y2: 400 };

  test("a pane between the endpoints is an obstacle (Finding 1)", () => {
    const pane: SchemeRect = { x: -200, y: 150, w: 400, h: 100 };
    expect(edgeObstacles(edge, [], [pane])).toHaveLength(1);
  });

  test("the source card and the target container are excluded", () => {
    const source = { id: "t1", x: -130, y: -64, w: 260, h: 64 }; // the edge's own card
    const target: SchemeRect = { x: -300, y: 400, w: 600, h: 200 }; // owns the (0,400) endpoint
    const other = { id: "t2", x: -130, y: 180, w: 260, h: 64 }; // an unrelated card in the way
    const obs = edgeObstacles(edge, [source, other], [target]);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ x: -130, y: 180 });
  });
});
