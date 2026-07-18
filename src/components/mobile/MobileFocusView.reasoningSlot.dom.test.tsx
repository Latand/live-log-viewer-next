import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import { emptyStore } from "@/components/runtime/runtimeModel";

/*
 * Issue #270 — 390px MobileFocusView: the reasoning identity must occupy the
 * scrolling header meta row as one in-flow «model · effort» chip. The bar
 * meter (a desktop identity element) must not mount at all on the phone, and
 * nothing in the reasoning slot may be an absolute overlay that could stack
 * onto the neighboring chips at phone width.
 */

const dom = new HappyWindow({ width: 390, height: 844 });
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver, IntersectionObserver: undefined,
});
// The phone layout: force useIsMobile true.
(dom as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (query: string) => ({
  matches: true, media: query, addEventListener() {}, removeEventListener() {},
});

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualLogTail = await import("@/hooks/useLogTail");
const inertRuntime = { enabled: false, connection: "offline" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inertRuntime, lastEventAt: null }),
  useRuntime: () => inertRuntime,
  useRuntimeSession: () => null,
  useRuntimeSessionByArtifact: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
mock.module("@/hooks/useLogTail", () => ({
  useLogTail: () => ({
    lines: [], linesStart: 0, size: 0, loading: false, error: null, tickTime: null,
    paused: false, setPaused: () => undefined, clear: () => undefined,
    hasMore: false, loadingOlder: false, loadOlder: async () => 0, prependGen: 0,
  }),
}));

const { MobileFocusView } = await import("./MobileFocusView");

const roots = new Set<Root>();
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  dom.sessionStorage.clear();
});

const root: FileEntry = {
  path: "/root.jsonl", root: "claude-projects", name: "root.jsonl", project: "project", title: "Focused conversation",
  engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 2, size: 1, activity: "live",
  proc: null, pid: null, conversationId: "conv-root", model: "fable", effort: "low",
  pendingQuestion: null, waitingInput: null,
};

test("the 390px focus view renders reasoning as one in-flow chip in the scrolling meta row, with no bar overlay", () => {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const rootInstance = createRoot(host as unknown as HTMLElement);
  roots.add(rootInstance);
  flushSync(() => rootInstance.render(
    <MobileFocusView
      project="project"
      groups={[]}
      manual={[root]}
      files={[root]}
      flows={[]}
      pipelines={[]}
      tasks={[]}
      drafts={[]}
      loaded
      focus="/root.jsonl"
      onSelect={() => undefined}
      onClose={() => undefined}
      onDraftClose={() => undefined}
      onDraftSpawned={() => undefined}
    />,
  ));

  const view = host as unknown as HTMLElement;
  /* The desktop bar meter never mounts on the phone. */
  expect(view.querySelector("[data-effort-slot]")).toBeNull();
  /* The combined chip carries model + tier and stays a shrink-0 flex item. */
  const chips = [...view.querySelectorAll("header span")] as HTMLElement[];
  const combined = chips.find((el) => el.textContent === "fable · low");
  expect(combined).toBeTruthy();
  expect(combined!.className).toContain("shrink-0");
  expect(combined!.className).not.toContain("absolute");
  expect(combined!.title).toContain("Reasoning effort: low");
  /* Its slot is the horizontally scrolling meta row — at 390px overflow
     scrolls away instead of stacking chips on top of one another. */
  let scroller: HTMLElement | null = null;
  for (let node = combined!.parentElement; node; node = node.parentElement) {
    if (node.className.includes("overflow-x-auto")) { scroller = node; break; }
  }
  expect(scroller).not.toBeNull();
  expect(scroller!.className).toContain("no-scrollbar");
});
