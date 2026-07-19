import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { ComposerBar } from "./ComposerBar";
import { useComposer } from "@/hooks/useComposer";

/* Issue #419: a decoding or failed attachment blocks Send with a visible reason,
   so no image is ever silently dropped mid-read. */

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;

class DeferredReader {
  static queue: DeferredReader[] = [];
  result: string | null = null;
  error: unknown = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  readAsDataURL() { DeferredReader.queue.push(this); }
  static next(): DeferredReader {
    const reader = DeferredReader.queue.shift();
    if (!reader) throw new Error("no pending read");
    return reader;
  }
  resolve(dataUrl: string) { this.result = dataUrl; this.onload?.(); }
  reject(message: string) { this.error = new Error(message); this.onerror?.(); }
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
const tick = async () => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

const submits: string[] = [];

function Harness() {
  const composer = useComposer({ initialText: () => "hello agent", persistText: () => {}, submit: () => { submits.push("submit"); } });
  return (
    <ComposerBar
      composer={composer}
      placeholder="Prompt"
      textareaAriaLabel="Prompt"
      imageAriaLabel="Add images"
      leftSlot={null}
      sendLabelIdle="Send"
      sendLabelRecording="Stop"
      sendIdleClassName="bg-accent"
    />
  );
}

let roots: Root[] = [];
beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
  (dom as unknown as { matchMedia: unknown }).matchMedia = OVERRIDES.matchMedia;
});
afterAll(async () => {
  await tick();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
});
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; DeferredReader.queue = []; submits.length = 0; });
afterEach(async () => { for (const r of roots) flushSync(() => r.unmount()); roots = []; await tick(); });

function mount() {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<Harness />));
  roots.push(root);
  return host as unknown as HTMLElement;
}

function paste(host: HTMLElement, name: string) {
  const textarea = host.querySelector("textarea")!;
  const key = Object.keys(textarea).find((k) => k.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onPaste(event: unknown): void }>)[key]!;
  const fileFor = () => new dom.File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
  flushSync(() => props.onPaste({ clipboardData: { items: [{ type: "image/png", getAsFile: fileFor }] }, preventDefault() {} }));
}

const send = (host: HTMLElement) => host.querySelector('button[aria-label="Send"]') as unknown as HTMLButtonElement;

function pressEnter(host: HTMLElement) {
  const textarea = host.querySelector("textarea")!;
  const key = Object.keys(textarea).find((k) => k.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onKeyDown(event: unknown): void }>)[key]!;
  flushSync(() => props.onKeyDown({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: false }, preventDefault() {} }));
}

test("Send is blocked with a reason while an attachment is still decoding, then unblocks (#419)", async () => {
  const host = mount();
  /* Text alone: Send is enabled. */
  expect(send(host).disabled).toBe(false);

  paste(host, "reading.png");
  await tick();
  /* A placeholder is decoding — Send blocks and says why. */
  expect(send(host).disabled).toBe(true);
  expect(host.textContent).toContain("Waiting for the image to finish loading");

  DeferredReader.next().resolve("data:image/png;base64,cmVhZHk=");
  await tick();
  expect(send(host).disabled).toBe(false);
  expect(host.textContent).not.toContain("Waiting for the image to finish loading");
});

test("Send stays blocked on a failed read until it is removed or retried (#419)", async () => {
  const host = mount();
  paste(host, "bad.png");
  await tick();
  DeferredReader.next().reject("couldn't read the image");
  await tick();

  expect(send(host).disabled).toBe(true);
  expect(host.textContent).toContain("Remove or retry the failed image");

  /* Removing the failed slot re-enables Send (text remains). */
  const remove = host.querySelector('button[aria-label="Remove image 1"]') as unknown as HTMLButtonElement;
  flushSync(() => remove.click());
  await tick();
  expect(send(host).disabled).toBe(false);
});

test("Enter honors the attachment admission gate exactly like the Send button (PR #431)", async () => {
  const host = mount();
  paste(host, "reading.png");
  await tick();
  /* The slot is still decoding — Enter must not submit and silently drop it. */
  expect(send(host).disabled).toBe(true);
  pressEnter(host);
  await tick();
  expect(submits).toHaveLength(0);

  /* Once every slot settles, the same Enter sends. */
  DeferredReader.next().resolve("data:image/png;base64,cmVhZHk=");
  await tick();
  expect(send(host).disabled).toBe(false);
  pressEnter(host);
  await tick();
  expect(submits).toHaveLength(1);
});

test("Enter stays inert while a failed attachment blocks Send (PR #431)", async () => {
  const host = mount();
  paste(host, "bad.png");
  await tick();
  DeferredReader.next().reject("couldn't read the image");
  await tick();
  expect(send(host).disabled).toBe(true);

  pressEnter(host);
  await tick();
  expect(submits).toHaveLength(0);
});
