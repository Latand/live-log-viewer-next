import { describe, expect, test } from "bun:test";

import type { Camera } from "./Minimap";
import { GAP_X, NODE_W, type SchemeLayout } from "./layout";
import {
  collectNavTargets,
  isTaskNavKey,
  LABEL_Z,
  MAX_Z,
  navTargetLabel,
  nearestToViewportCenter,
  type NavTarget,
  nextZoomStep,
  pickDirectional,
  TASK_NAV_PREFIX,
  taskNavKey,
  type TaskNavTarget,
  zoomLadderSteps,
} from "./spatialNav";
import { translate, type TFunction } from "@/lib/i18n";

function target(key: string, x: number, y: number, w = NODE_W, h = 680): NavTarget {
  return { key, x, y, w, h };
}

/* Node dimensions used across the geometry cases (root 780, child 680). */
const H = 680;

describe("pickDirectional — rows", () => {
  /* Three panes in a row at the same y, one NODE_W + GAP_X apart. */
  const step = NODE_W + GAP_X;
  const row = [target("a", 0, 0), target("b", step, 0), target("c", step * 2, 0)];

  test("Right walks to the adjacent pane, one at a time", () => {
    expect(pickDirectional(row, "a", "right")).toBe("b");
    expect(pickDirectional(row, "b", "right")).toBe("c");
  });

  test("Right at the last pane returns null (edge, no wrap)", () => {
    expect(pickDirectional(row, "c", "right")).toBeNull();
  });

  test("Left walks back symmetrically and stops at the edge", () => {
    expect(pickDirectional(row, "c", "left")).toBe("b");
    expect(pickDirectional(row, "b", "left")).toBe("a");
    expect(pickDirectional(row, "a", "left")).toBeNull();
  });

  test("picks are independent of array order", () => {
    const shuffled = [row[2]!, row[0]!, row[1]!];
    expect(pickDirectional(shuffled, "a", "right")).toBe("b");
    expect(pickDirectional(shuffled, "b", "right")).toBe("c");
    expect(pickDirectional(shuffled, "b", "left")).toBe("a");
  });
});

describe("pickDirectional — staircase", () => {
  /* Indented parent→child chain: Δx=64 (INDENT), Δy=810 (ROOT/ CHILD + GAP_Y). */
  const rungs = [
    target("r0", 0, 0, NODE_W, 780),
    target("r1", 64, 810),
    target("r2", 128, 1620),
    target("r3", 192, 2430),
  ];

  test("Down chains through every rung", () => {
    expect(pickDirectional(rungs, "r0", "down")).toBe("r1");
    expect(pickDirectional(rungs, "r1", "down")).toBe("r2");
    expect(pickDirectional(rungs, "r2", "down")).toBe("r3");
    expect(pickDirectional(rungs, "r3", "down")).toBeNull();
  });

  test("Up chains back through every rung", () => {
    expect(pickDirectional(rungs, "r3", "up")).toBe("r2");
    expect(pickDirectional(rungs, "r1", "up")).toBe("r0");
    expect(pickDirectional(rungs, "r0", "up")).toBeNull();
  });
});

describe("pickDirectional — sparse fallback", () => {
  /* A lone root far to the upper-left of a deep child: only the half-plane tier
     reaches it, but Up must still find it (traversal is total). */
  const sparse = [target("root", 100, 100, NODE_W, 780), target("child", 13124, 1010)];

  test("Up from a far-right child reaches the sole root via the half-plane tier", () => {
    expect(pickDirectional(sparse, "child", "up")).toBe("root");
  });

  test("unknown anchor key yields null", () => {
    expect(pickDirectional(sparse, "ghost", "up")).toBeNull();
  });
});

describe("pickDirectional — tiers and ties", () => {
  test("a same-band candidate far along wins over a near off-band one", () => {
    /* Same-row b at dp=5000 beats off-band c at dp=900 (tier 1 before tier 2). */
    const anchor = target("a", 0, 0);
    const b = target("b", 5000, 0); // same band (y overlaps)
    const c = target("c", 900, 4000); // off band, closer along x
    expect(pickDirectional([anchor, b, c], "a", "right")).toBe("b");
  });

  test("equidistant candidates break ties by perpendicular distance then key", () => {
    const anchor = target("a", 0, 0);
    /* Two candidates dead ahead, mirrored in y (equal ds), no band overlap. */
    const up = target("z", 2000, -3000);
    const down = target("y", 2000, 3000);
    /* Equal score and equal ds → lexicographic: "y" < "z". */
    expect(pickDirectional([anchor, up, down], "a", "right")).toBe("y");
  });

  test("candidates behind or barely ahead are discarded", () => {
    const anchor = target("a", 1000, 0);
    const behind = target("b", 0, 0); // dp < 0
    const barely = target("c", 1000 + 4, 0); // centre only 4px ahead → below DP_MIN
    expect(pickDirectional([anchor, behind, barely], "a", "right")).toBeNull();
  });
});

