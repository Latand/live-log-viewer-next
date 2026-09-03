import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { setLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

/*
 * Mobile v2 lane 5 (#1439) — the two rows this lane takes off the bottom of the
 * phone's transcript (README §3.4, §6).
 *
 * The operator's screenshot stacked, above the keyboard: a live-tail pill, a
 * «working… 1m 31s» status row, and a model/effort row. The pill and the status
 * row are LogFeed's, and both are gone on the phone: following is the feed's
 * default and needs no pill, and the state phrase with its clock lives in the
 * conversation bar's meta line while Stop is the composer's send slot. Neither
 * was ever in the old `chatBudget` sum, which is why that budget stayed green
 * while the screen filled with chrome.
 *
 * What must NOT go with them is the «back to live» control: it only exists once
 * the operator has scrolled away from the tail, and without it a phone has no
 * way back. The desktop keeps all three.
 */

const dom = new HappyWindow({ width: 390, height: 844 });
let mobile = true;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: mobile,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false,
});

const resizeCallbacks = new Set<ResizeObserverCallback>();
class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) { resizeCallbacks.add(callback); }
  observe() {}
  unobserve() {}
  disconnect() { resizeCallbacks.delete(this.callback); }
}

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
  PointerEvent: dom.PointerEvent,
  KeyboardEvent: dom.KeyboardEvent,
  WheelEvent: dom.WheelEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  IntersectionObserver: undefined,
});

const AT = (second: number) => `2026-09-02T10:00:${String(second).padStart(2, "0")}.000Z`;
const TRANSCRIPT = [
  { type: "user", uuid: "uuid-ask", timestamp: AT(0), message: { role: "user", content: [{ type: "text", text: "Rebuild the board status projection." }] } },
  { type: "assistant", uuid: "uuid-answer", timestamp: AT(1), message: { role: "assistant", content: [{ type: "text", text: "The projection derives held from the delivery outbox." }] } },
].map((line) => JSON.stringify(line));

const previousFetch = globalThis.fetch;
globalThis.fetch = (async () => ({ ok: false, status: 404, json: async () => ({}) } as Response)) as unknown as typeof fetch;

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualLogTail = await import("@/hooks/useLogTail");
const actualToolCues = await import("@/hooks/useToolActivityCues");
const inertRuntime = { enabled: true, connection: "live" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inertRuntime, lastEventAt: null }),
  useRuntime: () => inertRuntime,
  useRuntimeSession: () => null,
  useRuntimeSessionForConversation: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
mock.module("@/hooks/useLogTail", () => ({
  ...actualLogTail,
  useLogTail: () => ({
    lines: TRANSCRIPT,
    linesStart: 0,
    size: TRANSCRIPT.length,
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
mock.module("@/hooks/useToolActivityCues", () => ({ ...actualToolCues, useToolActivityCues: () => undefined }));

const { LogFeed } = await import("./LogFeed");

const roots = new Set<Root>();
beforeEach(() => {
  setLocale("en");
  mobile = true;
  dom.sessionStorage.clear();
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
});
afterAll(() => {
  globalThis.fetch = previousFetch;
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
  mock.module("@/hooks/useToolActivityCues", () => actualToolCues);
});

/** A live conversation with an open turn: the state that renders both rows. */
const file = {
  path: "/fixtures/claude/projects/-repo/lane5-chrome.jsonl",
  root: "claude-projects",
  name: "lane5-chrome.jsonl",
  project: "repo",
  title: "Rebuild the board status projection",
  engine: "claude",
  kind: "session",
  fmt: "claude",
  parent: null,
  mtime: Date.parse(AT(2)) / 1000,
  size: 1,
  activity: "live",
  proc: "running",
  pid: 7,
  model: null,
  pendingQuestion: null,
  waitingInput: null,
  conversationId: "conversation_lane5_chrome",
  lastTurn: { startedAt: Date.parse(AT(0)), endedAt: null },
} as FileEntry;

function render(): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as Element);
  roots.add(root);
  flushSync(() => root.render(
    <LogFeed file={file} showSvc={false} lineFilter="" onStatus={() => undefined} paused follow setFollow={() => undefined} compact />,
  ));
  return host as unknown as HTMLElement;
}

test("the phone transcript ends with the feed: no live-tail pill, no turn status row", () => {
  const host = render();
  expect(host.querySelector("[data-live-tail-pill]")).toBeNull();
  expect(host.querySelector("[data-turn-status]")).toBeNull();
});

test("the desktop keeps both — the removal is the phone's, not a regression for everyone", () => {
  mobile = false;
  const host = render();
  expect(host.querySelector("[data-live-tail-pill]")).toBeTruthy();
  expect(host.querySelector('[data-turn-status="running"]')).toBeTruthy();
});

/** A scroller the feed's magnet logic can actually read (happy-dom reports 0
    for every box), so releasing the magnet is a real gesture here. */
function setScrollerGeometry(element: HTMLElement, height: number, viewport: number, initialTop: number) {
  let top = initialTop;
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => viewport },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => { top = Math.max(0, Math.min(Number(value), height - viewport)); },
    },
  });
  return { setTop: (value: number) => { element.scrollTop = value; } };
}

test("«back to live» survives on the phone: it is the only way back once the tail is left", async () => {
  const host = render();
  const scroller = host.querySelector("[data-log-feed-scroller]") as HTMLElement;
  const geometry = setScrollerGeometry(scroller, 1_200, 200, 1_000);
  flushSync(() => {
    scroller.dispatchEvent(new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -200 }) as unknown as Event);
    geometry.setTop(600);
    scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
  });
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline && !host.querySelector('button[aria-label="Back to the live tail"]')) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(host.querySelector('button[aria-label="Back to the live tail"]')).toBeTruthy();
  /* And leaving the tail still does not bring the removed rows back. */
  expect(host.querySelector("[data-live-tail-pill]")).toBeNull();
  expect(host.querySelector("[data-turn-status]")).toBeNull();
});
