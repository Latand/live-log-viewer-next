import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import { setLocale } from "@/lib/i18n";
import { emptyStore } from "@/components/runtime/runtimeModel";
import type { RuntimeReceipt } from "./runtime/runtimeModel";
import { setTmuxComposerRuntimeDependenciesForTests } from "./tmuxComposerRuntime";
import { attachModeFor, capabilitiesFor } from "./agentCapabilities";
import type { RuntimeSessionView } from "@/hooks/useRuntime";

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
let tailLines = fixtureLines;

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
    lines: tailLines,
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
const { TmuxComposer } = await import("./TmuxComposer");
const { enqueueOutbox, readOutbox, resetOutboxForTests, seedLaunchOutbox, updateOutbox } = await import("./conversation/outbox");

/* The newest fixture record: the agent's reply after the tool call. */
const NEWEST_RECORD_AT = Date.parse("2026-08-06T13:44:33.481Z");
const NOW = NEWEST_RECORD_AT + 5_000;
const originalDateNow = Date.now;

const roots = new Set<Root>();
beforeEach(() => {
  Date.now = () => NOW;
  setLocale("en");
  tailLines = fixtureLines;
  dom.sessionStorage.clear();
  resetOutboxForTests();
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  Date.now = originalDateNow;
  setTmuxComposerRuntimeDependenciesForTests(null);
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

function render(renderedFile: FileEntry = file, withComposer = false): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  flushSync(() => {
    root.render(
      <>
        {withComposer ? <TmuxComposer file={renderedFile} /> : null}
        <LogFeed
          file={renderedFile}
          showSvc={false}
          lineFilter=""
          onStatus={() => undefined}
          paused
          follow={false}
          setFollow={() => undefined}
        />
      </>,
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

test.each([
  ["builder", "Ship the focused repair.", "You are a Builder in plain mode.\n\nShip the focused repair."],
  ["reviewer", "Review the focused repair.", "You are a Reviewer.\nSafety fences:\n- stay in scope\n\nReview the focused repair."],
])("issue 616: direct 202-to-live %s adoption renders only the scaffolded transcript echo", (_role, raw, scaffolded) => {
  const conversationId = "conversation_direct_adoption";
  const launchId = "launch_direct_adoption";
  const transcriptAt = NEWEST_RECORD_AT;
  tailLines = [JSON.stringify({
    timestamp: new Date(transcriptAt).toISOString(),
    type: "response_item",
    payload: {
      type: "message",
      id: "message_direct_adoption",
      role: "user",
      content: [{ type: "input_text", text: scaffolded }],
    },
  })];

  /* The accepted 202 seeded the raw operator draft and the provisional window
     already attached its exact owner. The first files response is live, so no
     intermediate placeholder poll supplied the role scaffold's echo identity. */
  seedLaunchOutbox(conversationId, {
    id: launchId,
    text: raw,
    images: 0,
    at: transcriptAt - 1_000,
    owner: { conversationId, generation: 1 },
  });
  const adoptedFile: FileEntry = {
    ...file,
    path: "/fixtures/direct-adoption.jsonl",
    name: "direct-adoption.jsonl",
    conversationId,
    generation: 1,
    launch: {
      launchId,
      clientAttemptId: null,
      accountId: null,
      conversationId,
      generation: 1,
      state: "recovered",
      initialMessage: "delivered",
      retrySafe: false,
      error: null,
      deliveredAt: transcriptAt - 500,
      promptEcho: scaffolded,
    },
  };

  const host = render(adoptedFile);
  expect(host.querySelectorAll('[data-feed-kind="user"]')).toHaveLength(1);
  expect(host.querySelector("[data-outbox-entry]") === null).toBe(true);
  expect(readOutbox(conversationId)[0]).toMatchObject({ text: raw, echoText: scaffolded });
});

// Exercise receipt ingestion and feed projection together, with a capped tail.
test.each([
  ["delivered", "valid"], ["delivered", "missing"], ["delivered", "scaffolded-echo"],
  ["queued", "valid"], ["delivering", "valid"], ["uncertain", "valid"],
] as const)(
  "mounted composer and feed preserve chronology for a late %s receipt (%s)",
  (status, evidence) => {
    const key = "late-tail-receipt";
    const serverAt = NEWEST_RECORD_AT - 20_000;
    const receipt: RuntimeReceipt = {
      operationId: "op-late-tail", idempotencyKey: key, conversationId: file.conversationId!,
      kind: "send", status, at: evidence === "missing" ? "" : new Date(serverAt).toISOString(), revision: 3,
    };
    const view = {
      session: { conversationId: file.conversationId, hostKind: "codex-app-server", host: "hosted", recentReceipts: [] },
      uiState: {}, attentions: [], receipts: [receipt], legacy: false, structuredControlsEnabled: true,
    } as unknown as RuntimeSessionView;
    setTmuxComposerRuntimeDependenciesForTests({
      useAgentCapabilities: (candidate) => ({
        caps: capabilitiesFor(candidate, view, { runtimeEnabled: true }),
        runtime: view, structuredSession: view, runtimeEnabled: true,
        attachMode: attachModeFor(candidate, view, { runtimeEnabled: true }),
      }),
      useRuntimeReceiptsForArtifact: () => [receipt],
    });
    enqueueOutbox(file.conversationId!, { id: key, text: "Inspect queued work.", images: 0, at: serverAt - 40_000 });
    updateOutbox(file.conversationId!, key, { state: "delivering" });
    if (evidence === "scaffolded-echo") {
      const scaffold = "Context for this request.\n\nInspect queued work.";
      updateOutbox(file.conversationId!, key, { echoText: scaffold });
      // One echo belongs to the old request; an identical later submission remains.
      enqueueOutbox(file.conversationId!, { id: "next-tail-receipt", text: "Inspect queued work.", images: 0, at: NOW, echoBaseline: 1 });
      updateOutbox(file.conversationId!, "next-tail-receipt", { state: "delivering", echoText: scaffold });
      tailLines = [JSON.stringify({ timestamp: new Date(serverAt).toISOString(), type: "response_item", payload: {
        type: "message", id: "exact-scaffold-echo", role: "user", content: [{ type: "input_text", text: scaffold }],
      } }), ...fixtureLines];
    }
    const host = render(file, true);
    expect(host.querySelectorAll("[data-feed-kind]").length).toBeGreaterThan(0);
    if (evidence === "missing") {
      expect(readOutbox(file.conversationId!)[0]?.settledAt).toBeUndefined();
      expect(host.querySelector<HTMLElement>("[data-outbox-entry]")?.dataset.outboxState).toBe("delivered");
    } else if (evidence === "scaffolded-echo") {
      const bubbles = host.querySelectorAll<HTMLElement>("[data-outbox-entry]");
      expect(bubbles).toHaveLength(1);
      expect(bubbles[0]?.dataset.outboxEntry).toBe("next-tail-receipt");
    } else if (status === "delivered") {
      expect(readOutbox(file.conversationId!)[0]?.settledAt).toBe(serverAt);
      expect(host.querySelector("[data-outbox-entry]")).toBeNull();
    } else {
      expect(host.querySelector<HTMLElement>("[data-outbox-entry]")?.dataset.outboxState).toBe("delivering");
    }
  },
);
