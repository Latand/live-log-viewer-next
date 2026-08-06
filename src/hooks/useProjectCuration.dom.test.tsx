import { afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useProjectCuration, type UseProjectCuration } from "./useProjectCuration";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
});

const originalFetch = globalThis.fetch;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
  globalThis.fetch = originalFetch;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function renderHook(): Promise<() => UseProjectCuration> {
  let current: UseProjectCuration | null = null;
  function Harness() {
    current = useProjectCuration([], []);
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness />); });
  return () => {
    if (!current) throw new Error("curation hook is not mounted");
    return current;
  };
}

test("rapid crown choices serialize per project and persist in click order", async () => {
  const responses = [deferred<Response>(), deferred<Response>()];
  const requests: Array<{ project: string; crowned: boolean }> = [];
  globalThis.fetch = mock((_, init) => {
    requests.push(JSON.parse(String(init?.body)) as { project: string; crowned: boolean });
    return responses[requests.length - 1]!.promise;
  }) as unknown as typeof fetch;
  const hook = await renderHook();

  await act(async () => {
    hook().toggleCrown("viewer", true);
    hook().toggleCrown("viewer", false);
    await Promise.resolve();
  });

  expect(requests).toEqual([{ project: "viewer", crowned: true }]);
  expect(hook().crownedProjects.has("viewer")).toBe(false);

  await act(async () => {
    responses[0]!.resolve(new Response(null, { status: 200 }));
    await responses[0]!.promise;
    await Promise.resolve();
  });
  expect(requests).toEqual([
    { project: "viewer", crowned: true },
    { project: "viewer", crowned: false },
  ]);

  await act(async () => {
    responses[1]!.resolve(new Response(null, { status: 200 }));
    await responses[1]!.promise;
  });
});
