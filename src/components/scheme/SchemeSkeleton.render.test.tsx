import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SchemeSkeleton } from "./SchemeSkeleton";

test("the board skeleton announces politely and is marked busy (#172)", () => {
  const html = renderToStaticMarkup(<SchemeSkeleton />);
  expect(html).toContain('role="status"');
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain('aria-live="polite"');
  /* A localized label rather than a leftover interpolation token. */
  expect(html).toContain("Loading the board");
  expect(html).not.toContain("{");
});

test("the skeleton reflows responsively and stays reduced-motion safe", () => {
  const html = renderToStaticMarkup(<SchemeSkeleton />);
  /* Auto-fill columns with a shared minimum keep the placeholder from jumping
     between a 390px phone and a wide desktop, and the body never scrolls
     sideways (overflow hidden). */
  expect(html).toContain("auto-fill");
  expect(html).toContain("overflow-hidden");
  /* The pulse yields to prefers-reduced-motion. */
  expect(html).toContain("animate-pulse");
  expect(html).toContain("motion-reduce:animate-none");
});
