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
 * This asserts the two halves of that contract on the real component: an
 * explicit chip tap reports the open, and a header swipe to the next pane does
 * not. Passing a card is not reading it, which is the entire point of the hold.
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

/* The lane that finished: quiet, nothing pending — a `done` pane, so the
   attention fallback focuses the live one instead and this card's chip is the
   inactive one a thumb reaches for. */
const held = entry({ path: "/held.jsonl", title: "Finished lane outcome", conversationId: "conv-held" });
const live = entry({ path: "/live.jsonl", title: "Still working", conversationId: "conv-live", activity: "live", mtime: 2_000 });

/* The pane header carries MobileFocusView's swipe handle. A mostly-horizontal
   drag past the threshold steps to the neighbouring pane. */
function swipe(header: HTMLElement, dx: number) {
  const start = new dom.Event("touchstart", { bubbles: true });
  Object.assign(start, { touches: [{ clientX: 300, clientY: 200 }] });
  const end = new dom.Event("touchend", { bubbles: true });
  Object.assign(end, { touches: [], changedTouches: [{ clientX: 300 + dx, clientY: 200 }] });
  flushSync(() => { header.dispatchEvent(start as unknown as Event); });
  flushSync(() => { header.dispatchEvent(end as unknown as Event); });
}

const paneTitle = () => dom.document.querySelector('[data-testid="mobile-focused-pane"] header')?.textContent ?? "";

test("a chip tap opens the conversation and reports it seen; a swipe past it does not (#1244)", async () => {
  const opened: string[] = [];
  roots.push(
    mount(
      <MobileFocusView
        project="demo"
        groups={[]}
        manual={[live, held]}
        files={[live, held]}
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

  /* The live pane wins the attention fallback, so the held card is on screen as
     a chip only. Sitting there reports nothing: passive presence is not an act. */
  expect(paneTitle()).toContain("Still working");
  expect(opened).toEqual([]);

  /* A header swipe hops to the next pane. It changes what is focused WITHOUT
     reporting an open — swiping past a held card must not release its hold. */
  const header = dom.document.querySelector('[data-testid="mobile-focused-pane"] header') as unknown as HTMLElement | null;
  expect(header).not.toBeNull();
  swipe(header!, -120);
  await settle();
  expect(paneTitle()).toContain("Finished lane outcome");
  expect(opened).toEqual([]);

  /* The explicit gesture: tapping the chip. Same act as clicking the card on the
     desktop board, so it reports the same open. */
  swipe(dom.document.querySelector('[data-testid="mobile-focused-pane"] header') as unknown as HTMLElement, 120);
  await settle();
  expect(paneTitle()).toContain("Still working");
  const chip = dom.document.querySelector('button[title="Finished lane outcome"]') as HTMLButtonElement | null;
  expect(chip).not.toBeNull();
  flushSync(() => chip!.click());
  await settle();
  expect(paneTitle()).toContain("Finished lane outcome");
  expect(opened).toEqual(["/held.jsonl"]);
});
