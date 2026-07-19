import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { useComposer } from "@/hooks/useComposer";
import { setLocale } from "@/lib/i18n";

import { ComposerBar } from "./ComposerBar";

/*
 * Issue #419 (reopened) — chat-first mobile composer. The model/reasoning +
 * attachment controls must NOT ride a persistent second row beneath the input
 * on the phone: collapsed they reserve zero height (the row is not in the DOM),
 * and a compact 44px primary-row action discloses them on demand. Paste/drop
 * attachment behavior stays live through the textarea while collapsed. Desktop
 * keeps the inline second row unchanged.
 */

const dom = new Window();
let mobile = false;
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});
(dom as unknown as { matchMedia(query: string): unknown }).matchMedia = (query: string) => ({
  matches: mobile,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

afterEach(() => {
  document.body.replaceChildren();
  setLocale("en");
  mobile = false;
});

function Harness({ onImageFiles }: { onImageFiles?: (files: File[]) => void }) {
  const composer = useComposer({ initialText: () => "", persistText: () => {}, submit: () => {} });
  return (
    <ComposerBar
      composer={composer}
      placeholder="Prompt"
      textareaAriaLabel="Prompt"
      imageAriaLabel="Add images"
      leftSlot={<span data-testid="left-marker">runtime</span>}
      sendLabelIdle="Send"
      sendLabelRecording="Stop"
      sendIdleClassName="bg-accent"
      onImageFiles={onImageFiles}
    />
  );
}

function mount(node: React.ReactElement) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(node));
  return { host, root };
}

test("desktop keeps the model/attachment second row inline with no disclosure toggle", () => {
  mobile = false;
  const { host, root } = mount(<Harness />);
  expect(host.querySelector('[data-testid="composer-options-row"]')).toBeTruthy();
  expect(host.querySelector('[data-testid="left-marker"]')).toBeTruthy();
  expect(host.querySelector('button[aria-label="Add images"]')).toBeTruthy();
  expect(host.querySelector('[data-testid="composer-options-toggle"]')).toBeNull();
  flushSync(() => root.unmount());
});

test("mobile collapses the second row to zero reserved height by default", () => {
  mobile = true;
  const { host, root } = mount(<Harness />);
  /* Zero reserved height: the second-row container is not in the DOM at all. */
  expect(host.querySelector('[data-testid="composer-options-row"]')).toBeNull();
  expect(host.querySelector('[data-testid="left-marker"]')).toBeNull();
  expect(host.querySelector('button[aria-label="Add images"]')).toBeNull();
  /* A compact 44px primary-row action discloses them, collapsed by default. */
  const toggle = host.querySelector('[data-testid="composer-options-toggle"]') as HTMLButtonElement;
  expect(toggle).toBeTruthy();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.getAttribute("aria-label")).toBe("Show message options");
  /* 44px accessible target via the shared iconBtn hit-area pseudo-element. */
  expect(toggle.className).toContain("before:-inset-1.5");
  flushSync(() => root.unmount());
});

test("mobile toggle discloses the runtime pill and attachment picker on demand", () => {
  mobile = true;
  const { host, root } = mount(<Harness />);
  const toggle = host.querySelector('[data-testid="composer-options-toggle"]') as HTMLButtonElement;
  flushSync(() => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.getAttribute("aria-label")).toBe("Hide message options");
  expect(host.querySelector('[data-testid="composer-options-row"]')).toBeTruthy();
  expect(host.querySelector('[data-testid="left-marker"]')).toBeTruthy();
  const picker = host.querySelector('button[aria-label="Add images"]') as HTMLButtonElement;
  expect(picker).toBeTruthy();
  expect(picker.className).toContain("before:-inset-1.5");
  flushSync(() => root.unmount());
});

test("mobile paste keeps delivering attachments while the second row is collapsed", () => {
  mobile = true;
  const delivered: File[][] = [];
  const { host, root } = mount(<Harness onImageFiles={(files) => delivered.push(files)} />);
  /* Collapsed — no picker on screen, but the textarea still owns paste/drop. */
  expect(host.querySelector('button[aria-label="Add images"]')).toBeNull();
  const textarea = host.querySelector("textarea")!;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onPaste(event: unknown): void }>)[propsKey]!;
  const imageFile = { name: "shot.png", type: "image/png" } as File;
  props.onPaste({
    clipboardData: { items: [{ type: "image/png", getAsFile: () => imageFile }] },
    preventDefault() {},
  });
  expect(delivered).toEqual([[imageFile]]);
  flushSync(() => root.unmount());
});
