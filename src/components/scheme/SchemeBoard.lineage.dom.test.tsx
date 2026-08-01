/**
 * The operator-visible half of issue #828, through the real SchemeBoard.
 *
 * The screenshot in the report showed one arrow running from a Builder card
 * down to the Codex session two generations above it. These cases render the
 * board from fixtures shaped like those records and read the drawn graph back
 * out of the DOM: which card each arrow leaves, which generations it spans, and
 * what a card says when its parent is not on the board at all. The last case
 * moves the intermediate ancestor through the activity states that made the
 * defect intermittent and asserts the drawn hierarchy does not move with it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";

const dom = new Window();
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = () => ({
  matches: false,
  media: "",
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false,
});

const requestFrame = (callback: FrameRequestCallback) => dom.setTimeout(() => callback(0), 0);
function bindDomGlobals() {
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    Node: dom.Node,
    HTMLElement: dom.HTMLElement,
    HTMLButtonElement: dom.HTMLButtonElement,
    HTMLDivElement: dom.HTMLDivElement,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    MouseEvent: dom.MouseEvent,
    PointerEvent: dom.PointerEvent,
    KeyboardEvent: dom.KeyboardEvent,
    WheelEvent: dom.WheelEvent,
    sessionStorage: dom.sessionStorage,
    localStorage: dom.localStorage,
    ResizeObserver: TestResizeObserver,
    IntersectionObserver: undefined,
    requestAnimationFrame: requestFrame,
    cancelAnimationFrame: (id: number) => dom.clearTimeout(id as never),
  });
}
bindDomGlobals();

const { buildBranchGroups } = await import("@/components/projectModel");
const { SchemeBoard } = await import("./SchemeBoard");

const roots = new Set<Root>();
let previousFetch: typeof fetch;
beforeEach(() => {
  bindDomGlobals();
  previousFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = previousFetch;
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  dom.sessionStorage.clear();
  dom.localStorage.clear();
});

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects",
    name: overrides.path,
    project: "lineage",
    title: overrides.path,
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1_000,
    size: 10,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

/* Recorded depth was 0 at every level of the live chain, so nothing here may
   depend on it. */
function lineage(parentConversationId: string | null, role: string | null = null, kind: "spawn" | "review" = "spawn") {
  return { kind, role, depth: 0, parentConversationId, reviewsConversationId: null, memberships: [] } as FileEntry["durableLineage"];
}

const coordinator = entry({
  path: "/coordinator", conversationId: "conversation_coordinator", root: "codex-sessions", engine: "codex",
  title: "Voice Coordinator", activity: "live",
});
const codexSession = entry({
  path: "/codex-session", conversationId: "conversation_codex", root: "codex-sessions", engine: "codex",
  title: "Codex session", activity: "live", parent: coordinator.path, durableLineage: lineage("conversation_coordinator"),
});
const orchestrator = entry({
  path: "/orchestrator", conversationId: "conversation_orchestrator", title: "Orchestrator", activity: "live",
  parent: codexSession.path, durableLineage: lineage("conversation_codex", "orchestrator"),
});
const builder = entry({
  path: "/builder", conversationId: "conversation_builder", title: "Builder — plain", activity: "live",
  parent: orchestrator.path, durableLineage: lineage("conversation_orchestrator", "builder"),
});

/** The true chain, top-down: an index further left is further up the lineage. */
const CHAIN = ["/coordinator", "/codex-session", "/orchestrator", "/builder"];

function mount(files: FileEntry[]): { host: HTMLElement; render: (next: FileEntry[]) => void } {
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(host as never);
  const root = createRoot(host);
  roots.add(root);
  const render = (next: FileEntry[]) =>
    flushSync(() =>
      root.render(
        <SchemeBoard
          project="lineage"
          groups={buildBranchGroups(next, "lineage")}
          manual={[]}
          files={next}
          flows={[]}
          tasks={[]}
          drafts={[]}
          focus={null}
          onSelect={() => {}}
          onClose={() => {}}
          onDraftClose={() => {}}
          onDraftSpawned={() => {}}
        />,
      ),
    );
  render(files);
  return { host, render };
}

/** Drawn lineage arrows as parent → child pairs, read off the edge layer. */
const drawnEdges = (host: HTMLElement): Array<[string | null, string | null]> =>
  [...host.querySelectorAll("[data-scheme-edge]")].map((edge) => [
    edge.getAttribute("data-scheme-edge-from"),
    edge.getAttribute("data-scheme-edge"),
  ]);

