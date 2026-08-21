import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore } from "@/components/runtime/runtimeModel";

/*
 * The dock's geometry contract (issue #977 acceptance): the width is the
 * operator's and survives reload, and the board keeps at least 320px even with
 * the document preview sheet open on the other side. Since #1011 that width is
 * remembered PER PROJECT, so a mandate-heavy dock in one project leaves every
 * other project's dock the size the operator left it.
 */

const dom = new HappyWindow();
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver,
  IntersectionObserver: undefined,
});
(dom as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (query: string) => ({
  matches: false, media: query, addEventListener() {}, removeEventListener() {},
});

const actualRuntimeHooks = await import("@/hooks/useRuntime");
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ enabled: false, connection: "off", resyncedAt: null, lastEventAt: null, store: emptyStore() }),
  useRuntime: () => ({ enabled: false, connection: "off", resyncedAt: null, store: emptyStore() }),
  useRuntimeEnabled: () => false,
  useRuntimeSession: () => null,
  useRuntimeSessionForConversation: () => null,
  useRuntimeSessionByArtifact: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));

const {
  OrchestratorDock,
  MIN_WIDTH,
  MIN_BOARD,
  DEFAULT_WIDTH,
  RAIL_WIDTH,
  RESERVED_BESIDE_DOCK,
  dockWidthForPointer,
  storedDockWidth,
} = await import("./OrchestratorDock");
const { leftShellInset } = await import("../shellLayout");

/** `ArtifactPreviewHost`'s own default, minimum and board floor — the numbers
    the other half of this geometry is clamped by. */
const PREVIEW_DEFAULT = 560;
const PREVIEW_MIN = 380;
const MIN_CONVERSATION = 320;
/** The sheet's own clamp, restated here so the two halves are checked as ONE
    budget rather than each against itself. */
const sheetWidth = (viewport: number, inset: number) =>
  Math.max(PREVIEW_MIN, Math.min(PREVIEW_DEFAULT, viewport - MIN_CONVERSATION - inset));
/** What the operator actually sees of the board, with both surfaces open. */
const visibleBoard = (viewport: number, dock: number) =>
  viewport - RAIL_WIDTH - dock - sheetWidth(viewport, RAIL_WIDTH + dock);

const realFetch = globalThis.fetch;
const roots = new Set<Root>();
beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/orchestrator/seat?")) {
      return { ok: true, status: 200, json: async () => ({ seat: null, pending: null, exists: true }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as typeof fetch;
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  dom.localStorage.clear();
  dom.sessionStorage.clear();
  globalThis.fetch = realFetch;
});
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

/** A witness at the commit boundary. Its layout effect runs inside the SAME
    commit as the dock's own — after the dock's subtree, before the browser
    paints and before any passive effect — so what it observes is the frame the
    operator would actually see. Timing bugs that a passive effect papers over
    are visible from here and nowhere else. */
function CommitProbe({ at }: { at: () => void }) {
  useLayoutEffect(() => {
    at();
  });
  return null;
}

/** The dock's committed width, as the observer at a commit boundary reads it. */
type CommitWatcher = (width: string | null | undefined) => void;

/** One dock on a project, as a page load gives it: its own host, its own root,
    and the two gestures the width contract is made of — drag the edge, switch
    the project underneath it. */
function mountDock(project: string, atCommit?: CommitWatcher) {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  const readWidth = () => host.querySelector("[data-orchestrator-dock]")?.getAttribute("data-orchestrator-dock-width");
  let commit = atCommit;
  const render = (on: string) => flushSync(() => root.render(
    <>
      <OrchestratorDock project={on} projectName={on} files={[]} onClose={() => undefined} />
      <CommitProbe at={() => commit?.(readWidth())} />
    </>,
  ));
  render(project);
  /* The gesture in three parts, because a switch can land between them. */
  const pointerDown = () => {
    const handle = host.querySelector("[data-orchestrator-dock-resize]") as unknown as HTMLElement;
    flushSync(() => handle.dispatchEvent(new dom.MouseEvent("pointerdown", { bubbles: true }) as unknown as Event));
  };
  /** The raw pointer event that lands the dock on `target` px, on a 2000px
      desktop wide enough that the pointer clamp does not bite. Unflushed, so it
      can be fired from inside a commit the way a real one arrives. */
  const dispatchMove = (target: number) => {
    Object.defineProperty(dom, "innerWidth", { value: 2_000, configurable: true });
    dom.dispatchEvent(Object.assign(new dom.Event("pointermove"), { clientX: RAIL_WIDTH + target }));
  };
  const pointerMoveTo = (target: number) => flushSync(() => dispatchMove(target));
  const pointerUp = () => flushSync(() => dom.dispatchEvent(new dom.Event("pointerup")));
  return {
    render,
    width: readWidth,
    /** What to run at each commit boundary from here on. */
    onCommit: (fn?: CommitWatcher) => {
      commit = fn;
    },
    pointerDown,
    dispatchMove,
    pointerMoveTo,
    pointerUp,
    dragTo: (target: number) => {
      pointerDown();
      pointerMoveTo(target);
      pointerUp();
    },
    unmount: () => {
      flushSync(() => root.unmount());
      roots.delete(root);
      host.remove();
    },
  };
}

