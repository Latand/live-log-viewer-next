/**
 * FINAL operator decision, acceptance-pinned: voice has NO authorization
 * ceremony. An ordinary fresh tab — no operator link ever visited, nothing in
 * storage, no cookie — opens a voice-capable hosted conversation, sees the
 * canonical "Start continuous voice conversation" button, and pressing it
 * starts the real voice flow. These tests render the REAL composer with a
 * hosted codex-app-server session and a spy realtime client, in exactly that
 * clean state.
 */
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import type { RuntimeSessionView } from "@/hooks/useRuntime";
import type { FileEntry } from "@/lib/types";

const dom = new Window();
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
  File: dom.File,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

const CONVERSATION = "conversation_voice_accept";

/* A live structured codex-app-server host: exactly the session shape that makes
   a conversation voice-capable. */
const structuredView: RuntimeSessionView = {
  session: {
    conversationId: CONVERSATION,
    hostKind: "codex-app-server",
    host: "hosted",
    capabilities: { imageInput: { supported: true }, runtimeSettings: { perTurnEffort: true, perTurnModel: false } },
    recentReceipts: [],
  },
  uiState: {},
  attentions: [],
  receipts: [],
  legacy: false,
  structuredControlsEnabled: true,
} as unknown as RuntimeSessionView;

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const realUseRuntimeSession = actualRuntimeHooks.useRuntimeSession;
const realUseRuntimeReceiptsForArtifact = actualRuntimeHooks.useRuntimeReceiptsForArtifact;
/* Delegating mock (bun's registry is global): only this file's conversation sees
   the structured view; every suite loaded later observes real behavior. */
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeSession: (conversationId: string | null) => {
    const real = realUseRuntimeSession(conversationId);
    return conversationId === CONVERSATION ? structuredView : real;
  },
  useRuntimeReceiptsForArtifact: (path: string | null, conversationId?: string | null) => {
    const real = realUseRuntimeReceiptsForArtifact(path, conversationId);
    return path === "/voice-accept.jsonl" || conversationId === CONVERSATION ? [] : real;
  },
}));
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

const { TmuxComposer } = await import("./TmuxComposer");
const { configureRealtimeClientForTests } = await import("@/hooks/useCodexRealtime");

const realFetch = globalThis.fetch;
let roots: Root[] = [];
let starts = 0;

const IDLE = { phase: "idle" as const, lines: [], error: null, startedAt: null, micMuted: false, outputMuted: false };
const spyClient = {
  subscribe: () => () => undefined,
  getSnapshot: () => IDLE,
  micStream: () => null,
  toggleMic: () => undefined,
  toggleOutput: () => undefined,
  start: async () => { starts += 1; },
  stop: async () => undefined,
  updateWorkerProgress: () => undefined,
  reconcileWorkerDeliveries: () => undefined,
  onDeliveryAcknowledged: () => () => undefined,
  realtimeSession: () => null,
};

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  configureRealtimeClientForTests(null);
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});

const file: FileEntry = {
  path: "/voice-accept.jsonl", root: "codex-sessions", name: "voice-accept.jsonl", project: "viewer",
  title: "Codex", engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1,
  size: 1, activity: "idle", proc: "running", pid: null, conversationId: CONVERSATION,
  model: "gpt-5.6-sol", effort: "high", fast: false, pendingQuestion: null, waitingInput: null,
} as FileEntry;

async function renderComposer(): Promise<HTMLElement> {
  /* A fresh, ordinary tab: nothing was seeded above — no fragment, no
     sessionStorage credential, no cookie, no probe. */
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })
  ) as unknown as typeof fetch;
  configureRealtimeClientForTests(() => spyClient);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(<TmuxComposer file={file} />));
  return host as unknown as HTMLElement;
}

test("an ordinary fresh tab shows the canonical voice button on a voice-capable hosted conversation", async () => {
  expect(sessionStorage.getItem("llv.operator.capability")).toBeNull();
  const host = await renderComposer();
  const button = host.querySelector("[data-testid=voice-call-button]") as HTMLButtonElement | null;
  expect(button).not.toBeNull();
  expect(button!.getAttribute("aria-label")).toBe("Start continuous voice conversation");
  /* And no ceremony surfaces anywhere: no gate, no paste field, no unlock. */
  expect(host.querySelector("[data-testid=voice-operator-gate]")).toBeNull();
  expect(host.querySelector("input[type=password]")).toBeNull();
});

test("pressing it starts real voice with no prior authorization step", async () => {
  const host = await renderComposer();
  const button = host.querySelector("[data-testid=voice-call-button]") as HTMLButtonElement;
  await act(async () => {
    button.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  });
  expect(starts).toBe(1);
});
