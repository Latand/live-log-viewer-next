import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { MobileBottomShelf } from "./MobileBottomShelf";

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
});

afterEach(() => dom.document.body.replaceChildren());

test("the mobile handoff and hidden-work shelf expands upward as a bounded overlay (#440)", () => {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(
    <MobileBottomShelf total={3} leading={<button type="button">Handoff</button>}>
      <div data-testid="hidden-work">Hidden work</div>
    </MobileBottomShelf>,
  ));

  const shelf = host.querySelector('[data-testid="mobile-bottom-shelf"]') as unknown as HTMLElement;
  expect(shelf.className).toContain("relative");
  expect(shelf.className).toContain("pb-[env(safe-area-inset-bottom)]");
  expect(shelf.textContent).toContain("Handoff");

  const toggle = shelf.querySelector('button[aria-expanded="false"]') as unknown as HTMLButtonElement;
  flushSync(() => toggle.click());
  const overlay = shelf.querySelector('[data-testid="mobile-bottom-shelf-overlay"]') as unknown as HTMLElement | null;
  expect(overlay).not.toBeNull();
  expect(overlay!.className).toContain("absolute");
  expect(overlay!.className).toContain("bottom-[calc(100%+min(38dvh,20rem)+3.5rem)]");
  expect(overlay!.className).toContain("max-h-[min(30dvh,18rem)]");
  expect(overlay!.className).toContain("overflow-x-clip");
  expect(overlay!.className).toContain("overflow-y-auto");
  expect(overlay!.querySelector('[data-testid="hidden-work"]')).not.toBeNull();

  flushSync(() => root.unmount());
});