test("dock and preview sheet share ONE budget: the board keeps 320px at every desktop width", () => {
  /* The reviewer's own case: 1440px, both surfaces at their remembered
     defaults. The sheet is the half that yields — it opens at 560 and the dock
     is a surface the operator sized — so the board lands exactly on its floor
     instead of the 192px it used to get. */
  expect(sheetWidth(1_440, RAIL_WIDTH + DEFAULT_WIDTH)).toBe(432);
  expect(visibleBoard(1_440, DEFAULT_WIDTH)).toBe(MIN_BOARD);

  /* Wider viewports need no yielding at all: the sheet keeps its full width. */
  for (const viewport of [1_600, 1_920, 2_560]) {
    expect(sheetWidth(viewport, RAIL_WIDTH + DEFAULT_WIDTH)).toBe(PREVIEW_DEFAULT);
    expect(visibleBoard(viewport, DEFAULT_WIDTH)).toBeGreaterThanOrEqual(MIN_BOARD);
  }

  /* A dock dragged to its own maximum is still inside the budget, because that
     maximum reserves the sheet's minimum — the two clamps meet exactly. */
  const widest = dockWidthForPointer(9_999, 1_440);
  expect(widest).toBe(1_440 - RESERVED_BESIDE_DOCK);
  expect(sheetWidth(1_440, RAIL_WIDTH + widest)).toBe(PREVIEW_MIN);
  expect(visibleBoard(1_440, widest)).toBe(MIN_BOARD);
  for (const viewport of [1_600, 1_920, 2_560]) {
    expect(visibleBoard(viewport, dockWidthForPointer(9_999, viewport))).toBeGreaterThanOrEqual(MIN_BOARD);
  }

  /* And the dock never collapses below its own minimum: on a viewport too
     narrow for every floor at once, both surfaces stay usable and the CSS
     floors decide the remainder. */
  expect(dockWidthForPointer(0, 1_920)).toBe(MIN_WIDTH);
  expect(dockWidthForPointer(9_999, 900)).toBe(MIN_WIDTH);
});

test("the dock publishes the row it occupies, live through a drag, and gives it back on unmount", () => {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  flushSync(() => root.render(
    <OrchestratorDock project="atlas" projectName="Atlas" files={[]} onClose={() => undefined} />,
  ));

  /* What the sheet reads: rail + dock, so it reserves 320px of BOARD. */
  expect(leftShellInset()).toBe(RAIL_WIDTH + DEFAULT_WIDTH);

  const handle = host.querySelector("[data-orchestrator-dock-resize]") as unknown as HTMLElement;
  flushSync(() => handle.dispatchEvent(new dom.MouseEvent("pointerdown", { bubbles: true }) as unknown as Event));
  Object.defineProperty(dom, "innerWidth", { value: 1_920, configurable: true });
  flushSync(() => dom.dispatchEvent(Object.assign(new dom.Event("pointermove"), { clientX: 848 })));
  expect(leftShellInset()).toBe(RAIL_WIDTH + 600);
  expect(visibleBoard(1_920, 600)).toBeGreaterThanOrEqual(MIN_BOARD);
  flushSync(() => dom.dispatchEvent(new dom.Event("pointerup")));

  /* Closing the dock hands the row back — no phantom reservation for a panel
     that is gone. */
  flushSync(() => root.unmount());
  roots.delete(root);
  expect(leftShellInset()).toBe(0);
});

test("a stored width is honoured; a missing or nonsense one falls back to the default", () => {
  expect(storedDockWidth(() => "520")).toBe(520);
  expect(storedDockWidth(() => null)).toBe(DEFAULT_WIDTH);
  expect(storedDockWidth(() => "12")).toBe(DEFAULT_WIDTH);
  expect(storedDockWidth(() => "not a number")).toBe(DEFAULT_WIDTH);
});

