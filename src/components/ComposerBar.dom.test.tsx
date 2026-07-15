import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { useComposer } from "@/hooks/useComposer";
import { setLocale, translate } from "@/lib/i18n";
import type { RuntimeImageCapability } from "@/lib/runtime/structuredContent";

import { ComposerBar } from "./ComposerBar";
import { ImagePreviewStrip, type PendingImage } from "./imageAttachments";

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
(dom as unknown as { matchMedia(query: string): unknown }).matchMedia = (query) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

afterEach(() => {
  document.body.replaceChildren();
  setLocale("en");
});

function Harness() {
  const composer = useComposer({ initialText: () => "", persistText: () => {}, submit: () => {} });
  return <ComposerBar
    composer={composer}
    placeholder="Prompt"
    textareaAriaLabel="Prompt"
    imageAriaLabel="Add images"
    leftSlot={null}
    sendLabelIdle="Send"
    sendLabelRecording="Stop"
    sendIdleClassName="bg-accent"
    imageDisabled
    imageDisabledReason="Capability unavailable"
  />;
}

test("unsupported image capability disables picker, paste, and drop before admission", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<Harness />));

  const picker = host.querySelector('button[aria-label="Add images"]') as HTMLButtonElement;
  expect(picker.disabled).toBe(true);
  expect(picker.title).toBe("Capability unavailable");
  const textarea = host.querySelector("textarea")!;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, {
    onPaste(event: unknown): void;
    onDrop(event: unknown): void;
  }>)[propsKey]!;
  let pastePrevented = false;
  let dropPrevented = false;
  props.onPaste({
    clipboardData: { items: [{ type: "image/png", getAsFile: () => ({ type: "image/png" }) }] },
    preventDefault: () => { pastePrevented = true; },
  });
  props.onDrop({
    dataTransfer: { files: [{ type: "image/png" }] },
    preventDefault: () => { dropPrevented = true; },
  });
  expect(pastePrevented).toBe(true);
  expect(dropPrevented).toBe(true);
  expect(host.textContent).toContain("Capability unavailable");
  flushSync(() => root.unmount());
});

const LIMIT_CAPABILITY: RuntimeImageCapability = {
  supported: true,
  reason: null,
  formats: ["image/png"],
  maxImages: 2,
  maxRawBytesPerImage: 3,
  maxEncodedBytesPerRequest: 8,
};

function LimitHarness({
  images,
  onSubmit,
  capability = LIMIT_CAPABILITY,
}: {
  images: PendingImage[];
  onSubmit: () => void;
  capability?: RuntimeImageCapability;
}) {
  const composer = useComposer({
    initialText: () => "",
    persistText: () => {},
    submit: () => {
      if (composer.attachments.validate()) onSubmit();
    },
    imageCapability: capability,
  });
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    composer.attachments.replace(images);
  }, [composer.attachments, images]);
  return <form onSubmit={(event) => { event.preventDefault(); void composer.submit(); }}>
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
  </form>;
}

test("structured attachment restoration and submit accept the exact count and encoded boundary", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let submits = 0;
  const images: PendingImage[] = [
    { base64: "AAAA", mime: "image/png", preview: "data:image/png;base64,AAAA" },
    { base64: "AQID", mime: "image/png", preview: "data:image/png;base64,AQID" },
  ];
  flushSync(() => root.render(<LimitHarness images={images} onSubmit={() => { submits += 1; }} />));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const send = host.querySelector('button[aria-label="Send"]') as HTMLButtonElement;
  expect(send.disabled).toBe(false);
  flushSync(() => send.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(submits).toBe(1);
  flushSync(() => root.unmount());
});

test("structured attachment restoration rejects an over-count batch before submit", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let submits = 0;
  const images = Array.from({ length: 3 }, (_, index): PendingImage => ({
    base64: "AA==",
    mime: "image/png",
    preview: `data:image/png;base64,${index}`,
  }));
  flushSync(() => root.render(<LimitHarness images={images} onSubmit={() => { submits += 1; }} />));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const send = host.querySelector('button[aria-label="Send"]') as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  expect(host.textContent).toContain("Up to 2 images");
  flushSync(() => send.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(submits).toBe(0);
  flushSync(() => root.unmount());
});

