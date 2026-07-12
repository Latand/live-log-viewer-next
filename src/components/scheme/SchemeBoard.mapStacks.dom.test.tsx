import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { WorkerStack } from "./workerCollapse";
import { SchemeBoard } from "./SchemeBoard";

/* The mobile full-map renders SchemeBoard in map mode (onNodePick set → lite,
   no live panes). This exercises that exact path: collapsed worker stacks threaded
   in must surface as one minimap dot per origin (issue #136 finding 2). */
const dom = new Window();
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLDivElement: dom.HTMLDivElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver,
  IntersectionObserver: undefined,
});
// happy-dom lacks matchMedia; the camera reads pointer coarseness through it.
(dom as unknown as { matchMedia: (q: string) => unknown }).matchMedia = () => ({
  matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
});

const workerStacks: WorkerStack[] = [
  { key: "wstack::flow::f1", kind: "flow", id: "f1", items: [] },
  { key: "wstack::pipeline::p1", kind: "pipeline", id: "p1", items: [] },
  { key: "wstack::origin::/root", kind: "origin", id: "/root", items: [] },
];

afterEach(() => document.body.replaceChildren());

test("the mobile map (lite SchemeBoard) shows one minimap dot per collapsed origin (#136 finding 2)", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  flushSync(() => {
    root.render(
      <SchemeBoard
        project="demo"
        groups={[]}
        manual={[]}
        files={[]}
        flows={[]}
        tasks={[]}
        drafts={[]}
        workerStacks={workerStacks}
        focus={null}
        onNodePick={() => {}}
        onSelect={() => {}}
        onClose={() => {}}
        onDraftClose={() => {}}
        onDraftSpawned={() => {}}
      />,
    );
  });

  /* The stack-dot legend is titled with the count and renders one dot each. */
  const legend = host.querySelector('[title="3 collapsed stacks"]');
  expect(legend).toBeTruthy();
  expect(legend!.querySelectorAll("span").length).toBe(3);

  flushSync(() => root.unmount());
  host.remove();
});
