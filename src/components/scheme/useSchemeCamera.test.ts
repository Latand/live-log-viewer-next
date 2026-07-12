import { describe, expect, test } from "bun:test";

import type { SchemeRect } from "./layout";
import { hasBoardContent } from "./useSchemeCamera";

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

  test("a truly empty board has no content", () => {
    expect(hasBoardContent(empty)).toBe(false);
    expect(hasBoardContent(empty, new Map())).toBe(false);
  });
});
