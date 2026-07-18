import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { useActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import { translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

/* Finding 4/5: dead-host recovery must never swallow a failure. Re-check routes
   through the runtime-bus refresh (so a recovered host actually clears the
   banner) and surfaces a failed refresh; Respawn surfaces a non-2xx/network
   failure instead of appearing to complete. `refreshRuntime` is mocked and
   `fetch` is stubbed to exercise both paths. */

let refreshResult = true;
let refreshCalls = 0;
const actual = await import("@/hooks/useRuntime");
mock.module("@/hooks/useRuntime", () => ({
  ...actual,
  refreshRuntime: () => { refreshCalls += 1; return Promise.resolve(refreshResult); },
}));

const { DeadHostBanner } = await import("./DeadHostBanner");

const dom = new Window();
useActEnv();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
});

const file: FileEntry = {
  path: "/c.jsonl", root: "codex-sessions", name: "c.jsonl", project: "viewer", title: "c",
  engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1, size: 1,
  activity: "idle", proc: null, pid: null, model: "gpt", effort: "high", fast: false,
  pendingQuestion: null, waitingInput: null,
} as FileEntry;

const realFetch = globalThis.fetch;
afterEach(() => { refreshResult = true; refreshCalls = 0; globalThis.fetch = realFetch; document.body.replaceChildren(); });

async function mount(): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<DeadHostBanner file={file} />));
  return { host, root };
}

const byLabel = (host: HTMLElement, key: Parameters<typeof translate>[1]) =>
  [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(translate("en", key)))!;

const click = async (button: HTMLButtonElement) => {
  await act(async () => {
    button.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event);
    await new Promise((r) => setTimeout(r, 0));
  });
};

test("Re-check calls the runtime-bus refresh (not a discarded snapshot fetch)", async () => {
  const { host, root } = await mount();
  await click(byLabel(host, "deadHost.recheck"));
  expect(refreshCalls).toBe(1);
  await act(async () => root.unmount());
});

test("a failed refresh shows the error alert", async () => {
  refreshResult = false;
  const { host, root } = await mount();
  await click(byLabel(host, "deadHost.recheck"));
  const alerts = [...host.querySelectorAll('[role="alert"]')].map((n) => n.textContent ?? "");
  expect(alerts.some((text) => text.includes(translate("en", "deadHost.recheckFailed")))).toBe(true);
  await act(async () => root.unmount());
});

test("a non-2xx respawn surfaces the failure instead of silently completing", async () => {
  globalThis.fetch = ((url: string) => {
    void url;
    return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ error: "no pane to resume" }) } as unknown as Response);
  }) as typeof fetch;
  const { host, root } = await mount();
  await click(byLabel(host, "deadHost.respawn"));
  const alerts = [...host.querySelectorAll('[role="alert"]')].map((n) => n.textContent ?? "");
  expect(alerts.some((text) => text.includes("no pane to resume"))).toBe(true);
  await act(async () => root.unmount());
});

test("a respawn network error surfaces the localized failure", async () => {
  globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
  const { host, root } = await mount();
  await click(byLabel(host, "deadHost.respawn"));
  const alerts = [...host.querySelectorAll('[role="alert"]')].map((n) => n.textContent ?? "");
  expect(alerts.some((text) => text.includes(translate("en", "deadHost.respawnFailed")))).toBe(true);
  await act(async () => root.unmount());
});
