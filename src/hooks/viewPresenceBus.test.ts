import { expect, test } from "bun:test";

import type { SchemeLayout } from "@/components/scheme/layout";
import { MAX_SELECTED_PATHS } from "@/lib/view/types";

import {
  cameraToPresence,
  createViewBus,
  mergeView,
  OVERVIEW_CONTEXT,
  OVERVIEW_SLICE,
  orderedSelection,
  schemeFocusedPath,
  schemeVisiblePaths,
  UNAVAILABLE_BOARD,
  worldRectFor,
  type ViewSlice,
} from "./viewPresenceBus";

const node = (path: string, x: number, y: number, w = 100, h = 100) =>
  ({ file: { path }, tasks: [], under: [], isRoot: false, x, y, w, h }) as unknown as SchemeLayout["nodes"][number];

const layoutOf = (...nodes: SchemeLayout["nodes"]): SchemeLayout => ({ nodes }) as unknown as SchemeLayout;

const vp = { w: 800, h: 600 };

test("worldRect solves screen = world*zoom + camera for both viewport corners", () => {
  const cam = { x: -200, y: -100, z: 2 };
  const rect = worldRectFor(cam, vp);
  /* screen (0,0) → world (100,50); screen (800,600) spans 400x300 in world. */
  expect(rect).toEqual({ x: 100, y: 50, width: 400, height: 300 });
  const presence = cameraToPresence(cam, vp);
  expect(presence).toEqual({ x: -200, y: -100, zoom: 2, worldRect: rect });
});

test("visible paths are the camera-intersecting nodes in layout order", () => {
  const layout = layoutOf(node("a", 0, 0), node("b", 500, 0), node("c", 5000, 0));
  /* Camera framing world x∈[0,800): a and b intersect, c is far off-screen. */
  const cam = { x: 0, y: 0, z: 1 };
  expect(schemeVisiblePaths(layout, cam, vp, 128)).toEqual(["a", "b"]);
});

test("visible paths cap drops the freshest-last nodes", () => {
  const layout = layoutOf(node("a", 0, 0), node("b", 100, 0), node("c", 200, 0));
  const cam = { x: 0, y: 0, z: 1 };
  expect(schemeVisiblePaths(layout, cam, vp, 2)).toEqual(["a", "b"]);
});

test("selection is reported in visual (layout) order regardless of set insertion", () => {
  const layout = layoutOf(node("a", 0, 0), node("b", 100, 0), node("c", 200, 0));
  expect(orderedSelection(layout, new Set(["c", "a"]))).toEqual(["a", "c"]);
  expect(orderedSelection(layout, new Set())).toEqual([]);
  /* A selected path no longer on the board drops out. */
  expect(orderedSelection(layout, new Set(["a", "gone"]))).toEqual(["a"]);
});

test("selection is capped at MAX_SELECTED_PATHS in visual order before publishing", () => {
  /* A marquee over more panes than the server accepts (65 > 64) must not make
     every presence POST 400 — the bus caps it in layout order. */
  const nodes = Array.from({ length: 70 }, (_, i) => node(`p${String(i).padStart(2, "0")}`, i * 100, 0));
  const layout = layoutOf(...nodes);
  const all = new Set(nodes.map((n) => n.file.path));
  const out = orderedSelection(layout, all);
  expect(out.length).toBe(MAX_SELECTED_PATHS);
  /* Kept the freshest-first (left) run; dropped the freshest-last off the right. */
  expect(out[0]).toBe("p00");
  expect(out.at(-1)).toBe(`p${String(MAX_SELECTED_PATHS - 1).padStart(2, "0")}`);
});

test("focus precedence: expanded overlay wins over a real transcript ring", () => {
  const transcripts = new Set(["/x", "/y"]);
  expect(schemeFocusedPath("/x", "/y", transcripts)).toBe("/x");
  expect(schemeFocusedPath(null, "/y", transcripts)).toBe("/y");
  expect(schemeFocusedPath(null, null, transcripts)).toBeNull();
});

test("a ring on a virtual layout key focuses nothing (never leaks PATH_OUTSIDE_CURRENT_VIEW)", () => {
  /* Spatial nav rings deck/stack/draft keys, which are not scanner transcripts;
     publishing one as focusedPath makes composeSnapshot reject the whole
     snapshot, so schemeFocusedPath filters them to null. */
  const transcripts = new Set(["/a", "/b"]);
  expect(schemeFocusedPath(null, "deck::flow-1", transcripts)).toBeNull();
  expect(schemeFocusedPath(null, "/a::stack", transcripts)).toBeNull();
  expect(schemeFocusedPath(null, "draft::123", transcripts)).toBeNull();
  /* A real transcript ring still publishes, and an overlay still wins even when
     the ring underneath it is a virtual key. */
  expect(schemeFocusedPath(null, "/a", transcripts)).toBe("/a");
  expect(schemeFocusedPath("/b", "deck::flow-1", transcripts)).toBe("/b");
});

test("mergeView takes the slice viewport when present, else the window viewport", () => {
  const windowVp = { width: 1000, height: 900, dpr: 1 };
  const slice: ViewSlice = { mode: "scheme", focusedPath: "a", selectedPaths: ["a"], visiblePaths: ["a", "b"], camera: cameraToPresence({ x: 0, y: 0, z: 1 }, vp), viewport: { width: 800, height: 600, dpr: 2 } };
  const merged = mergeView({ project: "proj", board: UNAVAILABLE_BOARD }, slice, windowVp);
  expect(merged.project).toBe("proj");
  expect(merged.viewport).toEqual({ width: 800, height: 600, dpr: 2 });
  const overview = mergeView(OVERVIEW_CONTEXT, OVERVIEW_SLICE, windowVp);
  expect(overview.viewport).toEqual(windowVp);
  expect(overview.mode).toBe("overview");
  expect(overview.camera).toBeNull();
});

test("the bus notifies only on a real change and merges context under the slice", () => {
  const bus = createViewBus();
  let notifications = 0;
  bus.subscribe(() => (notifications += 1));
  bus.reportContext({ project: "p", board: UNAVAILABLE_BOARD });
  bus.reportContext({ project: "p", board: UNAVAILABLE_BOARD }); // identical → dropped
  bus.reportSlice({ mode: "list", focusedPath: null, selectedPaths: [], visiblePaths: ["a"], camera: null });
  expect(notifications).toBe(2);
  const merged = mergeView(bus.getContext(), bus.getSlice(), { width: 1, height: 1, dpr: 1 });
  expect(merged.project).toBe("p");
  expect(merged.mode).toBe("list");
  expect(merged.visiblePaths).toEqual(["a"]);
});
