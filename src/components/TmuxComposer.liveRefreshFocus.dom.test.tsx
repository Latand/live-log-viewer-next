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
 * jumping the caret. `useComposer` mirrors the field into the draft on the
 * browser-ordered native `input` event (which fires AFTER the engine applies
 * each composition step, unlike `compositionupdate`, which fires before) so the
 * refresh re-renders identical text.
 *
 * Fidelity: these tests drive the REAL production board-feed owners — the
 * desktop `NodesLayer` (which keys every pane host by transcript path and
 * renders live `BranchPane`s over the whole canvas) and the mobile
 * `MobileFocusView` (which keys the focused pane by `activeNode.file.path`).
 * A refresh re-renders the owner with fresh `FileEntry` objects (bumped
 * mtime/activity, reordered) and the assertions demand the SAME textarea node
 * pointer, `document.activeElement`, `selectionStart`/`selectionEnd`, the draft,
 * staged attachments, and the persisted runtime choice all survive. A final
 * negative control reenacts the historical remount (an unstable pane key) and
 * proves the identity assertion turns RED.
 */
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore } from "@/components/runtime/runtimeModel";
import type { BranchGroup } from "@/components/projectModel";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import { setLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import type { SchemeLayout, SchemeNode } from "./scheme/layout";

const dom = new Window();
const resizeCallbacks = new Set<() => void>();
class TestResizeObserver {
  private readonly notify: () => void;
  constructor(callback: ResizeObserverCallback) {
    this.notify = () => callback([], this as unknown as ResizeObserver);
    resizeCallbacks.add(this.notify);
  }
  observe() {}
  unobserve() {}
  disconnect() { resizeCallbacks.delete(this.notify); }
}

Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  CompositionEvent: dom.CompositionEvent,
  File: dom.File,
  FileReader: dom.FileReader,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  ResizeObserver: TestResizeObserver,
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});
(dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
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
const actualLogTail = await import("@/hooks/useLogTail");
const inertRuntime = { enabled: true, structuredHostsEnabled: true, connection: "live" as const, resyncedAt: null, store: emptyStore() };
/* Stable references: an unstable [] / object returned per render would re-fire
   every downstream effect keyed on it and spin the board into an infinite loop. */
const inertBusState = { ...inertRuntime, lastEventAt: null };
const EMPTY_RECEIPTS: never[] = [];
const sessionListeners = new Set<() => void>();
let currentSession: RuntimeSessionView | null = null;
function publishSession(next: RuntimeSessionView | null): void {
  currentSession = next;
  for (const listener of sessionListeners) listener();
}
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntime: () => inertRuntime,
  useRuntimeBusState: () => inertBusState,
  useRuntimeFlow: () => null,
  useRuntimeSession: (conversationId: string | null) =>
    useSyncExternalStore(
      (listener) => { sessionListeners.add(listener); return () => sessionListeners.delete(listener); },
      () => (conversationId === "conv-refresh" ? currentSession : null),
      () => null,
    ),
  useRuntimeSessionByArtifact: () => null,
  useRuntimeReceiptsForArtifact: () => EMPTY_RECEIPTS,
}));
mock.module("@/hooks/useLogTail", () => ({
  useLogTail: () => ({
    lines: [], linesStart: 0, size: 0, loading: false, error: null, tickTime: null,
    paused: false, setPaused: () => undefined, clear: () => undefined,
    hasMore: false, loadingOlder: false, loadOlder: async () => 0, prependGen: 0,
  }),
}));
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
});

const { NodesLayer } = await import("./scheme/nodes");
const { MobileFocusView } = await import("./mobile/MobileFocusView");
const { storageKey } = await import("./runtimeProfile");

