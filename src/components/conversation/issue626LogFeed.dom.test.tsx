import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { RuntimeSessionView } from "@/hooks/useRuntime";
import { setLocale } from "@/lib/i18n";
import { installActEnv } from "@/test-helpers/actEnv";
import type { FileEntry } from "@/lib/types";

import {
  enqueueOutbox,
  resetOutboxForTests,
  seedLaunchOutbox,
} from "./outbox";

const CONVERSATION_ID = "conversation_issue_626_logfeed";
const LAUNCH_ID = "launch_issue_626_logfeed";
const STARTING_PATH = `spawn:${LAUNCH_ID}`;
const ADOPTED_PATH = "/workspace/.codex/sessions/issue-626-logfeed.jsonl";

const dom = new Window({ url: "http://localhost/" });
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: undefined,
});
(dom.HTMLElement.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
(dom as unknown as { matchMedia(query: string): unknown }).matchMedia = (query: string) => ({
  matches: query.includes("pointer: coarse"),
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualLogTail = await import("@/hooks/useLogTail");
let tailLines: string[] = [];
let tailStart = 0;
let runtimeView: RuntimeSessionView = {
  session: {
    conversationId: CONVERSATION_ID,
    sessionKey: { engine: "codex", sessionId: "session_issue_626_logfeed" },
    hostKind: "codex-app-server",
    host: "hosted",
    turn: "idle",
    provenance: "structured",
    revision: 1,
    attentionIds: [],
    recentReceipts: [],
    accountId: "work",
    parentConversationId: null,
    flowId: null,
    workflowId: null,
    cwd: "/workspace",
    artifactPath: ADOPTED_PATH,
    capabilities: { steer: true, structuredAttention: true },
    activeTurnId: null,
    liveTurn: null,
  },
  uiState: "idle",
  attentions: [],
  receipts: [],
  legacy: false,
  structuredControlsEnabled: true,
};

mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeSessionForConversation: (
    conversationId: string | null | undefined,
    artifactPath: string | null,
  ) => conversationId === CONVERSATION_ID || artifactPath === ADOPTED_PATH ? runtimeView : null,
}));
mock.module("@/hooks/useLogTail", () => ({
  useLogTail: () => ({
    lines: tailLines,
    linesStart: tailStart,
    size: tailLines.join("\n").length,
    loading: false,
    error: null,
    tickTime: null,
    paused: false,
    setPaused: () => undefined,
    clear: () => undefined,
    hasMore: tailStart > 0,
    loadingOlder: false,
    loadOlder: async () => 0,
    prependGen: 0,
  }),
}));

const { LogFeed } = await import("../LogFeed");
const realFetch = globalThis.fetch;
const roots = new Set<Root>();

afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
  globalThis.fetch = realFetch;
});

afterEach(() => {
  for (const root of roots) {
    act(() => root.unmount());
  }
  roots.clear();
  setLocale("en");
  dom.document.body.replaceChildren();
  dom.sessionStorage.clear();
  resetOutboxForTests();
  tailLines = [];
  tailStart = 0;
  runtimeView = {
    ...runtimeView,
    session: { ...runtimeView.session, canonicalOwnership: undefined },
  };
  globalThis.fetch = realFetch;
});

function file(path: string): FileEntry {
  return {
    path,
    root: "codex-sessions",
    name: path.split("/").at(-1) ?? path,
    project: "live-log-viewer-next",
    title: "Issue 626 LogFeed lifecycle",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "live",
    proc: "running",
    pid: null,
    model: "gpt-5.6-sol",
    pendingQuestion: null,
    waitingInput: null,
    conversationId: CONVERSATION_ID,
    launch: {
      launchId: LAUNCH_ID,
      clientAttemptId: "attempt_issue_626_logfeed",
      accountId: "work",
      state: path === STARTING_PATH ? "starting" : "live-late-success",
      initialMessage: path === STARTING_PATH ? "queued" : "delivered",
      retrySafe: false,
      error: null,
      ["prompt"]: "repeatable launch prompt",
      promptEcho: "repeatable launch prompt",
      promptImages: 0,
      promptAt: 1_000,
    },
  } as FileEntry;
}

