import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { Pipeline } from "@/lib/pipelines/types";

import { Minimap, type Camera } from "./Minimap";
import type { SchemeLayout } from "./layout";
import { PipelineGroup, usePipelineGroupContext } from "./PipelineGroup";
import { PIPELINE_GROUP_BODY_H, PIPELINE_GROUP_COLLAPSED_H, PIPELINE_GROUP_EXPANDED_H, layoutPipelineGroups, type PipelineGroupPlacement } from "./pipelineAnchor";
import { TASK_W } from "./taskGeometry";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLDivElement: dom.HTMLDivElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
});

const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  document.body.replaceChildren();
});

function pipeline(overrides: Record<string, unknown> = {}): Pipeline {
  return {
    id: "pipeline-a",
    task: "Board pipeline",
    project: "viewer",
    repoDir: "/repo",
    worktreeDir: "/repo-pipeline-a",
    branch: "pipeline/a",
    baseBranch: "main",
    baseRef: "abc",
    lastPassedCommit: "abc",
    stages: [
      { id: "build", kind: "run", prompt: "", next: "review" },
      { id: "review", kind: "review-loop", prompt: "", next: null },
    ],
    runs: [],
    cursor: { stageId: "review", state: "pending", input: null, activatedBy: null },
    state: "draft",
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    closedAt: null,
    ...overrides,
  } as unknown as Pipeline;
}

function StreamCProbe() {
  const context = usePipelineGroupContext();
  return <div data-stream-c-slot data-context={`${context.id}:${context.worldRect.x},${context.worldRect.y},${context.worldRect.w}x${context.worldRect.h}`}>stage graph</div>;
}

function placement(expanded: boolean): PipelineGroupPlacement {
  const header = { x: 420, y: 180, w: 360, h: PIPELINE_GROUP_COLLAPSED_H };
  const body = expanded ? { x: 420, y: 180 + PIPELINE_GROUP_COLLAPSED_H, w: 360, h: PIPELINE_GROUP_BODY_H } : null;
  const bounds = expanded ? { x: 420, y: 180, w: 360, h: PIPELINE_GROUP_EXPANDED_H } : header;
  return { ...bounds, header, body, bounds, direction: expanded ? "down" : "collapsed" };
}

const emptyLayout: SchemeLayout = {
  nodes: [], edges: [], stacks: [], decks: [], loops: [], groups: [], links: [], drafts: [], slots: [],
  byPath: new Map(), width: 1000, height: 1000,
};

function renderGroup(value = pipeline(), pins: Array<{ x: number; y: number }> = [], zoom = 1): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  const camRef = { current: { x: 0, y: 0, z: zoom } as Camera };
  function Harness() {
    const [expanded, setExpanded] = useState(false);
    return (
      <PipelineGroup
        pipeline={value}
        rect={placement(expanded)}
        camRef={camRef}
        onPin={async (_pipeline, pos) => { pins.push(pos); return null; }}
        interactive
        expanded={expanded}
        onExpandedChange={(_pipelineId, nextExpanded) => setExpanded(nextExpanded)}
      >
        <StreamCProbe />
      </PipelineGroup>
    );
  }
  flushSync(() => root.render(<Harness />));
  return host;
}

test("collapsed group keeps one status dot and one stage counter", () => {
  const host = renderGroup();
  const group = host.querySelector('[data-pipeline-group="pipeline-a"]');

  expect(group).toBeTruthy();
  expect(group!.hasAttribute("data-scheme-ui")).toBe(true);
  expect(group!.querySelectorAll("[data-pipeline-group-status]")).toHaveLength(1);
  expect(group!.querySelectorAll("[data-pipeline-group-counter]")).toHaveLength(1);
  expect(group!.textContent).toContain("Board pipeline");
  expect(group!.textContent).toContain("2/2");
  expect(group!.querySelector("[data-stream-c-slot]")).toBeNull();
  expect(group!.getAttribute("data-pipeline-draft")).toBe("");
});

test("dragging the header persists one zoom-corrected world position", () => {
  const pins: Array<{ x: number; y: number }> = [];
  const host = renderGroup(pipeline({ state: "running" }), pins, 2);
  const handle = host.querySelector("[data-pipeline-group-drag]") as HTMLElement;

  handle.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 100, clientY: 100 }) as unknown as Event);
  handle.dispatchEvent(new dom.PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 140, clientY: 160 }) as unknown as Event);
  handle.dispatchEvent(new dom.PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 140, clientY: 160 }) as unknown as Event);

  expect(pins).toEqual([{ x: 440, y: 210 }]);
});

