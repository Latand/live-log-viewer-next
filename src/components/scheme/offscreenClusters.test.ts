import { describe, expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import type { SchemeLayout } from "./layout";
import { boardClusters, CHIP_MAX_W, chipRevealWidth, offscreenClusterChips, OVERFLOW_TRIGGER, overflowAnchor, resolveOverflowPlacement, screenKeepoutObstacles, type BoardCluster } from "./offscreenClusters";

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

describe("corner reveal geometry (issue #474: the full title band fits or the chip folds)", () => {
  /* A top/bottom chip is centered on its anchor, so near a viewport corner its
     reveal band has too little horizontal room to unfurl the whole 48–60 char
     title: it can never paint the complete pill, and a truncated-forever sliver
     is not acceptable. Such a chip must fold into the edge «+N» aggregate, so a
     near-corner title either fully fits or folds — never a permanent ellipsis. */
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

  test("a top chip whose centered band cannot hold the whole title — but is wider than the old resting minimum — folds instead of truncating forever", () => {
    /* Its center-to-corner ray crosses the *top* edge at x≈200: the centered
       reveal band there is ~356px — comfortably past a resting pill, but far
       short of the full CHIP_MAX_W title band, so a 48/60-char label would
       ellipsis-truncate even fully revealed. Admitting it is the corner defect;
       it must fold. */
    const chips = offscreenClusterChips([cluster("top-near-corner", -150, -400)], cam, vp);
    const { edge, x } = { edge: "top" as const, x: 200 };
    expect(chipRevealWidth(edge, x, vp)).toBeLessThan(CHIP_MAX_W);
    expect(chips.visible).toHaveLength(0);
    expect(chips.overflow.map((chip) => chip.cluster.key)).toEqual(["top-near-corner"]);
  });

  test("a top chip clear of both corners keeps its full reveal band and stays visible", () => {
    const chips = offscreenClusterChips([cluster("top-center", 450, -700)], cam, vp);
    expect(chips.visible.map((chip) => chip.cluster.key)).toEqual(["top-center"]);
    const { edge, x } = chips.visible[0]!;
    expect(chipRevealWidth(edge, x, vp)).toBeGreaterThanOrEqual(CHIP_MAX_W);
  });

  test("every admitted chip around every edge and both corners reserves the full collision-safe title band", () => {
    /* A dense ring of off-screen clusters aimed at every edge and both corners:
       whichever survive as visible must each reserve the *whole* CHIP_MAX_W
       title band — the corner-pinned ones fold instead of truncating. */
    const ring: BoardCluster[] = [];
    for (let angle = 0; angle < 360; angle += 12) {
      const rad = (angle * Math.PI) / 180;
      ring.push(cluster(`ring-${angle}`, Math.round(500 + Math.cos(rad) * 4_000), Math.round(350 + Math.sin(rad) * 4_000)));
    }
    const chips = offscreenClusterChips(ring, cam, vp, 99);
    expect(chips.visible.length).toBeGreaterThan(0);
    for (const chip of chips.visible) {
      expect(chipRevealWidth(chip.edge, chip.x, vp)).toBeGreaterThanOrEqual(CHIP_MAX_W);
    }
  });
});

describe("overflow aggregate placement (issue #474: the «+N» disclosure clears panes and keep-outs)", () => {
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const triggerBox = (edge: "left" | "right" | "top" | "bottom", anchor: { x: number; y: number }) => {
    const half = OVERFLOW_TRIGGER / 2;
    if (edge === "left") return { x: 10, y: anchor.y - half, w: OVERFLOW_TRIGGER, h: OVERFLOW_TRIGGER };
    if (edge === "right") return { x: vp.w - 10 - OVERFLOW_TRIGGER, y: anchor.y - half, w: OVERFLOW_TRIGGER, h: OVERFLOW_TRIGGER };
    if (edge === "top") return { x: anchor.x - half, y: 10, w: OVERFLOW_TRIGGER, h: OVERFLOW_TRIGGER };
    return { x: anchor.x - half, y: vp.h - 10 - OVERFLOW_TRIGGER, w: OVERFLOW_TRIGGER, h: OVERFLOW_TRIGGER };
  };

  test("with a clear edge the trigger stays at the edge midpoint", () => {
    expect(overflowAnchor("left", vp)).toEqual({ x: 10, y: vp.h / 2 });
    expect(overflowAnchor("top", vp)).toEqual({ x: vp.w / 2, y: 10 });
  });

  test("slides the left-edge trigger off an avatar-rail keep-out covering the midpoint", () => {
    /* A subagent avatar/round column pokes into the viewport at the left edge,
       centered vertically over where the trigger would default. */
    const rail = { x: 0, y: vp.h / 2 - 70, w: 60, h: 140 };
    const anchor = overflowAnchor("left", vp, [rail]);
    expect(anchor).not.toBeNull();
    expect(overlaps(triggerBox("left", anchor!), rail)).toBe(false);
    expect(anchor!.x).toBe(10);
  });

  test("slides the bottom-edge trigger off a composer keep-out covering the midpoint", () => {
    const composer = { x: vp.w / 2 - 170, y: vp.h - 70, w: 340, h: 70 };
    const anchor = overflowAnchor("bottom", vp, [composer]);
    expect(anchor).not.toBeNull();
    expect(overlaps(triggerBox("bottom", anchor!), composer)).toBe(false);
    expect(anchor!.y).toBe(vp.h - 10);
  });

  test("returns null when the whole edge is blocked — no slot to dock the trigger without overlap", () => {
    const wall = { x: 0, y: 0, w: 60, h: vp.h };
    expect(overflowAnchor("left", vp, [wall])).toBeNull();
  });
});

describe("nullable / re-homed aggregate placement (issue #474: a fully blocked edge suppresses or re-homes «+N» without overlap)", () => {
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const half = OVERFLOW_TRIGGER / 2;
  const triggerBox = (edge: "left" | "right" | "top" | "bottom", anchor: { x: number; y: number }) => {
    if (edge === "left") return { x: 10, y: anchor.y - half, w: OVERFLOW_TRIGGER, h: OVERFLOW_TRIGGER };
    if (edge === "right") return { x: vp.w - 10 - OVERFLOW_TRIGGER, y: anchor.y - half, w: OVERFLOW_TRIGGER, h: OVERFLOW_TRIGGER };
    if (edge === "top") return { x: anchor.x - half, y: 10, w: OVERFLOW_TRIGGER, h: OVERFLOW_TRIGGER };
    return { x: anchor.x - half, y: vp.h - 10 - OVERFLOW_TRIGGER, w: OVERFLOW_TRIGGER, h: OVERFLOW_TRIGGER };
  };

  test("keeps the aggregate on its own edge when that edge has a clear slot", () => {
    const placement = resolveOverflowPlacement("left", vp, []);
    expect(placement).toEqual({ edge: "left", x: 10, y: vp.h / 2 });
  });

  test("re-homes to a clear border when the requested edge is fully walled — landing on a slot clear of every obstacle", () => {
    /* The whole left edge is walled, but the rest of the viewport border is
       open: the aggregate must re-home rather than dock over the wall. */
    const wall = { x: 0, y: 0, w: 60, h: vp.h };
    const placement = resolveOverflowPlacement("left", vp, [wall]);
    expect(placement).not.toBeNull();
    expect(placement!.edge).not.toBe("left");
    expect(overlaps(triggerBox(placement!.edge, placement!), wall)).toBe(false);
  });

  test("suppresses the aggregate (null) only when the entire viewport border is blocked", () => {
    /* A pane filling the whole viewport walls every border — there is no
       non-overlapping slot anywhere, so the caller suppresses the trigger. */
    const fullPane = { x: 0, y: 0, w: vp.w, h: vp.h };
    expect(resolveOverflowPlacement("bottom", vp, [fullPane])).toBeNull();
  });
});

describe("measured admission (issue #474: exact wide-glyph 48/60-char titles fully fit or fold)", () => {
  /* offscreenClusterChips reserves the *measured* rendered width, not a fixed
     latin band. A wide-glyph exact-length title measures wider than the room and
     folds; a title that genuinely fits at the same anchor is admitted with its
     whole band reserved. The default (no measure) keeps the CHIP_MAX_W band. */
  const rightEdge = (key: string): BoardCluster => cluster(key, 4_000, 350);

  test("a title whose measured width exceeds the room at its anchor folds instead of truncating forever", () => {
    /* The right edge on a 1000px viewport has ~956px of room. A measured width
       past that — a 60-char wide-glyph (CJK/emoji) label — cannot ever paint in
       full, so the chip folds. */
    const wideGlyph = () => 1_200;
    const chips = offscreenClusterChips([rightEdge("wide")], cam, vp, 4, [], wideGlyph);
    expect(chips.visible).toHaveLength(0);
    expect(chips.overflow.map((chip) => chip.cluster.key)).toEqual(["wide"]);
  });

  test("a title whose measured width fits the room at its anchor is admitted, reserving exactly its measured band", () => {
    const measured = () => 480;
    const chips = offscreenClusterChips([rightEdge("fits")], cam, vp, 4, [], measured);
    expect(chips.visible.map((chip) => chip.cluster.key)).toEqual(["fits"]);
    /* The admitted chip carries its measured reveal budget, so its live reveal
       caps exactly at the band the collision geometry reserved. */
    expect(chips.visible[0]!.revealWidth).toBe(480);
  });

  test("admission tracks the *measured* width, not the label length: a narrow near-corner title fits where a wide one folds", () => {
    /* Same near-corner top anchor (centered band ~356px) the fixed-band code
       always folded: a narrow measured title (≤ the band) is now correctly
       admitted, while a wide one still folds. Proves admission is measured. */
    const nearCorner = cluster("near-corner", -150, -400);
    const narrow = offscreenClusterChips([nearCorner], cam, vp, 4, [], () => 300);
    const wide = offscreenClusterChips([nearCorner], cam, vp, 4, [], () => 500);
    expect(narrow.visible.map((chip) => chip.cluster.key)).toEqual(["near-corner"]);
    expect(narrow.visible[0]!.edge).toBe("top");
    expect(wide.visible).toHaveLength(0);
    expect(wide.overflow.map((chip) => chip.cluster.key)).toEqual(["near-corner"]);
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