function userEcho(text: string): string {
  return JSON.stringify({
    type: "response_item",
    timestamp: "2026-07-23T15:00:00.000Z",
    payload: {
      type: "message",
      id: "user-echo-626",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  });
}

function laterRecord(index: number): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp: `2026-07-23T15:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    payload: { type: "token_count", index },
  });
}

async function mountLogFeed(entry: FileEntry): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  host.style.height = "844px";
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  await act(async () => {
    root.render(
      <LogFeed
        file={entry}
        showSvc={false}
        lineFilter=""
        onStatus={() => undefined}
        paused={false}
        follow
        setFollow={() => undefined}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { host, root };
}

async function rerender(root: Root, entry: FileEntry): Promise<void> {
  await act(async () => {
    root.render(
      <LogFeed
        file={entry}
        showSvc={false}
        lineFilter=""
        onStatus={() => undefined}
        paused={false}
        follow
        setFollow={() => undefined}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function visibleOutboxIds(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll<HTMLElement>("[data-outbox-entry]"))
    .map((entry) => entry.dataset.outboxEntry ?? "");
}

test("issue 626 real LogFeed keeps canonical outbox retirement through adoption, tail eviction, and refresh", async () => {
  const claims: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/runtime/canonical-ownership") {
      claims.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    }
    throw new Error(`unexpected fetch ${String(input)}`);
  }) as typeof fetch;

  seedLaunchOutbox(CONVERSATION_ID, {
    id: LAUNCH_ID,
    text: "repeatable launch prompt",
    images: 0,
    at: 1_000,
    echoText: "repeatable launch prompt",
  });
  enqueueOutbox(CONVERSATION_ID, {
    id: "queued-unrelated-626",
    text: "queued unrelated follow-up",
    images: 0,
    at: 2_000,
  });

  const mounted = await mountLogFeed(file(STARTING_PATH));
  expect(visibleOutboxIds(mounted.host)).toEqual([LAUNCH_ID, "queued-unrelated-626"]);

  tailLines = [userEcho("repeatable launch prompt")];
  await rerender(mounted.root, file(ADOPTED_PATH));
  expect(visibleOutboxIds(mounted.host)).toEqual(["queued-unrelated-626"]);
  expect(claims).toContainEqual({
    conversationId: CONVERSATION_ID,
    assistantItemIds: [],
    launchOutboxIds: [LAUNCH_ID],
    outboxEntryIds: [],
  });

  act(() => mounted.root.unmount());
  roots.delete(mounted.root);
  resetOutboxForTests();
  tailLines = Array.from({ length: 6_000 }, (_, index) => laterRecord(index + 1));
  tailStart = 1;
  const refreshed = await mountLogFeed(file(ADOPTED_PATH));
  expect(visibleOutboxIds(refreshed.host)).toEqual(["queued-unrelated-626"]);

  act(() => refreshed.root.unmount());
  roots.delete(refreshed.root);
  dom.sessionStorage.clear();
  resetOutboxForTests();
  seedLaunchOutbox(CONVERSATION_ID, {
    id: LAUNCH_ID,
    text: "repeatable launch prompt",
    images: 0,
    at: 1_000,
    echoText: "repeatable launch prompt",
  });
  enqueueOutbox(CONVERSATION_ID, {
    id: "queued-fresh-viewer-626",
    text: "fresh viewer queued entry",
    images: 0,
    at: 3_000,
  });
  runtimeView = {
    ...runtimeView,
    session: {
      ...runtimeView.session,
      canonicalOwnership: {
        launchOutboxIds: [LAUNCH_ID],
        outboxEntryIds: [],
      },
    },
  };
  const freshViewer = await mountLogFeed(file(ADOPTED_PATH));
  expect(visibleOutboxIds(freshViewer.host)).toEqual(["queued-fresh-viewer-626"]);
});
