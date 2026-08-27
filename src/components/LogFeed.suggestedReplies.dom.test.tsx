import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { setLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import { emptyStore } from "@/components/runtime/runtimeModel";

/**
 * #1202 where the operator actually meets the drafts: the conversation feed.
 *
 * The orchestrator dock and the board's conversation pane are the same shell —
 * both compose `LogFeed` over `TmuxComposer` — so this asserts the placement
 * contract on the feed itself: the pills sit inside the scroller under the
 * latest turn while that turn is what the operator is looking at, and move to
 * the pinned row above the composer once the magnet is released. Never both.
 */

const dom = new HappyWindow({ width: 1280, height: 800 });
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false,
});

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
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
  KeyboardEvent: dom.KeyboardEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  IntersectionObserver: undefined,
});

const CONVERSATION_ID = "conversation_seat_1202";
const AT = (second: number) => `2026-08-26T10:00:${String(second).padStart(2, "0")}.000Z`;

/* One ask from the manager, as the tail reads it: the operator's request, the
   answer, and the question the drafts belong under. */
const TRANSCRIPT = [
  { type: "user", uuid: "uuid-ask", timestamp: AT(0), message: { role: "user", content: [{ type: "text", text: "How does the merge look?" }] } },
  { type: "assistant", uuid: "uuid-answer", timestamp: AT(1), message: { role: "assistant", content: [{ type: "text", text: "Both reviews passed. Merge now, or hold for the deploy window?" }] } },
].map((line) => JSON.stringify(line));

const drafts = [
  { label: "merge now", text: "Merge it now." },
  { label: "hold for the window", text: "Hold for the deploy window." },
];

const served = {
  set: {
    conversationId: CONVERSATION_ID,
    setId: "rsg_feed",
    at: AT(2),
    origin: { kind: "manager", conversationId: CONVERSATION_ID, role: "orchestrator" },
    replies: drafts,
  },
};

const previousFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => {
  const url = String(input);
  if (url.startsWith("/api/log/suggestions")) {
    return { ok: true, status: 200, json: async () => served } as Response;
  }
  /* Everything else the pane may reach for is simply absent here — a 404 is
     what each of those readers already handles (no delivery evidence, no tmux
     targets, no speech backends), so nothing else renders. */
  return { ok: false, status: 404, json: async () => ({}) } as Response;
}) as typeof fetch;

const tailState = { lines: TRANSCRIPT };
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
    lines: tailState.lines,
    linesStart: 0,
    size: tailState.lines.length,
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
mock.module("@/hooks/useToolActivityCues", () => ({
  ...actualToolCues,
  useToolActivityCues: () => undefined,
}));

const { LogFeed } = await import("./LogFeed");

const roots = new Set<Root>();
beforeEach(() => {
  setLocale("en");
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

const file = {
  path: "/fixtures/claude/projects/-repo/seat-1202.jsonl",
  root: "claude-projects",
  name: "seat-1202.jsonl",
  project: "repo",
  title: "Manager",
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
  conversationId: CONVERSATION_ID,
} as FileEntry;

function render(follow: boolean): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  flushSync(() => {
    root.render(
      <LogFeed
        file={file}
        showSvc={false}
        lineFilter=""
        onStatus={() => undefined}
        paused
        follow={follow}
        setFollow={() => undefined}
        compact
      />,
    );
  });
  return host as unknown as HTMLElement;
}

async function settle(host: HTMLElement, selector: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !host.querySelector(selector)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("the drafts render inside the feed, under the latest turn, while the operator is watching it", async () => {
  const host = render(true);
  await settle(host, '[data-reply-suggestions="inline"]');

  const row = host.querySelector('[data-reply-suggestions="inline"]')!;
  expect([...row.querySelectorAll("[data-reply-suggestion]")].map((pill) => pill.textContent))
    .toEqual(drafts.map((draft) => draft.label));
  /* Inside the transcript scroller, after the last transcript row: the drafts
     answer the turn they are sitting under. */
  const scroller = host.querySelector("[data-log-feed-scroller]")!;
  expect(scroller.contains(row)).toBe(true);
  const lastRow = [...host.querySelectorAll("[data-feed-key]")].at(-1)!;
  expect(lastRow.compareDocumentPosition(row) & 4 /* DOCUMENT_POSITION_FOLLOWING */).toBeTruthy();
  /* One offer, one place. */
  expect(host.querySelectorAll('[data-reply-suggestions="floating"]')).toHaveLength(0);
});

test("with the magnet released the drafts pin above the composer instead of staying off-screen", async () => {
  const host = render(false);
  await settle(host, '[data-reply-suggestions="floating"]');

  const row = host.querySelector('[data-reply-suggestions="floating"]')!;
  expect(row.querySelectorAll("[data-reply-suggestion]")).toHaveLength(drafts.length);
  /* Outside the scroller — it rides the pane, not the transcript — and the
     inline copy is gone rather than doubled. */
  expect(host.querySelector("[data-log-feed-scroller]")!.contains(row)).toBe(false);
  expect(host.querySelectorAll('[data-reply-suggestions="inline"]')).toHaveLength(0);
});
