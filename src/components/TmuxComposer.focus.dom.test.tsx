import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import type { RuntimeReceipt } from "@/components/runtime/runtimeModel";
import { setLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

const dom = new Window();
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
/* Per-test viewport: the UK mobile scenario flips this to the 390px branch. */
let mobileViewport = false;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: mobileViewport && /max-width/.test(String(query)),
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

/* The durable receipt stream, controllable per test exactly like production
   pushes bus updates into a typing user's composer. */
const actualRuntimeHooks = await import("@/hooks/useRuntime");
const receiptListeners = new Set<() => void>();
let busReceipts: RuntimeReceipt[] = [];
function publishReceipts(next: RuntimeReceipt[]): void {
  busReceipts = next;
  for (const listener of receiptListeners) listener();
}
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => useSyncExternalStore(
    (listener) => {
      receiptListeners.add(listener);
      return () => receiptListeners.delete(listener);
    },
    () => busReceipts,
    () => busReceipts,
  ),
}));
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

const { TmuxComposer } = await import("./TmuxComposer");

globalThis.fetch = (async (input) => {
  if (String(input) === "/api/tmux/targets") {
    return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
  }
  throw new Error(`unexpected request: ${String(input)}`);
}) as typeof fetch;

function fileFor(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "codex-sessions",
    name: overrides.path.slice(1),
    project: "viewer",
    title: overrides.path,
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: "running",
    pid: null,
    conversationId: undefined,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  } as FileEntry;
}

function pasteImage(textarea: HTMLTextAreaElement, tag: string): void {
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onPaste(event: unknown): void }>)[propsKey]!;
  const bytes = new TextEncoder().encode(`png-${tag}`);
  props.onPaste({
    clipboardData: { items: [{ type: "image/png", getAsFile: () => new dom.File([bytes], `${tag}.png`, { type: "image/png" }) }] },
    preventDefault() {},
  });
}

test("board polls and receipt updates never move focus, caret, draft, or attachments — and mounting never autofocuses", async () => {
  setLocale("en");
  mobileViewport = false;
  const conversationId = "conv-focus-poll";
  const draft = "keep my caret steady while the board refreshes";
  sessionStorage.setItem(`llvDraft:${conversationId}`, draft);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const entry = (mtime: number, activity: FileEntry["activity"]) =>
    fileFor({ path: "/focus-poll.jsonl", conversationId, mtime, activity });

  try {
    flushSync(() => root.render(<TmuxComposer file={entry(1, "idle")} />));
    const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    /* A polling path mounted this composer: it must never take focus itself. */
    expect(document.activeElement).not.toBe(textarea);

    textarea.focus();
    textarea.setSelectionRange(5, 5);
    pasteImage(textarea, "poll-stable");
    for (let attempt = 0; attempt < 50 && host.querySelectorAll("img").length !== 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(host.querySelectorAll("img")).toHaveLength(1);

    /* Poll refresh: a brand-new FileEntry object with moved mtime/activity. */
    flushSync(() => root.render(<TmuxComposer file={entry(2, "live")} />));
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(5);
    expect(textarea.selectionEnd).toBe(5);
    expect(textarea.value).toBe(draft);
    expect(host.querySelectorAll("img")).toHaveLength(1);

    /* A durable receipt for some other operation streams in mid-typing. */
    flushSync(() => publishReceipts([{
      operationId: "op-unrelated",
      idempotencyKey: "key-unrelated",
      conversationId: "conversation_bus-session",
      kind: "send",
      status: "queued",
      text: "someone else's message",
      at: "2026-07-18T00:00:01.000Z",
      revision: 1,
    }]));
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(5);
    expect(textarea.value).toBe(draft);
    expect(host.querySelectorAll("img")).toHaveLength(1);
  } finally {
    flushSync(() => root.unmount());
    publishReceipts([]);
    sessionStorage.clear();
    host.remove();
  }
});

test("a committed path migration remounts the composer under a new key: focus, caret, and draft survive", () => {
  setLocale("en");
  mobileViewport = false;
  const conversationId = "conv-migrate";
  const draft = "typed against the predecessor pane";
  sessionStorage.setItem(`llvDraft:${conversationId}`, draft);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  /* Production shape: the scheme node and the mobile focus view both key the
     hosting subtree by file.path, so a committed migration is a hard remount. */
  const board = (file: FileEntry) => (
    <div key={file.path} className="pane">
      <TmuxComposer file={file} />
    </div>
  );

  try {
    const predecessor = fileFor({ path: "/predecessor.jsonl", conversationId });
    flushSync(() => root.render(board(predecessor)));
    const before = host.querySelector("textarea") as HTMLTextAreaElement;
    before.focus();
    before.setSelectionRange(6, 13);
    expect(document.activeElement).toBe(before);

    const successor = fileFor({
      path: "/successor.jsonl",
      conversationId,
      predecessorPath: "/predecessor.jsonl",
    } as Partial<FileEntry> & { path: string });
    flushSync(() => root.render(board(successor)));

    const after = host.querySelector("textarea") as HTMLTextAreaElement;
    expect(after).not.toBe(before);
    expect(document.activeElement).toBe(after);
    expect(after.selectionStart).toBe(6);
    expect(after.selectionEnd).toBe(13);
    expect(after.value).toBe(draft);
  } finally {
    flushSync(() => root.unmount());
    sessionStorage.clear();
    host.remove();
  }
});

test("адопційний флап (390px): фокус повертається, чернетка переїжджає на канонічний id, а чужий фокус ніколи не крадеться", () => {
  setLocale("uk");
  mobileViewport = true;
  const draft = "чернетка, набрана під тимчасовим id";
  sessionStorage.setItem("llvDraft:conv-provisional", draft);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);

  try {
    /* The entry arrives with a provisional conversation id. */
    const provisional = fileFor({ path: "/adopt.jsonl", conversationId: "conv-provisional" });
    flushSync(() => root.render(<TmuxComposer file={provisional} />));
    const before = host.querySelector("textarea") as HTMLTextAreaElement;
    expect(before.value).toBe(draft);
    before.focus();
    before.setSelectionRange(draft.length, draft.length);

    /* Adoption flap: the scanner drops the entry for a poll cycle… */
    flushSync(() => root.render(<div />));
    /* …and re-adds it under the canonical id (same transcript path). */
    const canonical = fileFor({ path: "/adopt.jsonl", conversationId: "conv-canonical" });
    flushSync(() => root.render(<TmuxComposer file={canonical} />));

    const after = host.querySelector("textarea") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(after);
    expect(after.selectionStart).toBe(draft.length);
    expect(after.value).toBe(draft);
    /* The persisted records rode the identity change. */
    expect(sessionStorage.getItem("llvDraft:conv-canonical")).toBe(draft);
    expect(sessionStorage.getItem("llvDraft:conv-provisional")).toBe(null);

    /* A second flap while the user has moved on: the returning composer must
       never yank focus away from what they clicked. */
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    flushSync(() => root.render(<div />));
    elsewhere.focus();
    flushSync(() => root.render(<TmuxComposer file={canonical} />));
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  } finally {
    flushSync(() => root.unmount());
    sessionStorage.clear();
    host.remove();
  }
});
