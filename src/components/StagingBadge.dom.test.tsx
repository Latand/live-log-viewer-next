import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";

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
  localStorage: dom.localStorage,
});

const { StagingBadge } = await import("./StagingBadge");

let payload: Record<string, unknown> = { staging: false, revision: null, deployedAt: null, endpoint: null };
globalThis.fetch = (async () =>
  new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })
) as typeof fetch;

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
    root.render(<StagingBadge />);
  });
  return host;
}

test("a staging instance shows the staging badge with its deployed revision", async () => {
  payload = { staging: true, revision: "e".repeat(40), deployedAt: "2026-07-24T12:00:00.000Z", endpoint: "http://127.0.0.1:8899" };
  const host = await render();
  const badge = host.querySelector("[data-staging-badge]");
  expect(badge).not.toBeNull();
  expect(badge?.textContent ?? "").toContain("Staging");
  expect(badge?.textContent ?? "").toContain("e".repeat(7));
});

test("a production instance renders no staging badge", async () => {
  payload = { staging: false, revision: null, deployedAt: null, endpoint: null };
  const host = await render();
  expect(host.querySelector("[data-staging-badge]")).toBeNull();
});
