import { describe, expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import type { SchemeNode } from "./layout";
import { dragRect, nodesInRect, pruneSelection, rectsIntersect, screenRectToWorld, selectionBBox } from "./lasso";

function entry(path: string): FileEntry {
  return {
    path,
    root: "claude-projects",
    name: path,
    project: "demo",
    title: path,
    engine: "claude",
    kind: "сесія",
    fmt: "claude",
    parent: null,
    mtime: 1_000,
    size: 10,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

function node(path: string, x: number, y: number, w = 100, h = 80): SchemeNode {
  return { file: entry(path), tasks: [], under: [], isRoot: true, x, y, w, h };
}

describe("lasso geometry", () => {
  test("normalizes drags in both inverted axes", () => {
    expect(dragRect(40, 90, 10, 20)).toEqual({ x: 10, y: 20, w: 30, h: 70 });
    expect(dragRect(10, 90, 40, 20)).toEqual({ x: 10, y: 20, w: 30, h: 70 });
  });

  test("zero-area rect selects a node it sits inside", () => {
    expect(nodesInRect([node("/inside", 10, 10)], { x: 20, y: 20, w: 0, h: 0 })).toEqual(["/inside"]);
  });

  test("converts screen rects to world space under zoom and offsets", () => {
    expect(screenRectToWorld({ x: 60, y: 80, w: 50, h: 30 }, { x: 10, y: 20, z: 0.5 })).toEqual({
      x: 100,
      y: 120,
      w: 100,
      h: 60,
    });
    expect(screenRectToWorld({ x: 90, y: 54, w: 48, h: 32 }, { x: -6, y: 6, z: 1.6 })).toEqual({
      x: 60,
      y: 30,
      w: 30,
      h: 20,
    });
  });

  test("counts edge touch as intersection", () => {
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 4, w: 8, h: 8 })).toBe(true);
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 11, y: 4, w: 8, h: 8 })).toBe(false);
  });

  test("nodesInRect keeps input order and skips outside nodes", () => {
    const nodes = [node("/a", 0, 0), node("/b", 250, 0), node("/c", 50, 50)];
    expect(nodesInRect(nodes, { x: 40, y: 40, w: 30, h: 30 })).toEqual(["/a", "/c"]);
  });

  test("selectionBBox unions disjoint nodes and returns null for empty matches", () => {
    const nodes = [node("/a", 0, 10, 20, 30), node("/b", 80, 5, 40, 10), node("/c", 10, 80, 10, 10)];
    expect(selectionBBox(nodes, new Set(["/a", "/b"]))).toEqual({ x: 0, y: 5, w: 120, h: 35 });
    expect(selectionBBox(nodes, new Set(["/missing"]))).toBeNull();
  });

  test("pruneSelection preserves identity when unchanged and creates a smaller set when pruned", () => {
    const selected = new Set(["/a", "/b"]);
    const nodes = [node("/a", 0, 0), node("/b", 100, 0)];
    expect(pruneSelection(selected, nodes)).toBe(selected);

    const pruned = pruneSelection(selected, [nodes[0]!]);
    expect(pruned).not.toBe(selected);
    expect([...pruned]).toEqual(["/a"]);
  });
});
