import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { PipelineDialog } from "./PipelineDialog";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
});

/** Let queued microtasks + the effect's fetch settle and React re-render. */
async function settle() {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
});

test("a failed role catalog fetch surfaces an error with a retry", async () => {
  let roleFetches = 0;
  /* /api/roles rejects; /api/spawn resolves empty so only the role path fails. */
  globalThis.fetch = (async (input: string) => {
    const url = String(input);
    if (url.startsWith("/api/roles")) {
      roleFetches += 1;
      throw new Error("network down");
    }
    return { ok: true, json: async () => ({ dirs: [], cwd: null }) } as Response;
  }) as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  flushSync(() => { root.render(<PipelineDialog project="proj" onClose={() => {}} />); });
  await settle();
  flushSync(() => {});

  const body = document.body.textContent ?? "";
  expect(roleFetches).toBe(1);
  expect(body).toContain("Couldn't load the role catalog");
  /* The retry affordance is present and re-runs the fetch when pressed. */
  const retry = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Retry") as HTMLButtonElement | undefined;
  expect(retry).toBeTruthy();
  flushSync(() => { retry!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
  await settle();
  expect(roleFetches).toBe(2);

  flushSync(() => { root.unmount(); });
  host.remove();
});

test("the modal focuses in, inerts the background, and restores focus on close", async () => {
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ roles: [], dirs: [], cwd: null }) }) as Response) as unknown as typeof fetch;

  /* A background control the operator's focus was on before opening. */
  const opener = document.createElement("button");
  opener.textContent = "opener";
  document.body.append(opener);
  opener.focus();
  expect(document.activeElement).toBe(opener);

  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  flushSync(() => { root.render(<PipelineDialog project="proj" onClose={() => {}} />); });
  await settle();

  /* Focus entered the dialog (task field), and the background opener is inert. */
  const taskInput = document.querySelector('input[placeholder="Describe what this chain should accomplish"]')
    ?? Array.from(document.querySelectorAll("input"))[0];
  expect(document.activeElement).toBe(taskInput as Element);
  expect(opener.hasAttribute("inert")).toBe(true);

  flushSync(() => { root.unmount(); });
  /* Closing lifts inert and returns focus to the opener. */
  expect(opener.hasAttribute("inert")).toBe(false);
  expect(document.activeElement).toBe(opener);
  host.remove();
  opener.remove();
});
