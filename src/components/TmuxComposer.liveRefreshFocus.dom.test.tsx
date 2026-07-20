/**
 * Issue #272 (reopened P1) — the composer's focus, caret, draft, attachments,
 * runtime model/reasoning choice, and IME composition survive a live board/feed
 * refresh while the operator is typing, on desktop AND the 390px phone.
 *
 * The reopened regression: a background board/feed refresh (a poll re-render, a
 * runtime-plane surface resolution, a delivery receipt, or a reorder of the
 * conversation data) disturbed the composer mid-typing. The sharpest new seam —
 * and the first confirmed MOBILE reproduction — is the controlled textarea being
 * clobbered mid-IME-composition: a mobile keyboard composes every word (CJK,
 * Cyrillic, autocorrect, emoji), the browser suppresses React's change event for
 * the duration, the `text` state falls behind the half-composed DOM value, and a
 * refresh re-render re-asserts the stale value — wiping the composition and
 * jumping the caret. Native composition listeners in `useComposer` keep the
 * draft in lockstep so the refresh re-renders identical text.
 *
 * These tests drive the REAL composer form against real board/feed refresh
 * shapes and assert `document.activeElement`, `selectionStart`/`selectionEnd`,
 * the draft, staged attachments, and the persisted runtime choice all survive.
 */
import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import type { RuntimeSessionView } from "@/hooks/useRuntime";
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
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  CompositionEvent: dom.CompositionEvent,
  File: dom.File,
  FileReader: dom.FileReader,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});
/* Per-test viewport: the phone scenarios flip this to the 390px branch. */
let mobileViewport = false;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: mobileViewport && /max-width/.test(String(query)),
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

/* A live structured codex-app-server host, published on demand so a test can
   drive the staged runtime-plane resolution (bus-off → structured) that a real
   board refresh performs while the operator is typing. */
const structuredView: RuntimeSessionView = {
  session: {
    conversationId: "conv-refresh",
    hostKind: "codex-app-server",
    host: "hosted",
    capabilities: { imageInput: { supported: true }, runtimeSettings: { perTurnEffort: true, perTurnModel: true } },
    recentReceipts: [],
  },
  uiState: {},
  attentions: [],
  receipts: [],
  legacy: false,
  structuredControlsEnabled: true,
} as unknown as RuntimeSessionView;

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const sessionListeners = new Set<() => void>();
let currentSession: RuntimeSessionView | null = null;
function publishSession(next: RuntimeSessionView | null): void {
  currentSession = next;
  for (const listener of sessionListeners) listener();
}
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntime: () => ({ enabled: true, structuredHostsEnabled: true, connection: "online", resyncedAt: null, store: {} }),
  useRuntimeSession: (conversationId: string | null) =>
    useSyncExternalStore(
      (listener) => { sessionListeners.add(listener); return () => sessionListeners.delete(listener); },
      () => (conversationId === "conv-refresh" ? currentSession : null),
      () => null,
    ),
  useRuntimeSessionByArtifact: () => null,
  useRuntimeReceiptsForArtifact: () => [],
}));
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

const { TmuxComposer } = await import("./TmuxComposer");
const { storageKey } = await import("./runtimeProfile");

