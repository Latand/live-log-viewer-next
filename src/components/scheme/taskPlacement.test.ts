import { describe, expect, test } from "bun:test";

import type { BoardTask } from "@/lib/tasks/types";

import type { SchemeRect } from "./layout";
import { isAutoPlaceable, resolveTaskPlacements, TASK_GUTTER, type PlaceableTask } from "./taskPlacement";
import { TASK_W, taskCardHeight, taskRect } from "./taskGeometry";

/* A prompt-captured source — what curator.ts and inboxScanner.ts stamp on every
   card they create. A card with one is auto-placeable only while it also rests
   on the autoPos lattice; without one the card was hand-created and is held. */
const SRC = { path: "/src", ts: null, text: "", fingerprint: "f", engine: "claude" as const };

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

  test("a relocated auto card clears pane obstacles as well as other cards", () => {
    /* A pinned anchor ("a") the user dropped holds its exact spot; the colliding
       auto card ("b", sourced + on the lattice) relocates and must clear both
       the anchor and the pane. */
    const pane: SchemeRect = { x: 700, y: 60, w: 600, h: 680 };
    const tasks = [task("a", 740, 130, { pinned: true }), task("b", 740, 120, { source: SRC })];
    expect(isAutoPlaceable(tasks[1]!)).toBe(true);
    const placement = resolveTaskPlacements(tasks, [pane]);
    expect(placement.get("a")).toEqual({ x: 740, y: 130 });
    const moved = rectAt(tasks[1]!, placement.get("b")!);
    expect(clash(moved, pane, 0)).toBe(false);
    expect(clash(moved, rectAt(tasks[0]!, placement.get("a")!), TASK_GUTTER - 1)).toBe(false);
  });

  test("a lone auto card on a pane is nudged off, even with no card collision", () => {
    /* A sourced lattice card that lands inside a pane must clear it on its own —
       the early-out demands pane clearance in addition to card clearance. */
    const pane: SchemeRect = { x: 700, y: 60, w: 600, h: 680 };
    const tasks = [task("solo", 740, 120, { source: SRC })];
    const spot = resolveTaskPlacements(tasks, [pane]).get("solo")!;
    expect(spot).not.toEqual({ x: 740, y: 120 });
    expect(clash(rectAt(tasks[0]!, spot), pane, 0)).toBe(false);
  });

  test("a pinned card the user placed on a pane is preserved exactly", () => {
    /* An explicit hand placement over a pane (allowed by design) survives — a
       pinned card is law and is never nudged, colliding pane or not. */
    const pane: SchemeRect = { x: 0, y: 0, w: 600, h: 680 };
    const tasks = [task("solo", 100, 100, { pinned: true, source: SRC })];
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

  test("legacy manual card (no pinned, no source) is never relocated", () => {
    /* Pre-`pinned` hand-created cards carry neither flag. They must hold their
       operator-chosen spot — even parked over a pane — through the first render
       after upgrade, staying where the operator left them. */
    const pane: SchemeRect = { x: 0, y: 0, w: 600, h: 680 };
    const tasks = [task("legacy", 100, 100)];
    expect(isAutoPlaceable(tasks[0]!)).toBe(false);
    expect(resolveTaskPlacements(tasks, [pane]).get("legacy")).toEqual({ x: 100, y: 100 });
  });

  test("legacy sourced card dragged off the lattice is preserved", () => {
    /* A pre-`pinned` inbox card the user had dragged sits off the autoPos
       lattice; with no flag to read, being off the lattice is the signal that a
       human moved it, so it holds even overlapping a pane. */
    const pane: SchemeRect = { x: 0, y: 0, w: 600, h: 680 };
    const tasks = [task("dragged", 315, 402, { source: SRC })];
    expect(isAutoPlaceable(tasks[0]!)).toBe(false);
    expect(resolveTaskPlacements(tasks, [pane]).get("dragged")).toEqual({ x: 315, y: 402 });
  });

  test("only sourced lattice cards are auto — the classifier is the seam", () => {
    expect(isAutoPlaceable(task("a", 740, 120, { source: SRC }))).toBe(true); // new inbox/curator card
    expect(isAutoPlaceable(task("b", 1040, 360, { source: SRC }))).toBe(true); // other column, deeper row
    expect(isAutoPlaceable(task("c", 741, 120, { source: SRC }))).toBe(false); // one px off the lattice
    expect(isAutoPlaceable(task("d", 740, 120, { source: SRC, pinned: true }))).toBe(false); // dragged onto lattice
    expect(isAutoPlaceable(task("e", 740, 120))).toBe(false); // no source = hand-created
    expect(isAutoPlaceable(task("f", 120, 120, { pinned: false }))).toBe(true); // panel default seed
  });

  test("panel-created cards (pinned:false at a shared default) are spread apart", () => {
    /* The task sheet and bulk bar seed every card at one point with pinned:false.
       Without spreading they'd stack forever unreadable (issue #17). */
    const tasks = [
      task("p1", 120, 120, { pinned: false }),
      task("p2", 120, 120, { pinned: false }),
      task("p3", 120, 120, { pinned: false }),
    ];
    const placement = resolveTaskPlacements(tasks, []);
    const rects = tasks.map((t) => rectAt(t, placement.get(t.id)!));
    for (let a = 0; a < rects.length; a++) {
      for (let b = a + 1; b < rects.length; b++) {
        expect(clash(rects[a]!, rects[b]!, TASK_GUTTER - 1)).toBe(false);
      }
    }
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
