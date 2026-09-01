import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import type { ReactElement } from "react";
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

const resizeCallbacks = new Set<ResizeObserverCallback>();

class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    resizeCallbacks.add(callback);
  }
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
  tailState.lines = TRANSCRIPT;
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

function conversationFile(suffix: string): FileEntry {
  return {
    ...file,
    path: `/fixtures/claude/projects/-repo/seat-${suffix}.jsonl`,
    name: `seat-${suffix}.jsonl`,
    conversationId: `conversation_seat_${suffix.replaceAll("-", "_")}`,
  };
}

function feedElement(
  follow: boolean,
  setFollow: (value: boolean) => void,
  feedFile: FileEntry,
): ReactElement {
  return (
    <LogFeed
      file={feedFile}
      showSvc={false}
      lineFilter=""
      onStatus={() => undefined}
      paused
      follow={follow}
      setFollow={setFollow}
      compact
    />
  );
}

function transcriptWithUpdates(idPrefix: string, textPrefix: string, count: number): string[] {
  return [
    ...TRANSCRIPT,
    ...Array.from({ length: count }, (_, index) => JSON.stringify({
      type: "assistant",
      uuid: `uuid-${idPrefix}-${index}`,
      timestamp: AT(3 + index),
      message: { role: "assistant", content: [{ type: "text", text: `${textPrefix} ${index + 1}.` }] },
    })),
  ];
}

function render(
  follow: boolean,
  setFollow: (value: boolean) => void = () => undefined,
  feedFile: FileEntry = file,
): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  flushSync(() => {
    root.render(feedElement(follow, setFollow, feedFile));
  });
  return host as unknown as HTMLElement;
}

function setScrollerGeometry(element: HTMLElement, height: number, viewport: number, initialTop: number) {
  let scrollHeight = height;
  let top = initialTop;
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => scrollHeight },
    clientHeight: { configurable: true, get: () => viewport },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(Number(value), scrollHeight - viewport));
      },
    },
  });
  return {
    setHeight: (value: number) => { scrollHeight = value; },
    setTop: (value: number) => { element.scrollTop = value; },
  };
}

function touchEvent(type: "touchstart" | "touchmove" | "touchend", clientY?: number): Event {
  const event = new dom.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: clientY === undefined ? [] : [{ clientX: 20, clientY }],
  });
  return event as unknown as Event;
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

test("a floating pill row with no vertical range forwards vertical wheel movement to the feed", async () => {
  const host = render(false);
  await settle(host, '[data-reply-suggestions="floating"]');

  const row = host.querySelector('[data-reply-suggestions="floating"]') as HTMLElement;
  const scroller = host.querySelector("[data-log-feed-scroller]") as HTMLElement;
  setScrollerGeometry(row, 40, 40, 0);
  setScrollerGeometry(scroller, 1_000, 200, 600);

  flushSync(() => {
    row.dispatchEvent(new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120 }) as unknown as Event);
  });

  expect(scroller.scrollTop).toBe(480);

  setScrollerGeometry(row, 100, 40, 20);
  flushSync(() => {
    row.dispatchEvent(new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -20 }) as unknown as Event);
  });
  expect(scroller.scrollTop).toBe(480);
});

test("an upward wheel survives a concurrent glue and releases the scroll magnet on the first gesture", () => {
  const originalNow = Date.now;
  const fixedNow = originalNow();
  Date.now = () => fixedNow;
  try {
    const followChanges: boolean[] = [];
    const host = render(true, (value) => followChanges.push(value));
    const scroller = host.querySelector("[data-log-feed-scroller]") as HTMLElement;
    const geometry = setScrollerGeometry(scroller, 1_000, 200, 800);

    flushSync(() => {
      scroller.dispatchEvent(new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -20 }) as unknown as Event);
      geometry.setHeight(1_100);
      for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
      scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
      geometry.setTop(880);
      scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
    });

    expect(scroller.scrollTop).toBe(880);
    expect(followChanges).toEqual([false]);
  } finally {
    Date.now = originalNow;
  }
});

