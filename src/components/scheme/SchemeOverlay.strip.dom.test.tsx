import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import { emptyStore } from "@/components/runtime/runtimeModel";

import { resolveExpandedNode } from "./expandedNode";

/*
 * Finding 6 (issue #241): the REAL full-window overlay wiring — the board's
 * `resolveExpandedNode` picking the node and mounting it as an `expanded`
 * `BranchPane` — must carry the control strip and classify a scanner-shaped
 * subagent from its structured root. Regressions in the overlay path fail here
 * independently of the inline board node.
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

function structuredRoot(): RuntimeSessionView {
  return { session: { hostKind: "claude-broker", host: "hosted", artifactPath: "/root.jsonl" } as RuntimeSessionView["session"], uiState: {} as RuntimeSessionView["uiState"], attentions: [], receipts: [], legacy: false, structuredControlsEnabled: true };
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

const { BranchPane } = await import("@/components/BranchPane");

const roots = new Set<Root>();
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
});

interface OverlayNode { file: FileEntry; tasks: FileEntry[]; isRoot: boolean }
const subagentNode: OverlayNode = {
  file: {
    path: "/child.jsonl", root: "claude-projects", name: "child.jsonl", project: "project", title: "child",
    engine: "claude", kind: "subagent", fmt: "claude", parent: "/root.jsonl", mtime: 1, size: 1, activity: "live",
    proc: null, pid: null, conversationId: "conv-child", model: "sonnet", pendingQuestion: null, waitingInput: null,
  } as FileEntry,
  tasks: [],
  isRoot: false,
};

test("the overlay resolves the node and mounts an expanded strip (live-subagent) with a composer", () => {
  // real overlay wiring: pick the node exactly as SchemeBoard does
  const expandedNode = resolveExpandedNode([subagentNode], "/child.jsonl");
  expect(expandedNode).not.toBeNull();

  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const rootInstance = createRoot(host as unknown as HTMLElement);
  roots.add(rootInstance);
  // the exact overlay JSX SchemeBoard renders for the expanded node
  flushSync(() => rootInstance.render(
    <BranchPane file={expandedNode!.file} tasks={expandedNode!.tasks} isRoot={expandedNode!.isRoot} expanded showFavorite onToggleExpand={() => undefined} />,
  ));

  const strip = (host as unknown as HTMLElement).querySelector("[data-agent-control-strip]");
  expect(strip).not.toBeNull();
  expect(strip?.getAttribute("data-strip-surface")).toBe("structured-subagent");
  expect((host as unknown as HTMLElement).querySelector("textarea")).not.toBeNull();
});
