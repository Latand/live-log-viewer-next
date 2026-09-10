import { describe, expect, test } from "bun:test";

import type { SchemeRect } from "./layout";
import { READABLE_Z, cameraMatchesFraming, cameraShowsWorld, centredCamera, fitCameraToRect, hasBoardContent, nodeIsFramed } from "./useSchemeCamera";

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

describe("nodeIsFramed — what a focus request actually asks (#1625)", () => {
  const view = { w: 1600, h: 1000 };
  /* A conversation pane on a band board: taller than it is wide, and at this
     zoom taller than a third of the viewport. */
  const pane: SchemeRect = { x: 68.9, y: 9336.9, w: 1034.5, h: 1172.4 };

  test("the camera centredCamera asks for frames the node it was computed from", () => {
    const cam = centredCamera(pane, 0.58, view);
    expect(nodeIsFramed(pane, cam, view)).toBe(true);
    /* Head near the top, so a pane taller than the viewport starts readable. */
    expect(cam.y + pane.y * cam.z).toBeCloseTo(view.h * 0.08 + 40 * 0.58, 6);
  });

  test("the rectangle the live board reported, under the camera it reported, is not framed", () => {
    /* The production reading: the requested conversation sat above the
       viewport, which is exactly the state the operator could not read. */
    expect(nodeIsFramed(pane, { x: -8, y: -6438.3056, z: 0.58 }, view)).toBe(false);
    /* And the aim taken against a provisional projection leaves it below. */
    expect(nodeIsFramed(pane, { x: -2.88, y: -2813.9344, z: 0.58 }, view)).toBe(false);
  });

  test("a pane taller than the viewport is framed by its head, not by fitting whole", () => {
    const tall: SchemeRect = { x: 0, y: 0, w: 600, h: 40_000 };
    expect(nodeIsFramed(tall, { x: 0, y: 100, z: 0.58 }, view)).toBe(true);
    /* One pixel of head showing at the bottom edge is not readable. */
    expect(nodeIsFramed(tall, { x: 0, y: view.h - 1, z: 0.58 }, view)).toBe(false);
  });

  test("a node pushed off the side is not framed even at the right height", () => {
    expect(nodeIsFramed(pane, { x: -3_000, y: -5_305.8, z: 0.58 }, view)).toBe(false);
    expect(nodeIsFramed(pane, { x: view.w + 10, y: -5_305.8, z: 0.58 }, view)).toBe(false);
  });

  test("an unmeasured viewport frames nothing, so a request stays owed", () => {
    expect(nodeIsFramed(pane, centredCamera(pane, 0.58, view), { w: 1, h: 1 })).toBe(false);
  });

  test("a board zoomed out to chips frames nothing, however well the rectangle lines up", () => {
    /* Perfectly placed and entirely on screen — and drawn as a chip, which is
       located rather than readable. The focus request is not satisfied by it. */
    const overview = centredCamera(pane, 0.2, view);
    expect(nodeIsFramed(pane, overview, view)).toBe(false);
    expect(nodeIsFramed(pane, centredCamera(pane, READABLE_Z, view), view)).toBe(true);
  });

  test("a sliver hanging off the side is not framed", () => {
    const framed = centredCamera(pane, 0.58, view);
    /* One pixel of the pane inside the right edge. */
    expect(nodeIsFramed(pane, { ...framed, x: framed.x + view.w }, view)).toBe(false);
    /* And one pixel inside the left edge. */
    expect(nodeIsFramed(pane, { ...framed, x: framed.x - view.w }, view)).toBe(false);
    /* Half of it across the edge still reads. */
    expect(nodeIsFramed(pane, { ...framed, x: framed.x - pane.w * 0.58 / 2 }, view)).toBe(true);
  });
});
