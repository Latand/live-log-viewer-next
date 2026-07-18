import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { BranchGroup } from "@/components/projectModel";
import type { FileEntry } from "@/lib/types";

import { SchemeBoard } from "./SchemeBoard";

/* The mobile full-map overlay (map mode + mapFrame). Regression for round-1
   finding 1: the framing effect used to re-fire on every files poll (fresh
   array identities re-memoize the layout and change fit/fitCurrent identity),
   snapping a pinched/panned camera back to the fitted framing ~every 10s.
   Framing must be applied only on a real mapFrame transition.

   Like the sibling DOM tests, the happy-dom globals stay in place — React's
   scheduler drains a deferred task after teardown. Only per-test state is
   cleaned up. */
const dom = new Window();
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(dom as unknown as { matchMedia: (q: string) => unknown }).matchMedia = () => ({
  matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
});
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
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver,
  IntersectionObserver: undefined,
});

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects",
    name: overrides.path,
    project: "demo",
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

const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  document.body.replaceChildren();
  dom.sessionStorage.clear();
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* The camera world layer: the transformed div carrying the board. A fit glides
   it (a transform transition appears for ~500ms), so a fresh transition after
   the settle window proves a re-fit happened. */
const worldOf = (host: HTMLElement): HTMLElement => {
  const world = [...host.querySelectorAll("div")].find((el) => (el as HTMLElement).style.transformOrigin === "0 0");
  expect(world).toBeTruthy();
  return world as HTMLElement;
};

test("an open mobile map holds its camera across files polls and refits only on a frame toggle (round-1 finding 1)", async () => {
  const live = entry({ path: "/session", activity: "live" });
  const quiet = entry({ path: "/session/quiet", parent: "/session", kind: "subagent" });
  const files = [live, quiet];
  const group: BranchGroup = {
    key: "/session",
    columns: [{ file: live, tasks: [] }],
    returnable: [],
    finished: [quiet],
    smt: live.mtime,
    orphanTask: false,
  };
  const render = (nextFiles: FileEntry[], mapFrame: "all" | "current") => {
    flushSync(() => {
      root.render(
        <SchemeBoard
          project="demo"
          groups={[group]}
          manual={[]}
          files={nextFiles}
          flows={[]}
          tasks={[]}
          drafts={[]}
          focus={null}
          onNodePick={() => {}}
          mapFrame={mapFrame}
          onSelect={() => {}}
          onClose={() => {}}
          onDraftClose={() => {}}
          onDraftSpawned={() => {}}
        />,
      );
    });
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  roots.add(root);
  render(files, "all");

  /* Opening applies the "all" framing once: the world glides… */
  await wait(20);
  expect(worldOf(host).style.transition).toContain("transform");
  /* …and announces every framed item, quiet-history stacks included
     (round-1 finding 5): 1 node + 1 stack. */
  expect(host.textContent).toContain("Framed all content — 2 items");
  /* The glide settles. */
  await wait(650);
  expect(worldOf(host).style.transition).toBe("");

  /* A files poll hands fresh array/object identities with unchanged content.
     The camera must hold — no re-fit, no glide. */
  render(files.map((file) => ({ ...file })), "all");
  await wait(60);
  expect(worldOf(host).style.transition).toBe("");

  /* An actual framing toggle still re-fits. */
  render(files, "current");
  await wait(20);
  expect(worldOf(host).style.transition).toContain("transform");
});
