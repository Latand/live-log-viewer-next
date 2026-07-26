import { expect, test } from "bun:test";

import { nearestNamedFrame, resolveFocusTarget, type FocusFrameIndex, type NamedFrame } from "./resolve";
import { focusTargetAnchorKeys, geometricFrameRect, isGeometricTarget, targetAcceptsIntent, POINT_FRAME_SIZE } from "./targets";
import type { FocusFrame, FocusRect, FocusTarget } from "./types";

const rect = (x: number, y: number, w = 600, h = 780): FocusRect => ({ x, y, w, h });

/** A layout fixture. Nothing here builds a renderer or moves a camera — the
    whole target model is resolvable from a map of keys to boxes. */
function index(entries: Record<string, FocusRect>, options: { project?: string; named?: NamedFrame[]; boardRevision?: number | null } = {}): FocusFrameIndex {
  return {
    project: options.project ?? "demo",
    boardRevision: options.boardRevision ?? 7,
    rectFor: (key) => entries[key] ?? null,
    named: options.named,
  };
}

const created: FocusFrame = { project: "demo", rect: rect(100, 200), boardRevision: 4 };

test("every object target names the board key its anchor already lives under", () => {
  expect(focusTargetAnchorKeys({ kind: "conversation", path: "/tmp/a.jsonl" })).toEqual(["/tmp/a.jsonl"]);
  expect(focusTargetAnchorKeys({ kind: "pipeline", pipelineId: "p1" })).toEqual(["group::pipeline::p1"]);
  expect(focusTargetAnchorKeys({ kind: "stage", pipelineId: "p1", stageId: "s2" })).toEqual(["slot::p1::s2"]);
  expect(focusTargetAnchorKeys({ kind: "flowRound", flowId: "f1", round: 2 })).toEqual(["deck::f1"]);
  expect(focusTargetAnchorKeys({ kind: "task", taskId: "t1" })).toEqual(["task::t1"]);
  expect(focusTargetAnchorKeys({ kind: "draft", draftId: "d1" })).toEqual(["draft::d1"]);
  /* Geometric targets have no anchor by construction. */
  expect(focusTargetAnchorKeys({ kind: "point", project: "demo", x: 0, y: 0 })).toEqual([]);
});

test("an anchor still on the board resolves exactly, from the CURRENT layout", () => {
  const target: FocusTarget = { kind: "conversation", path: "/tmp/reviewer.jsonl" };
  /* The board reflowed since the request was created: the stored rect is stale
     the moment a sibling appears, so the live one has to win. */
  const result = resolveFocusTarget(target, created, index({ "/tmp/reviewer.jsonl": rect(900, 1_400) }));

  expect(result.resolution).toBe("exact");
  expect(result.degraded).toBe(false);
  expect(result.frame).toEqual({ project: "demo", rect: rect(900, 1_400), boardRevision: 7 });
  expect(result.target).toEqual(target);
});

test("a vanished anchor degrades to the stored frame rather than failing silently", () => {
  const target: FocusTarget = { kind: "conversation", path: "/tmp/deleted.jsonl" };

  const result = resolveFocusTarget(target, created, index({ "/tmp/someone-else.jsonl": rect(0, 0) }));

  expect(result.resolution).toBe("approximate");
  expect(result.degraded).toBe(true);
  /* "That's gone now — I'll take you to where it was." */
  expect(result.frame).toEqual({ project: "demo", rect: rect(100, 200), boardRevision: 7 });
  expect(result.target).toEqual({ kind: "point", project: "demo", x: 400, y: 590 });
});

test("a vanished anchor whose project is gone resolves as lost, never as a no-op", () => {
  const target: FocusTarget = { kind: "task", taskId: "t1" };

  expect(resolveFocusTarget(target, created, null).resolution).toBe("lost");
  /* The project on screen is a different one, so the stored frame means nothing. */
  expect(resolveFocusTarget(target, created, index({}, { project: "other" })).resolution).toBe("lost");
  expect(resolveFocusTarget(target, null, index({})).resolution).toBe("lost");
  expect(resolveFocusTarget(target, created, null).frame).toBeNull();
});