test("structured picker, paste, and drop reject an over-count batch before submit", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let submits = 0;
  flushSync(() => root.render(<LimitHarness images={[]} onSubmit={() => { submits += 1; }} />));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const files = Array.from({ length: 3 }, (_, index) => ({
    name: `image-${index}.png`,
    type: "image/png",
    size: 1,
  })) as File[];
  const textarea = host.querySelector("textarea")!;
  const textareaPropsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const textareaProps = (textarea as unknown as Record<string, {
    onPaste(event: unknown): void;
    onDrop(event: unknown): void;
  }>)[textareaPropsKey]!;

  flushSync(() => textareaProps.onPaste({
    clipboardData: { items: files.map((file) => ({ type: file.type, getAsFile: () => file })) },
    preventDefault() {},
  }));
  expect(host.textContent).toContain("Up to 2 images");
  flushSync(() => textareaProps.onDrop({ dataTransfer: { files }, preventDefault() {} }));
  expect(host.textContent).toContain("Up to 2 images");

  const picker = host.querySelector('input[type="file"]')!;
  const pickerPropsKey = Object.keys(picker).find((key) => key.startsWith("__reactProps$"))!;
  const pickerProps = (picker as unknown as Record<string, { onChange(event: unknown): void }>)[pickerPropsKey]!;
  flushSync(() => pickerProps.onChange({ target: { files, value: "selected" } }));
  expect(host.textContent).toContain("Up to 2 images");
  expect((host.querySelector('button[aria-label="Send"]') as HTMLButtonElement).disabled).toBe(true);
  expect(submits).toBe(0);
  flushSync(() => root.unmount());
});

test("structured restoration enforces raw and aggregate byte ceilings", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const rawCapability = { ...LIMIT_CAPABILITY, maxImages: 3, maxEncodedBytesPerRequest: 20 };
  flushSync(() => root.render(<LimitHarness
    images={[{ base64: "AAAAAA==", mime: "image/png", preview: "raw-over" }]}
    capability={rawCapability}
    onSubmit={() => {}}
  />));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(host.textContent).toContain("Image exceeds this host's");
  flushSync(() => root.unmount());

  const aggregateHost = document.createElement("div");
  document.body.append(aggregateHost);
  const aggregateRoot = createRoot(aggregateHost);
  const aggregateCapability = { ...LIMIT_CAPABILITY, maxImages: 3, maxEncodedBytesPerRequest: 7 };
  flushSync(() => aggregateRoot.render(<LimitHarness
    images={[
      { base64: "AAAA", mime: "image/png", preview: "aggregate-one" },
      { base64: "AQID", mime: "image/png", preview: "aggregate-two" },
    ]}
    capability={aggregateCapability}
    onSubmit={() => {}}
  />));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(aggregateHost.textContent).toContain("request limit");
  flushSync(() => aggregateRoot.unmount());
});

test("structured limit feedback is available in English and Ukrainian", () => {
  expect(translate("en", "img.tooManyStructured", { max: 2 })).toBe("Up to 2 images can be sent at once");
  expect(translate("uk", "img.tooManyStructured", { max: 2 })).toBe("За один раз можна надіслати до 2 картинок");
  expect(translate("en", "img.structuredAggregateTooLarge", { max: 24 })).toContain("24 MB request limit");
  expect(translate("uk", "img.structuredAggregateTooLarge", { max: 24 })).toContain("24 МБ");
});

test("attachment preview copy remains accurate for structured and tmux delivery in both locales", () => {
  const image = { base64: "AA==", mime: "image/png", preview: "data:image/png;base64,AA==" };
  for (const [locale, expected] of [["en", "attached to the message"], ["uk", "додано до повідомлення"]] as const) {
    setLocale(locale);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    flushSync(() => root.render(<ImagePreviewStrip images={[image]} onRemove={() => {}} />));
    expect(host.textContent).toContain(expected);
    expect(host.textContent).not.toContain("file paths");
    expect(host.textContent).not.toContain("шляхами до файлів");
    flushSync(() => root.unmount());
    host.remove();
  }
});