globalThis.fetch = (async (input) => {
  if (String(input) === "/api/tmux/targets") {
    return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
  }
  if (String(input).startsWith("/api/runtime")) {
    return { ok: true, json: async () => ({}) } as Response;
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
    pid: 4242,
    conversationId: undefined,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  } as FileEntry;
}

function compose(textarea: HTMLTextAreaElement, type: string): void {
  flushSync(() => textarea.dispatchEvent(new dom.CompositionEvent(type, { bubbles: true }) as unknown as Event));
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

for (const mobile of [false, true]) {
  const label = mobile ? "390px mobile" : "desktop";

  test(`[${label}] a board/feed refresh mid-IME-composition never wipes the composing word or moves the caret`, () => {
    setLocale("en");
    mobileViewport = mobile;
    publishSession(null);
    const conversationId = "conv-refresh";
    sessionStorage.setItem(`llvDraft:${conversationId}`, "abc");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const entry = (mtime: number, activity: FileEntry["activity"]) =>
      fileFor({ path: "/ime.jsonl", conversationId, mtime, activity });

    try {
      flushSync(() => root.render(<TmuxComposer file={entry(1, "idle")} />));
      const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
      textarea.focus();

      /* An IME composition is in flight: the DOM holds the half-composed word
         that React's controlled value does not yet include (the browser
         suppresses onChange until compositionend). */
      compose(textarea, "compositionstart");
      textarea.value = "abcあ";
      textarea.setSelectionRange(4, 4);
      compose(textarea, "compositionupdate");

      /* A background board/feed refresh re-renders the composer mid-composition
         (new FileEntry: moved mtime/activity, plus the runtime plane resolving). */
      flushSync(() => publishSession(structuredView));
      flushSync(() => root.render(<TmuxComposer file={entry(2, "live")} />));
      const after = host.querySelector("textarea") as HTMLTextAreaElement;
      expect(after.value).toBe("abcあ");
      expect(after.selectionStart).toBe(4);
      expect(after.selectionEnd).toBe(4);
      expect(document.activeElement).toBe(after);

      /* The composition commits, then another refresh: the final word persists. */
      after.value = "abcあい";
      after.setSelectionRange(5, 5);
      compose(after, "compositionend");
      flushSync(() => root.render(<TmuxComposer file={entry(3, "live")} />));
      const done = host.querySelector("textarea") as HTMLTextAreaElement;
      expect(done.value).toBe("abcあい");
      expect(document.activeElement).toBe(done);
      expect(sessionStorage.getItem(`llvDraft:${conversationId}`)).toBe("abcあい");
    } finally {
      flushSync(() => root.unmount());
      publishSession(null);
      sessionStorage.clear();
      host.remove();
    }
  });

  test(`[${label}] a mid-string selection, focus, draft, attachments, and runtime choice survive a surface-resolving refresh`, async () => {
    setLocale("en");
    mobileViewport = mobile;
    publishSession(null);
    const conversationId = "conv-refresh";
    const draft = "hello brave new world";
    sessionStorage.setItem(`llvDraft:${conversationId}`, draft);
    /* A committed model/reasoning choice the refresh must not revert (issue
       #499 fixed a persist-on-render that reverted it during resolution). */
    localStorage.setItem(storageKey(fileFor({ path: "/x", conversationId })), JSON.stringify({ model: "gpt-5.1-codex", effort: "high" }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const entry = (mtime: number, activity: FileEntry["activity"]) =>
      fileFor({ path: "/refresh.jsonl", conversationId, mtime, activity });

    try {
      flushSync(() => root.render(<TmuxComposer file={entry(1, "idle")} />));
      const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
      textarea.focus();
      /* A caret parked mid-string, selecting "brave" (the selection-range case). */
      textarea.setSelectionRange(6, 11);
      pasteImage(textarea, "keepme");
      for (let attempt = 0; attempt < 50 && host.querySelectorAll("img").length !== 1; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(host.querySelectorAll("img")).toHaveLength(1);

      /* Board/feed refresh: the runtime plane resolves (bus-off → structured,
         which flips the pill/placeholder) AND a poll delivers a fresh FileEntry. */
      flushSync(() => publishSession(structuredView));
      flushSync(() => root.render(<TmuxComposer file={entry(2, "live")} />));
      const after = host.querySelector("textarea") as HTMLTextAreaElement;
      expect(document.activeElement).toBe(after);
      expect(after.selectionStart).toBe(6);
      expect(after.selectionEnd).toBe(11);
      expect(after.value).toBe(draft);
      expect(host.querySelectorAll("img")).toHaveLength(1);
      /* The runtime model/reasoning choice rode the resolution untouched. */
      expect(JSON.parse(localStorage.getItem(storageKey(fileFor({ path: "/x", conversationId })))!)).toEqual({ model: "gpt-5.1-codex", effort: "high" });
    } finally {
      flushSync(() => root.unmount());
      publishSession(null);
      sessionStorage.clear();
      localStorage.clear();
      host.remove();
    }
  });

  test(`[${label}] a background reorder of the board (keyed by path) keeps focus and the caret on the typed pane`, () => {
    setLocale("en");
    mobileViewport = mobile;
    publishSession(null);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    sessionStorage.setItem("llvDraft:conv-a", "alpha draft text");
    sessionStorage.setItem("llvDraft:conv-b", "beta draft text");
    const fileA = fileFor({ path: "/a.jsonl", conversationId: "conv-a", pid: 1 });
    const fileB = fileFor({ path: "/b.jsonl", conversationId: "conv-b", pid: 2 });
    /* Production keys every pane host (scheme node, mobile focus pane, deck) by
       transcript path, so an activity/mtime reorder is a keyed MOVE, not a
       remount — the focused DOM node must ride along with its caret. */
    const board = (order: FileEntry[]) => (
      <div>
        {order.map((file) => (
          <div key={file.path} className="pane">
            <TmuxComposer file={file} />
          </div>
        ))}
      </div>
    );

    try {
      flushSync(() => root.render(board([fileA, fileB])));
      const typed = host.querySelectorAll("textarea")[0] as HTMLTextAreaElement;
      expect(typed.value).toBe("alpha draft text");
      typed.focus();
      typed.setSelectionRange(6, 11);
      expect(document.activeElement).toBe(typed);

      /* The poll reorders the panes (A now sorts after B). */
      flushSync(() => root.render(board([fileB, fileA])));
      const moved = Array.from(host.querySelectorAll("textarea")).find(
        (el) => (el as HTMLTextAreaElement).value === "alpha draft text",
      ) as HTMLTextAreaElement;
      expect(moved).toBe(typed); // same DOM node — a move, never a remount
      expect(document.activeElement).toBe(typed);
      expect(typed.selectionStart).toBe(6);
      expect(typed.selectionEnd).toBe(11);
    } finally {
      flushSync(() => root.unmount());
      publishSession(null);
      sessionStorage.clear();
      host.remove();
    }
  });
}