globalThis.fetch = (async (input) => {
  if (String(input) === "/api/tmux/targets") {
    return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
  }
  if (String(input).startsWith("/api/runtime")) {
    return { ok: true, json: async () => ({}) } as Response;
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as Response;
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

function schemeNode(file: FileEntry, x: number): SchemeNode {
  return { file, tasks: [], under: [], isRoot: true, x, y: 0, w: 600, h: 780 };
}

function schemeLayout(nodes: SchemeNode[]): SchemeLayout {
  return {
    nodes, edges: [], stacks: [], decks: [], loops: [], groups: [], links: [],
    drafts: [], slots: [], byPath: new Map(nodes.map((n) => [n.file.path, n])),
    width: 2000, height: 1000,
  } as unknown as SchemeLayout;
}

/* The real desktop board owner: keys every pane host by transcript path and
   renders live BranchPanes across the canvas. `dormant` only pauses the feed
   poll; the composer textarea mounts on every surface. */
function renderNodesLayer(root: Root, nodes: SchemeNode[], dormant = true): void {
  flushSync(() => root.render(
    <NodesLayer
      layout={schemeLayout(nodes)}
      project="viewer"
      files={nodes.map((n) => n.file)}
      interactive
      lite={false}
      dormant={dormant}
      selected={null}
      multi={new Set()}
      session={false}
      focus={null}
      attentionPaths={null}
      flowsByImpl={new Map()}
      flows={[]}
      pipelineStrips={new Map()}
      linkedTasksByPipeline={new Map()}
      deckFocus={null}
      onSelect={() => undefined}
      onClose={() => undefined}
      onFocusRound={() => undefined}
      onDraftClose={() => undefined}
      onDraftSpawned={() => undefined}
      onExpand={() => undefined}
    />,
  ));
}

/* The real mobile board owner: focuses one conversation and keys the pane host
   by `activeNode.file.path`. A board refresh re-renders it with a fresh group. */
function mobileGroup(file: FileEntry): BranchGroup {
  return { key: file.path, columns: [{ file, tasks: [] }], returnable: [], finished: [], smt: file.mtime, orphanTask: false } as unknown as BranchGroup;
}
function renderMobileFocus(root: Root, file: FileEntry): void {
  flushSync(() => root.render(
    <MobileFocusView
      project="viewer"
      groups={[mobileGroup(file)]}
      manual={[]}
      files={[file]}
      flows={[]}
      pipelines={[]}
      surfacePipelines={[]}
      workerStacks={[]}
      tasks={[]}
      drafts={[]}
      loaded
      focus={file.path}
      onSelect={() => undefined}
      onClose={() => undefined}
      onDraftClose={() => undefined}
      onDraftSpawned={() => undefined}
    />,
  ));
}

function textareaIn(host: HTMLElement): HTMLTextAreaElement {
  return host.querySelector("textarea") as HTMLTextAreaElement;
}
/* The composer's runtime pill (issue #390) advertises the resolved model +
   reasoning face as its accessible name (`⚡ 5.6-Terra · High`, aria-labelled
   "… — GPT-5.6-Terra, High"). Reading that rendered accessible name — not the
   raw localStorage record — is what proves the persisted choice actually
   reaches the operator, and lets either a model OR a reasoning reversion fail. */
function runtimePillLabel(scope: HTMLElement): string {
  return scope.querySelector("[data-runtime-pill]")?.getAttribute("aria-label") ?? "";
}
function compose(el: HTMLTextAreaElement, type: string): void {
  flushSync(() => el.dispatchEvent(new dom.CompositionEvent(type, { bubbles: true }) as unknown as Event));
}
/* The browser-ordered native input: fired AFTER the engine has applied the
   step's composed value to the field. Reading `el.value` here is the true
   half-composed DOM value the draft mirror must capture. */
function fireInput(el: HTMLTextAreaElement): void {
  flushSync(() => el.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event));
}
function pasteImage(el: HTMLTextAreaElement, tag: string): void {
  const propsKey = Object.keys(el).find((key) => key.startsWith("__reactProps$"))!;
  const props = (el as unknown as Record<string, { onPaste(event: unknown): void }>)[propsKey]!;
  const bytes = new TextEncoder().encode(`png-${tag}`);
  props.onPaste({
    clipboardData: { items: [{ type: "image/png", getAsFile: () => new dom.File([bytes], `${tag}.png`, { type: "image/png" }) }] },
    preventDefault() {},
  });
}

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  setLocale("en");
  publishSession(null);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  publishSession(null);
  resizeCallbacks.clear();
  sessionStorage.clear();
  localStorage.clear();
  host.remove();
});

