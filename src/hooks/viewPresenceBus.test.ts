import { expect, test } from "bun:test";

import type { SchemeLayout } from "@/components/scheme/layout";
import { MAX_SELECTED_PATHS } from "@/lib/view/types";
import { validatePresence } from "@/lib/view/validation";

import {
  cameraToPresence,
  createViewBus,
  mergeView,
  OVERVIEW_CONTEXT,
  OVERVIEW_SLICE,
  orderedSelection,
  selectionInOrder,
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

test("one selection, three per-view orders — the #771 publication contract", () => {
  const selected = new Set(["/c", "/a", "/b"]);
  /* The SAME set, published by three views. The scheme walks its layout nodes,
     the list its rows, the phone its own board order. Each order is that view's
     render order; the stored set is never reordered by publishing it. */
  const scheme = layoutOf(node("/a", 0, 0), node("/b", 100, 0), node("/c", 200, 0));
  expect(orderedSelection(scheme, selected)).toEqual(["/a", "/b", "/c"]);
  expect(selectionInOrder(["/c", "/b", "/a"], selected)).toEqual(["/c", "/b", "/a"]);
  expect(selectionInOrder(["/b", "/c", "/a"], selected)).toEqual(["/b", "/c", "/a"]);
  expect([...selected]).toEqual(["/c", "/a", "/b"]);
});

test("the scheme omits a member its board does not place, and that is the only omitting view", () => {
  const selected = new Set(["/a", "/b"]);
  /* Omission from the scheme's order is not removal from the set: the canonical
     selection outlives every view (see pruneSelection). */
  expect(selectionInOrder(["/a"], selected)).toEqual(["/a"]);
  expect(selectionInOrder([], selected)).toEqual([]);
  expect(selectionInOrder(["/x", "/b"], selected)).toEqual(["/b"]);
});

test("the list and the phone publish the WHOLE set — a member with no row is appended", () => {
  const selected = new Set(["/root", "/root/subagents/leaf"]);
  /* The real case: the flat list only lists ROOT conversations, so a selected
     subagent leaf appears in no row. Dropping it there would make a mode switch
     read as "the operator deselected everything" — the #771 regression itself. */
  expect(selectionInOrder(["/root"], selected, { includeUnordered: true })).toEqual(["/root", "/root/subagents/leaf"]);
  /* View-ordered members first, in the view's order; the rest in the set's order. */
  expect(selectionInOrder(["/root/subagents/leaf"], selected, { includeUnordered: true })).toEqual(["/root/subagents/leaf", "/root"]);
  /* A view that renders none of them still publishes all of them. */
  expect(selectionInOrder([], selected, { includeUnordered: true })).toEqual(["/root", "/root/subagents/leaf"]);
  /* An empty selection stays empty — nothing is invented. */
  expect(selectionInOrder(["/root"], new Set(), { includeUnordered: true })).toEqual([]);
  /* An order naming the same path twice must not publish it twice. */
  expect(selectionInOrder(["/root", "/root"], selected, { includeUnordered: true })).toEqual(["/root", "/root/subagents/leaf"]);
});

test("the cap holds across both phases of the complete projection", () => {
  const paths = Array.from({ length: 70 }, (_, i) => `/p${String(i).padStart(2, "0")}`);
  const all = new Set(paths);
  /* Only two paths are in this view's order; the appended remainder must still
     stop at the cap the server enforces. */
  const out = selectionInOrder(["/p69", "/p68"], all, { includeUnordered: true });
  expect(out.length).toBe(MAX_SELECTED_PATHS);
  expect(out.slice(0, 2)).toEqual(["/p69", "/p68"]);
  expect(new Set(out).size).toBe(out.length);
});

test("every view's projection is capped at MAX_SELECTED_PATHS in that view's order", () => {
  const paths = Array.from({ length: 70 }, (_, i) => `/p${String(i).padStart(2, "0")}`);
  const all = new Set(paths);
  const reversed = selectionInOrder([...paths].reverse(), all);
  expect(reversed.length).toBe(MAX_SELECTED_PATHS);
  /* The cap follows the ORDER, not the set: reversed order keeps the other end. */
  expect(reversed[0]).toBe("/p69");
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

test("the phone publishes one mode, mobile-focus; the map-lite mode is retired with the map (mobile v2 lane 10)", () => {
  const payload = {
    schemaVersion: 1, viewSessionId: "view-session-a", deviceId: "device-a",
    device: { kind: "mobile", browser: "chrome" }, visibility: "visible", sequence: 1, inputSequence: 0,
    project: "p", mode: "mobile-focus", viewport: { width: 390, height: 844, dpr: 2 }, camera: null,
    focusedPath: null, selectedPaths: [], visiblePaths: [], board: UNAVAILABLE_BOARD,
  };
  expect(validatePresence(payload).mode).toBe("mobile-focus");
  /* The server refuses the retired mode, so no stale leaf can report it. */
  expect(() => validatePresence({ ...payload, mode: "mobile-map" })).toThrow(/mode/);
  /* And the type no longer admits it, so no leaf can be written to report it. */
  // @ts-expect-error — "mobile-map" left the ViewMode union with the map (README §6, §8 row 10)
  const slice: ViewSlice = { mode: "mobile-map", focusedPath: null, selectedPaths: [], visiblePaths: [], camera: null };
  expect(slice.mode as string).toBe("mobile-map");
});