const nodePaths = (host: HTMLElement): string[] =>
  [...host.querySelectorAll("[data-scheme-node]")].map((node) => node.getAttribute("data-scheme-node")!);

const nodeAt = (host: HTMLElement, path: string) => host.querySelector(`[data-scheme-node="${path}"]`)!;

test("a transcript pointer naming a descendant never draws the builder as its coordinator's parent", () => {
  /* The reported frame, reduced to what the board could see: the codex session
     carried a pointer to the builder BELOW it, and both real parents were off
     the window. */
  const files = [{ ...builder, parent: null }, { ...codexSession, parent: "/builder" }];
  const { host } = mount(files);

  expect(nodePaths(host).sort()).toEqual(["/builder", "/codex-session"]);
  expect(drawnEdges(host)).not.toContainEqual(["/builder", "/codex-session"]);
  expect(drawnEdges(host)).toEqual([]);
  /* Neither card claims the other: each says its own parent is off the board. */
  for (const path of ["/builder", "/codex-session"]) {
    expect(nodeAt(host, path).getAttribute("data-scheme-node-host")).toBeNull();
    expect(nodeAt(host, path).querySelector("[data-scheme-ancestry-chip]")?.getAttribute("aria-label"))
      .toBe("Parent conversation is not on this board");
  }
});

test("an ancestor the board does not draw is marked on the edge and on the card", () => {
  const quiet = { ...orchestrator, activity: "idle" as const };
  const { host } = mount([coordinator, codexSession, quiet, builder]);

  expect(nodePaths(host)).not.toContain("/orchestrator");
  expect(drawnEdges(host)).toContainEqual(["/codex-session", "/builder"]);
  const spanning = host.querySelector('[data-scheme-edge="/builder"]')!;
  expect(spanning.getAttribute("data-scheme-edge-elided")).toBe("1");
  const chip = nodeAt(host, "/builder").querySelector("[data-scheme-ancestry-chip]")!;
  expect(chip.getAttribute("aria-label")).toBe("Parent not drawn on this board: Orchestrator");
  expect(nodeAt(host, "/builder").getAttribute("data-scheme-node-host")).toBe("/codex-session");
});

test("the whole chain reads coordinator → codex session → orchestrator → builder, in DOM order too", () => {
  const { host } = mount([coordinator, codexSession, orchestrator, builder]);

  expect(drawnEdges(host).sort()).toEqual([
    ["/codex-session", "/orchestrator"],
    ["/coordinator", "/codex-session"],
    ["/orchestrator", "/builder"],
  ]);
  /* Assistive order follows the hierarchy: a generation precedes the one it
     spawned, so the board is walkable top-down. */
  expect(nodePaths(host)).toEqual(["/coordinator", "/codex-session", "/orchestrator", "/builder"]);
  expect(host.querySelectorAll("[data-scheme-ancestry-chip]")).toHaveLength(0);
});

test("the drawn hierarchy holds while the intermediate ancestor moves between live, stalled and idle", () => {
  const { host, render } = mount([coordinator, codexSession, orchestrator, builder]);
  const seen: string[] = [];

  for (const activity of ["stalled", "idle", "live", "recent", "idle"] as const) {
    render([coordinator, codexSession, { ...orchestrator, activity }, builder]);
    /* Whatever the board can draw, every arrow leaves a genuine ancestor of the
       card it enters — no frame turns a descendant into a spawner. */
    for (const [from, to] of drawnEdges(host)) {
      expect({ from, to, ancestor: CHAIN.indexOf(from!) >= 0 && CHAIN.indexOf(from!) < CHAIN.indexOf(to!) })
        .toEqual({ from, to, ancestor: true });
    }
    /* The builder hangs under the nearest ancestor still drawn, never lower. */
    const host_ = nodeAt(host, "/builder").getAttribute("data-scheme-node-host");
    expect(["/orchestrator", "/codex-session"]).toContain(host_!);
    seen.push(host_!);
    /* Cards never disappear and never duplicate as the state moves. */
    expect(nodePaths(host).filter((path) => path === "/builder")).toHaveLength(1);
  }
  /* The activity transitions did change what is drawn — the fixture is not
     accidentally static — and every frame stayed correctly directed. */
  expect(new Set(seen).size).toBeGreaterThan(1);
});