describe("collectNavTargets", () => {
  test("mirrors every byPath entry with its key", () => {
    const layout = {
      byPath: new Map([
        ["p1", { x: 1, y: 2, w: 3, h: 4 }],
        ["deck::x", { x: 5, y: 6, w: 7, h: 8 }],
      ]),
    } as unknown as Parameters<typeof collectNavTargets>[0];
    const targets = collectNavTargets(layout);
    expect(targets).toHaveLength(2);
    expect(targets.find((t) => t.key === "deck::x")).toEqual({ key: "deck::x", x: 5, y: 6, w: 7, h: 8 });
  });

  test("appends task cards as nav targets after the layout nodes", () => {
    const layout = { byPath: new Map([["p1", { x: 1, y: 2, w: 3, h: 4 }]]) } as unknown as Parameters<typeof collectNavTargets>[0];
    const tasks: TaskNavTarget[] = [{ key: taskNavKey("t1"), x: 10, y: 20, w: 260, h: 90, label: "Fix the parser" }];
    const targets = collectNavTargets(layout, tasks);
    expect(targets).toHaveLength(2);
    /* Only the geometry crosses over — the label is not a NavTarget field. */
    expect(targets.find((t) => t.key === taskNavKey("t1"))).toEqual({ key: "task::t1", x: 10, y: 20, w: 260, h: 90 });
  });

  test("defaults to no task targets when the arg is omitted", () => {
    const layout = { byPath: new Map([["p1", { x: 0, y: 0, w: 1, h: 1 }]]) } as unknown as Parameters<typeof collectNavTargets>[0];
    expect(collectNavTargets(layout)).toHaveLength(1);
  });
});

describe("task nav keys", () => {
  test("taskNavKey prefixes the id and isTaskNavKey recognizes it", () => {
    expect(taskNavKey("abc")).toBe(`${TASK_NAV_PREFIX}abc`);
    expect(isTaskNavKey(taskNavKey("abc"))).toBe(true);
    expect(isTaskNavKey("/home/u/conv/parent.jsonl")).toBe(false);
    expect(isTaskNavKey("deck::x")).toBe(false);
    expect(isTaskNavKey(null)).toBe(false);
  });
});

describe("pickDirectional — task cards tier alongside nodes", () => {
  /* A node and a task card sitting in the same row, one node-width apart, plus a
     task card directly below the node — arrows must reach the cards by the same
     spatial tiers that reach nodes, and never wrap. */
  const node = target("/conv/a.jsonl", 0, 0, NODE_W, H);
  const rightCard = target(taskNavKey("t1"), NODE_W + GAP_X, 0, 260, 90);
  const belowCard = target(taskNavKey("t2"), 0, H + 200, 260, 90);
  const targets = [node, rightCard, belowCard];

  test("Right from a node lands on the task card in its band", () => {
    expect(pickDirectional(targets, "/conv/a.jsonl", "right")).toBe(taskNavKey("t1"));
  });

  test("Down from a node lands on the task card below it", () => {
    expect(pickDirectional(targets, "/conv/a.jsonl", "down")).toBe(taskNavKey("t2"));
  });

  test("Left from a task card walks back to the node, and stops at the edge", () => {
    expect(pickDirectional(targets, taskNavKey("t1"), "left")).toBe("/conv/a.jsonl");
    expect(pickDirectional(targets, taskNavKey("t1"), "up")).toBeNull();
  });

  test("Right from the rightmost card returns null (no wrap)", () => {
    expect(pickDirectional(targets, taskNavKey("t1"), "right")).toBeNull();
  });
});

describe("nearestToViewportCenter", () => {
  const targets = [target("a", 0, 0), target("b", 2000, 0), target("c", 4000, 0)];

  test("respects the camera transform to find the on-screen-centre window", () => {
    const vp = { w: 1600, h: 900 };
    /* Put b's centre (x=2000+300=2300, y=340) at the viewport centre. */
    const cam: Camera = { x: 800 - 2300, y: 450 - 340, z: 1 };
    expect(nearestToViewportCenter(targets, cam, vp)).toBe("b");
  });

  test("keeps a still-visible selection instead of re-picking", () => {
    const vp = { w: 1600, h: 900 };
    /* Camera centred on b, but a is passed as selected and fully in view. */
    const cam: Camera = { x: 800 - 2300, y: 450 - 340, z: 1 };
    /* a's screen box: left = -300, still ~50%+ visible? a is off-screen left
       here, so selection is NOT kept — nearest (b) wins. */
    expect(nearestToViewportCenter(targets, cam, vp, "a")).toBe("b");
  });

  test("keeps the selection when it is at least half visible", () => {
    const vp = { w: 1600, h: 900 };
    /* Centre a in view; a is fully visible so it is retained even if b is
       marginally closer to the exact centre. */
    const cam: Camera = { x: 800 - 300, y: 450 - 340, z: 1 };
    expect(nearestToViewportCenter(targets, cam, vp, "a")).toBe("a");
  });
});