test("successful drag yields to the authoritative echo and ignores an older save response", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  const pending: Array<(error: string | null) => void> = [];
  const base = placement(false);
  const at = (x: number, y: number): PipelineGroupPlacement => ({
    ...base,
    x,
    y,
    header: { ...base.header, x, y },
    bounds: { ...base.bounds, x, y },
  });
  const render = (rect: PipelineGroupPlacement) => flushSync(() => root.render(
    <PipelineGroup
      pipeline={pipeline({ state: "running" })}
      rect={rect}
      camRef={{ current: { x: 0, y: 0, z: 1 } }}
      onPin={async () => new Promise<string | null>((resolve) => pending.push(resolve))}
      interactive
      expanded={false}
      onExpandedChange={() => {}}
    />,
  ));
  render(base);
  const handle = host.querySelector("[data-pipeline-group-drag]") as HTMLElement;
  const dragTo = (pointerId: number, dx: number, dy: number) => {
    flushSync(() => {
      handle.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId, clientX: 100, clientY: 100 }) as unknown as Event);
      handle.dispatchEvent(new dom.PointerEvent("pointermove", { bubbles: true, pointerId, clientX: 100 + dx, clientY: 100 + dy }) as unknown as Event);
      handle.dispatchEvent(new dom.PointerEvent("pointerup", { bubbles: true, pointerId, clientX: 100 + dx, clientY: 100 + dy }) as unknown as Event);
    });
  };

  dragTo(1, 20, 30);
  dragTo(2, 40, 50);
  expect((host.querySelector('[data-pipeline-group="pipeline-a"]') as HTMLElement).style.transform).toBe("translate(480px, 260px)");
  expect(pending).toHaveLength(1);

  pending[0]!("stale failure");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(pending).toHaveLength(2);
  expect((host.querySelector('[data-pipeline-group="pipeline-a"]') as HTMLElement).style.transform).toBe("translate(480px, 260px)");

  pending[1]!(null);
  await Promise.resolve();
  render(at(480, 260));
  await new Promise((resolve) => setTimeout(resolve, 0));
  render(at(540, 300));
  expect((host.querySelector('[data-pipeline-group="pipeline-a"]') as HTMLElement).style.transform).toBe("translate(540px, 300px)");
});

test("latest failed drag rolls its optimistic position back to the authoritative rect", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  let resolveSave: ((error: string | null) => void) | null = null;
  flushSync(() => root.render(
    <PipelineGroup
      pipeline={pipeline({ state: "running" })}
      rect={placement(false)}
      camRef={{ current: { x: 0, y: 0, z: 1 } }}
      onPin={async () => new Promise<string | null>((resolve) => { resolveSave = resolve; })}
      interactive
      expanded={false}
      onExpandedChange={() => {}}
    />,
  ));
  const handle = host.querySelector("[data-pipeline-group-drag]") as HTMLElement;
  flushSync(() => {
    handle.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 100, clientY: 100 }) as unknown as Event);
    handle.dispatchEvent(new dom.PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 160, clientY: 180 }) as unknown as Event);
    handle.dispatchEvent(new dom.PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 160, clientY: 180 }) as unknown as Event);
  });
  const group = host.querySelector('[data-pipeline-group="pipeline-a"]') as HTMLElement;
  expect(group.style.transform).toBe("translate(480px, 260px)");

  resolveSave!("save rejected");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(group.style.transform).toBe("translate(420px, 180px)");
});