test("a burst of tail records cannot move the viewport down during an upward wheel gesture", () => {
  const followChanges: boolean[] = [];
  const feedFile = conversationFile("wheel-burst");
  const host = render(true, (value) => followChanges.push(value), feedFile);
  const root = [...roots].at(-1)!;
  const scroller = host.querySelector("[data-log-feed-scroller]") as HTMLElement;
  const geometry = setScrollerGeometry(scroller, 1_000, 200, 800);
  const viewportPositions = [scroller.scrollTop];

  try {
    flushSync(() => {
      scroller.dispatchEvent(new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120 }) as unknown as Event);
    });

    for (let record = 1; record <= 3; record += 1) {
      tailState.lines = transcriptWithUpdates("wheel-burst", "Burst update", record);
      geometry.setHeight(1_000 + record * 100);
      flushSync(() => {
        root.render(feedElement(true, (value) => followChanges.push(value), feedFile));
      });
      viewportPositions.push(scroller.scrollTop);
    }

    expect(viewportPositions).toEqual([800, 800, 800, 800]);
    expect(followChanges).toEqual([false]);
  } finally {
    tailState.lines = TRANSCRIPT;
  }
});

test("a burst of tail records cannot move the viewport down during an upward touch gesture", () => {
  const followChanges: boolean[] = [];
  const feedFile = conversationFile("touch-burst");
  const host = render(true, (value) => followChanges.push(value), feedFile);
  const root = [...roots].at(-1)!;
  const scroller = host.querySelector("[data-log-feed-scroller]") as HTMLElement;
  const geometry = setScrollerGeometry(scroller, 1_000, 200, 800);
  const viewportPositions = [scroller.scrollTop];

  try {
    flushSync(() => {
      scroller.dispatchEvent(touchEvent("touchstart", 400));
      scroller.dispatchEvent(touchEvent("touchmove", 460));
    });

    for (let record = 1; record <= 3; record += 1) {
      tailState.lines = transcriptWithUpdates("touch-burst", "Touch burst update", record);
      geometry.setHeight(1_000 + record * 100);
      flushSync(() => {
        root.render(feedElement(true, (value) => followChanges.push(value), feedFile));
      });
      viewportPositions.push(scroller.scrollTop);
    }

    expect(viewportPositions).toEqual([800, 800, 800, 800]);
    expect(followChanges).toEqual([false]);
  } finally {
    tailState.lines = TRANSCRIPT;
  }
});

test("follow stays disarmed across further arrivals and resizes until the operator reaches bottom", () => {
  const followChanges: boolean[] = [];
  const feedFile = conversationFile("durable-release");
  const host = render(true, (value) => followChanges.push(value), feedFile);
  const root = [...roots].at(-1)!;
  const scroller = host.querySelector("[data-log-feed-scroller]") as HTMLElement;
  const geometry = setScrollerGeometry(scroller, 1_000, 200, 800);

  try {
    flushSync(() => {
      scroller.dispatchEvent(new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -200 }) as unknown as Event);
      geometry.setTop(600);
      scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
    });

    const releasedPositions: number[] = [];
    for (let record = 1; record <= 3; record += 1) {
      tailState.lines = transcriptWithUpdates("durable-release", "Durable update", record);
      geometry.setHeight(1_000 + record * 100);
      flushSync(() => {
        root.render(feedElement(true, (value) => followChanges.push(value), feedFile));
        for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
      });
      releasedPositions.push(scroller.scrollTop);
    }

    expect(releasedPositions).toEqual([600, 600, 600]);
    expect(followChanges).toEqual([false]);

    flushSync(() => {
      scroller.dispatchEvent(new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 500 }) as unknown as Event);
      geometry.setTop(1_100);
      scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
    });
    expect(followChanges).toEqual([false, true]);

    tailState.lines = [
      ...tailState.lines,
      JSON.stringify({
        type: "assistant",
        uuid: "uuid-after-bottom-return",
        timestamp: AT(6),
        message: { role: "assistant", content: [{ type: "text", text: "Following again." }] },
      }),
    ];
    geometry.setHeight(1_400);
    flushSync(() => {
      root.render(feedElement(true, (value) => followChanges.push(value), feedFile));
    });
    expect(scroller.scrollTop).toBe(1_200);
  } finally {
    tailState.lines = TRANSCRIPT;
  }
});

