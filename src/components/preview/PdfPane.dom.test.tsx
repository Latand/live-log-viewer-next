import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale } from "@/lib/i18n";

import type { ArtifactFailure } from "./artifactResource";

installActEnv();

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});

/* pdf.js is mocked before the pane loads: these tests pin the transport
   contract (every request bound to the meta validator) and the failure
   mapping, not pdf parsing. PdfPane is the only consumer of pdfjs-dist, so
   the module mock cannot reach any other suite's dependencies. */
const getDocumentCalls: Record<string, unknown>[] = [];
let taskRejection: unknown = null;
let loadedDocument: PDFDocumentProxy | null = null;
mock.module("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: (params: Record<string, unknown>) => {
    getDocumentCalls.push(params);
    return {
      promise: taskRejection ? Promise.reject(taskRejection) : loadedDocument ? Promise.resolve(loadedDocument) : new Promise(() => {}),
      destroy: () => Promise.resolve(),
    };
  },
}));

const { default: PdfPane } = await import("./PdfPane");
const { ArtifactPreviewHost } = await import("./ArtifactPreviewHost");
const { openArtifactPreview } = await import("./previewBus");

let root: Root | null = null;
let failures: ArtifactFailure[] = [];
const onFailure = (code: ArtifactFailure) => failures.push(code);