test("expanded drag converges through server echo and a later authoritative group move", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  const value = pipeline({ state: "running" });
  const base = placement(true);
  const shifted = (x: number, y: number): PipelineGroupPlacement => {
    const dx = x - base.header.x;
    const dy = y - base.header.y;
    const header = { ...base.header, x, y };
    const body = base.body ? { ...base.body, x: base.body.x + dx, y: base.body.y + dy } : null;
    const bounds = { ...base.bounds, x: base.bounds.x + dx, y: base.bounds.y + dy };
    return { ...bounds, header, body, bounds, direction: base.direction };
  };
  const echo = shifted(480, 260);
  const movedHeader = { ...base.header, x: 540, y: 300 };
  const movedBody = { x: 180, y: 300, w: base.body!.w, h: base.body!.h };
  const movedBounds = { x: 180, y: 300, w: 720, h: base.body!.h };
  const moved: PipelineGroupPlacement = {
    ...movedBounds,
    header: movedHeader,
    body: movedBody,
    bounds: movedBounds,
    direction: "left",
  };
  let resolveSave: ((error: string | null) => void) | null = null;
  const render = (rect: PipelineGroupPlacement) => flushSync(() => root.render(
    <>
      <PipelineGroup
        pipeline={value}
        rect={rect}
        camRef={{ current: { x: 0, y: 0, z: 1 } }}
        onPin={async () => new Promise<string | null>((resolve) => { resolveSave = resolve; })}
        interactive
        expanded
        onExpandedChange={() => {}}
      >
        <StreamCProbe />
      </PipelineGroup>
      <Minimap
        layout={emptyLayout}
        world={{ x: -1000, y: -1000, w: 3000, h: 3000 }}
        pipelineGroups={[{ pipeline: value, rect: rect.bounds }]}
        cam={{ x: 0, y: 0, z: 1 }}
        vp={{ w: 800, h: 600 }}
        onJump={() => {}}
      />
    </>,
  ));
  render(base);
  const handle = host.querySelector("[data-pipeline-group-drag]") as HTMLElement;
  flushSync(() => {
    handle.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 100, clientY: 100 }) as unknown as Event);
    handle.dispatchEvent(new dom.PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 160, clientY: 180 }) as unknown as Event);
    handle.dispatchEvent(new dom.PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 160, clientY: 180 }) as unknown as Event);
  });
  expect((host.querySelector('[data-pipeline-group="pipeline-a"]') as HTMLElement).style.transform).toBe("translate(480px, 260px)");
  expect(host.querySelector("[data-stream-c-slot]")!.getAttribute("data-context")).toBe("pipeline-a:480,260,360x520");

  resolveSave!(null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  render(echo);
  await new Promise((resolve) => setTimeout(resolve, 0));
  render(moved);

  const group = host.querySelector('[data-pipeline-group="pipeline-a"]') as HTMLElement;
  const body = host.querySelector("[data-pipeline-group-body]") as HTMLElement;
  const minimap = host.querySelector('[data-minimap-pipeline="pipeline-a"]')!;
  expect(group.style.transform).toBe("translate(540px, 300px)");
  expect(body.style.left).toBe("-360px");
  expect(body.style.top).toBe("0px");
  expect(host.querySelector("[data-stream-c-slot]")!.getAttribute("data-context")).toBe("pipeline-a:180,300,720x444");
  expect({
    x: minimap.getAttribute("x"),
    y: minimap.getAttribute("y"),
    w: minimap.getAttribute("width"),
    h: minimap.getAttribute("height"),
  }).toEqual({ x: "180", y: "300", w: "720", h: "444" });
});

test("expanded body exposes children with the pipeline id and world rect", () => {
  const host = renderGroup();
  flushSync(() => (host.querySelector("button[aria-expanded]") as HTMLButtonElement).click());

  const slot = host.querySelector("[data-stream-c-slot]");
  expect(slot).toBeTruthy();
  expect(slot!.getAttribute("data-context")).toBe("pipeline-a:420,180,360x520");
});

test("an expanded pinned group renders its header at the durable origin and its body at the collision-safe offset", () => {
  const value = pipeline({ pos: { x: 420, y: 180 } });
  const placement = layoutPipelineGroups(
    [value],
    [],
    [],
    [{ x: 420, y: 280, w: TASK_W, h: 180 }],
    new Map([[value.id, PIPELINE_GROUP_EXPANDED_H]]),
  ).get(value.id)!;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(
    <PipelineGroup
      pipeline={value}
      rect={placement}
      camRef={{ current: { x: 0, y: 0, z: 1 } }}
      onPin={async () => null}
      interactive
      expanded
      onExpandedChange={() => {}}
    >
      <StreamCProbe />
    </PipelineGroup>,
  ));

  const group = host.querySelector('[data-pipeline-group="pipeline-a"]') as HTMLElement;
  const body = host.querySelector("[data-pipeline-group-body]") as HTMLElement;
  expect(group.style.transform).toBe("translate(420px, 180px)");
  expect(body.style.left).toBe(`${placement.body!.x - placement.header.x}px`);
  expect(body.style.top).toBe(`${placement.body!.y - placement.header.y}px`);
  expect(host.querySelector("[data-stream-c-slot]")!.getAttribute("data-context"))
    .toBe(`pipeline-a:${placement.bounds.x},${placement.bounds.y},${placement.bounds.w}x${placement.bounds.h}`);
});
