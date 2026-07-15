import { describe, expect, test } from "bun:test";

import type { SchemeRect } from "./layout";
import { isAutoPlaceable, resolveTaskPlacements, TASK_GUTTER, type PlaceableTask } from "./taskPlacement";
import { TASK_W, taskBoxHeight, taskCardHeight, taskRect } from "./taskGeometry";

/* A prompt-captured source — what curator.ts and inboxScanner.ts stamp on every
   card they create. A card with one is auto-placeable only while it also rests
   on the autoPos lattice; without one the card was hand-created and is held. */
const SRC = { path: "/src", ts: null, text: "", fingerprint: "f", engine: "claude" as const };

function task(id: string, x: number, y: number, over: Partial<PlaceableTask> = {}): PlaceableTask {
  return {
    id,
    pos: { x, y },
    text: "Investigate the flaky login test\nthat fails on CI",
    assignments: [],
    source: undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
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
    const rects = tasks.map((t) => taskRect(t));
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
    /* A held anchor ("a", hand-placed with no source) holds its exact spot; the
       colliding auto card ("b", sourced + on the lattice) relocates and must
       clear both the anchor and the pane. */
    const pane: SchemeRect = { x: 700, y: 60, w: 600, h: 680 };
    const tasks = [task("a", 740, 130), task("b", 740, 120, { source: SRC })];
    expect(isAutoPlaceable(tasks[0]!)).toBe(false);
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

  test("a hand-placed card on a pane is preserved exactly", () => {
    /* An explicit hand placement over a pane (allowed by design) survives — a
       source-less card is law and is never nudged, colliding pane or not. */
    const pane: SchemeRect = { x: 0, y: 0, w: 600, h: 680 };
    const tasks = [task("solo", 100, 100)];
    expect(resolveTaskPlacements(tasks, [pane]).get("solo")).toEqual({ x: 100, y: 100 });
  });

  test("held cards hold their exact spot even when they overlap", () => {
    /* Two hand-placed cards the user stacked stay put — the pass never overrides
       an explicit placement, so a deliberate overlap is the user's to keep. */
    const tasks = [task("a", 200, 200), task("b", 210, 205)];
    const placement = resolveTaskPlacements(tasks, []);
    expect(placement.get("a")).toEqual({ x: 200, y: 200 });
    expect(placement.get("b")).toEqual({ x: 210, y: 205 });
  });

  test("a hand-created card (no source) is never relocated", () => {
    /* «Task» tool drops carry no source. They hold their operator-chosen spot —
       even parked over a pane — staying exactly where the operator left them. */
    const pane: SchemeRect = { x: 0, y: 0, w: 600, h: 680 };
    const tasks = [task("manual", 100, 100)];
    expect(isAutoPlaceable(tasks[0]!)).toBe(false);
    expect(resolveTaskPlacements(tasks, [pane]).get("manual")).toEqual({ x: 100, y: 100 });
  });

  test("a sourced card dragged off the lattice is preserved", () => {
    /* An inbox card the user has dragged sits off the autoPos lattice; being off
       the lattice is the signal that a human moved it, so it holds even
       overlapping a pane. */
    const pane: SchemeRect = { x: 0, y: 0, w: 600, h: 680 };
    const tasks = [task("dragged", 315, 402, { source: SRC })];
    expect(isAutoPlaceable(tasks[0]!)).toBe(false);
    expect(resolveTaskPlacements(tasks, [pane]).get("dragged")).toEqual({ x: 315, y: 402 });
  });

  test("only sourced lattice cards are auto — the classifier is the seam", () => {
    expect(isAutoPlaceable(task("a", 740, 120, { source: SRC }))).toBe(true); // new inbox/curator card
    expect(isAutoPlaceable(task("b", 1040, 360, { source: SRC }))).toBe(true); // other column, deeper row
    expect(isAutoPlaceable(task("c", 741, 120, { source: SRC }))).toBe(false); // one px off the lattice
    expect(isAutoPlaceable(task("e", 740, 120))).toBe(false); // no source = hand-created
    expect(isAutoPlaceable(task("f", 120, 120))).toBe(false); // off-lattice, no source
  });

  test("adding a task never reshuffles the cards that predate it (Finding)", () => {
    /* Two sourced lattice cards at the shared autoPos seed, then a third added
       later whose UUID sorts *before* both. Ordering by creation time (not id)
       keeps the two existing cards exactly where they were; only the newcomer
       flows around. */
    const old1 = task("zzz-1", 740, 120, { source: SRC, createdAt: "2026-07-01T00:00:00.000Z" });
    const old2 = task("zzz-2", 740, 120, { source: SRC, createdAt: "2026-07-02T00:00:00.000Z" });
    const before = resolveTaskPlacements([old1, old2], []);
    const newer = task("aaa-3", 740, 120, { source: SRC, createdAt: "2026-07-03T00:00:00.000Z" });
    const after = resolveTaskPlacements([old1, old2, newer], []);
    expect(after.get("zzz-1")).toEqual(before.get("zzz-1"));
    expect(after.get("zzz-2")).toEqual(before.get("zzz-2"));
    /* And the newcomer still clears them. */
    const rects = [old1, old2, newer].map((t) => rectAt(t, after.get(t.id)!));
    for (let a = 0; a < rects.length; a++) {
      for (let b = a + 1; b < rects.length; b++) {
        expect(clash(rects[a]!, rects[b]!, TASK_GUTTER - 1)).toBe(false);
      }
    }
  });

  test("placement reserves the floating action-row strip below every card (Finding — P2)", () => {
    /* The collision pass spreads a pileup using the full rendered box
       (taskBoxHeight = visual card + the action-row strip), so a relocated card
       never lands on a neighbour's hover send/status/delete row. Assert every
       resolved pair clears at the full box that includes the action-row strip. */
    const tasks = densePileup(24);
    const placement = resolveTaskPlacements(tasks, []);
    const rects = tasks.map((t) => ({ x: placement.get(t.id)!.x, y: placement.get(t.id)!.y, w: TASK_W, h: taskBoxHeight(t) }));
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

describe("resolveTaskPlacements — expanded cards (issue #292)", () => {
  /* Tall enough that its expanded box swallows a card 200px below. */
  const LONG = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");

  test("an expanded card holds its spot; the pinned card it now covers steps aside", () => {
    const a = task("a", 0, 0, { text: LONG, createdAt: "2026-07-01T00:00:00.000Z" });
    const b = task("b", 0, 200, { createdAt: "2026-07-02T00:00:00.000Z" });
    /* Collapsed, the two never touch — both hold. */
    const collapsed = resolveTaskPlacements([a, b], []);
    expect(collapsed.get("a")).toEqual({ x: 0, y: 0 });
    expect(collapsed.get("b")).toEqual({ x: 0, y: 200 });
    /* Expanded, a's grown box covers b: a holds (the user is reading it), b is
       displaced for display and the two clear each other. */
    const expanded = resolveTaskPlacements([a, b], [], new Set(["a"]));
    expect(expanded.get("a")).toEqual({ x: 0, y: 0 });
    expect(expanded.get("b")).not.toEqual({ x: 0, y: 200 });
    const rectA = { x: 0, y: 0, w: TASK_W, h: taskCardHeight(a, true) };
    const rectB = { ...expanded.get("b")!, w: TASK_W, h: taskCardHeight(b) };
    expect(clash(rectA, rectB, TASK_GUTTER - 1)).toBe(false);
  });

  test("collapsing restores the arrangement exactly (stored positions never change)", () => {
    const a = task("a", 0, 0, { text: LONG });
    const b = task("b", 0, 200);
    const before = resolveTaskPlacements([a, b], []);
    const after = resolveTaskPlacements([a, b], []);
    expect(after.get("a")).toEqual(before.get("a"));
    expect(after.get("b")).toEqual(before.get("b"));
  });

  test("a pinned card clear of the expanded box does not move", () => {
    const a = task("a", 0, 0, { text: LONG });
    const far = task("far", 2000, 0);
    const placement = resolveTaskPlacements([a, far], [], new Set(["a"]));
    expect(placement.get("far")).toEqual({ x: 2000, y: 0 });
  });

  test("two overlapping expanded cards resolve in creation order without overlap", () => {
    const a = task("a", 0, 0, { text: LONG, createdAt: "2026-07-01T00:00:00.000Z" });
    const b = task("b", 0, 200, { text: LONG, createdAt: "2026-07-02T00:00:00.000Z" });
    const placement = resolveTaskPlacements([a, b], [], new Set(["a", "b"]));
    expect(placement.get("a")).toEqual({ x: 0, y: 0 });
    const rectA = { x: 0, y: 0, w: TASK_W, h: taskCardHeight(a, true) };
    const rectB = { ...placement.get("b")!, w: TASK_W, h: taskCardHeight(b, true) };
    expect(clash(rectA, rectB, TASK_GUTTER - 1)).toBe(false);
  });

  test("an expanded card clears pane obstacles and expanded cards (Finding — P1)", () => {
    /* The reviewer's exact probe: a 126px collapsed card that fits above a pane,
       a 568px expanded box that would swallow the pane at y=200. The expanded
       card must relocate off the pane — the old path held its spot whenever it
       did not also collide another expanded card, covering the pane's controls. */
    const pane: SchemeRect = { x: 0, y: 200, w: 600, h: 680 };
    const a = task("a", 0, 0, { text: LONG });
    /* Collapsed, the card sits clear above the pane and holds its spot. */
    const collapsed = resolveTaskPlacements([a], [pane]);
    expect(collapsed.get("a")).toEqual({ x: 0, y: 0 });
    expect(clash({ x: 0, y: 0, w: TASK_W, h: taskCardHeight(a) }, pane, 0)).toBe(false);
    /* Expanded, the grown box would cover the pane — so it is nudged clear. */
    const expanded = resolveTaskPlacements([a], [pane], new Set(["a"]));
    expect(expanded.get("a")).not.toEqual({ x: 0, y: 0 });
    const rect = { ...expanded.get("a")!, w: TASK_W, h: taskCardHeight(a, true) };
    expect(clash(rect, pane, 0)).toBe(false);
  });

  test("an expanded auto card anchors instead of auto-flowing", () => {
    /* Reading an auto card must not let the auto pass slide it around. */
    const auto = task("auto", 740, 120, { text: LONG, source: SRC });
    expect(isAutoPlaceable(auto)).toBe(true);
    const placement = resolveTaskPlacements([auto], [], new Set(["auto"]));
    expect(placement.get("auto")).toEqual({ x: 740, y: 120 });
  });

  test("deterministic with expansions: permuting the input yields identical positions", () => {
    const tasks = [
      task("a", 0, 0, { text: LONG, createdAt: "2026-07-01T00:00:00.000Z" }),
      task("b", 0, 200, { createdAt: "2026-07-02T00:00:00.000Z" }),
      task("c", 0, 420, { createdAt: "2026-07-03T00:00:00.000Z" }),
    ];
    const expanded = new Set(["a"]);
    const forward = resolveTaskPlacements(tasks, [], expanded);
    const reversed = resolveTaskPlacements([...tasks].reverse(), [], expanded);
    for (const t of tasks) expect(reversed.get(t.id)).toEqual(forward.get(t.id));
  });
});
