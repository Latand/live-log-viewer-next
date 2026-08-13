import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import type { BranchGroup } from "@/components/projectModel";
import type { FileEntry } from "@/lib/types";

/*
 * Issue #983 — the focus root must fit the KEYBOARD-SHRUNK viewport. iOS Safari
 * ignores interactive-widget=resizes-content, so with the keyboard open the
 * layout viewport (h-dvh body, this root's max-h-[100dvh]) keeps the full
 * screen height and the keyboard covers its bottom — composer controls
 * included. The browser then scrolls the WINDOW to reach the focused field and
 * re-asserts that scroll against any manual gesture (the reported snap-back).
 * Padding the keyboard's overlap away keeps everything inside the visible area
 * so the browser never has a reason to scroll the window at all.
 */

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const inertRuntime = { enabled: false, connection: "offline" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inertRuntime, lastEventAt: null }),
  useRuntime: () => inertRuntime,
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));

const { MobileFocusView } = await import("@/components/mobile/MobileFocusView");

/* A minimal visualViewport stand-in — happy-dom does not provide one. */
function makeVisualViewport(height: number) {
  const listeners = new Set<() => void>();
  return {
    height,
    scale: 1,
    offsetTop: 0,
    addEventListener(type: string, cb: () => void) { if (type === "resize") listeners.add(cb); },
    removeEventListener(type: string, cb: () => void) { if (type === "resize") listeners.delete(cb); },
    resizeTo(next: number) {
      this.height = next;
      for (const cb of [...listeners]) cb();
    },
  };
}

const dom = new Window({ url: "http://localhost/", width: 390, height: 800 });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  matchMedia: (q: string) => ({ matches: /max-width/.test(String(q)), media: String(q), onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }),
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  fetch: (async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" })) as unknown as typeof fetch,
};
(dom as unknown as { matchMedia: unknown }).matchMedia = OVERRIDES.matchMedia;
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
  (dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

let roots: Root[] = [];
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; });
afterEach(async () => {
  for (const r of roots) flushSync(() => r.unmount());
  roots = [];
  await settle();
  dom.sessionStorage.clear();
  delete (dom as unknown as Record<string, unknown>).visualViewport;
  delete G.visualViewport;
});

function mount(node: React.ReactElement): Root {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(node));
  return root;
}

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects", name: overrides.path, project: "demo", title: overrides.path,
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1_000, size: 10,
    activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
    ...overrides,
  };
}

function view() {
  const conversation = entry({ path: "/session", title: "Main session", activity: "live", mtime: 9_000 });
  const group: BranchGroup = { key: conversation.path, columns: [{ file: conversation, tasks: [] }], returnable: [], finished: [], smt: conversation.mtime, orphanTask: false };
  return (
    <MobileFocusView
      project="demo" groups={[group]} manual={[]} files={[conversation]} flows={[]}
      pipelines={[]} surfacePipelines={[]} tasks={[]} drafts={[]}
      loaded focus={null} onSelect={() => {}} onClose={() => {}} onDraftClose={() => {}} onDraftSpawned={() => {}}
    />
  );
}

function shell(): HTMLElement {
  return dom.document.querySelector('[data-testid="mobile-chat-shell"]') as unknown as HTMLElement;
}

test("keyboard open: the focus root pads the keyboard's overlap out of its height (#983)", async () => {
  /* Layout viewport 800px, visible area 448px: the keyboard covers 352px of
     the layout the root would otherwise fill. That overlap becomes bottom
     padding, so the composer's controls land above the keyboard and the
     browser has nothing to scroll the window for. */
  const vv = makeVisualViewport(448);
  (dom as unknown as Record<string, unknown>).visualViewport = vv;
  G.visualViewport = vv;
  roots.push(mount(view()));
  await settle();

  expect(shell()).not.toBeNull();
  expect(shell().style.paddingBottom).toBe("352px");
  /* The window-scroll prevention contract stays: a fixed-height root that
     clips its own overflow, never a scrollable document. */
  expect(shell().className).toContain("max-h-[100dvh]");
  expect(shell().className).toContain("overflow-hidden");
});

test("keyboard closes: the visualViewport resize returns the full-height root (#983)", async () => {
  const vv = makeVisualViewport(448);
  (dom as unknown as Record<string, unknown>).visualViewport = vv;
  G.visualViewport = vv;
  roots.push(mount(view()));
  await settle();
  expect(shell().style.paddingBottom).toBe("352px");

  flushSync(() => vv.resizeTo(800));
  expect(shell().style.paddingBottom).toBe("");
});

test("no visualViewport: the root keeps today's exact layout (#983 fallback)", async () => {
  roots.push(mount(view()));
  await settle();

  expect(shell()).not.toBeNull();
  expect(shell().style.paddingBottom).toBe("");
  expect(shell().className).toContain("h-full");
  expect(shell().className).toContain("max-h-[100dvh]");
});

test("a layout-resizing keyboard (resizes-content honored) needs no inset (#983)", async () => {
  /* Android Chrome honors the app's interactive-widget=resizes-content: the
     layout viewport itself shrinks, both viewports agree, and double-shrinking
     the root would waste half the screen. */
  const vv = makeVisualViewport(800);
  (dom as unknown as Record<string, unknown>).visualViewport = vv;
  G.visualViewport = vv;
  roots.push(mount(view()));
  await settle();

  expect(shell().style.paddingBottom).toBe("");
});
