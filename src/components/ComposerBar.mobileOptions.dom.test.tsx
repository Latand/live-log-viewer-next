import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { useComposer } from "@/hooks/useComposer";
import { setLocale } from "@/lib/i18n";

import { ComposerBar } from "./ComposerBar";

/*
 * Issue #499 (revising the #419 fold) — the model/reasoning pill is the one
 * obvious mobile runtime control: it rides an always-visible 44px row directly
 * under the input, never behind a disclosure. Only the attachment picker keeps
 * the #419 on-demand fold behind the compact primary-row action, so collapsed
 * the composer reserves exactly one quiet pill row. Paste/drop attachment
 * behavior stays live through the textarea while the picker is folded. Desktop
 * keeps the inline second row unchanged. A blocked Send explains itself inline
 * (not tooltip-only) and offers the caller's recovery action.
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

function Harness({ onImageFiles, sendDisabledReason, onSendBlockedRecover, leftSlot = <span data-testid="left-marker">runtime</span> }: {
  onImageFiles?: (files: File[]) => void;
  sendDisabledReason?: string;
  onSendBlockedRecover?: () => void;
  leftSlot?: React.ReactNode;
}) {
  const composer = useComposer({ initialText: () => "", persistText: () => {}, submit: () => {} });
  return (
    <ComposerBar
      composer={composer}
      placeholder="Prompt"
      textareaAriaLabel="Prompt"
      imageAriaLabel="Add images"
      leftSlot={leftSlot}
      sendLabelIdle="Send"
      sendLabelRecording="Stop"
      sendIdleClassName="bg-accent"
      onImageFiles={onImageFiles}
      sendDisabledReason={sendDisabledReason}
      onSendBlockedRecover={onSendBlockedRecover}
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

test("mobile keeps the runtime pill on an always-visible 44px row while attachments stay folded", () => {
  mobile = true;
  const { host, root } = mount(<Harness />);
  /* The one obvious mobile runtime control (issue #499): the pill row is in
     the DOM without any disclosure, directly under the input. */
  const pillRow = host.querySelector('[data-testid="composer-runtime-row"]')!;
  expect(pillRow).toBeTruthy();
  expect(pillRow.querySelector('[data-testid="left-marker"]')).toBeTruthy();
  /* 44px row reservation so the pill's touch target never collapses. */
  expect(pillRow.className).toContain("min-h-11");
  /* Attachments keep the #419 fold: no picker on screen until disclosed. */
  expect(host.querySelector('button[aria-label="Add images"]')).toBeNull();
  const toggle = host.querySelector('[data-testid="composer-options-toggle"]') as HTMLButtonElement;
  expect(toggle).toBeTruthy();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.getAttribute("aria-label")).toBe("Show message options");
  /* 44px accessible target via the shared iconBtn hit-area pseudo-element. */
  expect(toggle.className).toContain("before:-inset-1.5");
  flushSync(() => root.unmount());
});

test("mobile toggle discloses the attachment picker on demand", () => {
  mobile = true;
  const { host, root } = mount(<Harness />);
  const toggle = host.querySelector('[data-testid="composer-options-toggle"]') as HTMLButtonElement;
  flushSync(() => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.getAttribute("aria-label")).toBe("Hide message options");
  expect(host.querySelector('[data-testid="composer-options-row"]')).toBeTruthy();
  const picker = host.querySelector('button[aria-label="Add images"]') as HTMLButtonElement;
  expect(picker).toBeTruthy();
  expect(picker.className).toContain("before:-inset-1.5");
  flushSync(() => root.unmount());
});

test("mobile renders no fold toggle when only the pill exists (nothing to disclose)", () => {
  mobile = true;
  const { host, root } = mount(
    <ComposerBarNoImage />,
  );
  expect(host.querySelector('[data-testid="composer-runtime-row"]')).toBeTruthy();
  expect(host.querySelector('[data-testid="composer-options-toggle"]')).toBeNull();
  flushSync(() => root.unmount());
});

function ComposerBarNoImage() {
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
      showImage={false}
    />
  );
}

test("a blocked Send explains itself inline and offers the recovery action", () => {
  mobile = true;
  let recovered = 0;
  const { host, root } = mount(
    <Harness sendDisabledReason="Resolving conversation host…" onSendBlockedRecover={() => { recovered += 1; }} />,
  );
  /* The reason is visible text in a live region — never tooltip-only, which a
     phone cannot hover (issue #499). */
  const reason = host.querySelector('[data-testid="composer-send-blocked"]')!;
  expect(reason).toBeTruthy();
  expect(reason.getAttribute("role")).toBe("status");
  expect(reason.textContent).toContain("Resolving conversation host…");
  /* And it carries a recovery route, not just an explanation. */
  const recover = reason.querySelector("button") as HTMLButtonElement;
  expect(recover).toBeTruthy();
  expect(recover.textContent).toContain("Re-check");
  flushSync(() => recover.click());
  expect(recovered).toBe(1);
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
