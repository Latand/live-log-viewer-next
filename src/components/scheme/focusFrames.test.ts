import { expect, test } from "bun:test";

import { resolveFocusTarget } from "@/lib/attention/resolve";
import type { FileEntry } from "@/lib/types";

import { buildFocusFrameIndex, type FocusLayoutSlice } from "./focusFrames";
import type { SchemeGroup, SchemeNode, SchemeRect } from "./layout";

const rect = (x: number, y: number, w = 600, h = 780): SchemeRect => ({ x, y, w, h });

function node(path: string, title: string, box: SchemeRect): SchemeNode {
  return { ...box, file: { path, title } as FileEntry, tasks: [], under: [], isRoot: true };
}

function group(key: string, label: string, box: SchemeRect): SchemeGroup {
  return { ...box, key, label, kind: "pipeline", id: key, hue: 0, members: [] } as unknown as SchemeGroup;
}

function layout(): FocusLayoutSlice {
  const reviewer = node("/tmp/reviewer.jsonl", "Reviewer — login fix", rect(900, 1_400));
  return {
    nodes: [reviewer],
    groups: [group("group::pipeline::p1", "Login pipeline", rect(800, 1_300, 1_000, 1_000))],
    byPath: new Map<string, SchemeRect>([
      ["/tmp/reviewer.jsonl", reviewer],
      ["draft::d1", rect(2_000, 100)],
      ["deck::f1", rect(1_600, 1_400)],
      ["slot::p1::s2", rect(1_500, 2_400)],
      ["task::t1", rect(300, 300, 260, 160)],
    ]),
  };
}

test("every typed target resolves through the layout the board already built", () => {
  const index = buildFocusFrameIndex(layout(), "demo", { boardRevision: 12 });

  expect(resolveFocusTarget({ kind: "conversation", path: "/tmp/reviewer.jsonl" }, null, index).frame)
    .toEqual({ project: "demo", rect: { x: 900, y: 1_400, w: 600, h: 780 }, boardRevision: 12 });
  expect(resolveFocusTarget({ kind: "pipeline", pipelineId: "p1" }, null, index).frame!.rect)
    .toEqual({ x: 800, y: 1_300, w: 1_000, h: 1_000 });
  expect(resolveFocusTarget({ kind: "stage", pipelineId: "p1", stageId: "s2" }, null, index).resolution).toBe("exact");
  expect(resolveFocusTarget({ kind: "flowRound", flowId: "f1", round: 2 }, null, index).resolution).toBe("exact");
  expect(resolveFocusTarget({ kind: "task", taskId: "t1" }, null, index).resolution).toBe("exact");
  expect(resolveFocusTarget({ kind: "draft", draftId: "d1" }, null, index).resolution).toBe("exact");
});

test("a task the board placed on its own lattice still resolves", () => {
  const index = buildFocusFrameIndex(layout(), "demo", {
    extraRects: new Map([["task::loose", rect(50, 60, 260, 160)]]),
  });

  expect(resolveFocusTarget({ kind: "task", taskId: "loose" }, null, index).frame!.rect)
    .toEqual({ x: 50, y: 60, w: 260, h: 160 });
});

test("a stage that has launched resolves through its live card under the same key", () => {
  const withoutSlot: FocusLayoutSlice = {
    ...layout(),
    byPath: new Map([["/tmp/stage-agent.jsonl", rect(4_000, 4_000)]]),
  };
  const index = buildFocusFrameIndex(withoutSlot, "demo", {
    aliases: new Map([["slot::p1::s2", "/tmp/stage-agent.jsonl"]]),
  });

  const resolved = resolveFocusTarget({ kind: "stage", pipelineId: "p1", stageId: "s2" }, null, index);

  expect(resolved.resolution).toBe("exact");
  expect(resolved.frame!.rect).toEqual({ x: 4_000, y: 4_000, w: 600, h: 780 });
});

test("a point borrows the name of the nearest card for the spoken sentence", () => {
  const index = buildFocusFrameIndex(layout(), "demo");

  const resolved = resolveFocusTarget({ kind: "point", project: "demo", x: 1_200, y: 1_800 }, null, index);

  expect(resolved.nearestAnchor).toEqual({ key: "/tmp/reviewer.jsonl", label: "Reviewer — login fix" });
});

test("an anchor the layout no longer holds reports gone rather than a stale rect", () => {
  const index = buildFocusFrameIndex(layout(), "demo");

  expect(index.rectFor("/tmp/deleted.jsonl")).toBeNull();
  expect(resolveFocusTarget({ kind: "conversation", path: "/tmp/deleted.jsonl" }, null, index).resolution).toBe("lost");
});
