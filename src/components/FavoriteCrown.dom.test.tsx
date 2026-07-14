import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { FavoriteCrown } from "./FavoriteCrown";
import { FavoritesProvider, type FavoritesApi } from "./favorites/FavoritesContext";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
});

let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
});

/** A stateful stand-in for the board-backed favorites store, so a click that
    toggles through the crown actually persists in this harness's state. */
function Harness({ id }: { id: string }) {
  const [favorites, setFavorites] = useState<string[]>([]);
  const api: FavoritesApi = {
    has: (candidate) => favorites.includes(candidate),
    toggle: (candidate) =>
      setFavorites((current) => (current.includes(candidate) ? current.filter((x) => x !== candidate) : [...current, candidate])),
  };
  const ref = { current: dom.document.body as unknown as HTMLElement };
  return (
    <FavoritesProvider value={api}>
      <FavoriteCrown id={id} cardRef={ref} touch />
    </FavoritesProvider>
  );
}

function render(node: React.ReactElement): HTMLElement {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  flushSync(() => root!.render(node));
  return container as unknown as HTMLElement;
}

test("renders nothing without a favorites provider", () => {
  const ref = { current: null };
  const container = render(<FavoriteCrown id="c1" cardRef={ref} touch />);
  expect(container.querySelector("button")).toBeNull();
});

test("a touch crown starts unlit and a click toggles it to favorited and back", () => {
  const container = render(<Harness id="conv-42" />);
  const button = () => container.querySelector("button")!;
  expect(button().getAttribute("aria-pressed")).toBe("false");
  expect(button().getAttribute("data-favorite-crown")).toBe("off");

  flushSync(() => button().click());
  expect(button().getAttribute("aria-pressed")).toBe("true");
  expect(button().getAttribute("data-favorite-crown")).toBe("on");
  expect(button().className).toContain("is-favorite");

  flushSync(() => button().click());
  expect(button().getAttribute("aria-pressed")).toBe("false");
  expect(button().getAttribute("data-favorite-crown")).toBe("off");
});
