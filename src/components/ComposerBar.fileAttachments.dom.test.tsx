import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { useLayoutEffect } from "react";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { ComposerBar } from "./ComposerBar";
import { useComposer } from "@/hooks/useComposer";
import { MAX_INBOX_FILES, MAX_INBOX_FILE_BYTES } from "@/lib/filePolicy";

/* Issue #1224: the composer accepts any file, not only images. A dropped
   document used to be filtered out by MIME and the handler carried on with an
   empty list — nothing told the operator anything had happened. Every case here
   is either "the file lands" or "the refusal is visible"; the fixtures are
   invented names and bytes, never a real file from disk. */

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
  static settleAll(dataUrl = "data:application/pdf;base64,cmVhZHk=") {
    const pending = DeferredReader.queue.splice(0, DeferredReader.queue.length);
    for (const reader of pending) {
      reader.result = dataUrl;
      reader.onload?.();
    }
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
  matchMedia: (q: string) => ({ matches: false, media: String(q), onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }),
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
const tick = async () => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

let staged: { images: number; files: { name: string; base64: string }[] } = { images: 0, files: [] };

function Harness({ acceptFiles }: { acceptFiles: boolean }) {
  const composer = useComposer({ initialText: () => "", persistText: () => {}, submit: () => {}, acceptFiles });
  const { images, files } = composer.attachments;
  /* Published after commit, never during render: the assertions read what the
     tray actually settled on. */
  useLayoutEffect(() => {
    staged = { images: images.length, files: files.map(({ name, base64 }) => ({ name, base64 })) };
  }, [images, files]);
  return (
    <ComposerBar
      composer={composer}
      placeholder="Prompt"
      textareaAriaLabel="Prompt"
      imageAriaLabel="Add files or images"
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
beforeEach(() => {
  dom.document.body.replaceChildren();
  roots = [];
  DeferredReader.queue = [];
  staged = { images: 0, files: [] };
});
afterEach(async () => { for (const r of roots) flushSync(() => r.unmount()); roots = []; await tick(); });

function mount(acceptFiles = true) {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<Harness acceptFiles={acceptFiles} />));
  roots.push(root);
  return host as unknown as HTMLElement;
}

type TextareaProps = {
  onPaste(event: unknown): void;
  onDragOver(event: unknown): void;
  onDrop(event: unknown): void;
};

function textareaProps(host: HTMLElement): TextareaProps {
  const textarea = host.querySelector("textarea")!;
  const key = Object.keys(textarea).find((k) => k.startsWith("__reactProps$"))!;
  return (textarea as unknown as Record<string, TextareaProps>)[key]!;
}

function fileOf(name: string, type: string, size = 12): File {
  return { name, type, size } as File;
}

const tiles = (host: HTMLElement) => Array.from(host.querySelectorAll('[data-testid="attachment-tile"]'));

test("a pasted document lands as a file attachment instead of being discarded", async () => {
  const host = mount();
  flushSync(() => textareaProps(host).onPaste({
    clipboardData: { items: [{ kind: "file", type: "application/pdf", getAsFile: () => fileOf("quarterly-notes.pdf", "application/pdf") }] },
    preventDefault() {},
  }));
  await tick();

  expect(tiles(host)).toHaveLength(1);
  expect(host.textContent).toContain("quarterly-notes.pdf");
  flushSync(() => DeferredReader.settleAll());
  await tick();
  expect(staged.files.map((file) => file.name)).toEqual(["quarterly-notes.pdf"]);
  expect(staged.files[0]!.base64).toBe("cmVhZHk=");
  expect(staged.images).toBe(0);
});

test("a dropped document is claimed by the drag affordance and lands as a file", async () => {
  const host = mount();
  const props = textareaProps(host);
  const transfer = { items: [{ kind: "file", type: "text/csv" }], dropEffect: "" };
  let dragPrevented = false;
  flushSync(() => props.onDragOver({ dataTransfer: transfer, preventDefault: () => { dragPrevented = true; } }));
  /* Without a cancelled dragover the browser never fires the drop at all — it
     navigates to the dropped file, which is what a dragged CSV used to do. */
  expect(dragPrevented).toBe(true);
  expect(transfer.dropEffect).toBe("copy");

  flushSync(() => props.onDrop({
    dataTransfer: { files: [fileOf("rows.csv", "text/csv")] },
    preventDefault() {},
    stopPropagation() {},
  }));
  flushSync(() => DeferredReader.settleAll());
  await tick();
  expect(staged.files.map((file) => file.name)).toEqual(["rows.csv"]);
});

test("the attach picker no longer restricts the phone to the photo library", () => {
  const host = mount();
  const input = host.querySelector('input[type="file"]') as unknown as HTMLInputElement;
  /* `accept="image/*"` is exactly what makes a phone offer photos only and hide
     the Files app; a composer that delivers documents must not carry it. */
  expect(input.hasAttribute("accept")).toBe(false);

  const imagesOnly = mount(false);
  expect((imagesOnly.querySelector('input[type="file"]') as unknown as HTMLInputElement).getAttribute("accept")).toBe("image/*");
});

test("a picked document reaches the tray through the same intake as a pasted one", async () => {
  const host = mount();
  const input = host.querySelector('input[type="file"]')!;
  const key = Object.keys(input).find((k) => k.startsWith("__reactProps$"))!;
  const props = (input as unknown as Record<string, { onChange(event: unknown): void }>)[key]!;
  flushSync(() => props.onChange({ target: { files: [fileOf("deploy.log", "text/plain")], value: "x" } }));
  flushSync(() => DeferredReader.settleAll());
  await tick();

  expect(staged.files.map((file) => file.name)).toEqual(["deploy.log"]);
  expect(host.textContent).toContain("deploy.log");
});

test("an oversized file is refused by name and never occupies a tray slot", async () => {
  const host = mount();
  flushSync(() => textareaProps(host).onDrop({
    dataTransfer: { files: [fileOf("huge.bin", "application/octet-stream", MAX_INBOX_FILE_BYTES + 1)] },
    preventDefault() {},
    stopPropagation() {},
  }));
  await tick();

  expect(tiles(host)).toHaveLength(0);
  expect(host.textContent).toContain("huge.bin");
  expect(host.textContent).toContain("too large");
});

test("more files than one message may carry are refused with the limit, not dropped", async () => {
  const host = mount();
  flushSync(() => textareaProps(host).onDrop({
    dataTransfer: {
      files: Array.from({ length: MAX_INBOX_FILES + 1 }, (_, index) => fileOf(`note-${index}.txt`, "text/plain")),
    },
    preventDefault() {},
    stopPropagation() {},
  }));
  await tick();

  expect(tiles(host)).toHaveLength(MAX_INBOX_FILES);
  expect(host.textContent).toContain(String(MAX_INBOX_FILES));
});

test("a composer with no by-path road refuses a document by name rather than dropping it", async () => {
  const host = mount(false);
  flushSync(() => textareaProps(host).onDrop({
    dataTransfer: { files: [fileOf("report.pdf", "application/pdf")] },
    preventDefault() {},
    stopPropagation() {},
  }));
  await tick();

  expect(tiles(host)).toHaveLength(0);
  expect(host.textContent).toContain("report.pdf");
  expect(host.textContent).toContain("images only");
});

test("images are unaffected: they still stage as images beside a document", async () => {
  const host = mount();
  flushSync(() => textareaProps(host).onDrop({
    dataTransfer: { files: [fileOf("shot.png", "image/png"), fileOf("trace.log", "text/plain")] },
    preventDefault() {},
    stopPropagation() {},
  }));
  flushSync(() => DeferredReader.settleAll("data:image/png;base64,cmVhZHk="));
  await tick();

  expect(staged.images).toBe(1);
  expect(staged.files.map((file) => file.name)).toEqual(["trace.log"]);
  const kinds = tiles(host).map((tile) => tile.getAttribute("data-kind"));
  expect(kinds).toEqual(["image", "file"]);
  /* The staged-count copy stops saying "images" once one of them is not. */
  expect(host.textContent).toContain("2 attachments");
});

test("an empty file is refused by name instead of staging a tile that never delivers", async () => {
  const host = mount();
  flushSync(() => textareaProps(host).onDrop({
    dataTransfer: { files: [fileOf("empty.log", "text/plain", 0)] },
    preventDefault() {},
    stopPropagation() {},
  }));
  await tick();

  /* A zero-byte file has no bytes to hand an agent. Staging it would put a
     tile on screen that claims "attached to the message" and then leaves with
     the send — the silent discard #1224 exists to remove, in a new form. */
  expect(tiles(host)).toHaveLength(0);
  expect(staged.files).toEqual([]);
  expect(host.textContent).toContain("empty.log");
  expect(host.textContent).toContain("empty");
});

test("a read that comes back with no bytes errors its slot rather than sitting ready", async () => {
  const host = mount();
  flushSync(() => textareaProps(host).onDrop({
    dataTransfer: { files: [fileOf("truncated.log", "text/plain")] },
    preventDefault() {},
    stopPropagation() {},
  }));
  /* The invariant, not the one input: no slot may sit in `ready` while the
     deliverable projection excludes it, or Send goes out without it. */
  flushSync(() => DeferredReader.settleAll("data:text/plain;base64,"));
  await tick();

  const ready = tiles(host).filter((tile) => tile.getAttribute("data-status") === "ready");
  expect(ready).toHaveLength(0);
  expect(tiles(host).map((tile) => tile.getAttribute("data-status"))).toEqual(["error"]);
  expect(staged.files).toEqual([]);
  expect(host.textContent).toContain("truncated.log");
});
