import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CodexAccountSwitch } from "./CodexAccountSwitch";

/**
 * The Switchboard's Codex control is now one trigger that opens the canonical
 * AccountsPanel — the same preview → confirm → migrate surface as the limits
 * footer. It must never fall back to the legacy `<select>` (a mode-less bare
 * switch), so both account surfaces share one behavior (issue #40).
 */
const render = () => renderToStaticMarkup(<CodexAccountSwitch />);

test("renders a single dialog trigger and no bare <select> switch", () => {
  const html = render();
  expect(html).not.toContain("<select");
  expect(html).not.toContain("<option");
  expect(html).toContain('aria-haspopup="dialog"');
});

test("the trigger stays mounted with no accounts so Accounts is always reachable", () => {
  // The shared store starts empty (no fetch runs under static render); the
  // trigger keeps showing the fallback Accounts label and stays mounted.
  const html = render();
  expect(html).toContain("Accounts");
  expect(html).toContain("<button");
});
