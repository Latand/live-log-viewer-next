import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale } from "@/lib/i18n";

import type { ArtifactFailure } from "./artifactResource";

installActEnv();

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});

/* pdf.js is mocked before the pane loads: these tests pin the transport
   contract (every request bound to the meta validator) and the failure
   mapping, not pdf parsing. PdfPane is the only consumer of pdfjs-dist, so
   the module mock cannot reach any other suite's dependencies. */
const getDocumentCalls: Record<string, unknown>[] = [];
let taskRejection: unknown = null;
mock.module("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: (params: Record<string, unknown>) => {
    getDocumentCalls.push(params);
    return {
      promise: taskRejection ? Promise.reject(taskRejection) : new Promise(() => {}),
      destroy: () => Promise.resolve(),
    };
  },
}));

const { default: PdfPane } = await import("./PdfPane");

let root: Root | null = null;
let failures: ArtifactFailure[] = [];
const onFailure = (code: ArtifactFailure) => failures.push(code);

beforeEach(() => {
  setLocale("en");
  getDocumentCalls.length = 0;
  taskRejection = null;
  failures = [];
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  root = createRoot(host as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  dom.document.body.replaceChildren();
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
