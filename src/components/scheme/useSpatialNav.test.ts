import { describe, expect, test } from "bun:test";

import type { Camera } from "./Minimap";
import { GAP_X, NODE_W, type SchemeLayout, type SchemeRect } from "./layout";
import {
  collectNavTargets,
  keyToDir,
  nearestToViewportCenter,
  type NavDir,
  planReflow,
  pickDirectional,
} from "./spatialNav";

/* A minimal SchemeLayout-shaped stub: the nav decision logic only touches
   `byPath` and `nodes` (for labels), so the rest can stay empty. */
function layoutOf(rects: Record<string, SchemeRect>): SchemeLayout {
  const byPath = new Map<string, SchemeRect>(Object.entries(rects));
  return { byPath, nodes: [], edges: [], stacks: [], decks: [], loops: [], drafts: [], width: 0, height: 0 } as unknown as SchemeLayout;
}

const rect = (x: number, y: number, w = NODE_W, h = 680): SchemeRect => ({ x, y, w, h });

describe("keyToDir", () => {
  test("maps arrows and ignores everything else", () => {
    expect(keyToDir("ArrowUp")).toBe("up");
    expect(keyToDir("ArrowDown")).toBe("down");
    expect(keyToDir("ArrowLeft")).toBe("left");
    expect(keyToDir("ArrowRight")).toBe("right");
    expect(keyToDir("a")).toBeNull();
    expect(keyToDir(" ")).toBeNull();
  });
});

describe("planReflow — follow lifecycle", () => {
  test("a moved anchor translates by its exact world delta", () => {
    const plan = planReflow(rect(100, 100), rect(340, 190));
    expect(plan).toEqual({ kind: "translate", dx: 240, dy: 90 });
  });

  test("an anchor that left the layout drops follow", () => {
    expect(planReflow(rect(100, 100), null)).toEqual({ kind: "drop" });
    expect(planReflow(rect(100, 100), undefined)).toEqual({ kind: "drop" });
  });

  test("no prior baseline is a no-op (the select just seeded it)", () => {
    expect(planReflow(null, rect(100, 100))).toEqual({ kind: "none" });
  });

  test("sub-pixel jitter never triggers a glide", () => {
    expect(planReflow(rect(100, 100), rect(100.2, 99.8))).toEqual({ kind: "none" });
  });
});

/**
 * End-to-end state-machine simulation of the hook without a renderer: it drives
 * the same pure functions the hook calls, in the same order, so the traversal +
 * follow-translate + manual-disarm behaviour is covered as an integration.
 */
describe("nav state machine (hook logic simulation)", () => {
  const step = NODE_W + GAP_X;
  const cam: Camera = { x: 0, y: 0, z: 1 };
  const vp = { w: 1600, h: 900 };

  /* Mirrors the hook's onArrow selection + reflow bookkeeping. */
  function makeMachine(layout: SchemeLayout) {
    let selected: string | null = null;
    let follow = false;
    let prev: SchemeRect | null = null;
    const translates: { dx: number; dy: number }[] = [];
    return {
      get selected() {
        return selected;
      },
      get follow() {
        return follow;
      },
      get translates() {
        return translates;
      },
      seed(key: string) {
        selected = key;
        follow = true;
        prev = layout.byPath.get(key) ?? null;
      },
      arrow(dir: NavDir, live: SchemeLayout = layout, liveCam: Camera = cam) {
        const targets = collectNavTargets(live);
        const hasSel = follow && selected != null && targets.some((t) => t.key === selected);
        const pick = hasSel
          ? pickDirectional(targets, selected!, dir)
          : nearestToViewportCenter(targets, liveCam, vp, selected);
        if (pick) {
          selected = pick;
          follow = true;
          prev = live.byPath.get(pick) ?? null;
        }
        return pick;
      },
      reflow(live: SchemeLayout) {
        if (!follow || selected == null) return;
        const next = live.byPath.get(selected) ?? null;
        const plan = planReflow(prev, next);
        if (plan.kind === "drop") {
          follow = false;
          selected = null;
          prev = null;
        } else if (plan.kind === "translate") {
          translates.push({ dx: plan.dx, dy: plan.dy });
          prev = next;
        }
      },
      manualGesture() {
        follow = false;
        prev = null;
      },
    };
  }

  test("first Right selects the on-screen-centre window, then walks the row", () => {
    /* Row of three, camera centred so the middle one is at viewport centre. */
    const layout = layoutOf({ a: rect(0, 0), b: rect(step, 0), c: rect(step * 2, 0) });
    const centred: Camera = { x: vp.w / 2 - (step + NODE_W / 2), y: vp.h / 2 - 340, z: 1 };
    const targets = collectNavTargets(layout);
    /* First press with no selection lands on the centre window without stepping. */
    expect(nearestToViewportCenter(targets, centred, vp, null)).toBe("b");

    const m = makeMachine(layout);
    m.seed("a");
    expect(m.follow).toBe(true);
    expect(m.arrow("right")).toBe("b");
    expect(m.arrow("right")).toBe("c");
    expect(m.arrow("right")).toBeNull(); // edge holds the selection
    expect(m.selected).toBe("c");
  });

  test("a reflow under the anchor translates the camera to hold its screen spot", () => {
    const before = layoutOf({ a: rect(0, 0), b: rect(step, 0) });
    const m = makeMachine(before);
    m.seed("a");
    /* Freshness re-sort shifts every pane right by one slot. */
    const after = layoutOf({ a: rect(step, 0), b: rect(step * 2, 0) });
    m.reflow(after);
    expect(m.translates).toEqual([{ dx: step, dy: 0 }]);
    expect(m.selected).toBe("a"); // the anchor never left view
  });

  test("the anchor leaving the layout drops follow and the selection", () => {
    const before = layoutOf({ a: rect(0, 0), b: rect(step, 0) });
    const m = makeMachine(before);
    m.seed("a");
    const after = layoutOf({ b: rect(step, 0) }); // "a" closed
    m.reflow(after);
    expect(m.selected).toBeNull();
    expect(m.follow).toBe(false);
  });

  test("a manual gesture disarms follow so later reflows stop moving the camera", () => {
    const before = layoutOf({ a: rect(0, 0), b: rect(step, 0) });
    const m = makeMachine(before);
    m.seed("a");
    m.manualGesture(); // pan/wheel/pinch settle
    expect(m.follow).toBe(false);
    const after = layoutOf({ a: rect(step, 0), b: rect(step * 2, 0) });
    m.reflow(after);
    expect(m.translates).toEqual([]); // no camera write after re-baseline
  });

  test("the first Arrow after a manual gesture starts from the new viewport centre", () => {
    const layout = layoutOf({ a: rect(0, 0), b: rect(step, 0), c: rect(step * 2, 0) });
    const m = makeMachine(layout);
    m.seed("a");
    m.manualGesture();
    const centredOnC: Camera = { x: vp.w / 2 - (step * 2 + NODE_W / 2), y: vp.h / 2 - 340, z: 1 };

    expect(m.arrow("right", layout, centredOnC)).toBe("c");
    expect(m.selected).toBe("c");
    expect(m.follow).toBe(true);
  });
});
