import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { ImagePreviewStrip, useImageAttachments, type UseImageAttachmentsReturn } from "./imageAttachments";

/*
 * PR #431 — object-URL lifecycle: every owned preview URL is revoked exactly
 * once when the tray unmounts, and a FileReader that settles after unmount
 * stays inert (no state commit, no resurrected slot, no second revocation).
 */

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;

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

const tick = async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); };

/* Deterministic object-URL doubles, patched onto the real global URL class so
   `new URL(...)` construction elsewhere keeps working. */
const urls = { created: [] as string[], revoked: [] as string[] };
let urlSeq = 0;
type UrlPatch = { createObjectURL?: (blob: unknown) => string; revokeObjectURL?: (url: string) => void };
const urlPatch = URL as unknown as UrlPatch;
const savedCreate = urlPatch.createObjectURL;
const savedRevoke = urlPatch.revokeObjectURL;

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

let roots: Root[] = [];
beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
  urlPatch.createObjectURL = () => { const url = `blob:test-${++urlSeq}`; urls.created.push(url); return url; };
  urlPatch.revokeObjectURL = (url: string) => { urls.revoked.push(url); };
});
afterAll(async () => {
  await tick();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  if (savedCreate) urlPatch.createObjectURL = savedCreate; else delete urlPatch.createObjectURL;
  if (savedRevoke) urlPatch.revokeObjectURL = savedRevoke; else delete urlPatch.revokeObjectURL;
});
beforeEach(() => {
  dom.document.body.replaceChildren();
  roots = [];
  captured.api = null;
  captured.errors = [];
  DeferredReader.queue = [];
  urls.created = [];
  urls.revoked = [];
});
afterEach(async () => { for (const r of roots) flushSync(() => r.unmount()); roots = []; await tick(); });

function mount(): Root {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<Harness />));
  roots.push(root);
  return root;
}

test("unmount revokes every owned preview URL exactly once (PR #431)", async () => {
  const root = mount();
  flushSync(() => api().addFiles([file("a.png"), file("b.png")]));
  expect(urls.created).toHaveLength(2);
  expect(urls.revoked).toHaveLength(0);

  flushSync(() => root.unmount());
  roots = [];
  await tick();
  expect([...urls.revoked].sort()).toEqual([...urls.created].sort());
  expect(urls.revoked).toHaveLength(2);
});

test("a slot revoked by remove is not revoked again on unmount (PR #431)", async () => {
  const root = mount();
  flushSync(() => api().addFiles([file("keep.png"), file("drop.png")]));
  const dropId = api().attachments.find((attachment) => attachment.name === "drop.png")!.id;
  flushSync(() => api().remove(dropId));
  expect(urls.revoked).toHaveLength(1);

  flushSync(() => root.unmount());
  roots = [];
  await tick();
  /* One revocation per created URL — never a double revoke of the removed one. */
  expect(urls.revoked).toHaveLength(2);
  expect(new Set(urls.revoked).size).toBe(2);
});

test("a read settling after unmount stays inert — no commit, no resurrect (PR #431)", async () => {
  const root = mount();
  flushSync(() => api().addFiles([file("late.png")]));
  const trayApi = api();
  flushSync(() => root.unmount());
  roots = [];
  await tick();
  expect(urls.revoked).toHaveLength(1);

  /* The FileReader for the unmounted tray settles late: nothing may change —
     the ready projection stays empty and no extra revoke/create happens. */
  DeferredReader.take("late.png").resolve("data:image/png;base64,bGF0ZQ==");
  await tick();
  expect(trayApi.imagesRef.current).toHaveLength(0);
  expect(urls.created).toHaveLength(1);
  expect(urls.revoked).toHaveLength(1);
  expect(captured.errors).toEqual([]);
});

test("receipt settlement removes intake ids while preserving every later slot and owned preview", async () => {
  mount();
  flushSync(() => api().addFiles([file("sent.png")]));
  DeferredReader.take("sent.png").resolve("data:image/png;base64,c2VudA==");
  await tick();
  const sent = api().images.map((image) => ({ ...image }));
  const sentPreview = sent[0]!.preview;

  flushSync(() => api().addFiles([
    file("ready-one.png"),
    file("reading.png"),
    file("error.png"),
    file("ready-two.png"),
  ]));
  DeferredReader.take("ready-one.png").resolve("data:image/png;base64,b25l");
  DeferredReader.take("error.png").reject("broken image");
  DeferredReader.take("ready-two.png").resolve("data:image/png;base64,dHdv");
  await tick();

  const survivors = api().attachments.slice(1);
  const survivorPreviews = survivors.map((attachment) => attachment.preview);
  expect(survivors.map((attachment) => attachment.status)).toEqual(["ready", "reading", "error", "ready"]);

  flushSync(() => api().settleDelivered(sent));

  expect(api().attachments.map((attachment) => attachment.status)).toEqual(["ready", "reading", "error", "ready"]);
  expect(api().attachments.map((attachment) => attachment.preview)).toEqual(survivorPreviews);
  expect(api().attachments.every((attachment) => attachment.ownsPreview)).toBe(true);
  expect(urls.revoked).toEqual([sentPreview]);

  DeferredReader.take("reading.png").resolve("data:image/png;base64,bGF0ZXI=");
  await tick();
  expect(api().attachments.map((attachment) => attachment.status)).toEqual(["ready", "ready", "error", "ready"]);
  expect(api().attachments.map((attachment) => attachment.preview)).toEqual(survivorPreviews);
});
