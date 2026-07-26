import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { expiryFrom } from "@/lib/attention/machine";
import type { AttentionRequestV1 } from "@/lib/attention/types";
import { DOCK_WIDTH, sheetHeights } from "@/lib/overlay/layout";
import { translate } from "@/lib/i18n";

import { RootOverlayHost, type RootOverlayHostProps } from "./RootOverlayHost";

/*
 * #691 D2 — one conversation, three renderings, none owning the state.
 *
 * These tests are about the HOST's only job: choosing which container the one
 * component renders into, and never changing the component while doing it.
 */

const USABLE = 844 - 34;

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
});

let roots: Root[] = [];
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; });
afterEach(async () => { for (const root of roots) flushSync(() => root.unmount()); roots = []; await settle(); });

const t = ((key: string, vars?: Record<string, string | number>) => translate("en", key as "overlay.title", vars)) as RootOverlayHostProps["t"];

function request(): AttentionRequestV1 {
  const created = new Date("2026-07-01T10:00:00.000Z");
  return {
    id: "attention_1",
    createdAt: created.toISOString(),
    requestedBy: { rootId: "root_fixed" },
    origin: "root-agent",
    target: { kind: "conversation", path: "/tmp/reviewer.jsonl" },
    frameAtCreation: { project: "demo", rect: { x: 0, y: 0, w: 600, h: 780 }, boardRevision: 4 },
    intent: "show",
    zoom: "situate",
    reason: "The reviewer finished with request-changes.",
    state: "offered",
    stateChangedAt: created.toISOString(),
    expiresAt: expiryFrom(created),
    offeredTo: ["device-a"],
    returnPoints: [],
    revision: 1,
  };
}

/** A stand-in for the browser capability happy-dom cannot provide. */
function pipStub(open: boolean): { handle: RootOverlayHostProps["pictureInPicture"]; pipWindow: Window | null } {
  if (!open) {
    return { handle: { supported: true, pipWindow: null, open: async () => {}, close: () => {} }, pipWindow: null };
  }
  const detached = new Window({ url: "http://localhost/pip" });
  return {
    handle: {
      supported: true,
      pipWindow: detached as unknown as globalThis.Window,
      open: async () => {},
      close: () => {},
    },
    pipWindow: detached,
  };
}

type HostProps = Partial<RootOverlayHostProps>;

function element(props: HostProps) {
  return (
    <RootOverlayHost
      mobile={false}
      usableHeight={USABLE}
      state="idle"
      turns={[{ id: "t1", role: "agent", text: "Reviewer finished.", at: "2026-07-01T10:00:00.000Z" }]}
      onAcceptAttention={() => {}}
      onPreviewAttention={() => {}}
      onDeclineAttention={() => {}}
      onReturnAttention={() => {}}
      t={t}
      {...props}
    />
  );
}

function mount(props: HostProps = {}): (next: HostProps) => void {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(element(props)));
  roots.push(root);
  return (next) => flushSync(() => root.render(element({ ...props, ...next })));
}

const one = (selector: string, scope: Document | null = dom.document as unknown as Document) =>
  scope?.querySelector(selector) as unknown as HTMLElement | null;

test("with no window open, the identical component docks in the page at the window's width", () => {
  mount({ pictureInPicture: pipStub(false).handle });

  const dock = one("[data-testid='root-overlay-dock']")!;
  expect(dock.style.width).toBe(`${DOCK_WIDTH}px`);
  expect(one("[data-testid='root-overlay']")!.getAttribute("data-surface")).toBe("dock");
  /* The one control that crosses the boundary. */
  expect(one("[data-testid='overlay-dock-toggle']")!.textContent).toBe("Pop out into its own window");
});

test("where the browser has no document Picture-in-Picture, the control does not pretend", () => {
  mount({ pictureInPicture: { supported: false, pipWindow: null, open: async () => {}, close: () => {} } });

  /* Firefox and Safari: the dock is the whole story, so offering a pop-out that
     cannot happen would be the only lie on the surface. */
  expect(one("[data-testid='root-overlay-dock']")).not.toBeNull();
  expect(one("[data-testid='overlay-dock-toggle']")).toBeNull();
});

test("with a window open, the same component renders into it and the page keeps no copy", () => {
  const stub = pipStub(true);
  mount({ pictureInPicture: stub.handle });

  const inWindow = one("[data-testid='root-overlay']", stub.pipWindow!.document as unknown as Document)!;
  expect(inWindow.getAttribute("data-surface")).toBe("window");
  expect(one("[data-testid='overlay-dock-toggle']", stub.pipWindow!.document as unknown as Document)!.textContent)
    .toBe("Dock back into the page");
  /* Nothing is duplicated crossing the boundary. */
  expect(one("[data-testid='root-overlay-dock']")).toBeNull();
  expect(one("[data-testid='root-overlay']")).toBeNull();
});

test("on a phone the sheet is the rendering, and it opens at Half", () => {
  mount({ mobile: true });

  const sheet = one("[data-testid='root-sheet']")!;
  expect(sheet.getAttribute("data-snap")).toBe("half");
  expect(sheet.style.height).toBe(`${sheetHeights(USABLE).half}px`);
  expect(one("[data-testid='root-overlay-dock']")).toBeNull();
});

function drag(element: HTMLElement, from: number, to: number): void {
  flushSync(() => {
    const down = new dom.Event("pointerdown", { bubbles: true }) as unknown as Event & { clientY: number };
    Object.defineProperty(down, "clientY", { value: from });
    element.dispatchEvent(down);
    const up = new dom.Event("pointerup", { bubbles: true }) as unknown as Event & { clientY: number };
    Object.defineProperty(up, "clientY", { value: to });
    element.dispatchEvent(up);
  });
}

test("an arriving request lowers the sheet rather than raising it over the work", async () => {
  const rerender = mount({ mobile: true });

  /* Take it up to Full first, one snap at a time. */
  drag(one("[data-testid='sheet-grabber']")!, 400, 100);
  expect(one("[data-testid='root-sheet']")!.getAttribute("data-snap")).toBe("full");

  rerender({ attention: { request: request(), status: "actionable", returnAvailable: false } });
  await settle();

  /* A handoff moves the sheet DOWN so the thing it is pointing at is visible;
     it never raises the conversation over the work. */
  expect(one("[data-testid='root-sheet']")!.getAttribute("data-snap")).toBe("half");
  expect(one("[data-testid='attention-accept']")).not.toBeNull();
});

test("nothing else arriving in the timeline moves the sheet by itself", () => {
  const rerender = mount({ mobile: true });
  drag(one("[data-testid='sheet-grabber']")!, 400, 100);

  rerender({ turns: [
    { id: "t1", role: "agent", text: "Reviewer finished.", at: "2026-07-01T10:00:00.000Z" },
    { id: "t2", role: "agent", text: "And the deploy went out.", at: "2026-07-01T10:01:00.000Z" },
  ] });

  expect(one("[data-testid='root-sheet']")!.getAttribute("data-snap")).toBe("full");
});
