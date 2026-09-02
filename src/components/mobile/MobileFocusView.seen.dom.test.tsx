import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore } from "@/components/runtime/runtimeModel";
import type { FileEntry } from "@/lib/types";

/*
 * The phone's OPEN gesture (#1244).
 *
 * A finished lane holds its outcome card until the operator has SEEN it, and
 * "seen" is an act: they opened the conversation. On the desktop board that act
 * is a card expand, reported through SchemeBoard's `onConversationOpened`. The
 * phone had no equivalent — a chip tap only moved the pinned pane — so a held
 * card could not be released from a phone at all.
 *
 * Mobile v2 lane 3 replaced the chip strip with the bar's title cell: the
 * explicit gesture is now a SWITCHER ROW, and the passive one is the bar swipe
 * that walks the same list. This asserts both halves of that contract on the
 * real component: a switcher row reports the open, a swipe to the next sibling
 * does not. Passing a card is not reading it, which is the whole point of the
 * hold — and the swipe never walks Recent at all (README §3.3), so a finished
 * outcome cannot even be swiped past.
 */

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

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  // The phone layout: useIsMobile must answer true.
  matchMedia: (q: string) => ({ matches: true, media: String(q), onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }),
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
  (dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
});

let roots: Root[] = [];
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; });
afterEach(async () => { for (const r of roots) flushSync(() => r.unmount()); roots = []; await settle(); dom.sessionStorage.clear(); });

function mount(node: React.ReactElement): Root {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(node));
  return root;
}

function entry(over: Partial<FileEntry> & Pick<FileEntry, "path" | "title">): FileEntry {
  return {
    root: "claude-projects", name: over.path.slice(1), project: "demo", engine: "claude", kind: "session",
    fmt: "claude", parent: null, mtime: 1_000, size: 1, activity: "idle", proc: null, pid: null,
    conversationId: null, model: "opus", pendingQuestion: null, waitingInput: null,
    ...over,
  } as FileEntry;
}

/* The lane that finished: quiet, nothing pending — a `done` pane, so it lands
   in the switcher's Recent section, which the swipe never walks. */
const held = entry({ path: "/held.jsonl", title: "Finished lane outcome", conversationId: "conv-held" });
const live = entry({ path: "/live.jsonl", title: "Still working", conversationId: "conv-live", activity: "live", mtime: 3_000 });
const other = entry({ path: "/other.jsonl", title: "Also working", conversationId: "conv-other", activity: "live", mtime: 2_000 });

/* The bar and the dock are the swipe zone (README §3.3). A mostly-horizontal
   drag past the threshold steps to the neighbouring conversation. */
function swipe(zone: HTMLElement, dx: number) {
  const start = new dom.Event("touchstart", { bubbles: true });
  Object.assign(start, { touches: [{ clientX: 300, clientY: 200 }] });
  const end = new dom.Event("touchend", { bubbles: true });
  Object.assign(end, { touches: [], changedTouches: [{ clientX: 300 + dx, clientY: 200 }] });
  flushSync(() => { zone.dispatchEvent(start as unknown as Event); });
  flushSync(() => { zone.dispatchEvent(end as unknown as Event); });
}

const bar = () => dom.document.querySelector("[data-mobile2-bar]") as unknown as HTMLElement;
const barTitle = () => dom.document.querySelector("[data-mobile2-title-text]")?.textContent ?? "";

test("a switcher row opens the conversation and reports it seen; a bar swipe past a sibling does not (#1244)", async () => {
  const opened: string[] = [];
  roots.push(
    mount(
      <MobileFocusView
        project="demo"
        groups={[]}
        manual={[live, other, held]}
        files={[live, other, held]}
        flows={[]}
        pipelines={[]}
        tasks={[]}
        drafts={[]}
        loaded
        focus={null}
        onSelect={() => {}}
        onClose={() => {}}
        onDraftClose={() => {}}
        onDraftSpawned={() => {}}
        onConversationOpened={(path) => opened.push(path)}
      />,
    ),
  );
  await settle();

  /* The live pane wins the attention fallback. Sitting there reports nothing:
     passive presence is not an act. */
  expect(barTitle()).toContain("Still working");
  expect(opened).toEqual([]);

  /* A bar swipe hops to the next sibling. It changes what is focused WITHOUT
     reporting an open — swiping past a card must not release a hold. */
  swipe(bar(), -120);
  await settle();
  expect(barTitle()).toContain("Also working");
  expect(opened).toEqual([]);

  /* And the swipe never reaches the finished lane at all: Recent is not in the
     swipe's order, so the end of the list bumps instead of walking on. */
  swipe(bar(), -120);
  await settle();
  expect(barTitle()).toContain("Also working");
  expect(dom.document.querySelector("[data-mobile2-title]")?.getAttribute("data-mobile2-bump")).toBe("right");
  expect(opened).toEqual([]);

  /* The explicit gesture: the title cell opens the switcher, and its row is the
     same act as clicking the card on the desktop board. */
  const cell = dom.document.querySelector('[data-mobile2-open="switch"]') as unknown as HTMLButtonElement;
  expect(cell).not.toBeNull();
  flushSync(() => cell.click());
  await settle();
  const row = dom.document.querySelector('[data-mobile2-sheet="switch"] [data-mobile2-conversation="conv-held"]') as unknown as HTMLButtonElement;
  expect(row).not.toBeNull();
  flushSync(() => row.click());
  await settle();
  expect(barTitle()).toContain("Finished lane outcome");
  expect(opened).toEqual(["/held.jsonl"]);
});
