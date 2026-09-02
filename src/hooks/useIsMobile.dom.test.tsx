import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { MOBILE_LAYOUT_QUERY } from "@/lib/attention/eligibility";

import { useIsMobile } from "./useIsMobile";

/*
 * Mobile v2 (issue #1439, README §5): the phone shell renders whenever the
 * viewport is under 640 × 600 on EITHER axis — a landscape phone at 844 × 390
 * gets the shell, never the desktop — and the switch flips live when the
 * viewport crosses the line. The hook watches one media-query list; this
 * evaluates that list against a viewport the way a browser would, so the
 * assertion is about the query the product ships, not about a stub's answer.
 */

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
};
const HAD: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
for (const key of Object.keys(OVERRIDES)) { HAD[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }

const viewport = { width: 1_280, height: 800 };
const listeners = new Set<() => void>();
const asked: string[] = [];

/** A browser's reading of a media-query list: any comma-separated alternative
    matches; `max-*` is inclusive. */
function evaluate(query: string): boolean {
  return query.split(",").some((part) => {
    const match = /^\((max|min)-(width|height):\s*(\d+)px\)$/.exec(part.trim());
    if (!match) return false;
    const value = viewport[match[2] as "width" | "height"];
    const limit = Number(match[3]);
    return match[1] === "max" ? value <= limit : value >= limit;
  });
}
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => {
  asked.push(query);
  return {
    get matches() { return evaluate(query); },
    media: query,
    addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
  };
};

const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  listeners.clear();
  asked.length = 0;
});
afterAll(async () => {
  /* React's scheduler may still hold a callback from the last unmount; let it
     run before the window it reads goes away. */
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const key of Object.keys(OVERRIDES)) { if (HAD[key]) G[key] = SAVED[key]; else delete G[key]; }
});

function Reader() {
  const mobile = useIsMobile();
  return <span data-mobile={mobile ? "1" : "0"} />;
}

function mount(width: number, height: number): HTMLElement {
  viewport.width = width;
  viewport.height = height;
  const element = dom.document.createElement("div");
  dom.document.body.append(element);
  const host = element as unknown as HTMLElement;
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(<Reader />));
  return host;
}
const reading = (host: HTMLElement) => (host.querySelector("span") as HTMLElement).dataset.mobile === "1";
const resize = (width: number, height: number) => {
  viewport.width = width;
  viewport.height = height;
  flushSync(() => { for (const listener of listeners) listener(); });
};

test("the hook watches the shared breakpoint query, and it is a two-axis media-query list", () => {
  mount(1_280, 800);
  expect(asked[0]).toBe(MOBILE_LAYOUT_QUERY);
  expect(MOBILE_LAYOUT_QUERY).toBe("(max-width: 639px), (max-height: 599px)");
});

test("phone portrait frames render the shell; a desktop window does not", () => {
  expect(reading(mount(390, 844))).toBe(true);
  expect(reading(mount(430, 932))).toBe(true);
  expect(reading(mount(1_280, 800))).toBe(false);
});

test("a landscape phone at 844 × 390 renders the shell: the desktop needs both axes", () => {
  expect(reading(mount(844, 390))).toBe(true);
  /* The exact corner: 640 × 600 is the first desktop viewport; one pixel short
     on either axis is the phone. */
  expect(reading(mount(640, 600))).toBe(false);
  expect(reading(mount(639, 600))).toBe(true);
  expect(reading(mount(640, 599))).toBe(true);
});

test("the switch flips live when the viewport crosses the line, in both directions", () => {
  const host = mount(1_280, 800);
  expect(reading(host)).toBe(false);
  resize(844, 390);
  expect(reading(host)).toBe(true);
  resize(1_024, 768);
  expect(reading(host)).toBe(false);
  resize(600, 900);
  expect(reading(host)).toBe(true);
});
