import { afterEach, beforeEach, expect, mock, test } from "bun:test";
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

const {
  applyPipelineSnapshot,
  resetFilesClientCacheForTests,
  revertPipelineSnapshot,
  useFiles,
} = await import("./useFiles");
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
  revisionListener = null;
  document.body.replaceChildren();
});

function Probe() {
  const data = useFiles();
  return <div data-loaded={String(data.loaded)}>{data.files[0]?.path ?? "empty"}</div>;
}

function ScopedProbe({ pinnedPath }: { pinnedPath?: string }) {
  const data = useFiles(undefined, pinnedPath);
  return <div>{JSON.stringify({
    files: data.files.map((entry) => entry.path),
    pins: data.pinOverlayPaths,
    scope: data.requestScope,
    task: data.pipelines[0]?.task ?? "",
  })}</div>;
}

function pipelineRow(task: string) {
  return { id: "p1", task, project: "project-a", state: "draft", stages: [], runs: [], cursor: null, hiddenAt: null };
}

test("concurrent pinned and global hooks keep their scopes through local pipeline apply and revert", async () => {
  const pinnedPath = "/archive/dom-scoped-pin.jsonl";
  let fetches = 0;
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    fetches += 1;
    const url = String(input);
    const pinned = url !== "/api/files";
    return new Response(JSON.stringify({
      files: pinned ? [{ path: "/global" }, { path: pinnedPath }] : [{ path: "/global" }],
      pinOverlayPaths: pinned ? [pinnedPath] : [],
      pipelines: [pipelineRow("server")],
    }));
  }) as unknown as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => {
    root.render(<>
      <ScopedProbe pinnedPath={pinnedPath} />
      <ScopedProbe />
    </>);
  });
  await Bun.sleep(30);

  applyPipelineSnapshot(pipelineRow("patched") as never, false);
  await Bun.sleep(0);
  expect(fetches).toBe(2);
  expect(host.children[0]?.textContent).toBe(JSON.stringify({
    files: ["/global", pinnedPath],
    pins: [pinnedPath],
    scope: `/api/files?path=${encodeURIComponent(pinnedPath)}`,
    task: "patched",
  }));
  expect(host.children[1]?.textContent).toBe(JSON.stringify({
    files: ["/global"],
    pins: [],
    scope: "/api/files",
    task: "patched",
  }));

  revertPipelineSnapshot("p1");
  await Bun.sleep(0);
  expect(fetches).toBe(2);
  expect(host.children[0]?.textContent).toContain('"task":"server"');
  expect(host.children[0]?.textContent).toContain(pinnedPath);
  expect(host.children[1]?.textContent).toBe(JSON.stringify({
    files: ["/global"],
    pins: [],
    scope: "/api/files",
    task: "server",
  }));

  flushSync(() => { root.unmount(); });
  host.remove();
});

test("hook initialization paints only an exact request-scope cache snapshot", async () => {
  const pinA = "/archive/pin-a.jsonl";
  const pinB = "/archive/pin-b.jsonl";
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    calls += 1;
    const url = String(input);
    if (calls > 1) await gate;
    const pinnedPath = new URL(url, "http://localhost").searchParams.get("path");
    return new Response(JSON.stringify({
      files: pinnedPath ? [{ path: "/global" }, { path: pinnedPath }] : [{ path: "/global" }],
      pinOverlayPaths: pinnedPath ? [pinnedPath] : [],
    }));
  }) as unknown as typeof fetch;

  const warmHost = document.createElement("div");
  document.body.append(warmHost);
  const warmRoot = createRoot(warmHost);
  flushSync(() => { warmRoot.render(<ScopedProbe pinnedPath={pinA} />); });
  await Bun.sleep(20);
  expect(warmHost.textContent).toContain(pinA);
  flushSync(() => { warmRoot.unmount(); });
  warmHost.remove();

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => {
    root.render(<>
      <ScopedProbe />
      <ScopedProbe pinnedPath={pinB} />
      <ScopedProbe pinnedPath={pinA} />
    </>);
  });

  expect(host.children[0]?.textContent).toContain('"files":[]');
  expect(host.children[1]?.textContent).toContain('"files":[]');
  expect(host.children[2]?.textContent).toContain(pinA);
  expect(host.children[0]?.textContent).not.toContain(pinA);
  expect(host.children[1]?.textContent).not.toContain(pinA);

  release();
  await Bun.sleep(30);
  flushSync(() => { root.unmount(); });
  host.remove();
});

