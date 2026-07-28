/**
 * WHOSE turns carry the operator's view.
 *
 * The viewer-context prelude ("the operator is looking at: project …") belongs to
 * the Viewer-global manager and to nothing else. Its first version was gated on
 * `voiceEnabled`, a CAPABILITY shared by every hosted codex-app-server
 * conversation, so an ordinary hosted worker's turns silently carried the
 * operator's current project, focused conversation and selection too.
 *
 * These cases drive the REAL composer against a real structured send and read the
 * bytes that go on the wire: the manager's conversation gets the line, an
 * identically-capable worker gets none. Restore the capability gate and the worker
 * case goes red.
 */
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
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

const MANAGER = "conversation_manager_prelude";
const WORKER = "conversation_worker_prelude";

/* Both conversations are hosted codex-app-server sessions: identically
   voice-capable, so capability cannot be what tells them apart. */
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
  useRuntimeSession: (conversationId: string | null) => {
    const real = realUseRuntimeSession(conversationId);
    return conversationId === MANAGER || conversationId === WORKER
      ? structuredView(conversationId)
      : real;
  },
  useRuntimeReceiptsForArtifact: (path: string | null, conversationId?: string | null) => {
    const real = realUseRuntimeReceiptsForArtifact(path, conversationId);
    return conversationId === MANAGER || conversationId === WORKER ? [] : real;
  },
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
let sentTexts: string[] = [];

function fileFor(conversationId: string, name: string): FileEntry {
  return {
    path: `/${name}.jsonl`, root: "codex-sessions", name: `${name}.jsonl`, project: "viewer",
    title: "Codex", engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1,
    size: 1, activity: "idle", proc: "running", pid: null, conversationId,
    pendingQuestion: null, waitingInput: null,
  } as FileEntry;
}

/** The designation record names the manager and nobody else. */
function stubFetch(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "/api/orchestrator") {
      return json({ record: { conversationId: MANAGER, path: "/manager_prelude.jsonl" }, exists: true, defaultCwd: "/repo" });
    }
    if (url === "/api/runtime/send") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      sentTexts.push(body.text ?? "");
      return json({ operationId: "op-1", receipt: { status: "delivered", operationId: "op-1" } });
    }
    return json({});
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  sentTexts = [];
  resetManagerIdentityForTest();
  stubFetch();
  /* The operator is somewhere else entirely: another project, another card
     focused — exactly the situation the prelude exists to describe. */
  viewBus.reportContext({ project: "other-project", board: { renderedRevision: null, durableRevision: null, sync: "unavailable" } });
  viewBus.reportSlice({
    mode: "list",
    focusedPath: "/some-other-card.jsonl",
    selectedPaths: ["/some-other-card.jsonl"],
    visiblePaths: [],
    camera: null,
  });
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
});

/** Type a draft into the real composer and submit it the way the Send button
    does, then let the queue drain onto the wire. */
async function sendThrough(file: FileEntry, text: string): Promise<void> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<TmuxComposer file={file} />);
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    appendComposerDraft(file.conversationId!, text);
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    (host.querySelector("form") as HTMLFormElement)
      .dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
    for (let tick = 0; tick < 12; tick += 1) await new Promise((r) => setTimeout(r, 0));
  });
}

test("the manager's turn carries what the operator is looking at", async () => {
  await sendThrough(fileFor(MANAGER, "manager_prelude"), "work on this");

  expect(sentTexts).toHaveLength(1);
  expect(sentTexts[0]).toContain("[viewer context — the operator is looking at:");
  expect(sentTexts[0]).toContain("project other-project");
  expect(sentTexts[0]!.endsWith("work on this")).toBe(true);
});

test("an equally voice-capable worker's turn carries nothing of the operator's view", async () => {
  await sendThrough(fileFor(WORKER, "worker_prelude"), "run the suite");

  expect(sentTexts).toEqual(["run the suite"]);
  expect(sentTexts[0]).not.toContain("viewer context");
  expect(sentTexts[0]).not.toContain("other-project");
});

test("no designated manager means no conversation gets the prelude", async () => {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    /* The record's transcript is gone: nothing is the manager until a successor
       is adopted, so nothing may carry the operator's view. */
    if (url === "/api/orchestrator") {
      return json({ record: { conversationId: MANAGER, path: "/manager_prelude.jsonl" }, exists: false, defaultCwd: "/repo" });
    }
    if (url === "/api/runtime/send") {
      sentTexts.push((JSON.parse(String(init?.body ?? "{}")) as { text?: string }).text ?? "");
      return json({ operationId: "op-1", receipt: { status: "delivered", operationId: "op-1" } });
    }
    return json({});
  }) as unknown as typeof fetch;

  await sendThrough(fileFor(MANAGER, "manager_prelude"), "still just a message");
  expect(sentTexts).toEqual(["still just a message"]);
});