describe("zoomLadderSteps", () => {
  const vp = { w: 1600, h: 900 };
  const anchor = { x: 0, y: 0, w: NODE_W, h: H };

  test("is ascending, bounded by MAX_Z above and LABEL_Z below", () => {
    const steps = zoomLadderSteps(anchor, vp);
    expect(steps.length).toBeGreaterThan(1);
    for (let i = 1; i < steps.length; i++) expect(steps[i]!).toBeGreaterThan(steps[i - 1]!);
    expect(steps[steps.length - 1]!).toBeLessThanOrEqual(MAX_Z + 1e-9);
    expect(steps[0]!).toBeGreaterThanOrEqual(LABEL_Z - 1e-9);
  });

  test("step n frames n whole windows across", () => {
    const steps = zoomLadderSteps(anchor, vp);
    /* The 2-window framing must appear: (1600-48)/(2·600+48). */
    const two = (1600 - 48) / (2 * NODE_W + GAP_X);
    expect(steps.some((s) => Math.abs(s - two) < 1e-6)).toBe(true);
  });

  test("caps the single-window step at MAX_Z for a small anchor", () => {
    const tiny = { x: 0, y: 0, w: 40, h: 40 };
    const steps = zoomLadderSteps(tiny, vp);
    expect(Math.max(...steps)).toBeLessThanOrEqual(MAX_Z + 1e-9);
  });
});

describe("nextZoomStep", () => {
  const steps = [0.47, 0.59, 0.79, 1.2, 1.24];

  test("+ picks the next higher step, null at the ceiling", () => {
    expect(nextZoomStep(steps, 0.59, 1)).toBe(0.79);
    expect(nextZoomStep(steps, 1.24, 1)).toBeNull();
  });

  test("− picks the next lower step, null at the floor", () => {
    expect(nextZoomStep(steps, 0.79, -1)).toBe(0.59);
    expect(nextZoomStep(steps, 0.47, -1)).toBeNull();
  });

  test("ignores a step within ±1% of the current zoom", () => {
    expect(nextZoomStep(steps, 0.79, 1)).toBe(1.2);
    expect(nextZoomStep(steps, 0.79, -1)).toBe(0.59);
  });
});

describe("navTargetLabel — screen-reader labels", () => {
  const t: TFunction = (key, params) => translate("en", key, params);
  /* A layout with one real node and a quiet-branch stack hanging under it. */
  const layout = {
    nodes: [{ file: { path: "/home/u/conv/parent.jsonl", title: "Refactor the auth module" }, tasks: [], under: [], isRoot: true, x: 0, y: 0, w: 1, h: 1 }],
    stacks: [{ key: "/home/u/conv/parent.jsonl::stack", parent: "/home/u/conv/parent.jsonl", items: [{ file: {} }, { file: {} }, { file: {} }], x: 0, y: 0, w: 1, h: 1 }],
    decks: [],
    edges: [],
    loops: [],
    drafts: [],
    byPath: new Map(),
    width: 0,
    height: 0,
  } as unknown as SchemeLayout;

  test("a real node announces its clean title", () => {
    expect(navTargetLabel(layout, "/home/u/conv/parent.jsonl", t)).toBe("Refactor the auth module");
  });

  test("a mini-stack reads as human text — no raw path, no ::stack suffix", () => {
    const label = navTargetLabel(layout, "/home/u/conv/parent.jsonl::stack", t);
    expect(label).toBe("3 quiet branches under Refactor the auth module");
    expect(label).not.toContain("::stack");
    expect(label).not.toContain("/home/u/");
  });

  test("a single-item stack uses the singular form", () => {
    const one = { ...layout, stacks: [{ ...(layout.stacks[0] as object), items: [{ file: {} }] }] } as unknown as SchemeLayout;
    expect(navTargetLabel(one, "/home/u/conv/parent.jsonl::stack", t)).toBe("1 quiet branch under Refactor the auth module");
  });

  test("draft and deck keys drop their prefix (never a path)", () => {
    expect(navTargetLabel(layout, "draft::abc-123", t)).toBe("abc-123");
    expect(navTargetLabel(layout, "deck::flow-1", t)).toBe("flow-1");
  });

  test("a task key announces its first-line label from the task map", () => {
    const taskLabels = new Map([[taskNavKey("t1"), "Refactor the parser"]]);
    expect(navTargetLabel(layout, taskNavKey("t1"), t, taskLabels)).toBe("Refactor the parser");
  });

  test("the task label wins over any node/stack resolution for the same key", () => {
    /* A task label is authoritative — it never falls through to the raw-key
       branch that would leak a prefix or path. */
    const taskLabels = new Map([["deck::flow-1", "Ship the deck"]]);
    expect(navTargetLabel(layout, "deck::flow-1", t, taskLabels)).toBe("Ship the deck");
  });
});
