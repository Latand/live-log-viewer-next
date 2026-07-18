import { describe, expect, test } from "bun:test";

import type { SchemeRect } from "./layout";
import { cameraMatchesFraming, fitCameraToRect, hasBoardContent } from "./useSchemeCamera";

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
