import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import { emptyStore } from "@/components/runtime/runtimeModel";

/*
 * 390px acceptance for PR #441: the REAL phone wrapper (`MobileFocusView`)
 * mounts the subagent badge/anchor interaction on the focused conversation —
 * the two-tap title-then-navigation the desktop board already carries — and
 * navigates to the CURRENT non-archived generation rather than the stale
 * file-order entry.
 */

const dom = new HappyWindow({ innerWidth: 390, innerHeight: 844 });
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver, IntersectionObserver: undefined,
});
(dom as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (query: string) => ({
  matches: true, media: query, addEventListener() {}, removeEventListener() {},
});

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualLogTail = await import("@/hooks/useLogTail");
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ enabled: true, connection: "live", resyncedAt: null, lastEventAt: null, store: emptyStore() }),
  useRuntime: () => ({ enabled: true, connection: "live", resyncedAt: null, store: emptyStore() }),
  useRuntimeSession: () => null,
  useRuntimeSessionByArtifact: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
mock.module("@/hooks/useLogTail", () => ({
  useLogTail: () => ({
    lines: [], linesStart: 0, size: 0, loading: false, error: null, tickTime: null,
    paused: false, setPaused: () => undefined, clear: () => undefined,
    hasMore: false, loadingOlder: false, loadOlder: async () => 0, prependGen: 0,
  }),
}));

const { MobileFocusView } = await import("./MobileFocusView");

const roots = new Set<Root>();
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  dom.sessionStorage.clear();
});

function conversation(over: Partial<FileEntry>): FileEntry {
  return {
    path: "/parent.jsonl", root: "claude-projects", name: "parent.jsonl", project: "project", title: "Parent conversation",
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 2, size: 1, activity: "live",
    proc: "running", pid: 3, conversationId: "conv_parent", model: "fable",
    pendingQuestion: null, waitingInput: null,
    ...over,
  } as FileEntry;
}

async function renderFocus(files: FileEntry[], focus: string, onSelect: (file: FileEntry) => void): Promise<HTMLElement> {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const rootInstance = createRoot(host as unknown as HTMLElement);
  roots.add(rootInstance);
  const view = (
    <MobileFocusView
      project="project"
      groups={[]}
      manual={files}
      files={files}
      flows={[]}
      pipelines={[]}
      tasks={[]}
      drafts={[]}
      loaded
      focus={focus}
      onSelect={onSelect}
      onClose={() => undefined}
      onDraftClose={() => undefined}
      onDraftSpawned={() => undefined}
    />
  );
  flushSync(() => rootInstance.render(view));
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => rootInstance.render(view));
  return host as unknown as HTMLElement;
}

const parent = conversation({});
/* Two live generations of one spawned child share a conversation id; the stale
   one sorts first in file order but must never be the navigation target. */
const childStale = conversation({
  path: "/child-gen1.jsonl", name: "child-gen1.jsonl", title: "Spawned worker",
  parent: "/parent.jsonl", conversationId: "conv_child", generation: 1, mtime: 5,
});
const childCurrent = conversation({
  path: "/child-gen2.jsonl", name: "child-gen2.jsonl", title: "Spawned worker",
  parent: "/parent.jsonl", conversationId: "conv_child", generation: 2, mtime: 6,
});

test("the focused conversation mounts its subagent badge at 390px", async () => {
  const host = await renderFocus([parent, childStale, childCurrent], "/parent.jsonl", () => undefined);
  const badge = host.querySelector('[data-subagent-badge="conv_child"]') as HTMLButtonElement | null;
  expect(badge).not.toBeNull();
  expect(badge!.hasAttribute("data-scheme-ui")).toBe(true);
  expect(badge!.className).toContain("pointer-events-auto");
});

test("the rail lifts above the live composer bounds instead of resting on a fixed offset (issue #474 follow-up)", async () => {
  const host = await renderFocus([parent, childStale, childCurrent], "/parent.jsonl", () => undefined);
  const rail = host.querySelector('[data-testid="mobile-subagent-rail"]') as HTMLElement;
  expect(rail).not.toBeNull();
  /* The static bottom-20 offset let a grown composer (up to min(38dvh, 20rem))
     swallow the lowest badges; the offset is now a measured inline style. With
     happy-dom's zero-height rects the measurement settles at the resting
     minimum — the pre-#474 offset. */
  expect(rail.className).not.toContain("bottom-20");
  expect(rail.style.bottom).toBe("80px");

  /* Stub real geometry — pane area bottom 800, composer top 640 — and force a
     re-measure: the rail must clear the composer band plus the stable gutter. */
  const paneArea = rail.parentElement as HTMLElement;
  const rect = (over: Partial<DOMRect>) => () => ({ left: 0, top: 0, right: 390, bottom: 0, width: 390, height: 0, x: 0, y: 0, toJSON() {}, ...over }) as DOMRect;
  paneArea.getBoundingClientRect = rect({ bottom: 800 });
  const composer = paneArea.querySelector('[data-testid="bounded-mobile-composer"]') as HTMLElement;
  expect(composer).not.toBeNull();
  composer.getBoundingClientRect = rect({ top: 640, bottom: 800, height: 160 });
  dom.window.dispatchEvent(new dom.Event("resize"));
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(rail.style.bottom).toBe("172px"); // 160px composer band + 12px clearance
});

test("two taps navigate to the current non-archived generation, not the stale file-order entry", async () => {
  const selected: string[] = [];
  const host = await renderFocus([childStale, childCurrent, parent], "/parent.jsonl", (file) => selected.push(file.path));
  const badge = host.querySelector('[data-subagent-badge="conv_child"]') as HTMLButtonElement;
  const tap = () => badge.dispatchEvent(new dom.PointerEvent("pointerup", { bubbles: true, pointerType: "touch" }) as unknown as Event);

  flushSync(() => tap());
  expect(badge.getAttribute("aria-expanded")).toBe("true");
  expect(selected).toEqual([]);

  flushSync(() => tap());
  expect(selected).toEqual(["/child-gen2.jsonl"]);
});
