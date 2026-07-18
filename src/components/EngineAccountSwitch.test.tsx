import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { EngineAccountSwitch } from "./EngineAccountSwitch";

/**
 * The Switchboard header carries one quick-switch trigger per engine (issue
 * #40), each opening the canonical AccountsPanel — the same direct account
 * selection, add-account, and sign-in surface the limits footer uses.
 */
const render = (engine: "claude" | "codex") => renderToStaticMarkup(<EngineAccountSwitch engine={engine} />);

test("each engine renders a dialog trigger named for its engine, with no bare <select> switch", () => {
  const claude = render("claude");
  const codex = render("codex");
  expect(claude).toContain('aria-haspopup="dialog"');
  expect(codex).toContain('aria-haspopup="dialog"');
  expect(claude).toContain("Claude");
  expect(codex).toContain("Codex");
  expect(claude).not.toContain("<select");
  expect(codex).not.toContain("<option");
});

test("the accessible name carries the engine and the current account selection", () => {
  // The shared store starts empty under static render, so the current-selection
  // slot shows the recoverable Accounts fallback — never an empty name.
  expect(render("claude")).toContain('aria-label="Claude accounts — switch or add — Accounts"');
  expect(render("codex")).toContain('aria-label="Codex accounts — switch or add — Accounts"');
});

test("the trigger stays mounted with no accounts so Accounts is always reachable", () => {
  const html = render("claude");
  expect(html).toContain("Accounts");
  expect(html).toContain("<button");
});
