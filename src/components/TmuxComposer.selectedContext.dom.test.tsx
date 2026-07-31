/**
 * The composer half of #844, driven through the REAL composer and read off the
 * bytes that go on the wire.
 *
 * Two claims that only an end-to-end run can make:
 *
 * 1. The reference is captured ATOMICALLY with the text. Moving the selection
 *    immediately after submitting must leave the admitted request alone, and the
 *    only way to know that is to move it while the send is in flight.
 * 2. The badge in the composer names the same card the request names, so what
 *    the operator sees before sending is what they sent.
 */
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import type { RuntimeSessionView } from "@/hooks/useRuntime";
import type { SelectedContextRef } from "@/lib/selection/selectedContext";
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
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
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

const COMPOSING = "conversation_composing_selected";
const SELECTED_A = "conversation_selected_a";
const SELECTED_B = "conversation_selected_b";
const PATH_A = "fixtures/projects/atlas/worker-a.jsonl";
const PATH_B = "fixtures/projects/atlas/worker-b.jsonl";

function structuredView(conversationId: string): RuntimeSessionView {
  return {
    session: {
      conversationId,
      hostKind: "codex-app-server",
      host: "hosted",
      capabilities: { imageInput: { supported: true }, runtimeSettings: { perTurnEffort: false, perTurnModel: false } },
      recentReceipts: [],
    },
    uiState: {},
    attentions: [],
    receipts: [],
    legacy: false,
    structuredControlsEnabled: true,
  } as unknown as RuntimeSessionView;
}

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const realUseRuntimeSession = actualRuntimeHooks.useRuntimeSession;
const realUseRuntimeReceiptsForArtifact = actualRuntimeHooks.useRuntimeReceiptsForArtifact;
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeSession: (conversationId: string | null) =>
    conversationId === COMPOSING ? structuredView(conversationId) : realUseRuntimeSession(conversationId),
  useRuntimeReceiptsForArtifact: (path: string | null, conversationId?: string | null) =>
    conversationId === COMPOSING ? [] : realUseRuntimeReceiptsForArtifact(path, conversationId),
}));
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

const { appendComposerDraft, TmuxComposer } = await import("./TmuxComposer");
const { resetOutboxForTests } = await import("./conversation/outbox");
const { resetManagerIdentityForTest } = await import("./voice/managerIdentity");
const { viewBus } = await import("@/hooks/viewPresenceBus");

const realFetch = globalThis.fetch;
let roots: Root[] = [];
let sent: { text: string; selectedContext?: SelectedContextRef }[] = [];
/** Runs while the send request is in flight, so a selection change lands
    between capture and admission — the exact race criterion 3 describes. */
let duringSend: (() => void) | null = null;

function fileFor(conversationId: string, name: string): FileEntry {
  return {
    path: `/${name}.jsonl`, root: "codex-sessions", name: `${name}.jsonl`, project: "atlas",
    title: "Codex", engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1,
    size: 1, activity: "idle", proc: "running", pid: null, conversationId,
    pendingQuestion: null, waitingInput: null,
  } as FileEntry;
}

function stubFetch(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "/api/orchestrator") {
      return json({ record: null, exists: false, defaultCwd: "/repo" });
    }
    if (url === "/api/runtime/send") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string; selectedContext?: SelectedContextRef };
      sent.push({ text: body.text ?? "", selectedContext: body.selectedContext });
      duringSend?.();
      return json({ operationId: "op-1", receipt: { status: "delivered", operationId: "op-1" } });
    }
    return json({});
  }) as unknown as typeof fetch;
}

function selectCard(path: string): void {
  viewBus.reportSlice({ mode: "list", focusedPath: path, selectedPaths: [path], visiblePaths: [], camera: null });
}

beforeEach(() => {
  sent = [];
  duringSend = null;
  resetManagerIdentityForTest();
  stubFetch();
  viewBus.reportIdentity({ viewSessionId: "vs-synthetic-1", deviceId: "dev-synthetic-1" });
  viewBus.reportContext({ project: "atlas", board: { renderedRevision: null, durableRevision: null, sync: "unavailable" } });
  viewBus.reportCards([
    { path: PATH_A, conversationId: SELECTED_A, project: "atlas", label: "Worker A" },
    { path: PATH_B, conversationId: SELECTED_B, project: "atlas", label: "Worker B" },
  ]);
  selectCard(PATH_A);
});

afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots = [];
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  resetOutboxForTests();
  resetManagerIdentityForTest();
  viewBus.reportIdentity(null);
  viewBus.reportCards([]);
});

async function mountComposer(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<TmuxComposer file={fileFor(COMPOSING, "composing_selected")} />);
    await new Promise((r) => setTimeout(r, 0));
  });
  return host as unknown as HTMLElement;
}

async function sendThrough(host: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    appendComposerDraft(COMPOSING, text);
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    (host.querySelector("form") as HTMLFormElement)
      .dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
    for (let tick = 0; tick < 12; tick += 1) await new Promise((r) => setTimeout(r, 0));
  });
}

test("the submitted request names the selected card by its conversation id", async () => {
  const host = await mountComposer();
  await sendThrough(host, "look at that one");

  expect(sent).toHaveLength(1);
  expect(sent[0]!.text).toBe("look at that one");
  expect(sent[0]!.selectedContext).toMatchObject({
    version: 1,
    state: "selected",
    conversationId: SELECTED_A,
    project: "atlas",
    label: "Worker A",
    viewSessionId: "vs-synthetic-1",
    deviceId: "dev-synthetic-1",
  });
});

test("moving the selection while the send is in flight does not rewrite the admitted turn", async () => {
  const host = await mountComposer();
  duringSend = () => selectCard(PATH_B);
  await sendThrough(host, "look at that one");

  expect(sent).toHaveLength(1);
  expect(sent[0]!.selectedContext).toMatchObject({ state: "selected", conversationId: SELECTED_A });
  /* The move DID land — the next turn sees it, which is what proves the first
     one was frozen rather than simply never updated. */
  await sendThrough(host, "and now that one");
  expect(sent[1]!.selectedContext).toMatchObject({ state: "selected", conversationId: SELECTED_B });
});

test("an empty selection submits the explicit none variant, not a missing field", async () => {
  viewBus.reportSlice({ mode: "list", focusedPath: null, selectedPaths: [], visiblePaths: [], camera: null });
  const host = await mountComposer();
  await sendThrough(host, "anything running?");

  expect(sent[0]!.selectedContext).toMatchObject({ version: 1, state: "none", project: "atlas" });
  expect(sent[0]!.selectedContext).not.toHaveProperty("conversationId");
});

test("the composer shows a badge naming the card the next turn will carry", async () => {
  const host = await mountComposer();
  const badge = host.querySelector("[data-selected-context]");
  expect(badge?.getAttribute("data-selected-context")).toBe("selected");
  expect(badge?.textContent).toContain("Worker A");
  expect(badge?.getAttribute("aria-label")).toContain("Worker A");
});

test("the badge follows the selection before submission and disappears with it", async () => {
  const host = await mountComposer();
  await act(async () => {
    selectCard(PATH_B);
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(host.querySelector("[data-selected-context]")?.textContent).toContain("Worker B");

  await act(async () => {
    viewBus.reportSlice({ mode: "list", focusedPath: null, selectedPaths: [], visiblePaths: [], camera: null });
    await new Promise((r) => setTimeout(r, 0));
  });
  /* Nothing selected is an ANSWER on the persisted row, but a permanent
     "nothing selected" chip over every composer in the app is noise. The
     composer shows the badge only when there is a card to name. */
  expect(host.querySelector("[data-selected-context]")).toBeNull();
});
