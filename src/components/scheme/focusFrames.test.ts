import { expect, test } from "bun:test";

import { resolveFocusTarget } from "@/lib/attention/resolve";
import type { FileEntry } from "@/lib/types";

import type { Pipeline } from "@/lib/pipelines/types";

import { buildFocusFrameIndex, stageAnchorAliases, type FocusLayoutSlice } from "./focusFrames";
import type { MiniStack, SchemeGroup, SchemeNode, SchemeRect } from "./layout";

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

test("a launched stage's alias follows the attempt the operator would be taken to", () => {
  /* A retried stage has several attempts; the slot it dissolved into belongs to
     the newest one with a transcript, not the first one that ever ran. */
  const pipelines = [{
    id: "p1",
    runs: [
      { stageId: "s1", attempts: [{ agentPath: "/tmp/first.jsonl" }, { agentPath: "/tmp/retry.jsonl" }] },
      { stageId: "s2", attempts: [{ agentPath: null }] },
    ],
  }] as unknown as Pipeline[];

  const aliases = stageAnchorAliases(pipelines);

  expect(aliases.get("slot::p1::s1")).toBe("/tmp/retry.jsonl");
  /* A stage that never launched has no alias — its own slot is still on the
     board, and the frame index resolves it directly. */
  expect(aliases.has("slot::p1::s2")).toBe(false);
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

test("the board reports which card a launched stage's anchor actually resolves through", () => {
  /* The rect alone is enough for a camera and not for the phone, which pins a
     pane by key. Both surfaces read this one index, so the concrete key has to
     come from here rather than be re-derived by whoever navigates. */
  const withoutSlot: FocusLayoutSlice = {
    ...layout(),
    byPath: new Map([["/tmp/stage-agent.jsonl", rect(4_000, 4_000)]]),
  };
  const index = buildFocusFrameIndex(withoutSlot, "demo", {
    aliases: new Map([["slot::p1::s2", "/tmp/stage-agent.jsonl"]]),
  });

  expect(index.concreteAnchorKey!("slot::p1::s2")).toBe("/tmp/stage-agent.jsonl");
  /* A directly placed anchor resolves through itself. */
  expect(index.concreteAnchorKey!("/tmp/stage-agent.jsonl")).toBe("/tmp/stage-agent.jsonl");
  /* And an alias whose target has also left the board is gone, not a key that
     would send a surface looking for a card nobody is drawing. */
  const orphaned = buildFocusFrameIndex(withoutSlot, "demo", {
    aliases: new Map([["slot::p1::s2", "/tmp/vanished.jsonl"]]),
  });
  expect(orphaned.concreteAnchorKey!("slot::p1::s2")).toBeNull();
  expect(orphaned.rectFor("slot::p1::s2")).toBeNull();
});

/* ── Cards the board draws inside a container ───────────────────────────── */

function stack(key: string, box: SchemeRect, paths: string[]): MiniStack {
  return { ...box, key, parent: "/tmp/root.jsonl", items: paths.map((path) => ({ file: { path } as FileEntry, branches: 0 })) };
}

test("a quiet worker folded into its parent's stack resolves to the stack that is drawing it", () => {
  /* The live defect: an orchestration worker collapses ~15 minutes after it goes
     quiet (#112) and stops being a node of its own. It is still on screen — one
     row inside the mini-stack — but the focus index only knew about placed
     rects, so every request naming that conversation resolved to `lost`, the
     view never moved, and no way back was ever offered. */
  const folded = "/tmp/quiet-worker.jsonl";
  const stacked: FocusLayoutSlice = {
    ...layout(),
    stacks: [stack("/tmp/root.jsonl::stack", rect(2_400, 900, 240, 400), [folded])],
    byPath: new Map<string, SchemeRect>([["/tmp/root.jsonl::stack", rect(2_400, 900, 240, 400)]]),
  };

  const index = buildFocusFrameIndex(stacked, "demo", { boardRevision: 12 });

  expect(index.rectFor(folded)).toEqual({ x: 2_400, y: 900, w: 240, h: 400 });
  /* Named as the key the board is actually drawing, so a surface that navigates
     by key — the phone — pins the stack rather than hunting for a pane that is
     not on its own list. */
  expect(index.concreteAnchorKey!(folded)).toBe("/tmp/root.jsonl::stack");
  expect(resolveFocusTarget({ kind: "conversation", path: folded }, null, index).resolution).toBe("exact");
});

test("a full node of its own always wins over the stack that used to hold it", () => {
  const expanded = "/tmp/quiet-worker.jsonl";
  const own = rect(120, 240);
  const both: FocusLayoutSlice = {
    ...layout(),
    stacks: [stack("/tmp/root.jsonl::stack", rect(2_400, 900, 240, 400), [expanded])],
    byPath: new Map<string, SchemeRect>([
      [expanded, own],
      ["/tmp/root.jsonl::stack", rect(2_400, 900, 240, 400)],
    ]),
  };

  const index = buildFocusFrameIndex(both, "demo");

  expect(index.rectFor(expanded)).toEqual(own);
  expect(index.concreteAnchorKey!(expanded)).toBe(expanded);
});

test("a launched stage that has since gone quiet resolves through the stack holding its card", () => {
  const agent = "/tmp/stage-agent.jsonl";
  const stacked: FocusLayoutSlice = {
    ...layout(),
    stacks: [stack("/tmp/root.jsonl::stack", rect(2_400, 900, 240, 400), [agent])],
    byPath: new Map<string, SchemeRect>([["/tmp/root.jsonl::stack", rect(2_400, 900, 240, 400)]]),
  };

  const index = buildFocusFrameIndex(stacked, "demo", { aliases: new Map([["slot::p1::s2", agent]]) });

  expect(resolveFocusTarget({ kind: "stage", pipelineId: "p1", stageId: "s2" }, null, index).resolution).toBe("exact");
  expect(index.concreteAnchorKey!("slot::p1::s2")).toBe("/tmp/root.jsonl::stack");
});

test("a conversation no container is drawing is still gone", () => {
  const stacked: FocusLayoutSlice = {
    ...layout(),
    stacks: [stack("/tmp/root.jsonl::stack", rect(2_400, 900, 240, 400), ["/tmp/quiet-worker.jsonl"])],
  };

  const index = buildFocusFrameIndex(stacked, "demo");

  /* The stack itself is not in `byPath` here, so nothing on this board hosts the
     folded card — and inventing a rect for it would land the operator nowhere. */
  expect(index.rectFor("/tmp/quiet-worker.jsonl")).toBeNull();
  expect(index.rectFor("/tmp/never-here.jsonl")).toBeNull();
});
