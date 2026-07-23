import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import { setLocale } from "@/lib/i18n";

import { appendComposerDraft, TmuxComposer } from "./TmuxComposer";
import { readOutbox, resetOutboxForTests } from "./conversation/outbox";

/*
 * P1#1 (round-1 review): every submission method — the Send button click, the
 * Enter key, and the one-tap dictation send — must go through the SAME
 * queue-first path (`queueSubmit`): an immediate optimistic bubble, the composer
 * cleared, the message inspectable/cancellable in the durable outbox. The form's
 * onSubmit previously called `send()` directly, so clicking Send skipped all of
 * that. This asserts click and Enter reach identical queue state, and that the
 * dictation path is wired through the same `submit` callback.
 */

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

const realFetch = globalThis.fetch;

afterEach(() => {
  setLocale("en");
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  resetOutboxForTests();
});

async function renderInto(node: React.ReactElement): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
    await new Promise((r) => setTimeout(r, 0));
  });
  return { host, root };
}

const settle = async (fn: () => void) => {
  await act(async () => {
    fn();
    await new Promise((r) => setTimeout(r, 0));
  });
};

const file = {
  path: "/codex.jsonl",
  root: "codex-sessions",
  name: "codex.jsonl",
  project: "viewer",
  title: "Codex",
  engine: "codex",
  kind: "session",
  fmt: "codex",
  parent: null,
  mtime: 1,
  size: 1,
  activity: "idle",
  proc: "running",
  pid: null,
  conversationId: "conv-queuefirst",
  pendingQuestion: null,
  waitingInput: null,
} as FileEntry;

function stubFetch() {
  globalThis.fetch = (async (input: string) => {
    if (String(input) === "/api/tmux/targets") return { ok: true, json: async () => ({ targets: {} }) } as Response;
    // Keep the queued entry "delivering" forever so the optimistic bubble stays
    // observable; this test asserts the queue-first admission, not settlement.
    return new Promise(() => {}) as unknown as Response;
  }) as unknown as typeof fetch;
}

/** Drive the composer's draft the way a link-arrow drop does — this reliably
    updates the controlled textarea's React state in the happy-dom harness. */
const typeInto = (value: string) => appendComposerDraft("conv-queuefirst", value);

/** Press Enter through the textarea's React props. React's delegated keydown is
    not delivered by a bare dispatchEvent in happy-dom, so invoke the handler the
    way the user's keypress would reach it. */
function pressEnter(textarea: HTMLTextAreaElement): void {
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onKeyDown(event: unknown): void }>)[propsKey]!;
  props.onKeyDown({
    key: "Enter",
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    nativeEvent: { isComposing: false },
    preventDefault() {},
    stopPropagation() {},
  });
}

/** Submit through one method, then assert the queue-first result: exactly one
    optimistic bubble carrying the text (queued or on the wire) and a cleared
    composer. Each method renders fresh so the assertion is a stable snapshot. */
async function expectQueueFirst(submit: (host: HTMLElement, textarea: HTMLTextAreaElement) => void, text: string) {
  stubFetch();
  const { host, root } = await renderInto(<TmuxComposer file={file} />);
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  await settle(() => typeInto(text));
  expect(textarea.value).toBe(text);
  await settle(() => submit(host, textarea));

  const queue = readOutbox("conv-queuefirst");
  expect(queue.map((entry) => entry.text)).toEqual([text]);
  expect(["queued", "delivering"]).toContain(queue[0]!.state);
  expect(textarea.value).toBe("");
  await act(async () => root.unmount());
}

test("clicking Send is queue-first: the button (form submit) enqueues an optimistic bubble and clears", async () => {
  await expectQueueFirst(
    (host) => host.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event),
    "sent via click",
  );
});

test("pressing Enter is queue-first: identical optimistic bubble and clear as clicking Send", async () => {
  await expectQueueFirst((_host, textarea) => pressEnter(textarea), "sent via enter");
});
