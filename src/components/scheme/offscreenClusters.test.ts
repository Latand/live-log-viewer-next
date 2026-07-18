import { describe, expect, test } from "bun:test";

import { offscreenClusterChips, type BoardCluster } from "./offscreenClusters";

const cam = { x: 0, y: 0, z: 1 };
const vp = { w: 1_000, h: 700 };
const cluster = (key: string, x: number, y: number, priority = 1): BoardCluster => ({
  key,
  label: key,
  rect: { x, y, w: 100, h: 100 },
  priority,
  color: "red",
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
