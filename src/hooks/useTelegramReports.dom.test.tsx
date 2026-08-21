import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import type { TelegramReportsPayload } from "@/lib/telegram/reportContracts";

import { useTelegramReports, type TelegramReportsState } from "./useTelegramReports";

/**
 * Saving the analyst brief must report the outcome the SERVER gave (#1086
 * critique). A save the panel accepts on the client's behalf is the one bug
 * that cannot be seen from the panel: the operator rewrites the brief, the
 * request fails, the editor looks unchanged, and the next run uses the old text.
 */

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
});

const originalFetch = globalThis.fetch;
let root: Root | null = null;
let latest: TelegramReportsState | null = null;

function Harness() {
  const state = useTelegramReports(true);
  useEffect(() => { latest = state; }, [state]);
  return null;
}

async function mount(): Promise<void> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Harness />);
    await Bun.sleep(0);
  });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  latest = null;
  globalThis.fetch = originalFetch;
  document.body.replaceChildren();
});

const payload = (promptIsDefault: boolean): TelegramReportsPayload => ({
  settings: { enabled: true, time: "10:00", groups: [], promptIsDefault },
  history: [],
  nextRunAt: "2026-08-22T07:00:00.000Z",
});

/** GET list → GET prompt → POST save, in the order the editor makes them. */
function serve(save: Response): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    if ((init?.method ?? "GET") === "POST") return save;
    if (url.includes("prompt=1")) {
      return new Response(JSON.stringify({ prompt: "Write it in Ukrainian.", defaultPrompt: "Write one report." }), { status: 200 });
    }
    return new Response(JSON.stringify({ reports: payload(true) }), { status: 200 });
  }) as unknown as typeof fetch;
}

test("a rejected prompt save keeps the editor open and announces the failure", async () => {
  serve(new Response(JSON.stringify({ code: "action_failed" }), { status: 500 }));
  await mount();
  await act(async () => { await latest!.loadPrompt(); });
  expect(latest?.prompt?.prompt).toBe("Write it in Ukrainian.");

  await act(async () => { await latest!.savePrompt("Пиши звіт українською."); });
  /* The editor is still open — its textarea still holds the operator's text —
     and the section has a failure to render above it. */
  expect(latest?.prompt).not.toBeNull();
  expect(latest?.failure?.code).toBe("action_failed");
});

test("a save the server never answered is a transport failure, not a silent success", async () => {
  serve(new Response("", { status: 200 }));
  await mount();
  await act(async () => { await latest!.loadPrompt(); });
  globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;

  await act(async () => { await latest!.savePrompt("Пиши звіт українською."); });
  expect(latest?.prompt).not.toBeNull();
  expect(latest?.failure?.code).toBe("transport");
});

test("an accepted save closes the editor and takes the settings the save returned", async () => {
  serve(new Response(JSON.stringify({ reports: payload(false) }), { status: 200 }));
  await mount();
  await act(async () => { await latest!.loadPrompt(); });

  await act(async () => { await latest!.savePrompt("Пиши звіт українською."); });
  expect(latest?.prompt).toBeNull();
  expect(latest?.failure).toBeNull();
  /* Back on the settings view, the prompt row reads from the server's own
     answer — the acknowledgement is that state, not a client-side guess. */
  expect(latest?.reports?.settings.promptIsDefault).toBe(false);
});
