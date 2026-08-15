import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";
import type { LimitsPayload } from "@/lib/types";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.Event,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  localStorage: dom.localStorage,
});

const NOW = Math.round(Date.now() / 1000);

let limits: LimitsPayload;
const baseAccount = {
  id: "account-a",
  label: "Account A",
  kind: "managed",
  authPresent: true,
  auth: { state: "authenticated" },
  loginPending: false,
  loginState: "authenticated",
  deviceAuth: null,
  effective: { percent: 79, window: "weekly", freshness: "fresh" },
  limits: {
    state: "fresh",
    session: null,
    weekly: { usedPercent: 21, resetsAt: NOW + 6 * 86_400, windowMinutes: 10_080 },
    checkedAt: new Date((NOW - 60) * 1000).toISOString(),
  },
};
const accounts = {
  codex: { active: "account-a", accounts: [baseAccount] },
  claude: { active: "claude-a", accounts: [] },
};

// Bound before the component is imported so the singleton account stores read
// this stub rather than the real endpoints.
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url === "/api/limits") return Response.json(limits);
  if (url === "/api/accounts") return Response.json(accounts);
  return new Response(null, { status: 404 });
}) as unknown as typeof fetch;

const { LimitsFooter } = await import("./LimitsFooter");

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
  accounts.codex.accounts = [baseAccount];
});

async function render(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<LimitsFooter />);
  });
  // One more turn for the limits and accounts responses to land.
  await act(async () => { await Promise.resolve(); });
  return host;
}

test("a weekly-horizon Codex window is labelled Week in the footer, never 5h", async () => {
  // The production shape of #606: the only window the plan reports is a weekly
  // one, and it arrives in the session field. The footer row must be named by
  // the horizon the number carries.
  limits = {
    claude: null,
    codex: { session: { usedPercent: 15, resetsAt: NOW + 437_631, windowMinutes: 10_080 }, weekly: null, plan: "pro", capturedAt: NOW },
    claudeAccountId: "claude-a",
    codexAccountId: "account-a",
    provenance: {
      claude: { source: "unavailable", reason: null, staleSince: null },
      codex: { source: "live", reason: null, staleSince: null },
    },
    staleSince: null,
  };
  const host = await render();
  const text = host.textContent ?? "";
  expect(text).toContain("Week");
  expect(text).not.toContain("5h");
  expect(text).toContain("85%"); // 100 − 15 remaining, under the weekly label
});

test("a genuine 5-hour window keeps the 5h label", async () => {
  limits = {
    claude: null,
    codex: { session: { usedPercent: 40, resetsAt: NOW + 3_600, windowMinutes: 300 }, weekly: { usedPercent: 10, resetsAt: NOW + 172_800, windowMinutes: 10_080 }, plan: "pro", capturedAt: NOW },
    claudeAccountId: "claude-a",
    codexAccountId: "account-a",
    provenance: {
      claude: { source: "unavailable", reason: null, staleSince: null },
      codex: { source: "live", reason: null, staleSince: null },
    },
    staleSince: null,
  };
  const host = await render();
  const text = host.textContent ?? "";
  expect(text).toContain("5h");
  expect(text).toContain("Week");
});

test("provider exhaustion reconciles the header chip and weekly row to zero", async () => {
  accounts.codex.accounts = [{
    ...baseAccount,
    effective: { percent: 79, window: "weekly", freshness: "fresh" },
    limits: {
      state: "fresh",
      session: null,
      weekly: { usedPercent: 21, resetsAt: NOW + 6 * 86_400, windowMinutes: 10_080 },
      checkedAt: new Date((NOW - 60) * 1000).toISOString(),
    },
  }];
  limits = {
    claude: null,
    codex: { session: null, weekly: { usedPercent: 100, resetsAt: NOW + 6 * 86_400, windowMinutes: 10_080 }, plan: "prolite", capturedAt: NOW - 600 },
    claudeAccountId: "claude-a",
    codexAccountId: "account-a",
    provenance: {
      claude: { source: "unavailable", reason: null, staleSince: null },
      codex: { source: "transcript", reason: "transcript-reconciled", staleSince: null },
    },
  };

  const host = await render();
  const text = host.textContent ?? "";
  expect(text).not.toContain("79%");
  expect(text.match(/0%/g)?.length ?? 0).toBeGreaterThanOrEqual(2);

  const trigger = [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.includes("Codex"));
  expect(trigger).toBeDefined();
  await act(async () => { trigger?.click(); });
  const dialog = host.querySelector('[role="dialog"][aria-label*="Codex"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.textContent).not.toContain("79%");
  expect(dialog?.textContent).toContain("0%");
});

test("a stale reconciled number renders a visible as-of hint", async () => {
  limits = {
    claude: null,
    codex: { session: null, weekly: { usedPercent: 100, resetsAt: NOW + 6 * 86_400, windowMinutes: 10_080 }, plan: "prolite", capturedAt: NOW - 30 * 60 },
    claudeAccountId: "claude-a",
    codexAccountId: "account-a",
    provenance: {
      claude: { source: "unavailable", reason: null, staleSince: null },
      codex: { source: "transcript", reason: "transcript-reconciled", staleSince: null },
    },
  };

  const host = await render();
  expect(host.textContent).toContain("as of");
});

test("an account B limits payload cannot override account A at the rendering seam", async () => {
  limits = {
    claude: null,
    codex: { session: null, weekly: { usedPercent: 100, resetsAt: NOW + 6 * 86_400, windowMinutes: 10_080 }, plan: "prolite", capturedAt: NOW - 60 },
    claudeAccountId: "claude-a",
    codexAccountId: "account-b",
    provenance: {
      claude: { source: "unavailable", reason: null, staleSince: null },
      codex: { source: "transcript", reason: "transcript-reconciled", staleSince: null },
    },
  };

  const host = await render();
  const text = host.textContent ?? "";
  expect(text).toContain("79%");
  expect(text).not.toContain("0%");
});
