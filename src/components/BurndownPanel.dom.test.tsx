import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";
import type { BurndownPayload, BurndownSeries } from "@/lib/types";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  MouseEvent: dom.MouseEvent,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  localStorage: dom.localStorage,
});

const { BurndownPanel } = await import("./BurndownPanel");

const NOW = Math.round(Date.now() / 1000);

let payload: BurndownPayload;
globalThis.fetch = (async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

/** A weekly series with real history, as the Codex backfill produces it. */
function weeklySeries(): BurndownSeries {
  return {
    windowStart: NOW - 5 * 86_400,
    resetsAt: NOW + 2 * 86_400,
    windowSeconds: 7 * 24 * 3600,
    samples: [
      { t: NOW - 7_200, remaining: 70 },
      { t: NOW - 3_600, remaining: 55 },
      { t: NOW, remaining: 48 },
    ],
  };
}

/** The horizon the plan does not report at all: nothing to chart, ever. */
function unreportedSeries(windowSeconds: number): BurndownSeries {
  return { windowStart: null, resetsAt: null, windowSeconds, samples: [], windowUnreported: true };
}

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
});

async function render(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<BurndownPanel engine="codex" label="Codex" plan="pro" activeAccountId="account-a" onClose={() => {}} />);
  });
  return host;
}

/** Paths drawn inside the plot itself; the panel's close icon is an svg too. */
function chartPaths(host: HTMLElement): number {
  const chart = host.querySelector('svg[role="img"]');
  return chart ? chart.querySelectorAll("path").length : 0;
}

function tab(host: HTMLElement, name: string): HTMLElement {
  const found = [...host.querySelectorAll('[role="tab"]')].find((node) => (node.textContent ?? "").trim() === name);
  if (!found) throw new Error(`no tab labelled ${name} among ${[...host.querySelectorAll('[role="tab"]')].map((n) => n.textContent).join(", ")}`);
  return found as unknown as HTMLElement;
}

test("a Codex account with weekly history draws the weekly curve instead of claiming no history", async () => {
  payload = {
    claude: null,
    codex: { session: unreportedSeries(5 * 3600), weekly: weeklySeries() },
    claudeAccountId: null,
    codexAccountId: "account-a",
    historySince: new Date((NOW - 8 * 86_400) * 1000).toISOString(),
  };
  const host = await render();
  // Two drawn paths inside the plot: the ideal diagonal and the actual curve.
  expect(chartPaths(host)).toBe(2);
  expect(host.textContent ?? "").not.toContain("No history yet");
});

test("the 5h tab names the missing window instead of showing a generic empty state", async () => {
  payload = {
    claude: null,
    codex: { session: unreportedSeries(5 * 3600), weekly: weeklySeries() },
    claudeAccountId: null,
    codexAccountId: "account-a",
    historySince: new Date((NOW - 8 * 86_400) * 1000).toISOString(),
  };
  const host = await render();
  await act(async () => { tab(host, "5h").click(); });
  const text = host.textContent ?? "";
  expect(text).toContain("reports no 5h window");
  expect(text).not.toContain("No history yet");
  expect(chartPaths(host)).toBe(0);
});

test("each tab is named by the horizon its own series carries", async () => {
  // A series whose window is a week long is labelled "Week" wherever it sits,
  // so a weekly-horizon value is never presented as a 5-hour figure (#606).
  payload = {
    claude: null,
    codex: { session: { ...weeklySeries(), windowSeconds: 7 * 24 * 3600 }, weekly: weeklySeries() },
    claudeAccountId: null,
    codexAccountId: "account-a",
    historySince: null,
  };
  const host = await render();
  const labels = [...host.querySelectorAll('[role="tab"]')].map((node) => (node.textContent ?? "").trim());
  expect(labels).toEqual(["Week", "Week"]);
});

test("a history response for another account is not charted under this one", async () => {
  payload = {
    claude: null,
    codex: { session: unreportedSeries(5 * 3600), weekly: weeklySeries() },
    claudeAccountId: null,
    codexAccountId: "account-b",
    historySince: null,
  };
  const host = await render();
  expect(host.textContent ?? "").toContain("Loading history…");
  expect(chartPaths(host)).toBe(0);
});