test("an already-mounted hook drops pin-only rows in the render that changes scope", async () => {
  const pinA = "/archive/switch-pin-a.jsonl";
  const pinB = "/archive/switch-pin-b.jsonl";
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    calls += 1;
    const url = String(input);
    if (calls > 1) await gate;
    const pinnedPath = new URL(url, "http://localhost").searchParams.get("path");
    return new Response(JSON.stringify({
      files: pinnedPath ? [{ path: "/global" }, { path: pinnedPath }] : [{ path: "/global" }],
      pinOverlayPaths: pinnedPath ? [pinnedPath] : [],
    }));
  }) as unknown as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => { root.render(<ScopedProbe pinnedPath={pinA} />); });
  await Bun.sleep(20);
  expect(host.textContent).toContain(pinA);

  flushSync(() => { root.render(<ScopedProbe pinnedPath={pinB} />); });
  expect(host.textContent).toContain('"files":[]');
  expect(host.textContent).not.toContain(pinA);

  flushSync(() => { root.render(<ScopedProbe />); });
  expect(host.textContent).toContain('"files":[]');
  expect(host.textContent).not.toContain(pinA);

  release();
  await Bun.sleep(30);
  flushSync(() => { root.unmount(); });
  host.remove();
});

test("a failed cold hydration keeps creation guarded and retries until a snapshot succeeds", async () => {
  let calls = 0;
  globalThis.fetch = mock(async () => {
    calls += 1;
    if (calls === 1) throw new Error("cold files transport failed");
    return new Response(JSON.stringify({ files: [{ path: "/sessions/recovered.jsonl" }] }));
  }) as unknown as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => { root.render(<Probe />); });
  await Bun.sleep(20);
  expect(host.firstElementChild?.getAttribute("data-loaded")).toBe("false");
  expect(host.textContent).toBe("empty");

  await Bun.sleep(1_100);
  expect(calls).toBe(2);
  expect(host.firstElementChild?.getAttribute("data-loaded")).toBe("true");
  expect(host.textContent).toBe("/sessions/recovered.jsonl");
  flushSync(() => { root.unmount(); });
  host.remove();
});

test("a live-mode remount paints A from cache and reaches B through one background revalidation", async () => {
  let calls = 0;
  let releaseB!: () => void;
  const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
  globalThis.fetch = mock(async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ files: [{ path: "/sessions/project-a.jsonl" }] }));
    await gateB;
    return new Response(JSON.stringify({ files: [{ path: "/sessions/project-b.jsonl" }] }));
  }) as unknown as typeof fetch;

  const firstHost = document.createElement("div");
  document.body.append(firstHost);
  const firstRoot = createRoot(firstHost);
  flushSync(() => { firstRoot.render(<Probe />); });
  await Bun.sleep(20);
  expect(firstHost.textContent).toBe("/sessions/project-a.jsonl");
  flushSync(() => { firstRoot.unmount(); });
  firstHost.remove();

  const secondHost = document.createElement("div");
  document.body.append(secondHost);
  const secondRoot = createRoot(secondHost);
  flushSync(() => { secondRoot.render(<Probe />); });
  expect(secondHost.textContent).toBe("/sessions/project-a.jsonl");
  await Bun.sleep(20);
  expect(calls).toBe(2);

  releaseB();
  await Bun.sleep(20);
  expect(secondHost.textContent).toBe("/sessions/project-b.jsonl");
  expect(calls).toBe(2);
  flushSync(() => { secondRoot.unmount(); });
  secondHost.remove();
});

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
  await Bun.sleep(10);
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
