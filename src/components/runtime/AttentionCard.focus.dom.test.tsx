import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { setLocale } from "@/lib/i18n";

import { AttentionCard } from "./AttentionCard";
import type { RuntimeAttention } from "./runtimeModel";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

function attention(overrides: Partial<RuntimeAttention>): RuntimeAttention {
  return {
    id: "att_1",
    conversationId: "conv_a",
    kind: "approval",
    state: "open",
    unowned: false,
    createdAt: "2026-07-10T00:00:00.000Z",
    request: { command: "rm -rf build" },
    ...overrides,
  };
}

test("an attention card arriving from the runtime never steals focus from a composer mid-typing", async () => {
  setLocale("en");
  const composerField = document.createElement("textarea");
  composerField.value = "half-typed prompt";
  document.body.append(composerField);
  composerField.focus();
  composerField.setSelectionRange(4, 4);

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    /* The runtime event lands while the user is typing. */
    flushSync(() => root.render(
      <AttentionCard attention={attention({})} onApprove={() => {}} onDeny={() => {}} />,
    ));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(composerField);
    expect(composerField.selectionStart).toBe(4);

    /* A heuristic flap replacing the attention must not steal focus either. */
    flushSync(() => root.render(
      <AttentionCard attention={attention({ id: "att_2", kind: "waiting_heuristic", request: { detail: "still there?" } })} />,
    ));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(composerField);
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    composerField.remove();
  }
});

test("with no editor focused, the attention card still takes initial focus for keyboard operation", async () => {
  setLocale("en");
  (document.activeElement as HTMLElement | null)?.blur?.();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(
      <AttentionCard attention={attention({})} onApprove={() => {}} onDeny={() => {}} />,
    ));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const active = document.activeElement as HTMLElement | null;
    expect(active).not.toBe(null);
    expect(active).not.toBe(document.body);
    expect(host.contains(active)).toBe(true);
  } finally {
    flushSync(() => root.unmount());
    host.remove();
  }
});