beforeEach(() => {
  setLocale("en");
  getDocumentCalls.length = 0;
  taskRejection = null;
  loadedDocument = null;
  spyOn(dom.HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
  failures = [];
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  root = createRoot(host as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  dom.document.body.replaceChildren();
  mock.restore();
  Reflect.deleteProperty(globalThis, "ResizeObserver");
  dom.history.replaceState(null, "", "/");
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

async function render(mobile = false): Promise<void> {
  await act(async () => {
    root!.render(<PdfPane path="~/fixtures/report.pdf" etag='"p1"' mobile={mobile} onFailure={onFailure} />);
  });
  await flush();
}

test("the document loads with every pdf.js request bound to the meta validator", async () => {
  await render();
  expect(getDocumentCalls.length).toBe(1);
  const params = getDocumentCalls[0];
  expect(String(params.url)).toContain("/api/artifact");
  expect((params.httpHeaders as Record<string, string>)["if-match"]).toBe('"p1"');
});

test("a stale validator (file replaced mid-load) surfaces the changed state", async () => {
  taskRejection = Object.assign(new Error("stale validator"), { status: 412 });
  await render();
  expect(failures).toEqual(["changed"]);
});

test("mobile pdf controls carry the 44px touch-target sizing", async () => {
  await render(true);
  for (const label of ["Previous page", "Next page", "Zoom out", "Zoom in", "Fit width"]) {
    const control = dom.document.querySelector(`[aria-label="${label}"]`);
    expect(control).not.toBeNull();
    expect(control!.className).toContain("h-11 w-11");
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function pdfPage(width = 100, promise = Promise.resolve()) {
  const cancel = mock(() => {});
  const render = mock(() => ({ promise, cancel }));
  return {
    page: { getViewport: () => ({ width, height: width * 2 }), render } as unknown as PDFPageProxy,
    render,
    cancel,
  };
}

function documentWith(getPage: (page: number) => Promise<PDFPageProxy>) {
  loadedDocument = { numPages: 3, getPage } as PDFDocumentProxy;
}

async function click(label: string) {
  await act(async () => {
    const button = dom.document.querySelector(`[aria-label="${label}"]`);
    expect(button).not.toBeNull();
    (button as unknown as HTMLButtonElement).click();
  });
}

async function openHost() {
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(JSON.stringify({
    name: "report.pdf", kind: "pdf", mime: "application/pdf", size: 200000, etag: '"p1"',
  })), { preconnect: () => {} }));
  await act(async () => root!.render(<ArtifactPreviewHost mobile={false} />));
  await act(async () => openArtifactPreview("~/fixtures/report.pdf"));
  await flush();
}

for (const phase of ["initial load", "lazy page"] as const) {
  test(`${phase} 412 exposes the real host changed state and working Reload`, async () => {
    const pending = deferred<PDFPageProxy>();
    const first = pdfPage();
    if (phase === "initial load") taskRejection = { status: 412 };
    else documentWith((page) => page === 1 ? Promise.resolve(first.page) : pending.promise);
    await openHost();
    if (phase === "lazy page") {
      expect(first.render).toHaveBeenCalledTimes(1);
      await click("Next page");
      await act(async () => pending.reject({ status: 412 }));
    }
    expect(dom.document.querySelector("[data-artifact-preview]")?.getAttribute("data-artifact-state")).toBe("changed");
    const reload = Array.from(dom.document.querySelectorAll("button")).find((button) => button.textContent === "Reload");
    expect(reload).toBeDefined();
    taskRejection = null;
    documentWith(() => Promise.resolve(first.page));
    await act(async () => reload!.click());
    await flush();
    expect(getDocumentCalls).toHaveLength(2);
    expect(dom.document.querySelector("[data-artifact-preview]")?.getAttribute("data-artifact-state")).toBe("ready");
    expect(dom.document.querySelector("canvas")).not.toBeNull();
  });
}

for (const teardown of ["navigation", "unmount"] as const) {
  for (const settlement of ["reject", "resolve"] as const) {
    test(`late getPage ${settlement} after ${teardown} cannot report or paint`, async () => {
      const pending = deferred<PDFPageProxy>();
      const stale = pdfPage(900);
      const current = pdfPage(200);
      documentWith((page) => page === 1 ? pending.promise : Promise.resolve(current.page));
      await render();
      const canvas = dom.document.querySelector("canvas")!;
      if (teardown === "navigation") await click("Next page");
      else await act(async () => { root!.unmount(); root = null; });
      const width = canvas.width;
      await act(async () => {
        if (settlement === "reject") pending.reject({ status: 412 });
        else pending.resolve(stale.page);
      });
      expect(failures).toEqual([]);
      expect(stale.render).not.toHaveBeenCalled();
      expect(canvas.width).toBe(width);
      if (teardown === "navigation") {
        expect(current.render).toHaveBeenCalledTimes(1);
        expect(current.cancel).not.toHaveBeenCalled();
      }
    });
  }
}

for (const error of [{ status: 403 }, new Error("page unavailable"), null]) {
  test(`current lazy failure maps honestly: ${JSON.stringify(error)}`, async () => {
    documentWith(() => Promise.reject(error));
    await render();
    expect(failures).toEqual([error && "status" in error ? "denied" : "error"]);
  });
}

for (const teardown of ["navigation", "unmount"] as const) {
  test(`an active render is cancelled on ${teardown} and its rejection is ignored`, async () => {
    const pending = deferred<void>();
    const stale = pdfPage(100, pending.promise);
    const current = pdfPage(200);
    documentWith((page) => Promise.resolve(page === 1 ? stale.page : current.page));
    await render();
    expect(stale.render).toHaveBeenCalledTimes(1);
    if (teardown === "navigation") await click("Next page");
    else await act(async () => { root!.unmount(); root = null; });
    expect(stale.cancel).toHaveBeenCalledTimes(1);
    await act(async () => pending.reject(new Error("render cancelled")));
    expect(failures).toEqual([]);
  });
}

test("a current render failure is surfaced", async () => {
  const pending = deferred<void>();
  documentWith(() => Promise.resolve(pdfPage(100, pending.promise).page));
  await render();
  await act(async () => pending.reject(new Error("render failed")));
  expect(failures).toEqual(["error"]);
});

for (const settlement of ["reject", "resolve"] as const) {
  test(`resize supersedes a pending fetch before its late ${settlement}`, async () => {
    let resize!: () => void;
    const disconnect = mock(() => {});
    Object.assign(globalThis, { ResizeObserver: class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect = disconnect;
    } });
    const pending = deferred<PDFPageProxy>();
    const stale = pdfPage(900);
    const current = pdfPage(200);
    let calls = 0;
    documentWith(() => ++calls === 1 ? pending.promise : Promise.resolve(current.page));
    await render();
    await act(async () => resize());
    const canvas = dom.document.querySelector("canvas")!;
    const width = canvas.width;
    await act(async () => {
      if (settlement === "reject") pending.reject({ status: 412 });
      else pending.resolve(stale.page);
    });
    expect(failures).toEqual([]);
    expect(stale.render).not.toHaveBeenCalled();
    expect(current.render).toHaveBeenCalledTimes(1);
    expect(current.cancel).not.toHaveBeenCalled();
    expect(canvas.width).toBe(width);
    await act(async () => { root!.unmount(); root = null; });
    expect(disconnect).toHaveBeenCalledTimes(1);
    await act(async () => resize());
    expect(calls).toBe(2);
  });

  test(`switching artifacts ignores the old page's late ${settlement}`, async () => {
    const pending = deferred<PDFPageProxy>();
    const stale = pdfPage(900);
    const current = pdfPage(200);
    documentWith(() => pending.promise);
    await openHost();
    documentWith(() => Promise.resolve(current.page));
    await act(async () => openArtifactPreview("~/fixtures/another.pdf"));
    await flush();
    const canvas = dom.document.querySelector("canvas")!;
    const width = canvas.width;
    await act(async () => {
      if (settlement === "reject") pending.reject({ status: 412 });
      else pending.resolve(stale.page);
    });
    expect(dom.document.querySelector("[data-artifact-preview]")?.getAttribute("data-artifact-state")).toBe("ready");
    expect(stale.render).not.toHaveBeenCalled();
    expect(current.render).toHaveBeenCalledTimes(1);
    expect(canvas.width).toBe(width);
  });
}