test("switching projects re-seats the panel on the new project's own draft, keeping the dock's width", async () => {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  flushSync(() => root.render(
    <OrchestratorDock project="atlas" projectName="Atlas" files={[]} onClose={() => undefined} />,
  ));
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => undefined);

  const mandate = host.querySelector("[data-orchestrator-mandate]") as unknown as HTMLTextAreaElement;
  const propsKey = Object.keys(mandate).find((key) => key.startsWith("__reactProps$"))!;
  const props = (mandate as unknown as Record<string, { onChange: (event: unknown) => void }>)[propsKey]!;
  flushSync(() => props.onChange({ target: { value: "Atlas only" } }));
  expect((host.querySelector("[data-orchestrator-mandate]") as unknown as HTMLTextAreaElement).value).toBe("Atlas only");

  flushSync(() => root.render(
    <OrchestratorDock project="borealis" projectName="Borealis" files={[]} onClose={() => undefined} />,
  ));
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => undefined);

  expect(host.querySelector("[data-orchestrator-panel]")?.getAttribute("data-orchestrator-panel")).toBe("borealis");
  expect((host.querySelector("[data-orchestrator-mandate]") as unknown as HTMLTextAreaElement).value).not.toBe("Atlas only");
  /* Neither project has a width of its own here, so both open on the default;
     the width that DOES follow a switch is the case below. */
  expect(host.querySelector("[data-orchestrator-dock]")?.getAttribute("data-orchestrator-dock-width")).toBe(String(DEFAULT_WIDTH));
});

test("dragging the dock's edge persists the width under the project's own key, and the next mount opens on it", () => {
  const dock = mountDock("atlas");
  expect(dock.width()).toBe(String(DEFAULT_WIDTH));
  dock.dragTo(600);

  /* Scoped to the project (#1011). The drag claims one project's width and
     leaves the legacy global key exactly as the operator had it. */
  expect(dom.localStorage.getItem("llvOrchestratorPanelWidth:atlas")).toBe("600");
  expect(dom.localStorage.getItem("llvOrchestratorPanelWidth")).toBeNull();
  expect(dock.width()).toBe("600");
  expect(storedDockWidth(() => dom.localStorage.getItem("llvOrchestratorPanelWidth:atlas"))).toBe(600);

  /* Reload: the same project opens on the width it was left at. */
  dock.unmount();
  expect(mountDock("atlas").width()).toBe("600");
});

test("a project with no width of its own seeds from the legacy global one", () => {
  /* What an operator carries in from before #1011: ONE width, shared by every
     project. It seeds them all, so nobody's dock snaps back to the default. */
  dom.localStorage.setItem("llvOrchestratorPanelWidth", "620");
  expect(mountDock("atlas").width()).toBe("620");
  expect(mountDock("borealis").width()).toBe("620");

  /* A width of its own outranks the seed... */
  dom.localStorage.setItem("llvOrchestratorPanelWidth:borealis", "500");
  expect(mountDock("borealis").width()).toBe("500");
  /* ...and an unusable one falls to the default: the legacy key answers only
     for a project that has never been sized. */
  dom.localStorage.setItem("llvOrchestratorPanelWidth:borealis", "12");
  expect(mountDock("borealis").width()).toBe(String(DEFAULT_WIDTH));
});

test("two projects hold independent widths: resizing one leaves the other's alone", () => {
  const atlas = mountDock("atlas");
  atlas.dragTo(600);
  atlas.unmount();

  const borealis = mountDock("borealis");
  /* Untouched by the drag next door — no seed, so its own default. */
  expect(borealis.width()).toBe(String(DEFAULT_WIDTH));
  borealis.dragTo(520);
  borealis.unmount();

  expect(dom.localStorage.getItem("llvOrchestratorPanelWidth:atlas")).toBe("600");
  expect(dom.localStorage.getItem("llvOrchestratorPanelWidth:borealis")).toBe("520");
  expect(mountDock("atlas").width()).toBe("600");
});

