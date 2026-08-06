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

async function renderHook(initialCrowned: readonly string[] = []): Promise<{
  current: () => UseProjectCuration;
  rerender: (serverCrowned: readonly string[]) => Promise<void>;
}> {
  let current: UseProjectCuration | null = null;
  let pollRequestId = 0;
  function Harness({ serverCrowned }: { serverCrowned: readonly string[] }) {
    current = useProjectCuration(serverCrowned, []);
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness serverCrowned={initialCrowned} />); });
  return {
    current: () => {
      if (!current) throw new Error("curation hook is not mounted");
      return current;
    },
    rerender: async (serverCrowned) => {
      const requestId = ++pollRequestId;
      await act(async () => {
        window.dispatchEvent(new dom.CustomEvent("llv:files-revalidation-started", {
          detail: { requestId },
        }) as unknown as Event);
        root!.render(<Harness serverCrowned={serverCrowned} />);
        window.dispatchEvent(new dom.CustomEvent("llv:files-revalidated", {
          detail: { requestId, crownedProjects: serverCrowned },
        }) as unknown as Event);
      });
    },
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
    hook.current().toggleCrown("viewer", true);
    hook.current().toggleCrown("viewer", false);
    await Promise.resolve();
  });

  expect(requests).toEqual([{ project: "viewer", crowned: true }]);
  expect(hook.current().crownedProjects.has("viewer")).toBe(false);

  /* A poll matching the latest optimistic choice predates both queued writes;
     it cannot acknowledge the still-pending uncrown. */
  await hook.rerender([]);
  expect(hook.current().crownedProjects.has("viewer")).toBe(false);

  await act(async () => {
    responses[0]!.resolve(new Response(null, { status: 200 }));
    await responses[0]!.promise;
    await Promise.resolve();
  });
  expect(requests).toEqual([
    { project: "viewer", crowned: true },
    { project: "viewer", crowned: false },
  ]);

  /* The first request is durable while the uncrown remains in flight. The
     server may report that intermediate crown without changing the UI choice. */
  await hook.rerender(["viewer"]);
  expect(hook.current().crownedProjects.has("viewer")).toBe(false);

  await act(async () => {
    responses[1]!.resolve(new Response(null, { status: 200 }));
    await responses[1]!.promise;
  });

  await hook.rerender(["viewer"]);
  expect(hook.current().crownedProjects.has("viewer")).toBe(false);
  await hook.rerender([]);
  await hook.rerender(["viewer"]);
  expect(hook.current().crownedProjects.has("viewer")).toBe(true);
});

test("a successful equal-value poll acknowledges the latest queued crown choice", async () => {
  const responses = [deferred<Response>(), deferred<Response>()];
  let request = 0;
  globalThis.fetch = mock(() => responses[request++]!.promise) as unknown as typeof fetch;
  const uncrowned: readonly string[] = [];
  const hook = await renderHook(uncrowned);

  await act(async () => {
    hook.current().toggleCrown("viewer", true);
    hook.current().toggleCrown("viewer", false);
    await Promise.resolve();
  });
  await act(async () => {
    responses[0]!.resolve(new Response(null, { status: 200 }));
    await responses[0]!.promise;
    await Promise.resolve();
    responses[1]!.resolve(new Response(null, { status: 200 }));
    await responses[1]!.promise;
  });

  await act(async () => {
    window.dispatchEvent(new dom.CustomEvent("llv:files-revalidation-started", {
      detail: { requestId: 1 },
    }) as unknown as Event);
    window.dispatchEvent(new dom.CustomEvent("llv:files-revalidated", {
      detail: { requestId: 1, crownedProjects: uncrowned },
    }) as unknown as Event);
  });
  await hook.rerender(uncrowned);
  await hook.rerender(["viewer"]);
  expect(hook.current().crownedProjects.has("viewer")).toBe(true);
});

test("a poll started before the latest crown success cannot acknowledge it", async () => {
  const responses = [deferred<Response>(), deferred<Response>()];
  let request = 0;
  globalThis.fetch = mock(() => responses[request++]!.promise) as unknown as typeof fetch;
  const hook = await renderHook([]);

  await act(async () => {
    hook.current().toggleCrown("viewer", true);
    hook.current().toggleCrown("viewer", false);
    await Promise.resolve();
    window.dispatchEvent(new dom.CustomEvent("llv:files-revalidation-started", {
      detail: { requestId: 1 },
    }) as unknown as Event);
    responses[0]!.resolve(new Response(null, { status: 200 }));
    await responses[0]!.promise;
    await Promise.resolve();
    responses[1]!.resolve(new Response(null, { status: 200 }));
    await responses[1]!.promise;
    window.dispatchEvent(new dom.CustomEvent("llv:files-revalidated", {
      detail: { requestId: 1, crownedProjects: [] },
    }) as unknown as Event);
  });

  await hook.rerender(["viewer"]);
  expect(hook.current().crownedProjects.has("viewer")).toBe(false);
  await hook.rerender([]);
  await hook.rerender(["viewer"]);
  expect(hook.current().crownedProjects.has("viewer")).toBe(true);
});
