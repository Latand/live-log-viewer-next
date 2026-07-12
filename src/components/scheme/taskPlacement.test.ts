import { describe, expect, test } from "bun:test";

import type { BoardTask } from "@/lib/tasks/types";

import type { SchemeRect } from "./layout";
import { resolveTaskPlacements, TASK_GUTTER, type PlaceableTask } from "./taskPlacement";
import { TASK_W, taskCardHeight, taskRect } from "./taskGeometry";

function task(id: string, x: number, y: number, over: Partial<PlaceableTask> = {}): PlaceableTask {
  return { id, pos: { x, y }, text: "Investigate the flaky login test\nthat fails on CI", assignments: [], source: undefined, ...over };
}

/* The autoPos lattice both curator.ts and inboxScanner.ts write: two columns
   300px apart, 120px vertical stride — far tighter than a card runs tall, so a
   dense board packs them into an unreadable pileup. This is the bug fixture. */
function densePileup(count: number): PlaceableTask[] {
  return Array.from({ length: count }, (_, i) =>
    task(`t${String(i).padStart(2, "0")}`, 740 + (i % 2) * 300, 120 + Math.floor(i / 2) * 120, {
      /* Vary height with assignment chips so cards genuinely overrun the stride. */
      assignments: Array.from({ length: i % 3 }, () => ({ path: `/a${i}`, panePid: null, state: "delivered" as const, error: null, at: "" })),
      source: { path: "/src", ts: null, text: "", fingerprint: "f", engine: "claude" as const },
    }),
  );
}

function rectAt(t: PlaceableTask, pos: { x: number; y: number }): SchemeRect {
  return { x: pos.x, y: pos.y, w: TASK_W, h: taskCardHeight(t) };
}

