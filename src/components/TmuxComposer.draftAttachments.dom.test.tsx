/**
 * Issue #1224 round-2 finding 2 — a staged document must never disappear from
 * the tray without a word.
 *
 * The draft tray is persisted per card and replayed on every `cardId` change and
 * on mount, so switching conversations and coming back — or a phone browser
 * evicting and restoring the tab, which is the flow the operator reported —
 * used to restore the text and the staged screenshots while emptying a staged
 * PDF out of the tray in silence. A document's bytes cannot go into synchronous
 * session storage, so what is persisted is its NAME, and what comes back is a
 * named slot that blocks Send until the file is attached again.
 *
 * Mock-wire pattern and dead-structured session copied from
 * TmuxComposer.deadRecovery.dom.test.tsx. Every fixture is an invented name and
 * invented bytes.
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

/** A settle-on-demand FileReader, so an intake's read resolves inside the
    test's own act boundary. */
class QueuedReader {
  static queue: QueuedReader[] = [];
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  readAsDataURL() { QueuedReader.queue.push(this); }
  static settleAll(dataUrl: string) {
    for (const reader of QueuedReader.queue.splice(0, QueuedReader.queue.length)) {
      reader.result = dataUrl;
      reader.onload?.();
    }
  }
}

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
  FileReader: QueuedReader,
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

const CONVERSATION_ID = "conv-1224-draft";

function structuredView(conversationId: string): RuntimeSessionView {
  return {
    session: {
      conversationId,
      sessionKey: { engine: "codex", sessionId: "codex-session-1224-draft" },
      hostKind: "codex-app-server",
      host: "dead",
      turn: "idle",
      provenance: "structured",
      revision: 3,
      attentionIds: [],
      recentReceipts: [],
      accountId: null,
      parentConversationId: null,
      flowId: null,
      workflowId: null,
      cwd: "viewer",
      artifactPath: null,
      capabilities: {
        steer: true,
        structuredAttention: true,
        imageInput: { supported: true },
        runtimeSettings: { perTurnEffort: true, perTurnModel: false },
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

const VIEWS: Record<string, RuntimeSessionView> = { [CONVERSATION_ID]: structuredView(CONVERSATION_ID) };

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const realUseRuntime = actualRuntimeHooks.useRuntime;
const realUseRuntimeSession = actualRuntimeHooks.useRuntimeSession;
const realUseRuntimeReceiptsForArtifact = actualRuntimeHooks.useRuntimeReceiptsForArtifact;
let runtimePlaneAuthoritative = true;
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntime: () => {
    const real = realUseRuntime();
    return runtimePlaneAuthoritative ? { ...real, enabled: true } : real;
  },
  useRuntimeSession: (conversationId: string | null) => {
    const real = realUseRuntimeSession(conversationId);
    return (conversationId && VIEWS[conversationId]) || real;
  },
  useRuntimeReceiptsForArtifact: (path: string | null, conversationId?: string | null) => {
    const real = realUseRuntimeReceiptsForArtifact(path, conversationId);
    return conversationId && VIEWS[conversationId] ? [] : real;
  },
  refreshRuntime: () => Promise.resolve(true),
}));
afterAll(() => {
  runtimePlaneAuthoritative = false;
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

const { TmuxComposer } = await import("./TmuxComposer");

const realFetch = globalThis.fetch;

afterEach(() => {
  setLocale("en");
  globalThis.fetch = realFetch;
  QueuedReader.queue = [];
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});

function genuinelyDeadViewerFile(): FileEntry {
  return {
    path: "/codex-viewer-1224.jsonl",
    root: "codex-sessions",
    name: "codex-viewer-1224.jsonl",
    project: "viewer",
    title: "Viewer-launched conversation",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    lastTurn: { startedAt: 1_000, endedAt: 2_000 },
    conversationId: CONVERSATION_ID,
    spawnOrigin: "viewer",
    model: "gpt-5.6-sol",
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

async function renderComposer(): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<TmuxComposer file={genuinelyDeadViewerFile()} deadHost />);
    await new Promise((r) => setTimeout(r, 0));
  });
  return { host, root };
}

function dropInto(host: HTMLElement, files: { name: string; type: string; size: number }[]): void {
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onDrop(event: unknown): void }>)[propsKey]!;
  flushSync(() => props.onDrop({
    dataTransfer: { files },
    preventDefault() {},
    stopPropagation() {},
  }));
}

