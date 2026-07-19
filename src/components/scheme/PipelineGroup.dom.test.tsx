import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { Pipeline } from "@/lib/pipelines/types";

import type { Camera } from "./Minimap";
import { PipelineGroup, usePipelineGroupContext } from "./PipelineGroup";

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
  return <div data-stream-c-slot data-context={`${context.id}:${context.worldRect.x},${context.worldRect.y}`}>stage graph</div>;
}

function renderGroup(value = pipeline(), pins: Array<{ x: number; y: number }> = [], zoom = 1): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  const camRef = { current: { x: 0, y: 0, z: zoom } as Camera };
  flushSync(() => root.render(
    <PipelineGroup pipeline={value} rect={{ x: 420, y: 180, w: 360, h: 76 }} camRef={camRef} onPin={async (_pipeline, pos) => { pins.push(pos); return null; }}>
      <StreamCProbe />
    </PipelineGroup>,
  ));
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

test("expanded body exposes children with the pipeline id and world rect", () => {
  const host = renderGroup();
  flushSync(() => (host.querySelector("button[aria-expanded]") as HTMLButtonElement).click());

  const slot = host.querySelector("[data-stream-c-slot]");
  expect(slot).toBeTruthy();
  expect(slot!.getAttribute("data-context")).toBe("pipeline-a:420,180");
});