test("a materialized stage and a placeholder stage resolve through the same key", () => {
  const target: FocusTarget = { kind: "stage", pipelineId: "p1", stageId: "s2" };

  const placeholder = resolveFocusTarget(target, created, index({ "slot::p1::s2": rect(10, 20) }));
  expect(placeholder.resolution).toBe("exact");
  expect(placeholder.frame!.rect).toEqual(rect(10, 20));

  /* Once the stage launches, the layout registers the live card under the same
     key, so the request never has to know which surface exists yet. */
  const live = resolveFocusTarget(target, created, index({ "slot::p1::s2": rect(500, 600) }));
  expect(live.frame!.rect).toEqual(rect(500, 600));
});

test("a coordinate is exact or in another project, and never degrades", () => {
  const point: FocusTarget = { kind: "point", project: "demo", x: 400, y: 500 };

  const here = resolveFocusTarget(point, null, index({}));
  expect(here.resolution).toBe("exact");
  expect(here.frame!.rect).toEqual({
    x: 400 - POINT_FRAME_SIZE / 2,
    y: 500 - POINT_FRAME_SIZE / 2,
    w: POINT_FRAME_SIZE,
    h: POINT_FRAME_SIZE,
  });

  expect(resolveFocusTarget(point, null, index({}, { project: "elsewhere" })).resolution).toBe("lost");
});

test("a region resolves to exactly the rect it names", () => {
  const region: FocusTarget = { kind: "region", project: "demo", rect: rect(5, 6, 100, 200) };

  const result = resolveFocusTarget(region, null, index({}));

  expect(result.resolution).toBe("exact");
  expect(result.frame!.rect).toEqual(rect(5, 6, 100, 200));
  expect(geometricFrameRect(region as never)).toEqual(rect(5, 6, 100, 200));
});

test("a nameless destination borrows the nearest named object for the spoken form", () => {
  const named: NamedFrame[] = [
    { key: "group::pipeline::p1", label: "the login pipeline", rect: rect(0, 0, 100, 100) },
    { key: "/tmp/reviewer.jsonl", label: "the reviewer", rect: rect(1_000, 1_000, 100, 100) },
  ];

  const result = resolveFocusTarget({ kind: "point", project: "demo", x: 1_040, y: 1_040 }, null, index({}, { named }));

  expect(result.nearestAnchor).toEqual({ key: "/tmp/reviewer.jsonl", label: "the reviewer" });
});

test("with nothing named nearby there is no landmark to invent", () => {
  const result = resolveFocusTarget({ kind: "point", project: "demo", x: 10, y: 10 }, null, index({}));

  /* The spoken form then says "an empty area of the board" rather than
     pretending there is a landmark. */
  expect(result.nearestAnchor).toBeNull();
  expect(nearestNamedFrame(index({}), rect(0, 0))).toBeNull();
});

test("a degraded destination does not borrow the name of the anchor that vanished", () => {
  const named: NamedFrame[] = [
    { key: "/tmp/deleted.jsonl", label: "the thing that is gone", rect: rect(100, 200) },
    { key: "group::pipeline::p1", label: "the login pipeline", rect: rect(140, 240) },
  ];

  const result = resolveFocusTarget({ kind: "conversation", path: "/tmp/deleted.jsonl" }, created, index({}, { named }));

  expect(result.resolution).toBe("approximate");
  expect(result.nearestAnchor).toEqual({ key: "group::pipeline::p1", label: "the login pipeline" });
});

test("only a geometric target is refused an open intent", () => {
  expect(isGeometricTarget({ kind: "point", project: "demo", x: 0, y: 0 })).toBe(true);
  expect(isGeometricTarget({ kind: "conversation", path: "/tmp/a.jsonl" })).toBe(false);

  expect(targetAcceptsIntent({ kind: "point", project: "demo", x: 0, y: 0 }, "show")).toBe(true);
  expect(targetAcceptsIntent({ kind: "point", project: "demo", x: 0, y: 0 }, "open")).toBe(false);
  expect(targetAcceptsIntent({ kind: "conversation", path: "/tmp/a.jsonl" }, "open")).toBe(true);
});
