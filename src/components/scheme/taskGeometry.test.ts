import { describe, expect, test } from "bun:test";

import type { BoardTask, TaskAssignment } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import {
  assignEdgeLanes,
  buildTaskEdges,
  buildTaskTargetIndex,
  corridorGroups,
  edgeObstacles,
  rectAnchor,
  routePathsBounds,
  routeTaskEdge,
  routeTaskEdges,
  TASK_BODY_MAX,
  TASK_DISCLOSURE_H,
  TASK_W,
  TASK_WORLD_MARGIN,
  taskCardExpandable,
  taskCardHeight,
  taskEdgesSignature,
  taskRect,
  taskWorldBounds,
  type TaskEdgeGeom,
  type TaskEdgeObstacle,
  type TaskTargetSource,
} from "./taskGeometry";
import type { SchemeRect } from "./layout";

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
  groups: [
    {
      x: 2400,
      y: 100,
      w: 692,
      h: 150,
      pipeline: {
        srcPath: "/pipeline-source",
        runs: [{ stageId: "build", attempts: [{ agentPath: "/pipeline-history", flowId: "pipeline-flow" }] }],
      },
    },
  ],
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
  const index = buildTaskTargetIndex(LAYOUT, [{
    id: "pipeline-flow",
    implementerPath: "/pipeline-history",
    rounds: [{ reviewerPath: "/pipeline-review-round" }],
  }]);

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

  test("a compacted stage transcript resolves to its pipeline group", () => {
    expect(index.get("/pipeline-source")).toEqual({ x: 2400, y: 100, w: 692, h: 150 });
    expect(index.get("/pipeline-history")).toEqual({ x: 2400, y: 100, w: 692, h: 150 });
    expect(index.get("/pipeline-review-round")).toEqual({ x: 2400, y: 100, w: 692, h: 150 });
  });

  test("same-round durable reviewer bindings share the pipeline target and keep both task edges", () => {
    const flowId = "pipeline-flow-bindings";
    const layout: TaskTargetSource = {
      groups: [{
        x: 2400,
        y: 100,
        w: 692,
        h: 150,
        pipeline: { runs: [{ stageId: "review", attempts: [{ agentPath: "/review-current", flowId }] }] },
      }],
      nodes: [],
      stacks: [],
      decks: [],
    };
    const flows = [{
      id: flowId,
      implementerPath: "/builder",
      rounds: [{ n: 1, reviewerPath: "/review-current", reviewerConversationId: "conversation-current" }],
    }];
    const membership = (slot: string) => ({
      kind: "flow" as const, containerId: flowId, role: "reviewer", slot,
      stageId: null, stageOrder: null, round: 1, parentConversationId: "conversation-builder",
    });
    const files = [
      { path: "/review-prior", conversationId: "conversation-prior", durableLineage: { memberships: [membership("reviewer:1:binding-a")] } },
      { path: "/review-current", conversationId: "conversation-current", durableLineage: { memberships: [membership("reviewer:1:binding-b")] } },
    ] as unknown as FileEntry[];

    const bindingIndex = buildTaskTargetIndex(layout, flows, files);
    expect(bindingIndex.get("/review-prior")).toEqual({ x: 2400, y: 100, w: 692, h: 150 });
    expect(bindingIndex.get("/review-current")).toEqual({ x: 2400, y: 100, w: 692, h: 150 });

    const edges = buildTaskEdges([
      task({ id: "prior", pos: { x: 0, y: 0 }, assignments: [assignment({ path: "/review-prior" })] }),
      task({ id: "current", pos: { x: 0, y: 300 }, assignments: [assignment({ path: "/review-current" })] }),
    ], bindingIndex);
    expect(edges.map((edge) => edge.path)).toEqual(["/review-prior", "/review-current"]);
    expect(edges.every((edge) => edge.x2 === 2400)).toBe(true);
  });

  test("unknown path is absent — no edge, dead chip only", () => {
    expect(index.has("/gone")).toBe(false);
  });

  test("a path drawn both as a node and inside a container resolves to the node", () => {
    const overlapping: TaskTargetSource = {
      groups: [{ x: 800, y: 800, w: 20, h: 20, pipeline: { runs: [{ stageId: "x", attempts: [{ agentPath: "/dup" }] }] } }],
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

  test("height is a conservative upper bound for wide-glyph titles (Finding 2)", () => {
    /* 300 'W's (the widest glyph) with two assignment chips renders ~337px in
       Chromium. The estimate must not fall short of that, or the collision pass
       leaves the next card overlapping the rendered one. */
    const h = taskCardHeight(task({ id: "t", text: "W".repeat(300), assignments: [assignment({}), assignment({ path: "/b" })] }));
    expect(h).toBeGreaterThanOrEqual(337);
  });

  test("estimate bounds a worst-case rendered model at every length (Finding 2)", () => {
    /* Independent upper-bound model: the 236px content box wraps the widest bold
       glyph (≤13px advance — Chromium measured ~11.8 for 'W') into
       ceil(n·13/236) lines of 17px, plus the 6px strip, 20px body padding and
       26px per chip row (+6px gutter). The character-count estimate must never
       come in under this, or a tall card overruns its box and overlaps a
       neighbour. */
    const CONTENT_W = 260 - 24;
    const model = (chars: number, chips: number): number => {
      const lines = Math.ceil((chars * 13) / CONTENT_W);
      const body = Math.min(lines * 17, 340) + 20;
      const chipsH = chips ? chips * 26 + 6 : 0;
      return 6 + body + chipsH;
    };
    for (const chars of [1, 40, 120, 250, 340]) {
      for (const chips of [0, 1, 3]) {
        const chipList = Array.from({ length: chips }, (_, i) => assignment({ path: "/c" + i }));
        const h = taskCardHeight(task({ id: "t", text: "W".repeat(chars), assignments: chipList }));
        expect(h).toBeGreaterThanOrEqual(model(chars, chips));
      }
    }
  });

  test("wrap width uses the widest glyph advance", () => {
    /* The content box is only 236px, so a run of the widest glyphs cannot fit
       on one line — the estimate counts several lines for them. */
    const oneChar = taskCardHeight(task({ id: "t", text: "x" }));
    const wideRun = taskCardHeight(task({ id: "t", text: "W".repeat(40) }));
    expect(wideRun).toBeGreaterThan(oneChar);
  });

  test("word-boundary wrapping is included in the height bound (Finding)", () => {
    /* Twenty 10-'W' words wrap one-per-row in the 236px box (each word is ~118px,
       two don't fit), so the body hits its 340px cap (~378px card with a source
       chip). A length÷chars estimate packs them and undercounts to ~283px; the
       greedy word-wrap bound must cover the real render. */
    const twentyWords = Array.from({ length: 20 }, () => "WWWWWWWWWW").join(" ");
    const h = taskCardHeight(
      task({ id: "t", text: twentyWords, source: { path: "/n", ts: null, text: "x", fingerprint: "fp", engine: "codex" } }),
    );
    expect(h).toBeGreaterThanOrEqual(378);
  });

  test("tabs are counted at a full tab stop (Finding 2)", () => {
    /* `whitespace-pre-wrap` expands each tab to the next 8-space stop, so a
       `W\t`×50 run wraps to ~6 rows (~128px body); counting a tab as a single
       space undercounts to ~94px and overlaps the following card. */
    const tabbed = taskCardHeight(task({ id: "t", text: "W\t".repeat(50) }));
    const spaced = taskCardHeight(task({ id: "t", text: "W ".repeat(50) }));
    expect(tabbed).toBeGreaterThanOrEqual(128);
    expect(tabbed).toBeGreaterThanOrEqual(spaced);
  });

  test("standalone carriage returns each count as a rendered line (Finding 2)", () => {
    /* `whitespace-pre-wrap` breaks on a lone \r, so 100 of them are 101 rendered
       rows (body hits its 340px cap ≈ 346px card). A LF-only split would keep
       them in one line and undercount to ~230px, overlapping the next card. */
    const h = taskCardHeight(task({ id: "t", text: "x\r".repeat(100) + "x" }));
    expect(h).toBeGreaterThanOrEqual(346);
    /* CRLF and lone LF still count identically — the split treats all three the same. */
    const lf = taskCardHeight(task({ id: "t", text: "ab\ncd\nef" }));
    const crlf = taskCardHeight(task({ id: "t", text: "ab\r\ncd\r\nef" }));
    const cr = taskCardHeight(task({ id: "t", text: "ab\rcd\ref" }));
    expect(crlf).toBe(lf);
    expect(cr).toBe(lf);
  });

  test("bounds a large multi-target chip stack (Finding 2)", () => {
    /* The rendered chip block is 28m + 4 (h-6 = 24 per row, gap-1 = 4 between,
       pb-2 = 8 under the last). A multi-target delivery can stack a dozen rows,
       so the estimate must cover that or the gutter is eaten and cards overlap.
       Assert the whole card height clears strip + one body line + 28m + 4 at
       every stack size, including a 12-target card. */
    for (const m of [1, 2, 3, 6, 9, 12]) {
      const assignments = Array.from({ length: m }, (_, i) => assignment({ path: "/t" + i }));
      const h = taskCardHeight(task({ id: "t", text: "one line", assignments }));
      expect(h).toBeGreaterThanOrEqual(28 * m + 4);
    }
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

  test("a detour that escapes the layout is covered once route bounds are folded in (Finding 1)", () => {
    /* An edge routes around a pane at the right world edge, so its corridor sits
       past x=2000. The world box (viewBox for the edge SVG, camera and minimap)
       must grow to it or the connector and its marker clip out. */
    const pane: SchemeRect = { x: 1400, y: 100, w: 600, h: 680 };
    const edge: TaskEdgeGeom = { key: "A", taskId: "A", relation: "assignment", path: "/n", x1: 1900, y1: 0, x2: 1900, y2: 900, status: "assigned", failed: false, error: null };
    const routes = routeTaskEdges([edge], [], [pane]);
    const routeBox = routePathsBounds(routes.values())!;
    expect(routeBox.x + routeBox.w).toBeGreaterThan(2000); // detour truly escapes the layout width
    /* Without the route bounds the world clips the layout at 2000. */
    expect(taskWorldBounds(2000, 1000, []).x + taskWorldBounds(2000, 1000, []).w).toBeLessThan(routeBox.x + routeBox.w);
    /* Folding the route bounds in covers the whole detour. */
    const world = taskWorldBounds(2000, 1000, [routeBox]);
    expect(world.x + world.w).toBeGreaterThanOrEqual(routeBox.x + routeBox.w);
    expect(world.x).toBeLessThanOrEqual(routeBox.x);
  });

  test("routePathsBounds is null with no edges and pads the markers otherwise", () => {
    expect(routePathsBounds([])).toBeNull();
    const box = routePathsBounds([{ d: "M 0 0 C 50 0, 50 100, 100 100", mid: { x: 50, y: 50 }, crosses: false }])!;
    /* Control-point hull is x∈[0,100], y∈[0,100], padded outward for the markers. */
    expect(box.x).toBeLessThan(0);
    expect(box.y).toBeLessThan(0);
    expect(box.x + box.w).toBeGreaterThan(100);
    expect(box.y + box.h).toBeGreaterThan(100);
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
  /* Enters any segment of a routed path — handles multi-segment detours as well
     as a single cubic. */
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
    /* A real agent pane is 600×680; no single-cubic bow can produce that much
       clearance, so the old router faded a centreline straight through it. The
       detour goes around the pane's side and comes out clear. */
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

  test("partially collinear edges sharing a corridor get separate lanes (Finding)", () => {
    /* (0,0)→(1000,0) and (500,0)→(1500,0) overlap on a 500px run of the same
       line — distinct endpoints, so the old endpoint-signature grouping left
       both on lane 0 and they drew as one merged stroke. The corridor grouping
       fans them apart. */
    const a = edgeGeom("A", 0, 0, 1000, 0);
    const b = edgeGeom("B", 500, 0, 1500, 0);
    expect(corridorGroups([a, b]).some((g) => g.length === 2)).toBe(true);
    expect(new Set(assignEdgeLanes([a, b]).values()).size).toBe(2);
    const routes = routeTaskEdges([a, b], [], []);
    expect(routes.get("A")!.d).not.toBe(routes.get("B")!.d);
  });

  test("reverse-direction coincident edges are one corridor (direction-agnostic)", () => {
    const groups = corridorGroups([edgeGeom("A", 0, 0, 200, 0), edgeGeom("B", 200, 0, 0, 0)]);
    expect(groups.some((g) => g.length === 2)).toBe(true);
  });

  test("collinear edges that do not overlap stay on lane 0", () => {
    /* Same line, but their spans (0–100 and 500–600) do not touch — no overdraw,
       so they must not be needlessly fanned. */
    const lanes = assignEdgeLanes([edgeGeom("a", 0, 0, 100, 0), edgeGeom("b", 500, 0, 600, 0)]);
    expect([...lanes.values()]).toEqual([0, 0]);
  });

  test("near-collinear corridor grouping is symmetric under input order (Finding)", () => {
    /* Two slightly-off-collinear (±0.5px) overlapping edges of different length:
       the corridor test must not depend on which is the first argument, or
       visibility flips with ordering. */
    const a = edgeGeom("A", 0, 0, 1000, 0.5);
    const b = edgeGeom("B", 400, 0, 1400, -0.5);
    const key = (es: TaskEdgeGeom[]) =>
      corridorGroups(es)
        .map((g) => g.map((e) => e.key).join("+"))
        .sort()
        .join(",");
    expect(key([a, b])).toBe(key([b, a]));
    /* And they do land in one group (the overlap is real). */
    expect(corridorGroups([a, b]).some((g) => g.length === 2)).toBe(true);
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

describe("routeTaskEdges — edge-to-edge crossing handling (Finding 1)", () => {
  function geom(key: string, x1: number, y1: number, x2: number, y2: number, over: Partial<TaskEdgeGeom> = {}): TaskEdgeGeom {
    return { key, taskId: key, relation: "assignment", path: "/" + key, x1, y1, x2, y2, status: "assigned", failed: false, error: null, ...over };
  }
  /* Sample a routed path (multi-segment aware) and count proper crossings. */
  function points(d: string, per = 61): Array<{ x: number; y: number }> {
    const n = d
      .replace(/[MC,]/g, " ")
      .trim()
      .split(/\s+/)
      .map(Number);
    const cub = (t: number, a: number, b: number, c: number, e: number) => {
      const u = 1 - t;
      return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * e;
    };
    const pts = [{ x: n[0]!, y: n[1]! }];
    let x0 = n[0]!;
    let y0 = n[1]!;
    for (let i = 2; i + 6 <= n.length; i += 6) {
      const [c1x, c1y, c2x, c2y, x2, y2] = n.slice(i, i + 6);
      for (let k = 1; k <= per; k++) {
        const t = k / per;
        pts.push({ x: cub(t, x0, c1x!, c2x!, x2!), y: cub(t, y0, c1y!, c2y!, y2!) });
      }
      x0 = x2!;
      y0 = y2!;
    }
    return pts;
  }
  function crossings(dA: string, dB: string): number {
    const a = points(dA);
    const b = points(dB);
    const o = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    let c = 0;
    for (let i = 0; i + 1 < a.length; i++) {
      for (let j = 0; j + 1 < b.length; j++) {
        const d1 = o(b[j]!.x, b[j]!.y, b[j + 1]!.x, b[j + 1]!.y, a[i]!.x, a[i]!.y);
        const d2 = o(b[j]!.x, b[j]!.y, b[j + 1]!.x, b[j + 1]!.y, a[i + 1]!.x, a[i + 1]!.y);
        const d3 = o(a[i]!.x, a[i]!.y, a[i + 1]!.x, a[i + 1]!.y, b[j]!.x, b[j]!.y);
        const d4 = o(a[i]!.x, a[i]!.y, a[i + 1]!.x, a[i + 1]!.y, b[j + 1]!.x, b[j + 1]!.y);
        if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) c++;
      }
    }
    return c;
  }

  /* Does any sampled point of a routed path fall strictly inside `r`? */
  function enters(d: string, r: SchemeRect): boolean {
    return points(d, 60).some((p) => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h);
  }

  test("crossing reduction never re-enters a container to untangle edges (Finding 1)", () => {
    /* Two connectors cross beside a pane both must detour around. Every bow that
       would reduce the crossing routes back through the pane, so obstacle
       clearance — the higher-priority invariant — must win: both stay clear even
       though the crossing survives. */
    const pane: SchemeRect = { x: -300, y: 100, w: 600, h: 680 };
    const paneObstacle = { id: "pane", ...pane };
    const a = geom("A", -500, 0, 500, 900);
    const b = geom("B", 500, 0, -500, 900);
    expect(enters(routeTaskEdge(a, [pane], 0).d, pane)).toBe(false); // a clear route exists
    expect(crossings(routeTaskEdge(a, [pane], 0).d, routeTaskEdge(b, [pane], 0).d)).toBeGreaterThan(0); // reduction engaged
    const routes = routeTaskEdges([a, b], [paneObstacle], [pane]);
    expect(enters(routes.get("A")!.d, pane)).toBe(false);
    expect(enters(routes.get("B")!.d, pane)).toBe(false);
  });

  /* Fine (per=800) transversal-crossing check — dense enough to catch a crossing
     anywhere along a 16000px edge, so it never depends on the sampling density the
     production detector was faulted for. */
  function crossesFine(dA: string, dB: string): boolean {
    const a = points(dA, 800);
    const b = points(dB, 800);
    const o = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    for (let i = 0; i + 1 < a.length; i++) {
      for (let j = 0; j + 1 < b.length; j++) {
        const d1 = o(b[j]!.x, b[j]!.y, b[j + 1]!.x, b[j + 1]!.y, a[i]!.x, a[i]!.y);
        const d2 = o(b[j]!.x, b[j]!.y, b[j + 1]!.x, b[j + 1]!.y, a[i + 1]!.x, a[i + 1]!.y);
        const d3 = o(a[i]!.x, a[i]!.y, a[i + 1]!.x, a[i + 1]!.y, b[j]!.x, b[j]!.y);
        const d4 = o(a[i]!.x, a[i]!.y, a[i + 1]!.x, a[i + 1]!.y, b[j + 1]!.x, b[j + 1]!.y);
        if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
      }
    }
    return false;
  }

  test("a long crossing far from the endpoints is never left silent (Finding)", () => {
    /* The reviewer's exact repro: two long connectors whose base (lane-0) curves
       cross far from either endpoint. A fixed 32-sample crossing test stepped over
       that intersection and reported crosses:false for both, so the reduction
       never fired and they rendered visibly overlapping. Exact recursive
       intersection catches it — the base curves genuinely cross, and after routing
       the pair is separated, or one is flagged so the overlap reads as behind. */
    const a = geom("A", 8548, 7026, 3737, -9626);
    const b = geom("B", 7305, 6831, 4151, -5884);
    /* The base curves really do cross — this geometry exercises the long-edge
       case the sampling cap silently stepped over. */
    expect(crossesFine(routeTaskEdge(a, [], 0).d, routeTaskEdge(b, [], 0).d)).toBe(true);
    const routes = routeTaskEdges([a, b], [], []);
    const stillCross = crossesFine(routes.get("A")!.d, routes.get("B")!.d);
    const flagged = routes.get("A")!.crosses || routes.get("B")!.crosses;
    /* A surviving visible crossing must be flagged; a silent crossing is the bug. */
    expect(stillCross && !flagged).toBe(false);
  });

  test("a forced crossing ~10000px along each edge is still detected (Finding)", () => {
    /* Scaled box diagonals: the intersection sits far past where a bounded sample
       walk would land, yet the exact detector must flag the unavoidable crossing. */
    const a = geom("A", 0, 0, 20000, 20000);
    const b = geom("B", 0, 20000, 20000, 0);
    const routes = routeTaskEdges([a, b], [], []);
    expect(routes.get("A")!.crosses || routes.get("B")!.crosses).toBe(true);
  });

  test("busy fan-out detours are deconflicted onto distinct corridors (Finding)", () => {
    /* One task fanning out to six targets across a 600×680 pane: every edge must
       detour, and without deconfliction all six land on the identical corridor,
       compounding into an opaque rail. Each now gets its own track. */
    const pane: SchemeRect = { x: -300, y: 100, w: 600, h: 680 };
    const edges = Array.from({ length: 6 }, (_, i) => geom("a" + i, -450, 400 + i * 10, 450, 200 + i * 80));
    const routes = routeTaskEdges(edges, [], [pane]);
    const corridors = edges.map((e) => routes.get(e.key)!.corridor);
    expect(corridors.every((c) => c)).toBe(true); // all six detoured
    /* No two overlapping-extent corridors on the same axis sit within a lane. */
    for (let i = 0; i < corridors.length; i++) {
      for (let j = i + 1; j < corridors.length; j++) {
        const a = corridors[i]!;
        const b = corridors[j]!;
        if (a.axis === b.axis && Math.min(a.hi, b.hi) > Math.max(a.lo, b.lo)) {
          expect(Math.abs(a.pos - b.pos)).toBeGreaterThanOrEqual(25);
        }
      }
    }
    /* Deterministic under input order. */
    const rev = routeTaskEdges([...edges].reverse(), [], [pane]);
    for (const e of edges) expect(rev.get(e.key)!.d).toBe(routes.get(e.key)!.d);
  });

  test("fan-out deconfliction is not gated by the reduction cap (Finding)", () => {
    /* The same six-edge fan-out plus 43 unrelated far-away edges — 49 total,
       past CROSS_REDUCE_MAX. Corridor deconfliction must still run, or the six
       collapse back onto shared rails. */
    const pane: SchemeRect = { x: -300, y: 100, w: 600, h: 680 };
    const fan = Array.from({ length: 6 }, (_, i) => geom("fan" + i, -450, 400 + i * 10, 450, 200 + i * 80));
    const filler = Array.from({ length: 43 }, (_, i) => {
      const cx = 4000 + (i % 10) * 700;
      const cy = Math.floor(i / 10) * 240;
      return geom("z" + String(i).padStart(2, "0"), cx, cy, cx + 320, cy + 400);
    });
    expect(fan.length + filler.length).toBeGreaterThan(48);
    const routes = routeTaskEdges([...fan, ...filler], [], [pane]);
    const corridors = fan.map((e) => routes.get(e.key)!.corridor);
    expect(corridors.every((c) => c)).toBe(true);
    for (let i = 0; i < corridors.length; i++) {
      for (let j = i + 1; j < corridors.length; j++) {
        const a = corridors[i]!;
        const b = corridors[j]!;
        if (a.axis === b.axis && Math.min(a.hi, b.hi) > Math.max(a.lo, b.lo)) {
          expect(Math.abs(a.pos - b.pos)).toBeGreaterThanOrEqual(25);
        }
      }
    }
  });

  test("reduces an avoidable crossing that per-edge routing leaves tangled", () => {
    /* An obstacle bows edge A down through edge B (two crossings); the pass
       nudges A onto a lane that clears B. */
    const card = { id: "A", x: 180, y: -140, w: 40, h: 280 };
    const a = geom("A", 0, 0, 400, 0);
    const b = geom("B", 0, 110, 400, 110);
    const naive = crossings(routeTaskEdge(a, [card], 0).d, routeTaskEdge(b, [card], 0).d);
    expect(naive).toBeGreaterThan(0);
    const routes = routeTaskEdges([a, b], [card], []);
    expect(crossings(routes.get("A")!.d, routes.get("B")!.d)).toBeLessThan(naive);
  });

  test("never increases crossings versus per-edge routing", () => {
    const edges = [geom("A", 0, 0, 400, 0), geom("B", 0, 110, 400, 110), geom("C", 0, 220, 400, 40)];
    const card = { id: "A", x: 180, y: -140, w: 40, h: 280 };
    const routes = routeTaskEdges(edges, [card], []);
    const naive = new Map(edges.map((e) => [e.key, routeTaskEdge(e, [card], 0).d]));
    const total = (get: (k: string) => string) =>
      crossings(get("A"), get("B")) + crossings(get("A"), get("C")) + crossings(get("B"), get("C"));
    expect(total((k) => routes.get(k)!.d)).toBeLessThanOrEqual(total((k) => naive.get(k)!));
  });

  test("a forced crossing is never left silently solid — one side is faded", () => {
    /* The Finding-1 example: the two diagonals of a box interleave, so no
       bounded planar route removes the crossing. The old code detected nothing
       here (the crossing lands dead-centre on a shared sample vertex) and left
       BOTH edges `crosses:false`. The robust test now catches it, and since it
       can't be routed away, exactly one edge — the higher key, deterministically
       — is faded so it reads as passing behind. */
    const a = geom("A", 0, 0, 1000, 1000);
    const b = geom("B", 0, 1000, 1000, 0);
    const forward = routeTaskEdges([a, b], [], []);
    const reversed = routeTaskEdges([b, a], [], []);
    /* Deterministic for any input order. */
    expect(forward.get("A")!.d).toBe(reversed.get("A")!.d);
    expect(forward.get("B")!.crosses).toBe(reversed.get("B")!.crosses);
    /* The geometry still crosses once, and it is now flagged for the layer to fade. */
    expect(crossings(forward.get("A")!.d, forward.get("B")!.d)).toBe(1);
    expect([forward.get("A")!.crosses, forward.get("B")!.crosses].filter(Boolean)).toHaveLength(1);
    expect(forward.get("B")!.crosses).toBe(true); // higher key fades
  });

  test("a genuine crossing on long connectors is never silently missed (Finding)", () => {
    /* Two ~2400px cubics cross near (1533,1309). A fixed 12-segment sampling
       stepped right over it and left BOTH crosses:false — an opaque tangle.
       Adaptive-density sampling catches it: the routed geometry is either
       separated or the crossing is flagged, never solid-and-crossing. */
    const a = geom("A", 970, 950, 2753, 2533);
    const b = geom("B", 2156, 2163, 1444, 995);
    const routes = routeTaskEdges([a, b], [], []);
    const stillCross = crossings(routes.get("A")!.d, routes.get("B")!.d) > 0;
    const eitherFaded = routes.get("A")!.crosses || routes.get("B")!.crosses;
    /* The failing state the finding reported: a real crossing with both edges
       reporting clear. It must never occur. */
    expect(stillCross && !eitherFaded).toBe(false);
  });

  /* Min distance between two sampled paths — dense enough to see a near-endpoint
     graze that a coarse crossing count would step over. */
  function minCurveDistance(dA: string, dB: string): number {
    const a = points(dA, 300);
    const b = points(dB, 300);
    let m = Infinity;
    for (const p of a) for (const q of b) m = Math.min(m, Math.hypot(p.x - q.x, p.y - q.y));
    return m;
  }

  test("a shallow near-endpoint crossing on very long edges is resolved (Finding)", () => {
    /* The reviewer's exact repro: two very long connectors (~17000px / ~12700px)
       cross ~13px from B's endpoint at a shallow angle. A 32-chord sampling cap
       stepped over it and left both crosses:false — a solid tangle. Recursive
       cubic intersection catches it and the pass resolves it: the routed curves
       end up well apart, or one is faded. A solid overlap must never survive. */
    const a = geom("A", 8548, 7026, 3737, -9626);
    const b = geom("B", 7305, 6831, 4151, -5884);
    const routes = routeTaskEdges([a, b], [], []);
    const faded = routes.get("A")!.crosses || routes.get("B")!.crosses;
    const apart = minCurveDistance(routes.get("A")!.d, routes.get("B")!.d) > 4;
    expect(faded || apart).toBe(true);
  });

  test("distinct edges that do not cross are never faded", () => {
    const a = geom("A", 0, 0, 100, 100);
    const b = geom("B", 2000, 0, 2100, 100);
    const routes = routeTaskEdges([a, b], [], []);
    expect(routes.get("A")!.crosses).toBe(false);
    expect(routes.get("B")!.crosses).toBe(false);
  });

  test("fan-in edges meeting at one target are not treated as crossing", () => {
    /* Two edges landing on the same session share that endpoint by design; the
       shared-endpoint filter keeps them off the fade list. */
    const a = geom("A", 0, 0, 500, 500);
    const b = geom("B", 1000, 0, 500, 500);
    const routes = routeTaskEdges([a, b], [], []);
    expect(routes.get("A")!.crosses).toBe(false);
    expect(routes.get("B")!.crosses).toBe(false);
  });

  test("coincident edges stay fanned onto separate lanes", () => {
    /* Source + assignment to the same session: the pass must keep them on
       distinct lanes, never collapse them chasing a crossing. */
    const src = geom("t::source::/p", 0, 0, 300, 300, { relation: "source" });
    const asn = geom("t::/p", 0, 0, 300, 300);
    const routes = routeTaskEdges([src, asn], [], []);
    expect(routes.get(src.key)!.d).not.toBe(routes.get(asn.key)!.d);
  });

  test("a mixed-direction corridor fans to distinct curves, none overdrawn (Finding)", () => {
    /* Three edges on one line — two forward, one reversed. A lane bow is
       perpendicular to the edge's own direction, so without orientation
       normalization the reversed edge collapses onto a forward one. Every routed
       curve must be distinct. */
    const a = geom("A", 0, 0, 200, 0);
    const b = geom("B", 200, 0, 0, 0); // reversed
    const c = geom("C", 0, 0, 200, 0);
    const routes = routeTaskEdges([a, b, c], [], []);
    const ds = [routes.get("A")!.d, routes.get("B")!.d, routes.get("C")!.d];
    expect(new Set(ds).size).toBe(3);
    /* Order-independent. */
    const rev = routeTaskEdges([c, b, a], [], []);
    for (const k of ["A", "B", "C"]) expect(rev.get(k)!.d).toBe(routes.get(k)!.d);
  });

  test("stays within the render budget at the 300-task ceiling (Finding 2)", () => {
    /* The benchmark shape: 300 spread source edges, one placed card each, twelve
       panes. Broad-phase culling plus the reduction cap keep the whole global
       pass well under a frame-budget ceiling; the un-bounded version took ~10s. */
    const edges: TaskEdgeGeom[] = [];
    const cards: Array<SchemeRect & { id: string }> = [];
    for (let i = 0; i < 300; i++) {
      const cx = (i % 10) * 700;
      const cy = Math.floor(i / 10) * 240;
      edges.push(geom("e" + String(i).padStart(3, "0"), cx, cy, cx + 320, cy + 400));
      cards.push({ id: "e" + String(i).padStart(3, "0"), x: cx - 130, y: cy - 40, w: 260, h: 80 });
    }
    const panes: SchemeRect[] = Array.from({ length: 12 }, (_, i) => ({ x: (i % 6) * 700 + 200, y: Math.floor(i / 6) * 800 + 100, w: 600, h: 680 }));
    const t0 = performance.now();
    const routes = routeTaskEdges(edges, cards, panes);
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(routes.size).toBe(300);
  });

  test("order-independent under broad-phase culling and the reduction cap", () => {
    /* Determinism must survive the bounding-box short-circuit and the pass. D
       crosses A/B/C, engaging the reduction. */
    const edges = [geom("A", 0, 0, 400, 0), geom("B", 0, 110, 400, 110), geom("C", 0, 220, 400, 40), geom("D", 60, -60, 340, 320)];
    const card = { id: "A", x: 180, y: -140, w: 40, h: 280 };
    const forward = routeTaskEdges(edges, [card], []);
    const reversed = routeTaskEdges([...edges].reverse(), [card], []);
    for (const e of edges) {
      expect(reversed.get(e.key)!.d).toBe(forward.get(e.key)!.d);
      expect(reversed.get(e.key)!.crosses).toBe(forward.get(e.key)!.crosses);
    }
  });
});

describe("routeTaskEdges — busy fan-out corridor deconfliction (Finding)", () => {
  function geom(key: string, x1: number, y1: number, x2: number, y2: number): TaskEdgeGeom {
    return { key, taskId: "t", relation: "assignment", path: "/" + key, x1, y1, x2, y2, status: "assigned", failed: false, error: null };
  }
  /* One task fanning out to six targets on the far side of a 600×680 pane: every
     straight line crosses the pane, so all six detour around it. The bug: they all
     took the identical central corridor, five faded, compounding into an opaque
     rail — the exact tangle #17 targets. Deconfliction must spread them onto
     distinct corridors. */
  function fanOut(): { edges: TaskEdgeGeom[]; pane: SchemeRect } {
    const pane: SchemeRect = { x: 0, y: 300, w: 600, h: 680 };
    const src = { x: 300, y: 0 };
    const targets = [-100, 50, 200, 400, 550, 700];
    const edges = targets.map((tx, i) => geom("t::" + i, src.x, src.y, tx, 1200));
    return { edges, pane };
  }

  test("six fan-out detours land on distinct corridors (Finding)", () => {
    const { edges, pane } = fanOut();
    const routes = routeTaskEdges(edges, [], [pane]);
    expect(routes.size).toBe(6);
    const corridorX = edges.map((e) => Math.round(routes.get(e.key)!.mid.x));
    /* Each corridor holds at most two edges — the old bug put all six on one. */
    const perCorridor = new Map<number, number>();
    for (const x of corridorX) perCorridor.set(x, (perCorridor.get(x) ?? 0) + 1);
    expect(Math.max(...perCorridor.values())).toBeLessThanOrEqual(2);
    /* The fan really spreads across several distinct corridors. */
    expect(new Set(corridorX).size).toBeGreaterThanOrEqual(4);
    /* Several still draw solid: the old collapse superimposed all six on one
       corridor, so the exact detector faded five as behind-the-rail. With the
       corridors spread apart at least a third stay solid — the honest fades that
       remain are genuine sibling crossings in the fan's approach legs. */
    const solid = edges.filter((e) => !routes.get(e.key)!.crosses).length;
    expect(solid).toBeGreaterThanOrEqual(2);
  });

  test("fan-out deconfliction is order-independent", () => {
    const { edges, pane } = fanOut();
    const forward = routeTaskEdges(edges, [], [pane]);
    const reversed = routeTaskEdges([...edges].reverse(), [], [pane]);
    for (const e of edges) {
      expect(reversed.get(e.key)!.d).toBe(forward.get(e.key)!.d);
      expect(reversed.get(e.key)!.crosses).toBe(forward.get(e.key)!.crosses);
    }
  });

  test("a dense 20-edge fan-out never reuses an occupied corridor (Finding)", () => {
    /* The fixed ten-lane list ran out and later edges fell back onto an occupied
       rail (three shared h:84). The lane search now steps until free, and an edge
       that can't find a corridor bows off the rail entirely — so no two routes
       ever share a corridor. */
    const pane: SchemeRect = { x: -300, y: 100, w: 600, h: 680 };
    const edges = Array.from({ length: 20 }, (_, i) => geom("a" + String(i).padStart(2, "0"), -450, 400 + i * 8, 450, 200 + i * 70));
    const routes = routeTaskEdges(edges, [], [pane]);
    const corridors = edges.map((e) => routes.get(e.key)!.corridor);
    for (let i = 0; i < corridors.length; i++) {
      for (let j = i + 1; j < corridors.length; j++) {
        const a = corridors[i];
        const b = corridors[j];
        if (a && b && a.axis === b.axis && Math.min(a.hi, b.hi) > Math.max(a.lo, b.lo)) {
          /* Shared axis and overlapping extent — their positions must be at least
             a lane apart, never the same rail. */
          expect(Math.abs(a.pos - b.pos)).toBeGreaterThanOrEqual(25);
        }
      }
    }
  });
});

describe("routeTaskEdges — render-thread cost (Finding 2)", () => {
  /* A star of edges through a shared centre: every route's bounds overlap, so the
     broad phase can't cull the edge-vs-edge pass — the pathological shape for the
     global router. */
  function star(n: number): { edges: TaskEdgeGeom[]; cards: TaskEdgeObstacle[] } {
    const edges: TaskEdgeGeom[] = [];
    const cards: TaskEdgeObstacle[] = [];
    const R = 600;
    const cx = 1000;
    const cy = 1000;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const x1 = cx + Math.cos(a) * R;
      const y1 = cy + Math.sin(a) * R;
      const x2 = cx - Math.cos(a) * R;
      const y2 = cy - Math.sin(a) * R;
      cards.push({ id: "t" + i, x: x1 - 130, y: y1 - 20, w: 260, h: 300 });
      edges.push({ key: "t" + i + "::/n", taskId: "t" + i, relation: "assignment", path: "/n", x1, y1, x2, y2, status: "assigned", failed: false, error: null });
    }
    return { edges, cards };
  }

  test("routes the 300-task ceiling well under a frame-budget's worth of seconds", () => {
    /* The Finding-2 regression: an earlier build spent 9.86 s on 200 edges,
       blocking the render thread. The control-hull cull keeps obstacle routing
       near the cards actually on each path, so the whole pass stays double-digit
       ms even at the 300-task ceiling. A generous ceiling here (still 60× under
       the old 200-edge time) keeps the guard robust across CI hardware. */
    const { edges, cards } = star(300);
    const t0 = performance.now();
    const routes = routeTaskEdges(edges, cards, []);
    const dt = performance.now() - t0;
    expect(routes.size).toBe(300);
    expect(dt).toBeLessThan(1500);
  });
});

describe("taskEdgesSignature — poll-stable route cache key (Finding 2)", () => {
  function geom(key: string, x1: number, y1: number, x2: number, y2: number): TaskEdgeGeom {
    return { key, taskId: key, relation: "assignment", path: "/" + key, x1, y1, x2, y2, status: "assigned", failed: false, error: null };
  }
  const edges = [geom("a", 0, 0, 300, 300)];
  const cards: TaskEdgeObstacle[] = [{ id: "a", x: 10, y: 10, w: 260, h: 100 }];

  test("identical geometry in fresh arrays yields the same signature", () => {
    const a = taskEdgesSignature(edges, cards, []);
    const b = taskEdgesSignature([geom("a", 0, 0, 300, 300)], [{ id: "a", x: 10, y: 10, w: 260, h: 100 }], []);
    expect(a).toBe(b);
  });

  test("sub-pixel jitter does not bust the cache", () => {
    const a = taskEdgesSignature(edges, cards, []);
    const b = taskEdgesSignature([geom("a", 0.2, -0.1, 300.4, 299.6)], cards, []);
    expect(a).toBe(b);
  });

  test("a moved edge, moved card, or new container all change the signature", () => {
    const base = taskEdgesSignature(edges, cards, []);
    expect(taskEdgesSignature([geom("a", 0, 40, 300, 300)], cards, [])).not.toBe(base);
    expect(taskEdgesSignature(edges, [{ id: "a", x: 80, y: 10, w: 260, h: 100 }], [])).not.toBe(base);
    expect(taskEdgesSignature(edges, cards, [{ x: 0, y: 0, w: 10, h: 10 }])).not.toBe(base);
  });
});

describe("taskCardExpandable (issue #292: compact preview + Expand, no internal scroll)", () => {
  test("short text is not expandable; text past the compact cap is", () => {
    expect(taskCardExpandable({ text: "one line" })).toBe(false);
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    expect(taskCardExpandable({ text: long })).toBe(true);
  });

  test("the boundary accounts for the body's 16px vertical padding (Finding)", () => {
    /* The compact clamp is a border-box max-height: the body's py-2 padding
       (16px) is spent inside TASK_BODY_MAX, so the plain preview holds only
       19 full hard lines (19 × 17 + 16 = 339 ≤ 340). Exactly 20 hard lines
       (20 × 17 + 16 = 356 > 340) would clip their last line — they must
       expose Expand. The pre-fix gate compared bare text height (20 × 17 =
       340 ≯ 340) and silently clipped line 20 with no fade and no control. */
    const nineteen = Array.from({ length: 19 }, (_, i) => `l${i}`).join("\n");
    const twenty = `${nineteen}\nl19`;
    expect(taskCardExpandable({ text: nineteen })).toBe(false);
    expect(taskCardExpandable({ text: twenty })).toBe(true);
  });

  test("an expandable card's compact height estimate stays capped — the disclosure fits inside it", () => {
    const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const height = taskCardHeight({ text: long, assignments: [], source: undefined });
    /* strip 6 + capped body 340 + pad 20: the rendered preview (340−24) plus the
       24px disclosure row exactly fills the same box. */
    expect(height).toBe(6 + TASK_BODY_MAX + 20);
    expect(TASK_DISCLOSURE_H).toBe(24);
  });
});
