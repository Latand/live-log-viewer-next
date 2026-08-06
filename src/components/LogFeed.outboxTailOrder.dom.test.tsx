import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import { setLocale } from "@/lib/i18n";
import { emptyStore } from "@/components/runtime/runtimeModel";

/**
 * The delivered-bubble ordering invariant (successor of the #922/#933 class):
 * the window tail renders outbox bubbles AFTER every flushed transcript row, so
 * a delivered operator bubble may only still render there while nothing in the
 * transcript is newer than its delivery. Rendered against the redacted
 * production Codex rollout fixture: a delivered entry whose echo was missed
 * must NOT render below the agent's newer tool calls and reply; a delivery
 * newer than the whole transcript still renders at the tail.
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
  IntersectionObserver: undefined,
});

const fixtureLines = fs
  .readFileSync(
    path.join(import.meta.dir, "conversation", "fixtures", "codex-composer-delivery.jsonl"),
    "utf8",
  )
  .split("\n")
  .filter(Boolean);

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualLogTail = await import("@/hooks/useLogTail");
const actualToolCues = await import("@/hooks/useToolActivityCues");
const inertRuntime = { enabled: false, connection: "offline" as const, resyncedAt: null, store: emptyStore() };
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
    lines: fixtureLines,
    linesStart: 0,
    size: 1,
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
const { enqueueOutbox, resetOutboxForTests, updateOutbox } = await import("./conversation/outbox");

/* The newest fixture record: the agent's reply after the tool call. */
const NEWEST_RECORD_AT = Date.parse("2026-08-06T13:44:33.481Z");
const NOW = NEWEST_RECORD_AT + 5_000;
const originalDateNow = Date.now;

const roots = new Set<Root>();
beforeEach(() => {
  Date.now = () => NOW;
  setLocale("en");
  dom.sessionStorage.clear();
  resetOutboxForTests();
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  Date.now = originalDateNow;
});
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
  mock.module("@/hooks/useToolActivityCues", () => actualToolCues);
});

const file: FileEntry = {
  path: "/tmp/x.jsonl",
  root: "codex-sessions",
  name: "x.jsonl",
  project: "project",
  title: "Conversation pane",
  engine: "codex",
  kind: "session",
  fmt: "codex",
  parent: null,
  mtime: NOW,
  size: 1,
  activity: "live",
  proc: "running",
  pid: 7,
  model: null,
  pendingQuestion: null,
  waitingInput: null,
  conversationId: "conversation-tail-order",
} as FileEntry;

function render(): HTMLElement {
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
        follow={false}
        setFollow={() => undefined}
      />,
    );
  });
  return host as unknown as HTMLElement;
}

test("a delivered bubble whose echo was missed cannot render below newer transcript rows", () => {
  /* Delivered BEFORE the fixture's tool call and reply; its text echoes
     nowhere in the transcript (the missed-echo class: scaffolded payload,
     tail attached after the echo row). */
  enqueueOutbox("conversation-tail-order", {
    id: "delivered-before-reply",
    text: "cadence acknowledged",
    images: 0,
    at: Date.parse("2026-08-06T13:44:20.000Z"),
  });
  updateOutbox("conversation-tail-order", "delivered-before-reply", {
    state: "delivered",
    settledAt: Date.parse("2026-08-06T13:44:24.000Z"),
  });

  const host = render();
  /* The transcript rendered — including records newer than the delivery. */
  expect(host.querySelectorAll("[data-feed-kind]").length).toBeGreaterThan(0);
  /* The delivered bubble retired instead of trailing the newer output. */
  expect(host.querySelector("[data-outbox-entry]")).toBeNull();
});

test("a delivery newer than the whole transcript still renders its bubble at the tail", () => {
  enqueueOutbox("conversation-tail-order", {
    id: "delivered-after-reply",
    text: "one more question",
    images: 0,
    at: NEWEST_RECORD_AT + 1_000,
  });
  updateOutbox("conversation-tail-order", "delivered-after-reply", {
    state: "delivered",
    settledAt: NEWEST_RECORD_AT + 1_000,
  });

  const host = render();
  const bubble = host.querySelector<HTMLElement>("[data-outbox-entry]");
  expect(bubble?.dataset.outboxState).toBe("delivered");
  /* Nothing in the transcript is newer than this delivery, so the tail
     position IS its chronological position. */
  const rows = [...host.querySelectorAll("[data-feed-kind], [data-outbox-entry]")];
  expect(rows.at(-1)?.getAttribute("data-outbox-entry")).toBe("delivered-after-reply");
});