function clash(a: SchemeRect, b: SchemeRect, gap: number): boolean {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

/** Every card pair, resolved, keeps at least TASK_GUTTER of clear space. */
function assertNoOverlap(tasks: PlaceableTask[], obstacles: SchemeRect[] = []): void {
  const placement = resolveTaskPlacements(tasks, obstacles);
  const rects = tasks.map((t) => rectAt(t, placement.get(t.id)!));
  for (let a = 0; a < rects.length; a++) {
    for (let b = a + 1; b < rects.length; b++) {
      expect(clash(rects[a]!, rects[b]!, TASK_GUTTER - 1)).toBe(false);
    }
  }
}

describe("resolveTaskPlacements", () => {
  test("dense autoPos pileup resolves to non-overlapping cards", () => {
    assertNoOverlap(densePileup(24));
  });

  test("the raw dense fixture really does overlap (guards the fixture)", () => {
    const tasks = densePileup(16);
    const rects = tasks.map((t) => taskRect(t as BoardTask));
    let overlaps = 0;
    for (let a = 0; a < rects.length; a++) {
      for (let b = a + 1; b < rects.length; b++) {
        if (clash(rects[a]!, rects[b]!, 0)) overlaps++;
      }
    }
    expect(overlaps).toBeGreaterThan(0);
  });

  test("an already-tidy layout is returned untouched (no-op on clean input)", () => {
    const tasks = [task("a", 0, 0), task("b", 0, 400), task("c", 400, 0), task("d", 400, 400)];
    const placement = resolveTaskPlacements(tasks, []);
    for (const t of tasks) {
      expect(placement.get(t.id)).toEqual(t.pos);
    }
  });

  test("deterministic: permuting the input yields byte-identical positions", () => {
    const tasks = densePileup(20);
    const forward = resolveTaskPlacements(tasks, []);
    const reversed = resolveTaskPlacements([...tasks].reverse(), []);
    const shuffled = resolveTaskPlacements([tasks[7]!, tasks[0]!, ...tasks.slice(1, 7), ...tasks.slice(8)], []);
    for (const t of tasks) {
      expect(reversed.get(t.id)).toEqual(forward.get(t.id));
      expect(shuffled.get(t.id)).toEqual(forward.get(t.id));
    }
  });

  test("idempotent: re-running on the resolved positions changes nothing", () => {
    const tasks = densePileup(18);
    const first = resolveTaskPlacements(tasks, []);
    const settled = tasks.map((t) => ({ ...t, pos: first.get(t.id)! }));
    const second = resolveTaskPlacements(settled, []);
    for (const t of tasks) {
      expect(second.get(t.id)).toEqual(first.get(t.id));
    }
  });

  test("the top-priority card of a pileup holds its stored spot", () => {
    const tasks = densePileup(12);
    const placement = resolveTaskPlacements(tasks, []);
    /* Reading order winner: smallest (y, x, id). The lattice's first card is at
       (740, 120) and nothing sorts ahead of it. */
    expect(placement.get("t00")).toEqual({ x: 740, y: 120 });
  });

  test("a relocated card clears pane obstacles, not just other cards", () => {
    /* A pinned anchor ("a") the user dropped on the pane holds its exact spot;
       the colliding auto card ("b") relocates and must clear both the anchor
       and the pane. */
    const pane: SchemeRect = { x: 700, y: 100, w: 600, h: 680 };
    const tasks = [task("a", 740, 140, { pinned: true }), task("b", 740, 150)];
    const placement = resolveTaskPlacements(tasks, [pane]);
    expect(placement.get("a")).toEqual({ x: 740, y: 140 });
    const moved = rectAt(tasks[1]!, placement.get("b")!);
    expect(clash(moved, pane, 0)).toBe(false);
    expect(clash(moved, rectAt(tasks[0]!, placement.get("a")!), TASK_GUTTER - 1)).toBe(false);
  });

  test("a lone auto card on a pane is nudged off, even with no card collision", () => {
    /* An auto-lattice card that lands inside a pane must clear it on its own —
       the early-out now demands pane clearance, not just card clearance. */
    const pane: SchemeRect = { x: 0, y: 0, w: 600, h: 680 };
    const tasks = [task("solo", 100, 100)];
    const spot = resolveTaskPlacements(tasks, [pane]).get("solo")!;
    expect(spot).not.toEqual({ x: 100, y: 100 });
    expect(clash(rectAt(tasks[0]!, spot), pane, 0)).toBe(false);
  });

  test("a pinned card the user placed on a pane is preserved exactly", () => {
    /* An explicit hand placement over a pane (allowed by design) survives — a
       pinned card is law and is never nudged, colliding pane or not. */
    const pane: SchemeRect = { x: 0, y: 0, w: 600, h: 680 };
    const tasks = [task("solo", 100, 100, { pinned: true })];
    expect(resolveTaskPlacements(tasks, [pane]).get("solo")).toEqual({ x: 100, y: 100 });
  });

  test("pinned cards hold their exact spot even when they overlap", () => {
    /* Two pinned cards the user stacked stay put — the pass never overrides an
       explicit placement, so a deliberate overlap is the user's to keep. */
    const tasks = [task("a", 200, 200, { pinned: true }), task("b", 210, 205, { pinned: true })];
    const placement = resolveTaskPlacements(tasks, []);
    expect(placement.get("a")).toEqual({ x: 200, y: 200 });
    expect(placement.get("b")).toEqual({ x: 210, y: 205 });
  });

  test("resolves a large burst without exploding out of bounds", () => {
    const tasks = densePileup(60);
    const placement = resolveTaskPlacements(tasks, []);
    assertNoOverlap(tasks);
    /* Cards stay clustered near the lattice, never flung to the far ring cap. */
    for (const t of tasks) {
      const spot = placement.get(t.id)!;
      expect(Math.abs(spot.x - t.pos.x)).toBeLessThan(4000);
      expect(Math.abs(spot.y - t.pos.y)).toBeLessThan(6000);
    }
  });
});
