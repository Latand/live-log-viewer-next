/**
 * Issue #499 — mobile structured composer: reliable Send + one obvious pill.
 *
 * A live Viewer-launched structured conversation must:
 *  1. enable Send within one frame of non-empty text (a single synchronous
 *     React flush — no polls, no timers between the keystroke and the enabled
 *     button);
 *  2. expose the model/reasoning pill on the phone without any disclosure —
 *     Claude and Codex alike;
 *  3. explain a blocked Send inline (never tooltip-only) and offer the
 *     Re-check recovery route wired to a runtime snapshot refresh.
 *
 * These drive the REAL TmuxComposer against a mocked wire, with the runtime
 * session view mirroring exactly what the bus projects for a Viewer-launched
 * conversation (spawnOrigin: "viewer" + a hosted structured session).
 */
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { RuntimeSessionView } from "@/hooks/useRuntime";
import type { FileEntry } from "@/lib/types";
import { setLocale, translate } from "@/lib/i18n";

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
  FileReader: dom.FileReader,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});
let mobile = false;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: mobile,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

/* One hosted structured session per engine, shaped like the runtime bus
   projection for a Viewer-launched conversation (issue #499 fixture). */
function structuredView(conversationId: string, hostKind: "codex-app-server" | "claude-broker", engine: "codex" | "claude"): RuntimeSessionView {
  return {
    session: {
      conversationId,
      sessionKey: { engine, sessionId: `${engine}-session-499` },
      hostKind,
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      revision: 3,
      attentionIds: [],
      recentReceipts: [],
      accountId: null,
      parentConversationId: null,
      flowId: null,
      workflowId: null,
      cwd: "/home/user/projects/viewer",
      artifactPath: null,
      capabilities: {
        steer: true,
        structuredAttention: true,
        imageInput: { supported: true },
        runtimeSettings: { perTurnEffort: engine === "codex", perTurnModel: false },
      },
      activeTurnId: null,
    },
    uiState: {},
    attentions: [],
    receipts: [],
    legacy: false,
    structuredControlsEnabled: true,
  } as unknown as RuntimeSessionView;
}

const VIEWS: Record<string, RuntimeSessionView> = {
  "conv-499-codex": structuredView("conv-499-codex", "codex-app-server", "codex"),
  "conv-499-claude": structuredView("conv-499-claude", "claude-broker", "claude"),
};

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const realUseRuntimeSession = actualRuntimeHooks.useRuntimeSession;
const realUseRuntimeReceiptsForArtifact = actualRuntimeHooks.useRuntimeReceiptsForArtifact;
let refreshCalls = 0;
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeSession: (conversationId: string | null) => {
    const real = realUseRuntimeSession(conversationId);
    return (conversationId && VIEWS[conversationId]) || real;
  },
  useRuntimeReceiptsForArtifact: (path: string | null, conversationId?: string | null) => {
    const real = realUseRuntimeReceiptsForArtifact(path, conversationId);
    return conversationId && VIEWS[conversationId] ? [] : real;
  },
  refreshRuntime: () => {
    refreshCalls += 1;
    return Promise.resolve(true);
  },
}));
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

const { TmuxComposer } = await import("./TmuxComposer");

const realFetch = globalThis.fetch;

afterEach(() => {
  setLocale("en");
  mobile = false;
  refreshCalls = 0;
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});

/** A Viewer-launched conversation card: the spawn lineage marker rides the
    scanned FileEntry exactly as the spawn projection emits it. */
function viewerLaunchedFile(engine: "codex" | "claude", conversationId: string): FileEntry {
  return {
    path: `/${engine}-viewer-499.jsonl`,
    root: engine === "codex" ? "codex-sessions" : "claude-projects",
    name: `${engine}-viewer-499.jsonl`,
    project: "viewer",
    title: "Viewer-launched conversation",
    engine,
    kind: "session",
    fmt: engine,
    parent: null,
    mtime: 1,
    size: 1,
    activity: "live",
    proc: "running",
    pid: null,
    conversationId,
    spawnOrigin: "viewer",
    model: engine === "codex" ? "gpt-5.6-sol" : "fable",
    effort: "high",
    fast: false,
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
}

function quietWire(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/tmux/targets") return { ok: true, status: 200, json: async () => ({ targets: {} }) } as Response;
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
}

async function renderInto(node: React.ReactElement): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
    await new Promise((r) => setTimeout(r, 0));
  });
  return { host, root };
}

