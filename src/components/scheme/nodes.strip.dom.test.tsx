import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import { emptyStore } from "@/components/runtime/runtimeModel";

import type { SchemeLayout, SchemeNode } from "./layout";

/*
 * Finding 6 (issue #241): the REAL scheme-node wrapper (`NodesLayer` →
 * `NodeShell` → `BranchPane`) must mount the control strip and classify a
 * scanner-shaped Claude subagent (proc:null, pid:null) as `live-subagent` from
 * its canonical ROOT host's liveness — the production shape the earlier suites
 * masked with synthetic proc:"running" children. A regression that stops the
 * scheme node from mounting the strip fails here independently.
 */

const dom = new HappyWindow();

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function bindDomGlobals() {
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator,
    Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
    HTMLInputElement: dom.HTMLInputElement, Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent,
    sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
    ResizeObserver: TestResizeObserver, IntersectionObserver: undefined,
  });
}
bindDomGlobals();

/* The runtime plane is authoritative and carries the live root host keyed by its
   artifact path (the subagent's `parent`); the root session itself reads as a
   live legacy tmux pane. */
function legacyRoot(): RuntimeSessionView {
  return { session: { hostKind: "tmux-legacy", host: "hosted", artifactPath: "/root.jsonl" } as RuntimeSessionView["session"], uiState: {} as RuntimeSessionView["uiState"], attentions: [], receipts: [], legacy: true, structuredControlsEnabled: true };
}
function structuredRoot(): RuntimeSessionView {
  return { session: { hostKind: "claude-broker", host: "hosted", artifactPath: "/root.jsonl" } as RuntimeSessionView["session"], uiState: {} as RuntimeSessionView["uiState"], attentions: [], receipts: [], legacy: false, structuredControlsEnabled: true };
}

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualLogTail = await import("@/hooks/useLogTail");
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ enabled: true, connection: "live", resyncedAt: null, lastEventAt: null, store: emptyStore() }),
  useRuntime: () => ({ enabled: true, connection: "live", resyncedAt: null, store: emptyStore() }),
  useRuntimeSession: (id: string | null) => (id === "conv-root" ? legacyRoot() : null),
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

const { NodesLayer } = await import("./nodes");

const roots = new Set<Root>();
beforeEach(bindDomGlobals);
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

function node(entry: FileEntry, x: number): SchemeNode {
  return { file: entry, tasks: [], under: [], isRoot: entry.kind === "session", x, y: 0, w: 600, h: 780 };
}

function layout(nodes: SchemeNode[]): SchemeLayout {
  return {
    nodes, edges: [], stacks: [], decks: [], loops: [], groups: [], links: [], drafts: [], slots: [],
    byPath: new Map(), width: 2000, height: 1000,
  };
}

const root: FileEntry = {
  path: "/root.jsonl", root: "claude-projects", name: "root.jsonl", project: "project", title: "root",
  engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1, size: 1, activity: "live",
  proc: "running", pid: 5, conversationId: "conv-root", model: "sonnet", pendingQuestion: null, waitingInput: null,
};
/* Scanner-shaped Claude subagent: proc/pid null — the root writes its transcript. */
const subagent: FileEntry = {
  path: "/child.jsonl", root: "claude-projects", name: "child.jsonl", project: "project", title: "child",
  engine: "claude", kind: "subagent", fmt: "claude", parent: "/root.jsonl", mtime: 1, size: 1, activity: "live",
  proc: null, pid: null, conversationId: "conv-child", model: "sonnet", pendingQuestion: null, waitingInput: null,
};

function render(nodes: SchemeNode[], dormant = false): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const rootInstance = createRoot(host as unknown as HTMLElement);
  roots.add(rootInstance);
  flushSync(() => rootInstance.render(
    <NodesLayer
      layout={layout(nodes)}
      project="project"
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
  return host as unknown as HTMLElement;
}

const surfaceOf = (host: HTMLElement, path: string) =>
  host.querySelector(`[data-scheme-node="${path}"] [data-agent-control-strip]`)?.getAttribute("data-strip-surface") ?? null;

test("a scheme node mounts the strip: live-root for the running root", () => {
  const host = render([node(root, 100)]);
  expect(surfaceOf(host, "/root.jsonl")).toBe("live-root");
});

test("a scheme node classifies a scanner-shaped subagent from its live structured root", () => {
  const host = render([node(root, 100), node(subagent, 700)]);
  expect(surfaceOf(host, "/child.jsonl")).toBe("structured-subagent");
  // the root-agent Stop note is rendered on the child's strip
  expect(host.querySelector('[data-scheme-node="/child.jsonl"]')?.textContent).toContain("interrupts the root agent");
});

test("dormant far-zoom scheme nodes render no control strip; active nodes restore it", () => {
  const dormantHost = render([node(root, 100), node(subagent, 700)], true);
  expect(dormantHost.querySelectorAll("[data-agent-control-strip]").length).toBe(0);
  const activeHost = render([node(root, 100)], false);
  expect(surfaceOf(activeHost, "/root.jsonl")).toBe("live-root");
});
