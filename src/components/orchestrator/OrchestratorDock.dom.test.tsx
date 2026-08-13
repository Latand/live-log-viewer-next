import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore } from "@/components/runtime/runtimeModel";

/*
 * The dock's geometry contract (issue #977 acceptance): the width is the
 * operator's and survives reload, and the board keeps at least 320px even with
 * the document preview sheet open on the other side.
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
  /* Width is the operator's preference, not the project's — it rides across. */
  expect(host.querySelector("[data-orchestrator-dock]")?.getAttribute("data-orchestrator-dock-width")).toBe(String(DEFAULT_WIDTH));
});

test("dragging the dock's edge persists the width, and the next mount opens on it", () => {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  flushSync(() => root.render(
    <OrchestratorDock project="atlas" projectName="Atlas" files={[]} onClose={() => undefined} />,
  ));

  const dock = host.querySelector("[data-orchestrator-dock]") as unknown as HTMLElement;
  expect(dock.getAttribute("data-orchestrator-dock-width")).toBe(String(DEFAULT_WIDTH));

  const handle = host.querySelector("[data-orchestrator-dock-resize]") as unknown as HTMLElement;
  flushSync(() => handle.dispatchEvent(new dom.MouseEvent("pointerdown", { bubbles: true }) as unknown as Event));
  Object.defineProperty(dom, "innerWidth", { value: 2_000, configurable: true });
  flushSync(() => dom.dispatchEvent(Object.assign(new dom.Event("pointermove"), { clientX: 848 })));
  flushSync(() => dom.dispatchEvent(new dom.Event("pointerup")));

  expect(dom.localStorage.getItem("llvOrchestratorPanelWidth")).toBe("600");
  expect(host.querySelector("[data-orchestrator-dock]")?.getAttribute("data-orchestrator-dock-width")).toBe("600");
  expect(storedDockWidth(() => dom.localStorage.getItem("llvOrchestratorPanelWidth"))).toBe(600);
});
