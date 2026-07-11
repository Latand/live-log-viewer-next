import { afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { FLOWS_CHANGED_EVENT } from "@/components/flows/flowModel";

let revisionListener: ((revision: number) => void) | null = null;

mock.module("./runtimeBus", () => ({
  isRuntimeUiEnabled: () => true,
  getRuntimeBus: () => ({
    getState: () => ({ connection: "live" }),
    subscribe: () => () => {},
    subscribeFilesRevision: (listener: (revision: number) => void) => {
      revisionListener = listener;
      return () => { revisionListener = null; };
    },
  }),
}));

const { useFiles } = await import("./useFiles");
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

afterEach(() => {
  globalThis.fetch = originalFetch;
  revisionListener = null;
  document.body.replaceChildren();
});

function Probe() {
  const data = useFiles();
  return <div>{data.files[0]?.path ?? "empty"}</div>;
}

test("a failed live revision hydration retries without another revision event", async () => {
  let calls = 0;
  globalThis.fetch = mock(async () => {
    calls += 1;
    if (calls === 2) throw new Error("transient files failure");
    const path = calls === 1 ? "/sessions/old.jsonl" : "/sessions/new.jsonl";
    return new Response(JSON.stringify({ files: [{ path }] }), {
      headers: { ETag: `"${calls}"` },
    });
  }) as unknown as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => { root.render(<Probe />); });
  await Bun.sleep(20);
  expect(host.textContent).toBe("/sessions/old.jsonl");

  revisionListener?.(7);
  await Bun.sleep(450);
  expect(calls).toBe(2);

  await Bun.sleep(1_100);
  expect(calls).toBe(3);
  expect(host.textContent).toBe("/sessions/new.jsonl");
  flushSync(() => { root.unmount(); });
  host.remove();
});

test("a delayed ordinary refresh cannot overwrite a newer revision hydration", async () => {
  let calls = 0;
  let resolveLate!: (response: Response) => void;
  globalThis.fetch = mock(async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ files: [{ path: "/sessions/initial.jsonl" }] }));
    }
    if (calls === 2) {
      return new Promise<Response>((resolve) => { resolveLate = resolve; });
    }
    return new Response(JSON.stringify({ files: [{ path: "/sessions/fresh-revision.jsonl" }] }));
  }) as unknown as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => { root.render(<Probe />); });
  await Bun.sleep(20);
  expect(host.textContent).toBe("/sessions/initial.jsonl");

  window.dispatchEvent(new dom.Event(FLOWS_CHANGED_EVENT) as unknown as Event);
  await Promise.resolve();
  expect(calls).toBe(2);
  revisionListener?.(8);
  await Bun.sleep(450);

  resolveLate(new Response(JSON.stringify({ files: [{ path: "/sessions/stale-late.jsonl" }] })));
  await Bun.sleep(30);
  expect(calls).toBe(3);
  expect(host.textContent).toBe("/sessions/fresh-revision.jsonl");
  flushSync(() => { root.unmount(); });
  host.remove();
});
