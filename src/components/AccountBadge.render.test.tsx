import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AccountBadge } from "./AccountBadge";

// Server render assumes desktop (useIsMobile → false), so these exercise the
// chip variant; the account store has no accounts server-side, so the Hint
// falls back to the health-free label.

test("desktop chip shows the @-prefixed account id and a deterministic hue dot", () => {
  const html = renderToStaticMarkup(<AccountBadge engine="claude" accountId="botfatherdev-2" />);
  expect(html).toContain("@ botfatherdev-2");
  // The leading dot's fill is a color-mix over a theme token — never a raw hex.
  expect(html).toContain("color-mix(in srgb, hsl(");
  expect(html).not.toMatch(/background-color:\s*#/i);
});

test("the full id, engine, and open affordance ride in the Hint / aria label", () => {
  const html = renderToStaticMarkup(<AccountBadge engine="codex" accountId="terra" />);
  expect(html).toContain("Account terra · Codex");
  expect(html).toContain("Open accounts for terra");
});

test("a long account id truncates to ~14ch with an ellipsis", () => {
  const html = renderToStaticMarkup(<AccountBadge engine="claude" accountId="an-extremely-long-account-id" />);
  expect(html).toContain("an-extremely-…");
  expect(html).not.toContain("an-extremely-long-account-id<");
});

test("the default home renders @ default", () => {
  const html = renderToStaticMarkup(<AccountBadge engine="claude" accountId="default" />);
  expect(html).toContain("@ default");
});
