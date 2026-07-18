import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import { emptyStore } from "@/components/runtime/runtimeModel";

/*
 * 390px acceptance for issue #383: the REAL phone wrapper (`MobileFocusView`
 * → `BranchPane`) renders the superseded banner for a retired round with 44px
 * touch targets, no composer, and the successor lineage chip on the live card.
 */

const dom = new HappyWindow({ innerWidth: 390, innerHeight: 844 });
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver, IntersectionObserver: undefined,
});
// The phone layout: force useIsMobile true.
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
    path: "/round-1.jsonl", root: "claude-projects", name: "round-1.jsonl", project: "project", title: "builder round",
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 2, size: 1, activity: "idle",
    proc: "killed", pid: null, conversationId: "conversation_round_1", model: "fable",
    pendingQuestion: null, waitingInput: null,
    ...over,
  } as FileEntry;
}

async function renderFocus(files: FileEntry[], focus: string): Promise<HTMLElement> {
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
      onSelect={() => undefined}
      onClose={() => undefined}
      onDraftClose={() => undefined}
      onDraftSpawned={() => undefined}
    />
  );
  flushSync(() => rootInstance.render(view));
  /* The `focus` prop lands through a passive effect; let it flush so the
     pinned pane (not the attention fallback) is the one asserted on. */
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => rootInstance.render(view));
  return host as unknown as HTMLElement;
}

const superseded = conversation({
  supersededBy: { conversationId: "conversation_round_2", path: "/round-2.jsonl", at: "2026-07-18T13:37:51.000Z", reason: "recovery-spawn" },
  activityReason: "superseded",
});
const successor = conversation({
  path: "/round-2.jsonl",
  conversationId: "conversation_round_2",
  activity: "live",
  proc: "running",
  pid: 7,
  continues: { conversationId: "conversation_round_1", path: "/round-1.jsonl", round: 2 },
});

test("a focused superseded round shows the banner with 44px actions and mounts no composer at 390px", async () => {
  const host = await renderFocus([superseded, successor], "/round-1.jsonl");
  const banner = host.querySelector("[data-superseded-banner]");
  expect(banner).not.toBeNull();
  const actions = [...(banner as HTMLElement).querySelectorAll("button")];
  expect(actions.length).toBe(2);
  expect(actions.every((action) => action.className.includes("min-h-11"))).toBe(true);
  expect(host.querySelector("textarea")).toBeNull();
  expect(host.querySelector("[data-dead-host-banner]")).toBeNull();
});

test("the focused successor keeps its composer and wears the truncating lineage chip at 390px", async () => {
  const host = await renderFocus([superseded, successor], "/round-2.jsonl");
  const chip = host.querySelector("[data-continues-chip]");
  expect(chip).not.toBeNull();
  expect(chip?.getAttribute("href")).toBe("#c=conversation_round_1");
  // The chip lives inside the horizontally scrolling meta row and truncates
  // instead of overlapping the top strip (#345 class).
  expect((chip as HTMLElement).className).toContain("truncate");
  expect(host.querySelector("textarea")).not.toBeNull();
});
