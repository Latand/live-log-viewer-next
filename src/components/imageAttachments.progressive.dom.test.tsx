import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { ImagePreviewStrip, useImageAttachments, type UseImageAttachmentsReturn } from "./imageAttachments";

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;

/* A FileReader whose reads settle only when the test releases them, so the
   placeholder→ready/error transitions can be observed one at a time. */
class DeferredReader {
  static queue: DeferredReader[] = [];
  result: string | null = null;
  error: unknown = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private file: { name: string } | null = null;
  readAsDataURL(file: { name: string }) {
    this.file = file;
    DeferredReader.queue.push(this);
  }
  static take(name: string): DeferredReader {
    const index = DeferredReader.queue.findIndex((reader) => reader.file?.name === name);
    if (index < 0) throw new Error(`no pending read for ${name}`);
    return DeferredReader.queue.splice(index, 1)[0]!;
  }
  resolve(dataUrl: string) {
    this.result = dataUrl;
    this.onload?.();
  }
  reject(message: string) {
    this.error = new Error(message);
    this.onerror?.();
  }
}

const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  FileReader: DeferredReader,
  matchMedia: (q: string) => ({ matches: /max-width/.test(String(q)), media: String(q), onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }),
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
(dom as unknown as { matchMedia: unknown }).matchMedia = OVERRIDES.matchMedia;

/* Reads resolve on a microtask, so let the promise `.then` and React's flush run. */
const tick = async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); };

const captured: { api: UseImageAttachmentsReturn | null; errors: string[] } = { api: null, errors: [] };
const api = () => captured.api!;

function Harness() {
  const attachments = useImageAttachments({ onError: (message) => captured.errors.push(message) });
  /* eslint-disable-next-line react-hooks/immutability -- test harness exposing the hook return for assertions */
  captured.api = attachments;
  return <ImagePreviewStrip attachments={attachments.attachments} onRemove={attachments.remove} onRetry={attachments.retry} onClearAll={attachments.clearAll} />;
}

function file(name: string): File {
  return new dom.File([new Uint8Array([1, 2, 3])], name, { type: "image/png" }) as unknown as File;
}

const tiles = () => [...dom.document.querySelectorAll('[data-testid="attachment-tile"]')];
const statusesOf = () => tiles().map((tile) => tile.getAttribute("data-status"));

let roots: Root[] = [];
beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
});
afterAll(async () => {
  await tick();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
});
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; captured.api = null; captured.errors = []; DeferredReader.queue = []; });
afterEach(async () => { for (const r of roots) flushSync(() => r.unmount()); roots = []; await tick(); });

function mount() {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<Harness />));
  roots.push(root);
}

test("placeholders commit synchronously in selection order before any read settles", () => {
  mount();
  flushSync(() => api().addFiles([file("a.png"), file("b.png"), file("c.png")]));
  /* All three slots exist immediately, still reading — nothing has settled. */
  expect(statusesOf()).toEqual(["reading", "reading", "reading"]);
  expect(api().hasReading).toBe(true);
  expect(api().images).toHaveLength(0);
});

test("each read settles independently — a slow file never blocks its siblings", async () => {
  mount();
  flushSync(() => api().addFiles([file("slow.png"), file("fast.png")]));
  expect(statusesOf()).toEqual(["reading", "reading"]);
  /* Settle the SECOND file first: it goes ready alone while the first stays reading. */
  DeferredReader.take("fast.png").resolve("data:image/png;base64,ZmFzdA==");
  await tick();
  expect(statusesOf()).toEqual(["reading", "ready"]);
  expect(api().images.map((image) => image.base64)).toEqual(["ZmFzdA=="]);
  DeferredReader.take("slow.png").resolve("data:image/png;base64,c2xvdw==");
  await tick();
  expect(statusesOf()).toEqual(["ready", "ready"]);
  /* Ready projection preserves selection order regardless of settle order. */
  expect(api().images.map((image) => image.base64)).toEqual(["c2xvdw==", "ZmFzdA=="]);
  expect(api().hasReading).toBe(false);
});

test("one failed read errors alone and blocks send until removed or retried; siblings deliver", async () => {
  mount();
  flushSync(() => api().addFiles([file("good.png"), file("bad.png")]));
  DeferredReader.take("good.png").resolve("data:image/png;base64,Z29vZA==");
  DeferredReader.take("bad.png").reject("couldn't read the image");
  await tick();
  expect(statusesOf()).toEqual(["ready", "error"]);
  expect(api().hasError).toBe(true);
  expect(api().images.map((image) => image.base64)).toEqual(["Z29vZA=="]);
  /* Retry re-reads only the failed slot; the good sibling is untouched. */
  flushSync(() => {
    const retry = dom.document.querySelector('[data-status="error"] button[aria-label="Retry image 2"]') as unknown as HTMLButtonElement;
    retry.click();
  });
  expect(statusesOf()).toEqual(["ready", "reading"]);
  DeferredReader.take("bad.png").resolve("data:image/png;base64,Zml4ZWQ=");
  await tick();
  expect(statusesOf()).toEqual(["ready", "ready"]);
  expect(api().hasError).toBe(false);
});

test("removing a slot while it is still reading never resurrects it when the read settles", async () => {
  mount();
  flushSync(() => api().addFiles([file("keep.png"), file("drop.png")]));
  const dropId = api().attachments.find((attachment) => attachment.name === "drop.png")!.id;
  flushSync(() => api().remove(dropId));
  expect(statusesOf()).toEqual(["reading"]);
  /* The late read for the removed file must not re-add a tile. */
  DeferredReader.take("drop.png").resolve("data:image/png;base64,ZHJvcA==");
  await tick();
  expect(statusesOf()).toEqual(["reading"]);
  DeferredReader.take("keep.png").resolve("data:image/png;base64,a2VlcA==");
  await tick();
  expect(statusesOf()).toEqual(["ready"]);
  expect(api().images.map((image) => image.base64)).toEqual(["a2VlcA=="]);
});

test("clear-all appears at two or more slots and drops the whole tray", () => {
  mount();
  flushSync(() => api().addFiles([file("one.png")]));
  expect(dom.document.querySelector('button[aria-label="Remove all images"]')).toBeNull();
  flushSync(() => api().addFiles([file("two.png")]));
  const clear = dom.document.querySelector('button[aria-label="Remove all images"]') as HTMLButtonElement | null;
  expect(clear).not.toBeNull();
  flushSync(() => clear!.click());
  expect(tiles()).toHaveLength(0);
});

test("the mobile tray is a bounded horizontal scroller that never widens the document", () => {
  mount();
  flushSync(() => api().addFiles([file("a.png"), file("b.png")]));
  const tray = dom.document.querySelector('[data-testid="attachment-tray"]') as unknown as HTMLElement;
  const className = tray.getAttribute("class") ?? "";
  expect(className).toContain("overflow-x-auto");
  expect(className).toContain("overscroll-x-contain");
  expect(className).toContain("min-w-0");
  expect(className).toContain("max-w-full");
  /* Each remove control carries a persistent (non-hover) 44px inset hit area. */
  const remove = dom.document.querySelector('button[aria-label="Remove image 1"]') as unknown as HTMLElement;
  expect(remove.getAttribute("class") ?? "").toContain("before:-inset-2.5");
});
