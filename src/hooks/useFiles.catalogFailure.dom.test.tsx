import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { FILES_CHANGED_EVENT } from "@/lib/filesEvents";

/* Issue #696: a failing `/api/files` used to be indistinguishable from an idle
   installation — the rejection was swallowed, `loaded` stayed false forever and
   the retry ran flat out at 1s. These tests pin the two behaviours an operator
   notices: the failure reaches the UI as a counted, published state, and the
   retry rate is bounded. The runtime bus is stubbed off so only the hydration
   path is under test. */

mock.module("./runtimeBus", () => ({
  isRuntimeUiEnabled: () => false,
  getRuntimeBus: () => ({
    getState: () => ({ connection: "offline" }),
    subscribe: () => () => {},
    subscribeFilesRevision: () => () => {},
  }),
}));

const { resetFilesClientCacheForTests, useFiles } = await import("./useFiles");

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
});

const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetFilesClientCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  document.body.replaceChildren();
});

function Probe() {
  const data = useFiles();
  return <div>{JSON.stringify({ loaded: data.loaded, failures: data.catalogFailures })}</div>;
}

test("a failing catalog fetch publishes a counted failure instead of a silent empty list", async () => {
  globalThis.fetch = mock(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => { root.render(<Probe />); });
  await Bun.sleep(30);

  /* The consumer can now tell "the server did not answer" from "there is
     nothing to show": loaded is still false, but the failure is counted. */
  expect(host.textContent).toBe(JSON.stringify({ loaded: false, failures: 1 }));

  flushSync(() => { root.unmount(); });
  host.remove();
});

test("a recovered catalog fetch clears the failure count", async () => {
  let calls = 0;
  globalThis.fetch = mock(async () => {
    calls += 1;
    if (calls === 1) return new Response("boom", { status: 500 });
    return new Response(JSON.stringify({ files: [{ path: "/sessions/a.jsonl" }] }));
  }) as unknown as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => { root.render(<Probe />); });
  await Bun.sleep(30);
  expect(host.textContent).toContain('"failures":1');

  /* The operator's retry: the degraded state's recovery action dispatches this
     event, which cancels the pending backoff and re-hydrates now. */
  flushSync(() => { window.dispatchEvent(new Event(FILES_CHANGED_EVENT)); });
  await Bun.sleep(30);
  expect(host.textContent).toBe(JSON.stringify({ loaded: true, failures: 0 }));

  flushSync(() => { root.unmount(); });
  host.remove();
});

test("failed hydration backs off instead of retrying at a flat 1s forever", async () => {
  const at: number[] = [];
  const started = Date.now();
  globalThis.fetch = mock(async () => {
    at.push(Date.now() - started);
    return new Response("boom", { status: 500 });
  }) as unknown as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => { root.render(<Probe />); });
  /* 3.2s covers the flat-1s schedule's fourth attempt (0/1s/2s/3s) but only the
     third of the backed-off one (0/1s/3s), so the bound is what fails here if
     the doubling is removed. */
  await Bun.sleep(3_200);

  expect(at.length).toBe(3);
  expect(at[1]).toBeGreaterThanOrEqual(900);
  expect(at[2] - at[1]).toBeGreaterThanOrEqual(1_800);
  expect(host.textContent).toContain('"failures":3');

  flushSync(() => { root.unmount(); });
  host.remove();
}, 10_000);
