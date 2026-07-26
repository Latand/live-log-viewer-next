import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

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

test("the first client render already carries the real time — no undemoted first frame", () => {
  /* Reading 0 on the first frame would paint every age-derived chip
     undemoted (a rail of pulsing green) and correct it a frame later, the
     exact lie issue #669 exists to remove. #172 forbids that flash. */
  const seen: number[] = [];
  const element = dom.document.createElement("div");
  dom.document.body.append(element);
  const root = createRoot(element as unknown as HTMLElement);
  roots.add(root);
  function Reader() {
    seen.push(useNowSeconds(90_000));
    return null;
  }
  flushSync(() => root.render(<Reader />));

  expect(seen.length).toBeGreaterThan(0);
  expect(seen[0]).toBeGreaterThan(1_700_000_000);
});

test("the server render still reads 0, so hydration markup agrees", () => {
  function Reader() {
    return <span>{String(useNowSeconds(120_000))}</span>;
  }
  expect(renderToStaticMarkup(<Reader />)).toBe("<span>0</span>");
});