test("the jump-to-latest control clears the durable disarm and restores live-tail follow", async () => {
  const followChanges: boolean[] = [];
  const feedFile = conversationFile("jump-latest");
  const host = render(true, (value) => followChanges.push(value), feedFile);
  const scroller = host.querySelector("[data-log-feed-scroller]") as HTMLElement;
  const geometry = setScrollerGeometry(scroller, 1_200, 200, 1_000);

  flushSync(() => {
    scroller.dispatchEvent(new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -200 }) as unknown as Event);
    geometry.setTop(600);
    scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
  });
  await settle(host, 'button[aria-label="Back to the live tail"]');

  const jump = host.querySelector('button[aria-label="Back to the live tail"]') as HTMLButtonElement;
  expect(jump).toBeTruthy();
  expect(followChanges).toEqual([false]);

  flushSync(() => { jump.click(); });

  expect(scroller.scrollTop).toBe(1_000);
  expect(followChanges).toEqual([false, true]);
  expect(host.querySelector('button[aria-label="Back to the live tail"]')).toBeNull();
  expect(host.querySelector("[data-live-tail-pill]")).toBeTruthy();
});

test("growth before an upward wheel survives resize glue and stays released through the next append", () => {
  const originalNow = Date.now;
  const fixedNow = originalNow();
  Date.now = () => fixedNow;
  try {
    const followChanges: boolean[] = [];
    const feedFile = {
      ...file,
      path: "/fixtures/claude/projects/-repo/seat-growth-before-input.jsonl",
      name: "seat-growth-before-input.jsonl",
      conversationId: "conversation_seat_growth_before_input",
    };
    const host = render(true, (value) => followChanges.push(value), feedFile);
    const root = [...roots].at(-1)!;
    const scroller = host.querySelector("[data-log-feed-scroller]") as HTMLElement;
    const geometry = setScrollerGeometry(scroller, 1_000, 200, 800);

    flushSync(() => {
      geometry.setHeight(1_100);
      scroller.dispatchEvent(new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120 }) as unknown as Event);
      for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
      scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
      geometry.setTop(780);
      scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
    });

    expect(scroller.scrollTop).toBe(780);
    expect(followChanges).toEqual([false]);

    tailState.lines = [
      ...TRANSCRIPT,
      JSON.stringify({
        type: "assistant",
        uuid: "uuid-after-release",
        timestamp: AT(3),
        message: { role: "assistant", content: [{ type: "text", text: "A later update arrived." }] },
      }),
    ];
    geometry.setHeight(1_200);
    flushSync(() => {
      root.render(
        <LogFeed
          file={feedFile}
          showSvc={false}
          lineFilter=""
          onStatus={() => undefined}
          paused
          follow={false}
          setFollow={(value) => followChanges.push(value)}
          compact
        />,
      );
    });

    expect(scroller.scrollTop).toBe(780);
    expect(followChanges).toEqual([false]);
  } finally {
    tailState.lines = TRANSCRIPT;
    Date.now = originalNow;
  }
});

test("a wheel that cannot move the feed does not tag a later settling scroll as user initiated", () => {
  const originalNow = Date.now;
  const fixedNow = originalNow();
  Date.now = () => fixedNow;
  try {
    const followChanges: boolean[] = [];
    const host = render(
      true,
      (value) => followChanges.push(value),
      {
        ...file,
        path: "/fixtures/claude/projects/-repo/seat-settling.jsonl",
        name: "seat-settling.jsonl",
        conversationId: "conversation_seat_settling",
      },
    );
    const scroller = host.querySelector("[data-log-feed-scroller]") as HTMLElement;
    const geometry = setScrollerGeometry(scroller, 1_000, 200, 800);

    flushSync(() => {
      scroller.dispatchEvent(new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120 }) as unknown as Event);
      geometry.setTop(600);
      scroller.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
    });

    expect(scroller.scrollTop).toBe(800);
    expect(followChanges).toEqual([]);
  } finally {
    Date.now = originalNow;
  }
});