test("switching projects while the dock is open re-reads the new project's width", () => {
  dom.localStorage.setItem("llvOrchestratorPanelWidth:atlas", "600");
  dom.localStorage.setItem("llvOrchestratorPanelWidth:borealis", "500");

  const dock = mountDock("atlas");
  expect(dock.width()).toBe("600");
  expect(leftShellInset()).toBe(RAIL_WIDTH + 600);

  dock.render("borealis");
  expect(dock.width()).toBe("500");
  /* The row the preview sheet budgets around follows the switch too. */
  expect(leftShellInset()).toBe(RAIL_WIDTH + 500);

  /* And back: the visit changed nothing about atlas's own width. */
  dock.render("atlas");
  expect(dock.width()).toBe("600");
  expect(dom.localStorage.getItem("llvOrchestratorPanelWidth:atlas")).toBe("600");
});

test("a project switch under an unfinished drag settles the width on the project it started on", () => {
  dom.localStorage.setItem("llvOrchestratorPanelWidth:borealis", "500");

  const dock = mountDock("atlas");
  dock.pointerDown();
  dock.pointerMoveTo(600);
  expect(dock.width()).toBe("600");

  /* The operator switches projects with the drag still armed — a pointerup
     released outside the window never reaches the dock's listeners, so this is
     reachable in the real app. */
  dock.render("borealis");
  expect(dock.width()).toBe("500");

  /* Atlas keeps the width the operator dragged IT to, and borealis keeps its
     own: neither project's key holds the other's number. */
  expect(dom.localStorage.getItem("llvOrchestratorPanelWidth:atlas")).toBe("600");
  expect(dom.localStorage.getItem("llvOrchestratorPanelWidth:borealis")).toBe("500");

  /* The dead drag is over: the pointer no longer drags borealis's dock, and
     its pointerup writes nothing. */
  dock.pointerMoveTo(720);
  expect(dock.width()).toBe("500");
  dock.pointerUp();
  expect(dom.localStorage.getItem("llvOrchestratorPanelWidth:atlas")).toBe("600");
  expect(dom.localStorage.getItem("llvOrchestratorPanelWidth:borealis")).toBe("500");

  /* Borealis is still resizable by a drag of its own. */
  dock.dragTo(700);
  expect(dock.width()).toBe("700");
  expect(dom.localStorage.getItem("llvOrchestratorPanelWidth:borealis")).toBe("700");
  expect(dom.localStorage.getItem("llvOrchestratorPanelWidth:atlas")).toBe("600");
});

test("the old drag's listeners are gone before the new project is on screen", () => {
  dom.localStorage.setItem("llvOrchestratorPanelWidth:borealis", "500");

  const dock = mountDock("atlas");
  dock.pointerDown();
  dock.pointerMoveTo(600);

  /* A pointermove fired at the commit boundary: the switch to borealis is
     committed and nothing has been painted yet. This is the window a passive
     cleanup leaves open, and a real pointer sits in it whenever the drag was
     left armed — so a listener still attached here would drag BOREALIS's dock
     with the gesture the operator aimed at atlas. */
  let fired = false;
  dock.onCommit(() => {
    if (fired) return;
    fired = true;
    dock.dispatchMove(720);
  });
  dock.render("borealis");
  dock.onCommit(undefined);
  expect(fired).toBe(true);

  expect(dock.width()).toBe("500");
  expect(dom.localStorage.getItem("llvOrchestratorPanelWidth:borealis")).toBe("500");
  expect(dom.localStorage.getItem("llvOrchestratorPanelWidth:atlas")).toBe("600");
});

test("the published row and the committed width change in the same frame", () => {
  dom.localStorage.setItem("llvOrchestratorPanelWidth:atlas", "400");
  dom.localStorage.setItem("llvOrchestratorPanelWidth:borealis", "900");

  const seen: Array<{ width: string | null | undefined; inset: number }> = [];
  const dock = mountDock("atlas", (width) => seen.push({ width, inset: leftShellInset() }));

  /* Mount: the sheet's budget is right from the first frame. */
  expect(seen.at(-1)).toEqual({ width: "400", inset: RAIL_WIDTH + 400 });

  dock.render("borealis");

  /* And through the switch that widens the dock by 500px, the two move
     together. Publishing a frame late would paint 900px of dock against a row
     reserved for 400 — the sheet takes its full 560 and the board is left with
     212px, well under its floor. */
  expect(seen.at(-1)).toEqual({ width: "900", inset: RAIL_WIDTH + 900 });
  expect(visibleBoard(1_920, 900)).toBeGreaterThanOrEqual(MIN_BOARD);
  expect(1_920 - RAIL_WIDTH - 900 - sheetWidth(1_920, RAIL_WIDTH + 400)).toBeLessThan(MIN_BOARD);
});
