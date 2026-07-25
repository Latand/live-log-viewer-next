import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { useNowSeconds } from "./useNowSeconds";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
});

const roots = new Set<Root>();

afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
});

function mount(tickMs: number, count = 1) {
  const element = dom.document.createElement("div");
  dom.document.body.append(element);
  const host = element as unknown as HTMLElement;
  const root = createRoot(host);
  roots.add(root);
  function Reader() {
    const now = useNowSeconds(tickMs);
    return <span data-now={String(now)} />;
  }
  flushSync(() => {
    root.render(<>{Array.from({ length: count }, (_, index) => <Reader key={index} />)}</>);
  });
  return host;
}

test("the clock lands the real time on subscription and reports epoch seconds", () => {
  const host = mount(60_000);
  const now = Number((host.querySelector("span") as HTMLElement).dataset.now);
  expect(now).toBeGreaterThan(1_700_000_000);
  expect(Math.abs(now - Date.now() / 1000)).toBeLessThan(2);
});

test("every subscriber of one cadence shares a single clock value", async () => {
  const host = mount(60, 3);
  await Bun.sleep(120);
  const values = [...host.querySelectorAll("span")].map((node) => (node as unknown as HTMLElement).dataset.now);
  expect(values).toHaveLength(3);
  expect(new Set(values).size).toBe(1);
});

test("the clock advances on its own so an age-derived surface never needs a reload", async () => {
  const host = mount(60);
  const first = Number((host.querySelector("span") as HTMLElement).dataset.now);
  await Bun.sleep(150);
  const later = Number((host.querySelector("span") as HTMLElement).dataset.now);
  expect(later).toBeGreaterThan(first);
});
