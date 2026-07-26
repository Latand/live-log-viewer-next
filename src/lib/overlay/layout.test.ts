import { expect, test } from "bun:test";

import {
  ARRANGEMENT_THRESHOLD,
  arrangementFor,
  composerArrangement,
  DESKTOP_IDENTITY_DOT,
  DESKTOP_MIC_SIZE,
  desktopBands,
  DOCK_WIDTH,
  MOBILE_IDENTITY_DOT,
  MOBILE_MIC_SIZE,
  MOBILE_SECONDARY_SIZE,
  nextSnap,
  PIP_DEFAULT_SIZE,
  sheetBands,
  sheetHeights,
  snapForAttentionRequest,
  viewerVisibleHeight,
  type SheetSnap,
} from "./layout";

/* The phone the design is specified against: 390×844 with a 34px bottom inset. */
const USABLE = 844 - 34;

test("the arrangement switches on measured height, with no mode to keep in sync", () => {
  expect(arrangementFor(PIP_DEFAULT_SIZE.height)).toBe("compact");
  expect(arrangementFor(ARRANGEMENT_THRESHOLD - 1)).toBe("compact");
  expect(arrangementFor(ARRANGEMENT_THRESHOLD)).toBe("expanded");
  expect(arrangementFor(560)).toBe("expanded");
});

test("the opening window budgets the timeline exactly the design's 108px", () => {
  const bands = desktopBands(PIP_DEFAULT_SIZE.height, false);

  expect(bands).toEqual({ header: 36, timeline: 108, actionRow: 0, composer: 44 });
});

test("an action row appears only when something needs an answer, and costs the timeline", () => {
  const quiet = desktopBands(PIP_DEFAULT_SIZE.height, false);
  const asking = desktopBands(PIP_DEFAULT_SIZE.height, true);

  expect(asking.actionRow).toBe(40);
  expect(asking.timeline).toBe(quiet.timeline - 40);
});

test("expanding gives every new pixel to the timeline, and nothing else", () => {
  const compact = desktopBands(300, false);
  const expanded = desktopBands(560, false);

  expect(expanded.header).toBe(compact.header);
  expect(expanded.composer).toBe(compact.composer);
  expect(expanded.timeline - compact.timeline).toBe(260);
});

test("the dock is the same width as the window, so crossing the boundary reflows nothing", () => {
  expect(DOCK_WIDTH).toBe(PIP_DEFAULT_SIZE.width);
});

test("the three snaps match the design, and Full still leaves a peek of the Viewer", () => {
  const heights = sheetHeights(USABLE);

  expect(heights).toEqual({ rail: 64, half: 364, full: 745 });
  /* Half leaves the operator at least 55% of the screen for the work. */
  expect(viewerVisibleHeight(USABLE, "half")).toBe(446);
  expect(viewerVisibleHeight(USABLE, "half") / USABLE).toBeGreaterThanOrEqual(0.55);
  /* The peek at Full is the return affordance: the Viewer never fully vanishes. */
  expect(viewerVisibleHeight(USABLE, "full")).toBe(65);
  expect(viewerVisibleHeight(USABLE, "full")).toBeGreaterThan(0);
});

test("the sheet's internal bands match the design at Half and at Full", () => {
  const heights = sheetHeights(USABLE);

  expect(sheetBands(heights.half, false)).toEqual({ header: 44, timeline: 256, actionRow: 0, composer: 64 });
  /* Full is the only snap where the timeline is long enough to read back. */
  expect(sheetBands(heights.full, true)).toEqual({ header: 44, timeline: 589, actionRow: 48, composer: 64 });
});

test("a gesture never jumps two snaps", () => {
  expect(nextSnap("rail", "drag-up")).toBe("half");
  expect(nextSnap("half", "drag-up")).toBe("full");
  expect(nextSnap("full", "drag-down")).toBe("half");
  expect(nextSnap("half", "drag-down")).toBe("rail");
  /* And the ends are ends. */
  expect(nextSnap("full", "drag-up")).toBe("full");
  expect(nextSnap("rail", "drag-down")).toBe("rail");
});

test("tapping the state row is the Rail-Half toggle, and steps down one from Full", () => {
  expect(nextSnap("rail", "tap-state-row")).toBe("half");
  expect(nextSnap("half", "tap-state-row")).toBe("rail");
  expect(nextSnap("full", "tap-state-row")).toBe("half");
});

test("an attention request lowers the sheet and never raises it", () => {
  /* If a handoff moves the sheet at all it moves it down, so the thing the
     operator is being pointed at is the thing they can see. */
  expect(snapForAttentionRequest("full")).toBe("half");
  expect(snapForAttentionRequest("half")).toBe("half");
  expect(snapForAttentionRequest("rail")).toBe("rail");
});

test("only one composer is ever expanded", () => {
  /* Focusing the worker's input drops the root sheet out of the way. */
  expect(composerArrangement("full", "worker")).toEqual({ snap: "rail", workerComposer: "expanded" });
  /* Raising the root sheet collapses the worker's composer to a chip. */
  expect(composerArrangement("half", "root")).toEqual({ snap: "half", workerComposer: "chip" });
  expect(composerArrangement("rail", "root")).toEqual({ snap: "half", workerComposer: "chip" });
});

test.each<SheetSnap[]>([["rail"], ["half"], ["full"]])("two expanded composers are unreachable from %s", (snap) => {
  for (const focus of ["root", "worker"] as const) {
    const arrangement = composerArrangement(snap, focus);
    const rootExpanded = arrangement.snap !== "rail";
    expect(rootExpanded && arrangement.workerComposer === "expanded").toBe(false);
  }
});

test("mobile controls are larger than desktop, deliberately", () => {
  expect(MOBILE_MIC_SIZE).toBeGreaterThan(DESKTOP_MIC_SIZE);
  expect(MOBILE_IDENTITY_DOT).toBeGreaterThan(DESKTOP_IDENTITY_DOT);
  /* The existing mobile focus strip uses 44px targets; the root conversation's
     are the ones reached for one-handed while looking elsewhere. */
  expect(MOBILE_SECONDARY_SIZE).toBeGreaterThanOrEqual(48);
});
