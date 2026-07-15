import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { useComposer } from "@/hooks/useComposer";

import { ComposerBar } from "./ComposerBar";

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

afterEach(() => document.body.replaceChildren());

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
