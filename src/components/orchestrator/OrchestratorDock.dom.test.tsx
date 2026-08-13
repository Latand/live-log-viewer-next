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
  RESERVED_BESIDE_DOCK,
  dockWidthForPointer,
  storedDockWidth,
} = await import("./OrchestratorDock");

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

test("the drag clamp leaves the board its 320px even with the preview sheet open", () => {
  /* A wide desktop: the operator can drag far and the board still has room. */
  expect(dockWidthForPointer(1_000, 2_560)).toBe(1_000 - 248);
  /* Dragging past the reservation stops at it — 320px of board plus the
     preview sheet's own minimum stay on the other side. */
  const wide = dockWidthForPointer(9_999, 1_920);
  expect(wide).toBe(1_920 - RESERVED_BESIDE_DOCK);
  expect(1_920 - 248 - wide - 380).toBeGreaterThanOrEqual(MIN_BOARD);
  /* And it never collapses below the dock's own minimum. */
  expect(dockWidthForPointer(0, 1_920)).toBe(MIN_WIDTH);
  expect(dockWidthForPointer(9_999, 900)).toBe(MIN_WIDTH);
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
