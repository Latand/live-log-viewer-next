import { describe, expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import type { SchemeLayout } from "./layout";
import { boardClusters, offscreenClusterChips, type BoardCluster } from "./offscreenClusters";

const cam = { x: 0, y: 0, z: 1 };
const vp = { w: 1_000, h: 700 };
const cluster = (key: string, x: number, y: number, priority = 1): BoardCluster => ({
  key,
  label: key,
  rect: { x, y, w: 100, h: 100 },
  priority,
  color: "red",
});

describe("board clusters", () => {
  test("wayfinding chips represent work regions only — task navigation lives in the reserved relation controls", () => {
    const live: FileEntry = {
      path: "/live.jsonl", root: "codex-sessions", name: "live.jsonl", project: "project", title: "Live agent",
      engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1, size: 1, activity: "live",
      proc: "running", pid: 1, model: null, pendingQuestion: null, waitingInput: null,
    };
    const layout = {
      groups: [],
      nodes: [{ x: 0, y: 0, w: 600, h: 780, file: live, isRoot: true }],
      stacks: [], decks: [], drafts: [], slots: [],
    } as unknown as SchemeLayout;
    const clusters = boardClusters(layout, new Set<string>());
    expect(clusters.map((cluster) => cluster.key)).toEqual(["/live.jsonl"]);
    expect(clusters.some((cluster) => cluster.key.startsWith("task::"))).toBe(false);
  });
});

describe("offscreen cluster chips", () => {
  test("uses the viewport edge crossed by the center-to-cluster ray", () => {
    const chips = offscreenClusterChips([
      cluster("right", 1_500, 300),
      cluster("left", -700, 300),
      cluster("top", 450, -700),
      cluster("bottom", 450, 1_200),
    ], cam, vp);
    expect(Object.fromEntries(chips.visible.map((chip) => [chip.cluster.key, chip.edge]))).toEqual({
      bottom: "bottom",
      left: "left",
      right: "right",
      top: "top",
    });
  });

  test("omits on-screen clusters and represents every off-screen cluster once", () => {
    const input = [cluster("inside", 100, 100), ...Array.from({ length: 7 }, (_, index) => cluster(`r${index}`, 1_300 + index * 20, 200, 7 - index))];
    const chips = offscreenClusterChips(input, cam, vp, 4);
    const represented = [...chips.visible, ...chips.overflow].map((item) => item.cluster.key);
    expect(chips.visible).toHaveLength(4);
    expect(chips.overflow).toHaveLength(3);
    expect(new Set(represented).size).toBe(7);
    expect(represented).not.toContain("inside");
  });

  test("priority and key ties are deterministic across input order", () => {
    const input = [cluster("b", 1_400, 100, 2), cluster("a", 1_400, 200, 2), cluster("urgent", 1_400, 300, 9)];
    const forward = offscreenClusterChips(input, cam, vp, 2);
    const reverse = offscreenClusterChips([...input].reverse(), cam, vp, 2);
    expect(forward.visible.map((chip) => chip.cluster.key)).toEqual(["urgent", "a"]);
    expect(reverse).toEqual(forward);
  });
});

describe("pane-overlap folding (issue #292: navigation chips never cover chat content)", () => {
  test("a chip whose pill would paint over a conversation pane folds into the edge overflow", () => {
    /* A focused pane fills the whole viewport — production shape from the
       rejection screenshot: left-edge task chips floated over the transcript. */
    const fullPane = { x: 0, y: 0, w: 1_000, h: 700 };
    const chips = offscreenClusterChips([cluster("left-task", -700, 300)], cam, vp, 4, [fullPane]);
    expect(chips.visible).toHaveLength(0);
    expect(chips.overflow.map((chip) => chip.cluster.key)).toEqual(["left-task"]);
  });

  test("a pane elsewhere on screen leaves a non-overlapping chip visible", () => {
    /* Pane in the right half; the left-edge chip band stays free. */
    const rightPane = { x: 500, y: 0, w: 500, h: 700 };
    const chips = offscreenClusterChips([cluster("left-task", -700, 300)], cam, vp, 4, [rightPane]);
    expect(chips.visible.map((chip) => chip.cluster.key)).toEqual(["left-task"]);
    expect(chips.overflow).toHaveLength(0);
  });

  test("folding respects the camera projection of the obstacle", () => {
    /* World-space pane at the viewport's left edge only after the camera pans. */
    const pane = { x: 2_000, y: 0, w: 500, h: 700 };
    const panned = { x: -2_000, y: 0, z: 1 };
    const chips = offscreenClusterChips(
      [cluster("left-task", 1_000, 300)],
      panned,
      vp,
      4,
      [{ x: pane.x * panned.z + panned.x, y: pane.y, w: pane.w, h: pane.h }],
    );
    expect(chips.visible).toHaveLength(0);
    expect(chips.overflow).toHaveLength(1);
  });
});
