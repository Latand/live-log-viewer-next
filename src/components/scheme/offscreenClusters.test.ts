import { describe, expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import type { SchemeLayout } from "./layout";
import { boardClusters, CHIP_MIN_W, chipRevealWidth, offscreenClusterChips, screenKeepoutObstacles, type BoardCluster } from "./offscreenClusters";

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

  test("keeps title text beyond the resting chip segment for progressive reveal", () => {
    const title = "Repair durable pipeline ownership while preserving every queued reviewer conversation title";
    const live: FileEntry = {
      path: "/long-title.jsonl", root: "codex-sessions", name: "long-title.jsonl", project: "project", title,
      engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1, size: 1, activity: "live",
      proc: "running", pid: 1, model: null, pendingQuestion: null, waitingInput: null,
    };
    const layout = {
      groups: [],
      nodes: [{ x: 0, y: 0, w: 600, h: 780, file: live, isRoot: true }],
      stacks: [], decks: [], drafts: [], slots: [],
    } as unknown as SchemeLayout;

    expect(boardClusters(layout, new Set<string>())[0]?.label).toBe(title);
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

describe("corner reveal geometry (issue #474: a positive, collision-safe reveal width or fold)", () => {
  /* A top/bottom chip is centered on its anchor, so near a viewport corner its
     reveal band has ~0 horizontal room: it can never paint a usable pill, and a
     zero-width reserved box also slips past every obstacle. Such a chip must
     fold into the edge «+N» aggregate, never reserve a sub-minimal sliver. */
  test("a top chip pinned into a corner folds into overflow instead of reserving a sliver", () => {
    /* Off-screen up-left: its center-to-corner ray crosses the *top* edge at
       x≈CHIP_EDGE_PAD (the left corner), where chipRevealWidth is ~0. */
    const chips = offscreenClusterChips([cluster("top-corner", -643, -500)], cam, vp);
    expect(chips.visible).toHaveLength(0);
    expect(chips.overflow.map((chip) => chip.cluster.key)).toEqual(["top-corner"]);
  });

  test("a bottom chip pinned into a corner also folds", () => {
    const chips = offscreenClusterChips([cluster("bottom-corner", -643, 1_100)], cam, vp);
    expect(chips.visible).toHaveLength(0);
    expect(chips.overflow.map((chip) => chip.cluster.key)).toEqual(["bottom-corner"]);
  });

  test("a top chip clear of both corners keeps its full reveal band and stays visible", () => {
    const chips = offscreenClusterChips([cluster("top-center", 450, -700)], cam, vp);
    expect(chips.visible.map((chip) => chip.cluster.key)).toEqual(["top-center"]);
    const { edge, x } = chips.visible[0]!;
    expect(chipRevealWidth(edge, x, vp)).toBeGreaterThanOrEqual(CHIP_MIN_W);
  });

  test("every admitted chip around every edge and both corners reserves at least the minimum collision-safe reveal width", () => {
    /* A dense ring of off-screen clusters aimed at every edge and both corners:
       whichever survive as visible must each reserve a positive, at-least-
       minimum band — the corner-pinned ones fold instead. */
    const ring: BoardCluster[] = [];
    for (let angle = 0; angle < 360; angle += 12) {
      const rad = (angle * Math.PI) / 180;
      ring.push(cluster(`ring-${angle}`, Math.round(500 + Math.cos(rad) * 4_000), Math.round(350 + Math.sin(rad) * 4_000)));
    }
    const chips = offscreenClusterChips(ring, cam, vp, 99);
    expect(chips.visible.length).toBeGreaterThan(0);
    for (const chip of chips.visible) {
      expect(chipRevealWidth(chip.edge, chip.x, vp)).toBeGreaterThanOrEqual(CHIP_MIN_W);
    }
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
    /* Pane clear of the left-edge chip's fully-revealed band (CHIP_MAX_W wide
       from x≈22): the left chip stays visible. */
    const rightPane = { x: 560, y: 0, w: 440, h: 700 };
    const chips = offscreenClusterChips([cluster("left-task", -700, 300)], cam, vp, 4, [rightPane]);
    expect(chips.visible.map((chip) => chip.cluster.key)).toEqual(["left-task"]);
    expect(chips.overflow).toHaveLength(0);
  });

  test("reserves the fully-revealed width: a chip whose unfurled label would cover a pane folds, even though its resting pill would clear it", () => {
    /* Obstacle sits past the resting pill but inside the reveal budget: a chip
       that looks clear at rest would paint its unfurled label over the pane, so
       collision geometry must reserve the revealed width and fold it (#474). */
    const paneInRevealBand = { x: 300, y: 330, w: 120, h: 40 };
    const chips = offscreenClusterChips([cluster("left-task", -700, 300)], cam, vp, 4, [paneInRevealBand]);
    expect(chips.visible).toHaveLength(0);
    expect(chips.overflow.map((chip) => chip.cluster.key)).toEqual(["left-task"]);
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

describe("fixed-chrome keep-out (issue #474: chips never paint over the subagent avatar/round stack or the composer)", () => {
  test("screenKeepoutObstacles translates viewport rects into chip-local space", () => {
    /* Board container's screen origin is (200, 80); a subagent avatar at screen
       (210, 300) lands at chip-local (10, 220). */
    const local = screenKeepoutObstacles({ left: 200, top: 80 }, [{ left: 210, top: 300, width: 30, height: 120 }], vp);
    expect(local).toEqual([{ x: 10, y: 220, w: 30, h: 120 }]);
  });

  test("screenKeepoutObstacles drops zero-area and fully off-viewport chrome", () => {
    const local = screenKeepoutObstacles({ left: 200, top: 80 }, [
      { left: 210, top: 300, width: 0, height: 120 }, // collapsed
      { left: 100, top: 80, width: 40, height: 100 }, // entirely left of the board (x+w ≤ 0)
      { left: 210, top: 300, width: 30, height: 120 }, // real
    ], vp);
    expect(local).toEqual([{ x: 10, y: 220, w: 30, h: 120 }]);
  });

  test("a left chip whose revealed band overlaps the subagent avatar rail folds into overflow", () => {
    /* The off-screen card's avatar/round stack pokes into the viewport at the
       left edge (a screen-space keep-out, x≈8–46). The left chip's reserved
       reveal band starts at x≈22 and would paint over it, so it folds. */
    const rail = screenKeepoutObstacles({ left: 0, top: 0 }, [{ left: 8, top: 280, width: 38, height: 160 }], vp);
    const chips = offscreenClusterChips([cluster("left-task", -700, 300)], cam, vp, 4, rail);
    expect(chips.visible).toHaveLength(0);
    expect(chips.overflow.map((chip) => chip.cluster.key)).toEqual(["left-task"]);
  });

  test("a low left chip whose band overlaps the composer/input folds into overflow", () => {
    /* Composer docked at the bottom-left; a left-edge chip anchored low would
       paint its revealed band over it, so it folds. */
    const composer = screenKeepoutObstacles({ left: 0, top: 0 }, [{ left: 0, top: 620, width: 340, height: 70 }], vp);
    const chips = offscreenClusterChips([cluster("left-low-task", -350, 796)], cam, vp, 4, composer);
    expect(chips.visible).toHaveLength(0);
    expect(chips.overflow.map((chip) => chip.cluster.key)).toEqual(["left-low-task"]);
  });

  test("a chip clear of the avatar rail and composer stays visible", () => {
    /* Keep-out chrome sits in the bottom-left; a right-edge chip is untouched. */
    const keepout = screenKeepoutObstacles({ left: 0, top: 0 }, [{ left: 8, top: 280, width: 38, height: 160 }], vp);
    const chips = offscreenClusterChips([cluster("right-task", 1_700, 300)], cam, vp, 4, keepout);
    expect(chips.visible.map((chip) => chip.cluster.key)).toEqual(["right-task"]);
    expect(chips.overflow).toHaveLength(0);
  });
});
