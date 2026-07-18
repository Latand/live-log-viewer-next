import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import type { FileEntry } from "@/lib/types";
import { emptyStore } from "@/components/runtime/runtimeModel";

/*
 * Issue #270 — the reasoning bars in the REAL pane header. Desktop board pane,
 * a scheme node's world (where `--inv-z` scales in-world text), and the 390px
 * phone header: the meter must hold a reserved flex slot beside the model chip
 * (or, on the phone, fold into the combined «model · effort» chip inside the
 * scrolling meta row) — never an overlay that paints across its neighbors.
 */

const desktop = new HappyWindow({ width: 1280, height: 800 });
const phone = new HappyWindow({ width: 390, height: 844 });

function stubMatchMedia(dom: HappyWindow, mobile: boolean) {
  (dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
    matches: mobile && query.includes("max-width"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  });
}
stubMatchMedia(desktop, false);
stubMatchMedia(phone, true);

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function bindDomGlobals(dom: HappyWindow) {
  Object.assign(globalThis, {
    ResizeObserver: TestResizeObserver,
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    Node: dom.Node,
    HTMLElement: dom.HTMLElement,
    HTMLButtonElement: dom.HTMLButtonElement,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    MouseEvent: dom.MouseEvent,
    KeyboardEvent: dom.KeyboardEvent,
    sessionStorage: dom.sessionStorage,
    localStorage: dom.localStorage,
    IntersectionObserver: undefined,
  });
}

bindDomGlobals(desktop);

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualLogTail = await import("@/hooks/useLogTail");
const inertRuntime = { enabled: false, connection: "offline" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inertRuntime, lastEventAt: null }),
  useRuntime: () => inertRuntime,
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
mock.module("@/hooks/useLogTail", () => ({
  useLogTail: () => ({
    lines: [],
    linesStart: 0,
    size: 0,
    loading: false,
    error: null,
    tickTime: null,
    paused: false,
    setPaused: () => undefined,
    clear: () => undefined,
    hasMore: false,
    loadingOlder: false,
    loadOlder: async () => 0,
    prependGen: 0,
  }),
}));

const { BranchPane } = await import("./BranchPane");

const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  desktop.document.body.replaceChildren();
  phone.document.body.replaceChildren();
});
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
});

function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/pane.jsonl",
    root: "claude-projects",
    name: "pane.jsonl",
    project: "project",
    title: "Conversation pane",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "live",
    proc: null,
    pid: null,
    model: "fable",
    effort: "low",
    pendingQuestion: null,
    waitingInput: null,
    conversationId: "conversation-1",
    ...overrides,
  };
}

function mount(dom: HappyWindow, node: React.ReactElement) {
  bindDomGlobals(dom);
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(node));
  return host;
}

function containerAncestor(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (node.className.includes("@container")) return node;
  }
  return null;
}

test("the desktop header seats the meter in-flow right after the model chip, inside a width-aware row", () => {
  const host = mount(desktop, <BranchPane file={file()} tasks={[]} isRoot />);
  const slot = host.querySelector("[data-effort-slot]") as HTMLElement;
  expect(slot).toBeTruthy();
  /* Reserved flex slot: shrink-0, no overlay positioning, no transform. */
  expect(slot.className).toContain("shrink-0");
  expect(slot.className).not.toContain("absolute");
  expect(slot.getAttribute("style") ?? "").not.toContain("transform");
  /* In DOM (= flex) order it directly follows the model identity chip. */
  const chip = slot.previousElementSibling as HTMLElement;
  expect(chip?.textContent).toBe("fable");
  /* The header meta row is the meter's query container, so a pane too narrow
     to seat the bars collapses them instead of letting them collide. */
  const row = containerAncestor(slot);
  expect(row).not.toBeNull();
  expect(host.querySelector("header")!.contains(row!)).toBe(true);
  expect(slot.className).toContain("@max-[240px]:hidden");
});

test("inside a zoomed-out scheme node the meter scales through its font-size under the shared in-world cap", () => {
  /* The scheme world sets `--inv-z` on an ancestor (SchemeBoard); the meter
     must grow its LAYOUT box through that var — capped at the same 2.6× every
     other in-world text uses — rather than paint a transform over the chips. */
  const host = mount(
    desktop,
    <div style={{ "--inv-z": "2.4", width: 600 } as React.CSSProperties}>
      <BranchPane file={file()} tasks={[]} isRoot />
    </div>,
  );
  const slot = host.querySelector("[data-effort-slot]") as HTMLElement;
  expect(slot).toBeTruthy();
  expect(slot.className).toContain("h-[1.2em]");
  /* happy-dom's CSSOM validator drops the nested min()/var() calc browsers
     accept, so the sizing string is asserted on the pane's static markup
     (same technique as GroupsLayer.render.test); the mounted pane above keeps
     the structural half of the contract. */
  const markup = renderToStaticMarkup(
    <div style={{ "--inv-z": "2.4", width: 600 } as React.CSSProperties}>
      <BranchPane file={file()} tasks={[]} isRoot />
    </div>,
  );
  const slotMarkup = markup.slice(markup.indexOf("data-effort-slot"));
  expect(slotMarkup).toContain("font-size:calc(10px * min(var(--inv-z, 1), 2.6))");
  expect(slotMarkup.slice(0, slotMarkup.indexOf("</span></span>"))).not.toContain("transform");
});

test("the 390px header replaces the bars with the combined chip inside the scrolling meta row", () => {
  const host = mount(phone, <BranchPane file={file()} tasks={[]} isRoot />);
  /* No bar meter on the phone — identity folds into one chip. */
  expect(host.querySelector("[data-effort-slot]")).toBeNull();
  const chips = [...host.querySelectorAll("header span")] as HTMLElement[];
  const combined = chips.find((el) => el.textContent === "fable · low");
  expect(combined).toBeTruthy();
  expect(combined!.className).toContain("shrink-0");
  expect(combined!.className).not.toContain("absolute");
  /* It lives inside the horizontally scrolling meta row: overflow scrolls
     off-screen instead of stacking chips on top of each other. */
  let scroller: HTMLElement | null = null;
  for (let node = combined!.parentElement; node; node = node.parentElement) {
    if (node.className.includes("overflow-x-auto")) {
      scroller = node;
      break;
    }
  }
  expect(scroller).not.toBeNull();
});
