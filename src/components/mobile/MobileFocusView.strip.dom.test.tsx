import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import { emptyStore } from "@/components/runtime/runtimeModel";

/*
 * Finding 6 (issue #241): the REAL mobile focus wrapper (`MobileFocusView` →
 * `BranchPane`) must mount the control strip for the focused conversation,
 * classify a scanner-shaped subagent as `live-subagent`, and expose 44px mobile
 * control targets. Regressions in the phone layout fail here independently.
 */

const dom = new HappyWindow();
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
function bindDomGlobals() {
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator,
    Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
    Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent,
    sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
    ResizeObserver: TestResizeObserver, IntersectionObserver: undefined,
  });
}
bindDomGlobals();
// The phone layout: force useIsMobile true.
(dom as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (query: string) => ({
  matches: true, media: query, addEventListener() {}, removeEventListener() {},
});

function structuredRoot(): RuntimeSessionView {
  return { session: { hostKind: "claude-broker", host: "hosted", artifactPath: "/root.jsonl" } as RuntimeSessionView["session"], uiState: {} as RuntimeSessionView["uiState"], attentions: [], receipts: [], legacy: false };
}
const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualLogTail = await import("@/hooks/useLogTail");
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ enabled: true, connection: "live", resyncedAt: null, lastEventAt: null, store: emptyStore() }),
  useRuntime: () => ({ enabled: true, connection: "live", resyncedAt: null, store: emptyStore() }),
  useRuntimeSession: () => null,
  useRuntimeSessionByArtifact: (path: string | null) => (path === "/root.jsonl" ? structuredRoot() : null),
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

/* Scanner-shaped Claude subagent focused on the phone. */
const subagent: FileEntry = {
  path: "/child.jsonl", root: "claude-projects", name: "child.jsonl", project: "project", title: "child",
  engine: "claude", kind: "subagent", fmt: "claude", parent: "/root.jsonl", mtime: 2, size: 1, activity: "live",
  proc: null, pid: null, conversationId: "conv-child", model: "sonnet", pendingQuestion: null, waitingInput: null,
};

test("the mobile focus view mounts the strip and classifies a scanner-shaped subagent as live-subagent", () => {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const rootInstance = createRoot(host as unknown as HTMLElement);
  roots.add(rootInstance);
  flushSync(() => rootInstance.render(
    <MobileFocusView
      project="project"
      groups={[]}
      manual={[subagent]}
      files={[subagent]}
      flows={[]}
      pipelines={[]}
      tasks={[]}
      drafts={[]}
      loaded
      focus="/child.jsonl"
      onSelect={() => undefined}
      onClose={() => undefined}
      onDraftClose={() => undefined}
      onDraftSpawned={() => undefined}
    />,
  ));

  const strip = (host as unknown as HTMLElement).querySelector("[data-agent-control-strip]");
  expect(strip).not.toBeNull();
  expect(strip?.getAttribute("data-strip-surface")).toBe("live-subagent");
  // mobile control targets are 44px (h-11 w-11) — the strip's own buttons
  const stripButtons = [...(strip as HTMLElement).querySelectorAll("button")];
  expect(stripButtons.some((b) => b.className.includes("h-11") && b.className.includes("w-11"))).toBe(true);
});