const tiles = (host: HTMLElement) => Array.from(host.querySelectorAll('[data-testid="attachment-tile"]'));

test.each(["en", "uk"] as const)(
  "[%s] a staged document comes back named, never emptied out in silence, and never as bytes",
  async (locale) => {
    setLocale(locale);
    quietWire();
    const first = await renderComposer();
    dropInto(first.host, [{ name: "quarterly-notes.pdf", type: "application/pdf", size: 24 }]);
    await act(async () => {
      QueuedReader.settleAll("data:application/pdf;base64,aW52ZW50ZWQ=");
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(tiles(first.host)).toHaveLength(1);

    /* Names only. A document's base64 would not fit here, and persisting bytes
       for something the send cannot replay is not the fix — saying which file
       has to come back is. */
    const persisted = sessionStorage.getItem(`llvDraftFiles:${CONVERSATION_ID}`);
    expect(persisted).toContain("quarterly-notes.pdf");
    expect(persisted).not.toContain("aW52ZW50ZWQ=");

    await act(async () => { first.root.unmount(); });

    /* The remount is the card switch and the restored phone tab: the tray used
       to come back empty with nothing said. */
    const second = await renderComposer();
    const restored = tiles(second.host);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.getAttribute("data-kind")).toBe("file");
    expect(restored[0]!.getAttribute("data-status")).toBe("error");
    expect(second.host.textContent).toContain("quarterly-notes.pdf");
    expect(second.host.textContent).toContain(translate(locale, "attach.notRestored"));

    /* Send is refused, with the reason on screen: this composer keeps a send
       MENU, so the gate the click honours is `aria-disabled` (the same one the
       button's own handler and the Enter key read). */
    const send = second.host.querySelector(`button[aria-label="${translate(locale, "composer.sendToAgent")}"]`) as HTMLButtonElement;
    expect(send.getAttribute("aria-disabled")).toBe("true");
    expect(second.host.textContent).toContain(translate(locale, "attach.blockedFailed"));

    /* The marker survives the NEXT switch too: an un-restored slot is still a
       file the operator has to attach again. */
    await act(async () => { second.root.unmount(); });
    expect(sessionStorage.getItem(`llvDraftFiles:${CONVERSATION_ID}`)).toContain("quarterly-notes.pdf");
    const third = await renderComposer();
    expect(tiles(third.host)).toHaveLength(1);
    await act(async () => { third.root.unmount(); });
  },
);

test("removing the un-restored slot clears the marker, and a staged image still comes back whole", async () => {
  quietWire();
  const first = await renderComposer();
  dropInto(first.host, [{ name: "shot.png", type: "image/png", size: 12 }]);
  await act(async () => {
    QueuedReader.settleAll("data:image/png;base64,aW52ZW50ZWQ=");
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(sessionStorage.getItem(`llvDraftFiles:${CONVERSATION_ID}`)).toBeNull();
  await act(async () => { first.root.unmount(); });

  /* Images are unaffected: they still persist whole and restore ready. */
  const second = await renderComposer();
  const restored = tiles(second.host);
  expect(restored).toHaveLength(1);
  expect(restored[0]!.getAttribute("data-kind")).toBe("image");
  expect(restored[0]!.getAttribute("data-status")).toBe("ready");

  dropInto(second.host, [{ name: "trace.log", type: "text/plain", size: 30 }]);
  await act(async () => {
    QueuedReader.settleAll("data:text/plain;base64,aW52ZW50ZWQ=");
    await new Promise((r) => setTimeout(r, 0));
  });
  const removeFile = second.host.querySelector(`button[aria-label="${translate("en", "attach.removeAria", { name: "trace.log" })}"]`) as HTMLButtonElement;
  expect(removeFile).toBeTruthy();
  await act(async () => { removeFile.click(); });
  expect(sessionStorage.getItem(`llvDraftFiles:${CONVERSATION_ID}`)).toBeNull();
  await act(async () => { second.root.unmount(); });
});