function sendButton(host: HTMLElement): HTMLButtonElement {
  return host.querySelector('button[aria-label="Send to the agent"]') as HTMLButtonElement;
}

test("typing non-empty text enables Send in the same synchronous flush on a live host", async () => {
  quietWire();
  const { host, root } = await renderInto(<TmuxComposer file={viewerLaunchedFile("codex", "conv-499-codex")} />);
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onChange: (e: unknown) => void }>)[propsKey]!;

  expect(sendButton(host).getAttribute("aria-disabled")).toBe("true");
  /* One frame: the keystroke's synchronous flush alone flips the button — no
     awaited timers or polls between the change event and the assertion. */
  flushSync(() => props.onChange({ target: { value: "ship it" } }));
  const send = sendButton(host);
  expect(send.getAttribute("aria-disabled")).toBe("false");
  expect(send.disabled).toBe(false);
  flushSync(() => root.unmount());
});

test.each(["codex", "claude"] as const)(
  "the %s Viewer-launched conversation exposes the pill on the phone without any disclosure",
  async (engine) => {
    mobile = true;
    quietWire();
    const { host, root } = await renderInto(
      <TmuxComposer file={viewerLaunchedFile(engine, `conv-499-${engine}`)} />,
    );
    /* The pill is on screen immediately — no options toggle press required. */
    const pill = host.querySelector("[data-runtime-pill]") as HTMLButtonElement;
    expect(pill).toBeTruthy();
    const row = pill.closest('[data-testid="composer-runtime-row"]')!;
    expect(row).toBeTruthy();
    expect(row.className).toContain("min-h-11");
    /* And it opens the mobile sheet with the model/reasoning sections. */
    await act(async () => {
      pill.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(host.querySelector("[data-runtime-sheet]")).toBeTruthy();
    flushSync(() => root.unmount());
  },
);

test("typed draft text survives live projection updates of the conversation card", async () => {
  quietWire();
  const before = viewerLaunchedFile("codex", "conv-499-codex");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<TmuxComposer file={before} />);
    await new Promise((r) => setTimeout(r, 0));
  });
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onChange: (e: unknown) => void }>)[propsKey]!;
  flushSync(() => props.onChange({ target: { value: "half-typed operator prompt" } }));

  /* A poll delivers a fresh FileEntry object (new mtime/model/activity, same
     conversation identity) — the exact live-projection churn the operator
     observed. The draft must ride through untouched. */
  const after = { ...before, mtime: before.mtime + 120, activity: "live", model: "gpt-5.6-terra", effort: "medium" } as FileEntry;
  await act(async () => {
    root.render(<TmuxComposer file={after} />);
    await new Promise((r) => setTimeout(r, 0));
  });
  expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("half-typed operator prompt");
  expect(sendButton(host).getAttribute("aria-disabled")).toBe("false");
  flushSync(() => root.unmount());
});

test("a blocked Send explains itself inline and Re-check refreshes the runtime snapshot", async () => {
  mobile = true;
  quietWire();
  const reason = translate("en", "strip.resolving");
  const { host, root } = await renderInto(
    <TmuxComposer
      file={viewerLaunchedFile("codex", "conv-499-unresolved")}
      sendBlockedReason={reason}
    />,
  );
  const blocked = host.querySelector('[data-testid="composer-send-blocked"]')!;
  expect(blocked).toBeTruthy();
  expect(blocked.textContent).toContain(reason);
  const recover = blocked.querySelector("button") as HTMLButtonElement;
  expect(recover.textContent).toContain(translate("en", "deadHost.recheck"));
  await act(async () => {
    recover.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(refreshCalls).toBe(1);
  flushSync(() => root.unmount());
});