for (const mobile of [false, true]) {
  const label = mobile ? "390px mobile" : "desktop";
  /* Drive the phone through MobileFocusView and the desktop through NodesLayer —
     each is production's real refresh owner for that form factor. `refresh`
     re-renders the owner with a fresh FileEntry (bumped mtime/activity). */
  const mount = (file: FileEntry) => { mobileViewport = mobile; return mobile ? renderMobileFocus(root, file) : renderNodesLayer(root, [schemeNode(file, 100)]); };
  const refresh = mount;

  test(`[${label}] a board/feed refresh mid-IME-composition never wipes the composing word or moves the caret (real owner, node identity held)`, () => {
    const conversationId = "conv-refresh";
    sessionStorage.setItem(`llvDraft:${conversationId}`, "abc");
    const entry = (mtime: number, activity: FileEntry["activity"]) =>
      fileFor({ path: "/ime.jsonl", conversationId, mtime, activity });

    mount(entry(1, "idle"));
    const textarea = textareaIn(host);
    textarea.focus();

    /* An IME composition is in flight, in real browser order: the engine fires
       compositionstart, then compositionupdate BEFORE it applies the composed
       value (el.value is still "abc" here), then it applies the value and fires
       the native input. A draft mirror that read `compositionupdate` would
       capture the stale "abc"; the fix reads the post-value `input`. */
    compose(textarea, "compositionstart");
    compose(textarea, "compositionupdate");
    textarea.value = "abcあ";
    textarea.setSelectionRange(4, 4);
    fireInput(textarea);

    /* A background board/feed refresh re-renders the composer mid-composition
       (fresh FileEntry: moved mtime/activity, plus the runtime plane resolving). */
    flushSync(() => publishSession(structuredView));
    refresh(entry(2, "live"));
    const after = textareaIn(host);
    expect(after).toBe(textarea); // SAME DOM node — a keyed in-place reconcile, never a remount
    expect(after.value).toBe("abcあ");
    expect(after.selectionStart).toBe(4);
    expect(after.selectionEnd).toBe(4);
    expect(document.activeElement).toBe(after);

    /* The composition commits, then another refresh: the final word persists. */
    after.value = "abcあい";
    after.setSelectionRange(5, 5);
    compose(after, "compositionend");
    refresh(entry(3, "live"));
    const done = textareaIn(host);
    expect(done).toBe(textarea);
    expect(done.value).toBe("abcあい");
    expect(document.activeElement).toBe(done);
    expect(sessionStorage.getItem(`llvDraft:${conversationId}`)).toBe("abcあい");
  });

  test(`[${label}] a mid-string selection, focus, draft, attachments, and runtime choice survive a surface-resolving refresh (real owner)`, async () => {
    const conversationId = "conv-refresh";
    const draft = "hello brave new world";
    sessionStorage.setItem(`llvDraft:${conversationId}`, draft);
    /* A committed model/reasoning choice the refresh must not revert (issue
       #499 fixed a persist-on-render that reverted it during resolution). It is
       a VALID, non-default catalog selection — `gpt-5.6-terra` (the default is
       `gpt-5.6-sol`) at `high` (the default is `low`) — so the pill actually
       hydrates and renders it; an unsupported id would be dropped to defaults on
       read and the rendered-face assertion below would have no teeth. */
    const runtimeKey = storageKey(fileFor({ path: "/refresh.jsonl", conversationId }));
    localStorage.setItem(runtimeKey, JSON.stringify({ model: "gpt-5.6-terra", effort: "high" }));
    const entry = (mtime: number, activity: FileEntry["activity"]) =>
      fileFor({ path: "/refresh.jsonl", conversationId, mtime, activity });

    mobileViewport = mobile;
    /* Desktop mounts the runtime control strip live (dormant=false) so the
       surface resolution actually drives the model/effort persistence path. */
    if (mobile) renderMobileFocus(root, entry(1, "idle"));
    else renderNodesLayer(root, [schemeNode(entry(1, "idle"), 100)], false);
    const textarea = textareaIn(host);
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
    if (mobile) renderMobileFocus(root, entry(2, "live"));
    else renderNodesLayer(root, [schemeNode(entry(2, "live"), 100)], false);
    const after = textareaIn(host);
    expect(after).toBe(textarea); // same node pointer across the resolution
    expect(document.activeElement).toBe(after);
    expect(after.selectionStart).toBe(6);
    expect(after.selectionEnd).toBe(11);
    expect(after.value).toBe(draft);
    expect(host.querySelectorAll("img")).toHaveLength(1);

    /* Wait for the pill's persisted-state hydration: the surface resolution
       mounts the runtime strip, and the pill's load effect reads the
       identity-scoped runtime draft — swapping the initial synthesized default
       face for the stored `GPT-5.6-Terra, High`. */
    for (let attempt = 0; attempt < 50 && !runtimePillLabel(host).includes("GPT-5.6-Terra"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    /* The runtime model/reasoning choice rode the resolution untouched — the
       RENDERED accessible face, not just the storage record. Reverting EITHER
       axis makes this RED: a model reversion drops "GPT-5.6-Terra" (→ the
       "GPT-5.6-Sol" default) and a reasoning reversion drops "High" (→ the
       "Light" default). */
    const label = runtimePillLabel(host);
    expect(label).toContain("GPT-5.6-Terra");
    expect(label).toContain("High");
    expect(label).not.toContain("GPT-5.6-Sol");
    expect(label).not.toContain("Light");
    expect(JSON.parse(localStorage.getItem(runtimeKey)!)).toEqual({ model: "gpt-5.6-terra", effort: "high" });
  });
}

test("[desktop] a background board reorder keeps focus, caret, and the textarea node on the typed pane (real NodesLayer keying)", () => {
  mobileViewport = false;
  sessionStorage.setItem("llvDraft:conv-a", "alpha draft text");
  sessionStorage.setItem("llvDraft:conv-b", "beta draft text");
  const fileA = (mtime: number) => fileFor({ path: "/a.jsonl", conversationId: "conv-a", pid: 1, mtime });
  const fileB = (mtime: number) => fileFor({ path: "/b.jsonl", conversationId: "conv-b", pid: 2, mtime });

  /* Production keys every pane host by transcript path (NodesLayer's
     stableNodeDomOrder), so an activity/mtime reorder is a keyed MOVE, not a
     remount — the focused DOM node must ride along with its caret. */
  renderNodesLayer(root, [schemeNode(fileA(1), 100), schemeNode(fileB(1), 800)]);
  const typed = Array.from(host.querySelectorAll("textarea")).find(
    (el) => (el as HTMLTextAreaElement).value === "alpha draft text",
  ) as HTMLTextAreaElement;
  expect(typed).toBeTruthy();
  typed.focus();
  typed.setSelectionRange(6, 11);
  expect(document.activeElement).toBe(typed);

  /* The poll reorders the panes (A now sorts after B, both bumped). */
  renderNodesLayer(root, [schemeNode(fileB(3), 100), schemeNode(fileA(3), 800)]);
  const moved = Array.from(host.querySelectorAll("textarea")).find(
    (el) => (el as HTMLTextAreaElement).value === "alpha draft text",
  ) as HTMLTextAreaElement;
  expect(moved).toBe(typed); // same DOM node — a move, never a remount
  expect(document.activeElement).toBe(typed);
  expect(typed.selectionStart).toBe(6);
  expect(typed.selectionEnd).toBe(11);
});

test("[negative control] the reenacted historical remount mutation turns the identity assertion RED", () => {
  mobileViewport = false;
  const conversationId = "conv-remount";
  sessionStorage.setItem(`llvDraft:${conversationId}`, "typed");
  /* The historical regression: a poll rekeyed the pane host on refresh (a
     volatile identity key instead of the stable transcript path), so the same
     conversation arrived under a NEW React key mid-composition. Reenact it by
     re-rendering the REAL owner with the node moved to a different keyed path
     while its draft stays under the stable conversation identity. */
  renderNodesLayer(root, [schemeNode(fileFor({ path: "/stable.jsonl", conversationId }), 100)]);
  const before = textareaIn(host);
  before.focus();
  compose(before, "compositionstart");
  compose(before, "compositionupdate");
  before.value = "typedあ";
  before.setSelectionRange(6, 6);
  fireInput(before);
  expect(document.activeElement).toBe(before);

  /* Same conversation, refreshed under a rekeyed path → NodesLayer remounts. */
  renderNodesLayer(root, [schemeNode(fileFor({ path: "/rekeyed.jsonl", conversationId }), 100)]);
  const after = textareaIn(host);
  /* RED: the identity assertion the green tests make (`after === before`) now
     fails — the field the operator was composing in is torn out and rebuilt, so
     the browser's live IME composition (bound to that DOM node) is aborted and
     the caret is lost. Production's stable identity keying is exactly what keeps
     this GREEN. (A fresh field may auto-refocus, so activeElement is not the
     tell — the destroyed node is.) */
  expect(after).not.toBe(before);
  expect(before.isConnected).toBe(false);
});
