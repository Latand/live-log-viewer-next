import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import { emptyStore } from "@/components/runtime/runtimeModel";

/*
 * 390 × 844 acceptance for #1439's phone conversation screen and its subagents.
 *
 * The desktop scheme's `SubagentBadges` positions every badge absolutely from
 * `layoutBadges(children, cardRect)`; the phone has no scheme canvas and no card
 * rect, so mounted there the badges landed down the feed's left edge, over the
 * prose (the prod defect the operator reported on commit 6b59d462). The phone
 * gives the feed its full width (lane 4) and reaches a child through the
 * conversation's own `⋯` menu: an in-flow row per child, which navigates to the
 * CURRENT non-archived generation rather than the stale file-order entry — the
 * same guarantee the badge used to carry (PR #441).
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

async function openMenu(): Promise<void> {
  const more = dom.document.querySelector('[data-mobile2-open="menu"]') as unknown as HTMLButtonElement | null;
  expect(more).not.toBeNull();
  flushSync(() => more!.click());
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("the phone conversation screen mounts no absolutely-positioned desktop badges over the feed at 390 × 844", async () => {
  const host = await renderFocus([parent, childStale, childCurrent], "/parent.jsonl", () => undefined);
  const pane = host.querySelector('[data-testid="mobile-focused-pane"]');
  expect(pane).not.toBeNull();
  /* No desktop badge, no overflow chip, no rail to hold them. */
  expect(host.querySelector("[data-subagent-badge], [data-subagent-overflow]")).toBeNull();
  expect(host.querySelector('[data-testid="mobile-subagent-rail"]')).toBeNull();
  /* Nothing that names a subagent is taken out of the flow inside the pane:
     an absolutely-positioned marker there is exactly what floated over the
     prose, wherever its coordinates come from. */
  const floating = [...pane!.querySelectorAll("[data-subagent-badge], [data-subagent-overflow], [data-subagent-fold]")]
    .filter((node) => (node as HTMLElement).className.split(/\s+/).includes("absolute"));
  expect(floating).toEqual([]);
});

test("the ⋯ menu lists the child as an in-flow row that opens the current non-archived generation", async () => {
  const selected: string[] = [];
  await renderFocus([childStale, childCurrent, parent], "/parent.jsonl", (file) => selected.push(file.path));
  await openMenu();
  const rows = [...dom.document.querySelectorAll('[data-mobile2-menu-row="subagent"]')] as unknown as HTMLButtonElement[];
  expect(rows.map((row) => row.getAttribute("data-mobile2-subagent"))).toEqual(["conv_child"]);
  const row = rows[0]!;
  expect(row.textContent).toContain("Spawned worker");
  /* A sheet row, in the flow of the sheet: never the scheme's floating chip. */
  expect(row.className.split(/\s+/)).not.toContain("absolute");
  expect(row.hasAttribute("data-scheme-ui")).toBe(false);

  flushSync(() => row.click());
  expect(selected).toEqual(["/child-gen2.jsonl"]);
});
