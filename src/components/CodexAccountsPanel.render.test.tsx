import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { CodexAccountsState } from "@/hooks/useCodexAccounts";

import { CodexAccountsPanel } from "./CodexAccountsPanel";

const state: CodexAccountsState = {
  accounts: [{ id: "work", label: "Work", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null }],
  active: "work",
  identityVersion: 0,
  status: "ready",
  notice: null,
  challenge: null,
  mutation: null,
  refresh: async () => true,
  select: async () => true,
  add: async () => true,
  retryNotice: async () => true,
};

const render = () => renderToStaticMarkup(<CodexAccountsPanel state={state} onClose={() => {}} />);

// Finding 4: on mobile the sheet lives inside the project drawer, whose scrim
// closes the drawer on tap. A dedicated, mobile-only backdrop must sit between
// the scrim and the sheet so an outside tap closes only the sheet — the drawer
// never sees the gesture. Desktop is a flyout beside the rail with no drawer, so
// the backdrop must not render there.
test("the panel renders a mobile-only backdrop separate from the dialog", () => {
  const html = render();
  expect(html).toContain("sm:hidden");
  expect(html).toContain("fixed inset-0");
  // Exactly one dialog; the backdrop is its own element, not the dialog.
  expect(html.match(/role="dialog"/g)?.length).toBe(1);
});

test("the backdrop precedes the dialog so it intercepts the outside tap", () => {
  const html = render();
  const backdropAt = html.indexOf("sm:hidden");
  const dialogAt = html.indexOf('role="dialog"');
  expect(backdropAt).toBeGreaterThanOrEqual(0);
  expect(dialogAt).toBeGreaterThanOrEqual(0);
  expect(backdropAt).toBeLessThan(dialogAt);
});

test("the dialog itself stays visible on desktop (only the backdrop is mobile-only)", () => {
  const html = render();
  const dialogTag = html.slice(html.indexOf('role="dialog"'));
  const dialogClass = dialogTag.slice(0, dialogTag.indexOf(">"));
  expect(dialogClass).not.toContain("sm:hidden");
});

test("device-login success guidance omits a Retry action", () => {
  const html = renderToStaticMarkup(<CodexAccountsPanel state={{
    ...state,
    notice: { kind: "success", operation: "add", messageKey: "accounts.loginOpened", target: "codex-login", action: null },
  }} onClose={() => {}} />);
  expect(html).toContain("Device login opened in codex-login");
  expect(html).not.toContain(">Retry<");
});
