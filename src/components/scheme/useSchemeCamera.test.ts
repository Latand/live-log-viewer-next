import { describe, expect, test } from "bun:test";

import type { SchemeRect } from "./layout";
import { cameraMatchesFraming, cameraShowsWorld, fitCameraToRect, hasBoardContent } from "./useSchemeCamera";

const empty = { nodes: [], drafts: [] };
const rect: SchemeRect = { x: 0, y: 0, w: 260, h: 100 };

describe("hasBoardContent — task cards are board content (issue #17)", () => {
  test("a project with only task cards has content, so the camera fits", () => {
    const taskRects = new Map<string, SchemeRect>([["task::a", rect]]);
    expect(hasBoardContent(empty, taskRects)).toBe(true);
  });

  test("nodes alone, drafts alone, or tasks alone each count", () => {
    expect(hasBoardContent({ nodes: [rect as never], drafts: [] })).toBe(true);
    expect(hasBoardContent({ nodes: [], drafts: [rect as never] })).toBe(true);
    expect(hasBoardContent(empty, new Map([["t", rect]]))).toBe(true);
  });

  test("a compact memberless pipeline group counts as board content", () => {
    expect(hasBoardContent({ nodes: [], drafts: [], groups: [rect as never] })).toBe(true);
  });

  test("a board whose only content is a PipelineGroup still initializes and fits", () => {
    const pipelineRects = new Map<string, SchemeRect>([["pipeline-a", rect]]);
    expect(hasBoardContent(empty, new Map(), pipelineRects)).toBe(true);
  });

  test("a truly empty board has no content", () => {
    expect(hasBoardContent(empty)).toBe(false);
    expect(hasBoardContent(empty, new Map())).toBe(false);
  });
});

describe("fit camera geometry (#343)", () => {
  test("current-work framing is at least as close as Fit All", () => {
    const vp = { w: 1200, h: 800 };
    const current = fitCameraToRect({ x: 100, y: 100, w: 600, h: 680 }, vp);
    const all = fitCameraToRect({ x: 0, y: 0, w: 5_000, h: 3_000 }, vp);
    expect(current.z).toBeGreaterThanOrEqual(all.z);
  });

  test("the fitted camera is recognized within the repeated-zero tolerance", () => {
    const target = fitCameraToRect({ x: 100, y: 100, w: 600, h: 680 }, { w: 1200, h: 800 });
    expect(cameraMatchesFraming(target, target)).toBe(true);
    expect(cameraMatchesFraming({ ...target, z: target.z * 1.02 }, target)).toBe(false);
    expect(cameraMatchesFraming({ ...target, x: target.x + 8 }, target)).toBe(false);
  });
});

describe("a restored camera must still show the world (#1614)", () => {
  const vp = { w: 1400, h: 900 };
  /* The board the operator opened: a 390-task band stack, tens of thousands of
     pixels tall, and the camera saved far down it. */
  const tallWorld: SchemeRect = { x: 0, y: 0, w: 1400, h: 40_000 };
  const savedFarDown = { x: 0, y: -25_239.92, z: 1.6 };

  test("the saved camera is kept while its own world still stands", () => {
    expect(cameraShowsWorld(savedFarDown, tallWorld, vp)).toBe(true);
  });

  test("the same camera frames nothing once the empty bands leave the board", () => {
    /* What the one-time migration leaves: 80 bands instead of 368. */
    expect(cameraShowsWorld(savedFarDown, { x: 0, y: 0, w: 1400, h: 9_000 }, vp)).toBe(false);
  });

  test("a world smaller than the viewport is not treated as off-world", () => {
    const small: SchemeRect = { x: 0, y: 0, w: 520, h: 240 };
    expect(cameraShowsWorld({ x: 40, y: 40, z: 1 }, small, vp)).toBe(true);
    /* Even scrolled to the very edge, as far as `clampCam` allows. */
    expect(cameraShowsWorld({ x: vp.w - 130, y: vp.h - 130, z: 1 }, small, vp)).toBe(true);
    expect(cameraShowsWorld({ x: vp.w + 10, y: 40, z: 1 }, small, vp)).toBe(false);
  });

  test("a world with a negative origin is measured from where it actually is", () => {
    const shifted: SchemeRect = { x: -4_000, y: -4_000, w: 1_000, h: 1_000 };
    expect(cameraShowsWorld({ x: 4_200, y: 4_200, z: 1 }, shifted, vp)).toBe(true);
    expect(cameraShowsWorld({ x: 0, y: 0, z: 1 }, shifted, vp)).toBe(false);
  });

  test("an unmeasured viewport cannot judge and does not veto a restore", () => {
    expect(cameraShowsWorld(savedFarDown, { x: 0, y: 0, w: 1400, h: 9_000 }, { w: 1, h: 1 })).toBe(true);
  });
});
